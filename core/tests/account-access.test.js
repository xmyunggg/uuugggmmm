const assert = require('node:assert/strict');
const test = require('node:test');

// 到期/封禁语义：登录拦截之外，还要踢会话、断 Socket、停掉名下正在跑的账号。
// 判定逻辑集中在 services/account-access，可被 runtime 启动过滤和 admin 兜底任务复用。

const {
    getUserBlockReason,
    getOwnerBlockState,
    filterStartableAccounts,
    collectBlockedUsers,
} = require('../dist/services/account-access');
const { createSessionManager } = require('../dist/controllers/admin/session');

const NOW = 1_800_000_000_000;
// 会话链路内部用 Date.now() 判定，这里必须用真实过去的时刻
const PAST = Date.now() - 1000;

function card(overrides = {}) {
    return { enabled: true, expiresAt: NOW + 86_400_000, ...overrides };
}

function makeSessionManager(accounts = []) {
    const tokens = new Set();
    const sessions = new Map();
    const stopped = [];
    const ctx = {
        tokens,
        sessions,
        io: { sockets: { sockets: new Map() } },
        provider: {
            getAccounts: () => ({ accounts }),
            stopAccount: (id) => {
                stopped.push(String(id));
                const target = accounts.find((item) => String(item.id) === String(id));
                if (target) target.running = false;
                return true;
            },
        },
    };
    return { ctx, tokens, sessions, stopped, manager: createSessionManager(ctx) };
}

function requireToken(manager, token) {
    const req = { headers: { 'x-admin-token': token } };
    let captured = null;
    let nexted = false;
    const res = {
        status(code) {
            captured = { code, body: null };
            return this;
        },
        json(body) {
            if (captured) captured.body = body;
            return this;
        },
    };
    manager.requireAdminToken(req, res, () => {
        nexted = true;
    });
    return { status: captured ? captured.code : null, body: captured ? captured.body : null, nexted };
}

test('getUserBlockReason: 管理员豁免、封禁优先、永久/未设到期放行', () => {
    assert.equal(getUserBlockReason(null, NOW), null);
    assert.equal(getUserBlockReason({ username: 'u', role: 'user', card: card() }, NOW), null);
    assert.equal(getUserBlockReason({ username: 'a', role: 'admin', card: card({ expiresAt: NOW - 1 }) }, NOW), null);
    assert.equal(getUserBlockReason({ username: 's', role: 'super_admin', card: card({ enabled: false }) }, NOW), null);
    assert.equal(getUserBlockReason({ username: 'u', role: 'user', card: card({ enabled: false, expiresAt: NOW - 1 }) }, NOW), 'banned');
    assert.equal(getUserBlockReason({ username: 'u', role: 'user', card: card({ expiresAt: NOW - 1 }) }, NOW), 'expired');
    assert.equal(getUserBlockReason({ username: 'u', role: 'user', card: card({ expiresAt: 0 }) }, NOW), null);
    assert.equal(getUserBlockReason({ username: 'u', role: 'user', card: card({ expiresAt: undefined }) }, NOW), null);
    assert.equal(getUserBlockReason({ username: 'u', role: 'user' }, NOW), null);
});

test('getOwnerBlockState / filterStartableAccounts: 无归属放行，已删除用户拦截', () => {
    const users = [
        { username: 'ok', role: 'user', card: card() },
        { username: 'out', role: 'user', card: card({ expiresAt: NOW - 1 }) },
    ];
    const findUser = (username) => users.find((item) => item.username === username) || null;

    assert.deepEqual(getOwnerBlockState('', findUser, NOW), { blocked: false, reason: null });
    assert.deepEqual(getOwnerBlockState('ok', findUser, NOW), { blocked: false, reason: null });
    assert.deepEqual(getOwnerBlockState('out', findUser, NOW), { blocked: true, reason: 'expired' });
    assert.deepEqual(getOwnerBlockState('ghost', findUser, NOW), { blocked: true, reason: 'missing' });

    const accounts = [
        { id: '1', username: '' },
        { id: '2', username: 'ok' },
        { id: '3', username: 'out' },
        { id: '4', username: 'ghost' },
    ];
    const { startable, skipped } = filterStartableAccounts(accounts, findUser, NOW);
    assert.deepEqual(startable.map((item) => item.id), ['1', '2']);
    assert.deepEqual(skipped.map((item) => `${item.id}:${item.reason}`), ['3:expired', '4:missing']);
});

test('collectBlockedUsers: 只收集非管理员的到期/封禁用户', () => {
    const blocked = collectBlockedUsers([
        { username: 'a', role: 'admin', card: card({ expiresAt: NOW - 1 }) },
        { username: 'b', role: 'user', card: card({ expiresAt: NOW - 1 }) },
        { username: 'c', role: 'user', card: card({ enabled: false }) },
        { username: 'd', role: 'user', card: card() },
    ], NOW);
    assert.deepEqual(blocked, [
        { username: 'b', reason: 'expired' },
        { username: 'c', reason: 'banned' },
    ]);
});

test('enforceBlockedUser: 踢掉该用户全部会话并只停他名下正在跑的账号', () => {
    const { tokens, sessions, stopped, manager } = makeSessionManager([
        { id: '1', username: 'u1', running: true },
        { id: '2', username: 'u1', running: false },
        { id: '3', username: 'u2', running: true },
    ]);
    const tokenA = manager.createAdminSession({ username: 'u1', role: 'user', card: card({ expiresAt: PAST }) });    const tokenB = manager.createAdminSession({ username: 'u2', role: 'user', card: card() });
    assert.equal(sessions.size, 2);

    assert.equal(manager.enforceBlockedUser('u1', 'expired'), 1);
    assert.deepEqual(stopped, ['1']);
    assert.equal(tokens.has(tokenA), false);
    assert.equal(tokens.has(tokenB), true);
    assert.equal(sessions.size, 1);

    // 重复扫描无副作用也没有多余的停账号调用
    assert.equal(manager.enforceBlockedUser('u1', 'expired'), 0);
    assert.deepEqual(stopped, ['1']);

    // 无归属用户名的账号不受影响
    assert.equal(manager.enforceBlockedUser('', 'expired'), 0);
    assert.deepEqual(stopped, ['1']);
});

test('requireAdminToken: 到期用户请求被拒并当场停账号，管理员豁免', () => {
    const make = () => makeSessionManager([
        { id: '1', username: 'u1', running: true },
        { id: '2', username: 'root', running: true },
    ]);

    const first = make();
    const expiredToken = first.manager.createAdminSession({ username: 'u1', role: 'user', card: card({ expiresAt: PAST }) });
    const result = requireToken(first.manager, expiredToken);
    assert.equal(result.status, 403);
    assert.equal(result.body.error, '账号已过期，请续费后重新登录');
    assert.equal(result.nexted, false);
    assert.deepEqual(first.stopped, ['1']);
    assert.equal(first.tokens.has(expiredToken), false);

    const second = make();
    const bannedToken = second.manager.createAdminSession({ username: 'u1', role: 'user', card: card({ enabled: false }) });
    const banned = requireToken(second.manager, bannedToken);
    assert.equal(banned.status, 403);
    assert.equal(banned.body.error, '账号已被封禁，请联系管理员');
    assert.deepEqual(second.stopped, ['1']);

    const third = make();
    const adminToken = third.manager.createAdminSession({ username: 'root', role: 'admin', card: card({ expiresAt: PAST }) });
    const admin = requireToken(third.manager, adminToken);
    assert.deepEqual({ status: admin.status, nexted: admin.nexted }, { status: null, nexted: true });
    assert.deepEqual(third.stopped, []);
});
