const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { PlantPhase } = require('../dist/config/config');
const { DEFAULT_ROUND_LIMIT, GOLDEN_BUG_ITEM_ID } = require('../dist/services/golden-bug');

// ==================== 一、账号级配置（落盘） ====================

const { getDataFile } = require('../dist/config/runtime-paths');
const store = require('../dist/models/store');

// 配置读写会写 store.json / accounts.json，测试前后备份还原，避免污染真实配置
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

test('默认不开启自动投放黄金虫，保留 0 只、单轮 24 只', () => {
    const snapshot = store.getConfigSnapshot();
    assert.equal(snapshot.automation.friend_golden_bug, false);
    assert.equal(snapshot.goldenBugKeepCount, 0);
    assert.equal(snapshot.goldenBugRoundLimit, DEFAULT_ROUND_LIMIT);
});

test('黄金虫配置落盘并被夹到合法区间', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    assert.ok(accountId, '测试环境需要一个账号用于读写账号级配置');
    const previous = store.getConfigSnapshot(accountId);
    try {
        store.applyConfigSnapshot({ goldenBugKeepCount: 12, goldenBugRoundLimit: 30 }, { accountId });
        assert.equal(store.getGoldenBugKeepCount(accountId), 12);
        assert.equal(store.getGoldenBugRoundLimit(accountId), 30);

        store.applyConfigSnapshot({ goldenBugKeepCount: -5, goldenBugRoundLimit: 999 }, { accountId });
        assert.equal(store.getGoldenBugKeepCount(accountId), 0);
        assert.equal(store.getGoldenBugRoundLimit(accountId), 100);

        store.applyConfigSnapshot({ goldenBugRoundLimit: 0 }, { accountId });
        assert.equal(store.getGoldenBugRoundLimit(accountId), DEFAULT_ROUND_LIMIT);
    }
    finally {
        store.applyConfigSnapshot({
            goldenBugKeepCount: previous.goldenBugKeepCount,
            goldenBugRoundLimit: previous.goldenBugRoundLimit,
            automation: { friend_golden_bug: previous.automation.friend_golden_bug },
        }, { accountId });
    }
});

test('黄金虫开关随 automation 一起读写', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    const previous = store.isAutomationOn('friend_golden_bug', accountId);
    try {
        store.setAutomation('friend_golden_bug', true, accountId);
        assert.equal(store.isAutomationOn('friend_golden_bug', accountId), true);
        store.setAutomation('friend_golden_bug', false, accountId);
        assert.equal(store.isAutomationOn('friend_golden_bug', accountId), false);
    }
    finally {
        store.setAutomation('friend_golden_bug', previous, accountId);
    }
});

// ==================== 二、好友农场投放协议适配 ====================

function stubModule(pathname, exports) {
    require.cache[pathname] = { id: pathname, filename: pathname, loaded: true, exports };
}

const modulePaths = {
    gameConfig: require.resolve('../dist/config/gameConfig'),
    sellConditions: require.resolve('../dist/config/sell-conditions'),
    network: require.resolve('../dist/utils/network'),
    proto: require.resolve('../dist/utils/proto'),
    utils: require.resolve('../dist/utils/utils'),
    activityWindows: require.resolve('../dist/services/activity-windows'),
    farmApi: require.resolve('../dist/services/farm/api'),
    landAnalysis: require.resolve('../dist/services/farm/land-analysis'),
    friendApi: require.resolve('../dist/services/friend/api'),
    warehouse: require.resolve('../dist/services/warehouse'),
};

const GOLDEN_BUG_INFO = {
    id: GOLDEN_BUG_ITEM_ID,
    name: '黄金虫',
    type: 23,
    can_use: 1,
    interaction_type: 'addItemUseItem',
};

const calls = { send: [], enter: [], leave: [] };
let bagItems = [];
let friendLands = [];
let friendBasic = {};
let failSendIndex = null;

stubModule(modulePaths.gameConfig, {
    getItemById: (id) => (Number(id) === GOLDEN_BUG_ITEM_ID ? GOLDEN_BUG_INFO : { id: Number(id), name: '其他' }),
    getItemImageById: () => '',
});
stubModule(modulePaths.sellConditions, { isSellConditionSatisfied: () => false });
stubModule(modulePaths.network, {
    getUserState: () => ({ gid: 9001 }),
    GatewayError: class GatewayError extends Error {},
    sendMsgAsync: async (service, method, body) => {
        const index = calls.send.length;
        calls.send.push({ service, method, body });
        if (failSendIndex !== null && index === failSendIndex) throw new Error('该地块已不符合使用条件');
        return { body: Buffer.from([]) };
    },
});
stubModule(modulePaths.proto, {
    types: {
        UseRequest: { create: (value) => value, encode: () => ({ finish: () => new Uint8Array([1, 2, 3]) }) },
        UseReply: { decode: () => ({}) },
    },
});
stubModule(modulePaths.utils, { toNum: (value) => Number(value) || 0 });
stubModule(modulePaths.activityWindows, { getSellConditionContext: async () => ({}) });
stubModule(modulePaths.farmApi, { getAllLands: async () => ({ lands: [] }) });
stubModule(modulePaths.landAnalysis, {
    buildLandMap: () => ({}),
    buildLandDetail: () => ({}),
    getCurrentPhase: (phases) => (Array.isArray(phases) ? phases[0] : { phase: 0 }),
    getDisplayLandContext: (land) => ({ occupiedByMaster: false, sourceLand: land, occupiedLandIds: [land.id] }),
    getPlantInteractionEffects: () => [],
});
stubModule(modulePaths.friendApi, {
    enterFriendFarm: async (gid) => {
        calls.enter.push(gid);
        return { basic: friendBasic, lands: friendLands };
    },
    leaveFriendFarm: async (gid) => { calls.leave.push(gid); },
});
stubModule(modulePaths.warehouse, {
    getBag: async () => ({}),
    getBagItems: () => bagItems,
});

const { placeGoldenBugOnFriendFarm } = require('../dist/services/friend-interaction-items');

function resetCalls() {
    calls.send.length = 0;
    calls.enter.length = 0;
    calls.leave.length = 0;
    failSendIndex = null;
    bagItems = [{ id: GOLDEN_BUG_ITEM_ID, count: 5, uid: 1 }];
    friendBasic = { gid: 100, remark: '阿黄' };
    // 一块可放置（种子期），一块已成熟（不可放置），一块空地（无作物）
    friendLands = [
        { id: 1, unlocked: true, plant: { id: 101, phases: [{ phase: PlantPhase.SEED }] } },
        { id: 2, unlocked: true, plant: { id: 102, phases: [{ phase: PlantPhase.MATURE }] } },
        { id: 3, unlocked: true },
    ];
}

test('只投放到可放置地块，并在 finally 里离开农场', async () => {
    resetCalls();
    const result = await placeGoldenBugOnFriendFarm(100, 3);
    assert.equal(result.placed, 1);
    assert.equal(result.ownerName, '阿黄');
    assert.deepEqual(calls.enter, [100]);
    assert.deepEqual(calls.leave, [100], '无论成功失败都要离开好友农场');
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].service, 'gamepb.itempb.ItemService');
    assert.equal(calls.send[0].method, 'Use');
});

test('投放数量不超过传入上限', async () => {
    resetCalls();
    friendLands = [1, 2, 3].map(id => ({ id, unlocked: true, plant: { id: 101, phases: [{ phase: PlantPhase.SEED }] } }));
    const result = await placeGoldenBugOnFriendFarm(100, 2);
    assert.equal(result.placed, 2);
    assert.equal(calls.send.length, 2);
});

test('库存不足时直接拒绝，不会进入农场', async () => {
    resetCalls();
    bagItems = [{ id: GOLDEN_BUG_ITEM_ID, count: 1, uid: 1 }];
    await assert.rejects(() => placeGoldenBugOnFriendFarm(100, 3), /只有 1 个黄金虫/);
    assert.deepEqual(calls.enter, []);
});

test('进入的农场 GID 与请求不一致时报错', async () => {
    resetCalls();
    friendBasic = { gid: 999 };
    await assert.rejects(() => placeGoldenBugOnFriendFarm(100, 1), /不一致/);
    assert.deepEqual(calls.leave, [100]);
});

test('单块地投放失败不影响其他地块', async () => {
    resetCalls();
    friendLands = [1, 2].map(id => ({ id, unlocked: true, plant: { id: 101, phases: [{ phase: PlantPhase.SEED }] } }));
    failSendIndex = 0;
    const result = await placeGoldenBugOnFriendFarm(100, 2);
    assert.equal(result.placed, 1);
    assert.equal(calls.send.length, 2);
    assert.deepEqual(calls.leave, [100]);
});

// ==================== 三、接线契约（静态检查） ====================

function readSource(relativePath) {
    return fs.readFileSync(require.resolve(relativePath), 'utf8');
}

test('worker 好友任务里挂上黄金虫投放，并在开关打开时立即执行一轮', () => {
    const source = readSource('../dist/core/worker.js');
    assert.match(source, /runGoldenBugPlacement/);
    assert.match(source, /auto\.friend_golden_bug/);
    assert.match(source, /friend_golden_bug_immediate/);
});

test('保存设置的字段白名单包含黄金虫配置', () => {
    const source = readSource('../dist/runtime/data-provider.js');
    assert.match(source, /'goldenBugKeepCount'/);
    assert.match(source, /'goldenBugRoundLimit'/);
});

test('GET /api/settings 会下发黄金虫配置', () => {
    const source = readSource('../dist/controllers/admin/account-routes.js');
    assert.match(source, /getGoldenBugKeepCount/);
    assert.match(source, /getGoldenBugRoundLimit/);
});
