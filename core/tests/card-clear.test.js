const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// 卡密批量清空：store 的 clearCards(scope) + 两个管理接口的危险确认。
// 直接调 mountCardRoutes 注册的 handler，避免起 HTTP 服务，但危险确认用的是真实实现。

const { getDataFile } = require('../dist/config/runtime-paths');
const userStore = require('../dist/models/user-store');
const { mountCardRoutes } = require('../dist/controllers/admin/card-routes');
const { createRouteHelpers } = require('../dist/controllers/admin/session');

const CARDS_FILE = getDataFile('cards.json');

function makeCard(code, usedBy = null) {
    return {
        code,
        description: `测试卡密 ${code}`,
        type: 'time',
        enabled: true,
        usedBy,
        usedAt: usedBy ? Date.now() : null,
        createdAt: Date.now(),
        durationValue: 1,
        durationUnit: 'month',
        isPermanent: false,
    };
}

function writeFixture(cards) {
    fs.writeFileSync(CARDS_FILE, JSON.stringify({ cards }, null, 2));
}

function readFixture() {
    const data = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    return data.cards || [];
}

// 真实的注册方式：拿到 handler，再用假 express 报文直接调用。
const routes = {};
const fakeApp = {
    get: (p, ...handlers) => { routes[`GET ${p}`] = handlers.at(-1); },
    post: (p, ...handlers) => { routes[`POST ${p}`] = handlers.at(-1); },
    delete: (p, ...handlers) => { routes[`DELETE ${p}`] = handlers.at(-1); },
};
const helpers = createRouteHelpers({ userStore });
const noopMiddleware = (_req, _res, next) => next();

mountCardRoutes(fakeApp, {}, {
    requireAdminToken: noopMiddleware,
    requireAdminRole: noopMiddleware,
    requireDangerConfirmation: helpers.requireDangerConfirmation,
});

function callRoute(key, body) {
    const handler = routes[key];
    assert.ok(handler, `路由未注册：${key}`);
    const captured = { status: 200, body: null };
    const res = {
        status(code) { captured.status = code; return this; },
        json(payload) { captured.body = payload; return this; },
    };
    handler({ body: body || {}, params: {}, headers: {} }, res);
    return captured;
}

function resetFixture() {
    writeFixture([
        makeCard('UNUSED-A'),
        makeCard('UNUSED-B'),
        makeCard('USED-C', 'alice'),
        makeCard('USED-D', 'bob'),
    ]);
}

// 保住开发机上真实的 cards.json，测完原样还回去。
let originalCardsContent = null;
let originalCardsExisted = false;
test.before(() => {
    originalCardsExisted = fs.existsSync(CARDS_FILE);
    originalCardsContent = originalCardsExisted ? fs.readFileSync(CARDS_FILE, 'utf8') : null;
});

test.after(() => {
    if (originalCardsExisted) fs.writeFileSync(CARDS_FILE, originalCardsContent);
    else if (fs.existsSync(CARDS_FILE)) fs.rmSync(CARDS_FILE);
});

test.beforeEach(resetFixture);
test.afterEach(resetFixture);

test('clearCards(used) 只删已使用的卡密，未使用库存原样保留', () => {
    const result = userStore.clearCards('used');

    assert.equal(result.ok, true);
    assert.equal(result.deletedCount, 2);
    assert.equal(result.remainingCount, 2);
    const codes = readFixture().map(card => card.code).sort();
    assert.deepEqual(codes, ['UNUSED-A', 'UNUSED-B']);
});

test('clearCards(used) 没有已使用卡密时是空操作，不误删库存', () => {
    writeFixture([makeCard('UNUSED-A'), makeCard('UNUSED-B')]);

    const result = userStore.clearCards('used');

    assert.equal(result.ok, true);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.remainingCount, 2);
    assert.equal(readFixture().length, 2);
});

test('clearCards(all) 清空全部卡密', () => {
    const result = userStore.clearCards('all');

    assert.equal(result.ok, true);
    assert.equal(result.deletedCount, 4);
    assert.equal(result.remainingCount, 0);
    assert.deepEqual(readFixture(), []);
});

test('scope 非法时拒绝执行且不动数据', () => {
    for (const scope of ['', 'used ', 'USED', 'partial', undefined]) {
        const result = userStore.clearCards(scope);
        assert.equal(result.ok, false, `scope=${scope} 应该被拒绝`);
        assert.equal(result.error, '清空范围不正确');
    }
    assert.equal(readFixture().length, 4);
});

test('接口必须带 confirmed 才执行，否则 400 危险操作未确认', () => {
    for (const key of ['POST /api/admin/cards/clear-used', 'POST /api/admin/cards/clear-all']) {
        const response = callRoute(key, {});
        assert.equal(response.status, 400, `${key} 未确认时应 400`);
        assert.equal(response.body.ok, false);
        assert.equal(response.body.error, '危险操作未确认');
    }
    assert.equal(readFixture().length, 4);
});

test('clear-used 接口删掉已使用卡密并返回计数', () => {
    const response = callRoute('POST /api/admin/cards/clear-used', { confirmed: true });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.deletedCount, 2);
    assert.equal(response.body.remainingCount, 2);
});

test('clear-all 接口必须原样输入确认短语', () => {
    const bad = callRoute('POST /api/admin/cards/clear-all', { confirmed: true, confirmText: '清空卡密' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.requiredConfirmation, 'CLEAR_ALL_CARDS');
    assert.equal(bad.body.requiredConfirmText, '清空所有卡密');
    assert.equal(readFixture().length, 4, '短语不对时不能删任何卡密');

    const good = callRoute('POST /api/admin/cards/clear-all', { confirmed: true, confirmText: '清空所有卡密' });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    assert.equal(good.body.deletedCount, 4);
    assert.deepEqual(readFixture(), []);
});

// 语义确认（用户已确认）：清空卡密只删卡密记录，不得回滚已续费账号的有效期/额度，
// 也不得顺手动别的数据文件。这里用真实注册+续费路径造出「已续费账号」再清空卡密。
test('清空卡密不回滚已续费账号的有效期与额度，也不写脏其它数据文件', () => {
    const usersFile = getDataFile('users.json');
    const usersBefore = fs.existsSync(usersFile) ? fs.readFileSync(usersFile, 'utf8') : null;
    // users.json 要在注册/续费之后再比（注册本身就会写它），这里先排除
    const otherFiles = fs.readdirSync(path.dirname(CARDS_FILE))
        .filter(name => name.endsWith('.json') && name !== 'cards.json' && name !== 'users.json')
        .map(name => ({ name, content: fs.readFileSync(path.join(path.dirname(CARDS_FILE), name), 'utf8') }));
    try {
        const registered = userStore.registerUser('clear_probe', 'Abcd1234!x', 'UNUSED-A');
        assert.equal(registered.ok, true, JSON.stringify(registered));
        const renewed = userStore.renewUser('clear_probe', 'UNUSED-B');
        assert.equal(renewed.ok, true, JSON.stringify(renewed));

        const expiresBefore = userStore.getUser('clear_probe').card.expiresAt;
        const limitBefore = userStore.getUser('clear_probe').accountLimit;
        assert.ok(expiresBefore > Date.now(), '续费后应带未来有效期');
        const usersJsonBefore = fs.readFileSync(usersFile, 'utf8');

        const cleared = userStore.clearCards('all');
        assert.equal(cleared.ok, true);
        assert.equal(cleared.remainingCount, 0, '卡密应被清空');

        assert.equal(userStore.getUser('clear_probe').card.expiresAt, expiresBefore, '已续费有效期不能被回滚');
        assert.equal(userStore.getUser('clear_probe').accountLimit, limitBefore, '账号额度不能被回滚');
        assert.equal(fs.readFileSync(usersFile, 'utf8'), usersJsonBefore, 'users.json 不应被清空卡密改写');
        for (const { name, content } of otherFiles) {
            assert.equal(fs.readFileSync(path.join(path.dirname(CARDS_FILE), name), 'utf8'), content, `${name} 不应被清空卡密改写`);
        }
    }
    finally {
        if (usersBefore === null) fs.rmSync(usersFile, { force: true });
        else fs.writeFileSync(usersFile, usersBefore);
        userStore.deleteUser('clear_probe');
    }
});
