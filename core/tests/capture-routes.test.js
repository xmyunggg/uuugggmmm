const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { getDataFile } = require('../dist/config/runtime-paths');
const store = require('../dist/models/store');
const routes = require('../dist/controllers/admin/capture-routes');

// ---------------- 抓包服务配置（落盘） ----------------

// 配置读写会写 store.json，测试前后备份/还原，避免污染真实配置
const STORE_FILE = getDataFile('store.json');
const storeFileBackup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;

test.after(() => {
    if (storeFileBackup === null) {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
    }
    else {
        fs.writeFileSync(STORE_FILE, storeFileBackup);
    }
});

test('抓包服务配置默认关闭且为嵌入模式', () => {
    const defaults = store.DEFAULT_CAPTURE_CONFIG;
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.embedded, true);
    assert.equal(defaults.apiBase, 'http://127.0.0.1:8450');
    assert.equal(defaults.autoImportQqGids, true);
    assert.equal(store.getCaptureConfig().enabled, false);
});

test('抓包服务配置可写入并落盘，Token 留空时沿用旧值', () => {
    const previous = store.getCaptureConfig();
    try {
        const saved = store.setCaptureConfig({ enabled: true, apiToken: 'token-1' });
        assert.equal(saved.enabled, true);
        assert.equal(saved.apiToken, 'token-1');
        assert.equal(store.getCaptureConfig().apiToken, 'token-1');

        const updated = store.setCaptureConfig({ enabled: false, autoImportQqGids: false });
        assert.equal(updated.enabled, false);
        assert.equal(updated.apiToken, 'token-1', '未提交 Token 时不应清空已保存的值');
        assert.equal(updated.autoImportQqGids, false);
        assert.equal(updated.embedded, true, '未提交 embedded 时保留默认嵌入模式');

        const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).captureConfig;
        assert.equal(onDisk.apiToken, 'token-1');
        assert.equal(onDisk.autoImportQqGids, false);
    }
    finally {
        store.setCaptureConfig(previous);
    }
});

// ---------------- 纯函数 ----------------

test('normalizeApiBase 校验并规范化地址', () => {
    assert.equal(routes.normalizeApiBase('http://127.0.0.1:8450/'), 'http://127.0.0.1:8450');
    assert.equal(routes.normalizeApiBase('https://capture.example.com/base/'), 'https://capture.example.com/base');
    assert.equal(routes.normalizeApiBase('http://127.0.0.1:8450/#x?y=1'), 'http://127.0.0.1:8450');
    assert.throws(() => routes.normalizeApiBase(''), /地址无效/);
    assert.throws(() => routes.normalizeApiBase('ftp://127.0.0.1'), /仅支持/);
    assert.throws(() => routes.normalizeApiBase('http://user:pass@127.0.0.1:8450'), /仅支持/);
    assert.throws(() => routes.normalizeApiBase('不是地址'), /格式无效/);
    assert.throws(() => routes.normalizeApiBase(`http://a.com/${'x'.repeat(600)}`), /地址无效/);
});

test('mergeKnownFriendGids 去重并剔除自身 GID', () => {
    assert.deepEqual(routes.mergeKnownFriendGids([1, 2], new Set([2, 3]), 3), [1, 2]);
    assert.deepEqual(routes.mergeKnownFriendGids([], new Set([0, -1, 5.5, 7]), 0), [7]);
    assert.deepEqual(routes.mergeKnownFriendGids(null, new Set([]), ''), []);
});

test('isCompleteQqFriendSource 只认可完整列表接口', () => {
    assert.equal(routes.isCompleteQqFriendSource('gamepb.friendpb.FriendService.GetAll'), true);
    assert.equal(routes.isCompleteQqFriendSource('gamepb.friendpb.FriendService.SyncAll'), true);
    assert.equal(routes.isCompleteQqFriendSource('gamepb.friendpb.FriendService.GetGameFriends'), false);
    assert.equal(routes.isCompleteQqFriendSource(''), false);
});

test('证书 Token 校验', () => {
    const flow = { certificateToken: 'abc123' };
    assert.equal(routes.isCertificateTokenValid(flow, 'abc123'), true);
    assert.equal(routes.isCertificateTokenValid(flow, 'abc124'), false);
    assert.equal(routes.isCertificateTokenValid(flow, ''), false);
    assert.equal(routes.isCertificateTokenValid({}, 'abc123'), false);
});

test('findDuplicateCapturedAccount 按 code/GID 判定重复', () => {
    const accounts = [
        { id: '1', platform: 'qq', code: 'AAA' },
        { id: '2', platform: 'wx', code: 'AAA' },
    ];
    assert.equal(routes.findDuplicateCapturedAccount(accounts, { platform: 'qq', code: 'AAA' })?.id, '1');
    assert.equal(routes.findDuplicateCapturedAccount(accounts, { platform: 'wx', code: 'AAA' })?.id, '2');
    assert.equal(routes.findDuplicateCapturedAccount(accounts, { platform: 'qq', code: 'BBB' }), null);
    assert.equal(routes.findDuplicateCapturedAccount(accounts, { platform: 'qq', accountGid: '9' }), null);
    assert.equal(routes.findDuplicateCapturedAccount(accounts, { platform: 'qq', code: 'AAA' }, '1'), null,
        '更新同一账号时不应判为重复');
});

test('getCaptureBypassHosts 收集面板来源地址', () => {
    const hosts = routes.getCaptureBypassHosts({
        hostname: 'localhost',
        headers: {
            'x-forwarded-host': 'panel.example.com, inner.example.com',
            origin: 'http://panel.example.com:3007',
            referer: 'http://127.0.0.1:3007/login',
        },
    });
    assert.deepEqual(hosts, ['localhost', 'panel.example.com', '127.0.0.1']);
});

test('getCaptureAdvertiseHost 跳过回环地址，取浏览器访问地址', () => {
    assert.equal(routes.getCaptureAdvertiseHost({ headers: { host: '127.0.0.1:3007' } }), '');
    assert.equal(routes.getCaptureAdvertiseHost({ headers: { host: 'localhost:3007' } }), '');
    assert.equal(routes.getCaptureAdvertiseHost({ headers: { 'x-forwarded-host': 'farm.example.com' } }), 'farm.example.com');
    assert.equal(routes.getCaptureAdvertiseHost({ headers: { host: '[::1]:3007' } }), '');
    assert.equal(routes.getCaptureAdvertiseHost({}), '');
});

test('addCapturedValues 合并会话快照且不覆盖已有值', () => {
    const flow = {
        platform: 'qq',
        code: '',
        accountGid: '',
        openId: '',
        friendGids: new Set(),
        friendSource: '',
        friendListComplete: false,
        publicInfo: {},
        proxy: {},
        captureStatus: 'idle',
    };
    routes.addCapturedValues(flow, {
        data: {
            channels: {
                qq: { status: 'captured', codes: [{ code: 'CODE-1', gid: '12345', openid: 'OPENID-1' }] },
            },
            friends: {
                source: 'gamepb.friendpb.FriendService.GetAll',
                items: [{ gid: '1001' }, { gid: '1002' }, { gid: 'bad' }],
                complete: true,
            },
            publicInfo: { host: '10.0.0.5', addresses: [{ address: '10.0.0.5', kind: 'lan' }], mitmPort: 18000 },
            proxy: { running: true, status: 'running' },
        },
    });

    assert.equal(flow.code, 'CODE-1');
    assert.equal(flow.accountGid, '12345');
    assert.equal(flow.openId, 'OPENID-1');
    assert.deepEqual([...flow.friendGids], [1001, 1002]);
    assert.equal(flow.friendListComplete, true);
    assert.equal(flow.captureStatus, 'captured');
    assert.equal(flow.publicInfo.mitmPort, 18000);

    // 二次刷新不应覆盖已抓到的值
    routes.addCapturedValues(flow, { data: { channels: { qq: { status: 'captured', codes: [{ code: 'CODE-2' }] } } } });
    assert.equal(flow.code, 'CODE-1');

    // 非完整列表接口不置 complete
    const partial = { ...flow, friendListComplete: false, friendSource: '' };
    routes.addCapturedValues(partial, {
        data: { friends: { source: 'gamepb.friendpb.FriendService.GetGameFriends', items: [{ gid: '2001' }] } },
    });
    assert.equal(partial.friendListComplete, false);
    assert.deepEqual([...partial.friendGids], [1001, 1002, 2001]);
});

test('addCapturedValues 忽略空快照', () => {
    const flow = { platform: 'qq', code: '', friendGids: new Set() };
    routes.addCapturedValues(flow, null);
    routes.addCapturedValues(flow, {});
    assert.equal(flow.code, '');
    assert.equal(flow.friendGids.size, 0);
});

// ---------------- 含副作用的辅助函数 ----------------

test('scheduleCapturedAccountStart 延迟启动并记录失败原因', () => {
    const scheduled = [];
    const provider = {
        started: [],
        restarted: [],
        startAccount(id) { this.started.push(id); },
        restartAccount(id) { this.restarted.push(id); },
    };
    const flow = { owner: 'u1', result: {} };
    const logger = { warn: () => {} };

    routes.scheduleCapturedAccountStart({
        provider,
        logger,
        flow,
        account: { id: '7' },
        isUpdate: false,
        wasRunning: false,
        delayMs: 5,
        schedule: (fn) => { scheduled.push(fn); return { unref() {} }; },
    });
    assert.equal(scheduled.length, 1);
    scheduled[0]();
    assert.deepEqual(provider.started, ['7']);

    // 更新账号且原本在运行 → 重启
    routes.scheduleCapturedAccountStart({
        provider,
        logger,
        flow,
        account: { id: '8' },
        isUpdate: true,
        wasRunning: true,
        delayMs: 5,
        schedule: (fn) => { scheduled.push(fn); return { unref() {} }; },
    });
    scheduled[1]();
    assert.deepEqual(provider.restarted, ['8']);

    // 更新账号但原本已停止 → 不重启
    routes.scheduleCapturedAccountStart({
        provider,
        logger,
        flow,
        account: { id: '9' },
        isUpdate: true,
        wasRunning: false,
        delayMs: 5,
        schedule: (fn) => { scheduled.push(fn); return { unref() {} }; },
    });
    scheduled[2]();
    assert.deepEqual(provider.restarted, ['8']);

    // 启动抛错 → 写入 result.startError，不冒泡
    const failingProvider = {
        startAccount() { throw new Error('账号启动失败'); },
    };
    const failingFlow = { owner: 'u1', result: {} };
    routes.scheduleCapturedAccountStart({
        provider: failingProvider,
        logger,
        flow: failingFlow,
        account: { id: '10' },
        isUpdate: false,
        wasRunning: false,
        delayMs: 5,
        schedule: (fn) => { fn(); return { unref() {} }; },
    });
    assert.equal(failingFlow.result.startError, '账号启动失败');
});

test('collectQqFriendGids 轮询到完整列表后导入并停掉代理', async () => {
    const originalGetAccounts = store.getAccounts;
    const originalGetKnown = store.getKnownFriendGids;
    const originalSetKnown = store.setKnownFriendGids;
    const written = [];
    const broadcast = [];

    store.getAccounts = () => ({ accounts: [{ id: '5', createdAt: 111 }] });
    store.getKnownFriendGids = () => [10];
    store.setKnownFriendGids = (accountId, gids) => { written.push({ accountId, gids }); };

    try {
        const flow = {
            id: 'flow-1',
            owner: 'u1',
            accountGid: '99',
            friendGids: new Set([10, 11, 99]),
            friendListComplete: false,
            friendSource: '',
            result: {},
        };
        let refreshCount = 0;
        let stopped = 0;
        let afterStopCalled = 0;

        const imported = await routes.collectQqFriendGids({
            provider: { broadcastConfig: id => broadcast.push(id) },
            logger: { info: () => {}, warn: () => {} },
            flow,
            accountId: '5',
            accountCreatedAt: 111,
            refresh: async () => {
                refreshCount += 1;
                if (refreshCount >= 2) {
                    flow.friendListComplete = true;
                    flow.friendSource = 'gamepb.friendpb.FriendService.GetAll';
                }
                return flow;
            },
            stop: async () => { stopped += 1; },
            wait: async () => {},
            now: () => 0,
            afterStop: async () => { afterStopCalled += 1; },
        });

        assert.equal(imported, 1, '只应统计新增好友 GID（10 已有，11 新增，99 是自身）');
        assert.deepEqual(written, [{ accountId: '5', gids: [10, 11] }]);
        assert.deepEqual(broadcast, ['5']);
        assert.equal(stopped, 1);
        assert.equal(afterStopCalled, 1);
        assert.equal(flow.result.importedFriendCount, 1);
    }
    finally {
        store.getAccounts = originalGetAccounts;
        store.getKnownFriendGids = originalGetKnown;
        store.setKnownFriendGids = originalSetKnown;
    }
});

test('collectQqFriendGids 账号被替换时放弃写入', async () => {
    const originalGetAccounts = store.getAccounts;
    const originalGetKnown = store.getKnownFriendGids;
    const originalSetKnown = store.setKnownFriendGids;
    const written = [];
    // createdAt 已变化 → 账号被重建
    store.getAccounts = () => ({ accounts: [{ id: '5', createdAt: 222 }] });
    store.getKnownFriendGids = () => [];
    store.setKnownFriendGids = (accountId, gids) => { written.push({ accountId, gids }); };

    try {
        const flow = {
            id: 'flow-2',
            owner: 'u1',
            accountGid: '',
            friendGids: new Set([42]),
            friendListComplete: true,
            result: {},
        };
        const imported = await routes.collectQqFriendGids({
            provider: {},
            logger: { info: () => {}, warn: () => {} },
            flow,
            accountId: '5',
            accountCreatedAt: 111,
            refresh: async () => flow,
            stop: async () => {},
            wait: async () => {},
            now: () => 0,
        });
        assert.equal(imported, 0);
        assert.deepEqual(written, []);
    }
    finally {
        store.getAccounts = originalGetAccounts;
        store.getKnownFriendGids = originalGetKnown;
        store.setKnownFriendGids = originalSetKnown;
    }
});
