const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

test('资本模式默认关闭、未选宠物、提前 10 秒', () => {
    const snapshot = store.getConfigSnapshot();
    assert.deepEqual(snapshot.capitalMode, { enabled: false, dogId: 0, leadSeconds: 10 });
});

test('资本模式读写落盘，leadSeconds 被夹到 5-300，dogId 非法值归零', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    assert.ok(accountId, '测试环境需要一个账号用于读写账号级配置');
    const previous = store.getCapitalMode(accountId);
    try {
        assert.deepEqual(store.setCapitalMode(accountId, { enabled: true, dogId: 601, leadSeconds: 30 }),
            { enabled: true, dogId: 601, leadSeconds: 30 });
        // 上限/下限
        assert.equal(store.setCapitalMode(accountId, { leadSeconds: 999 }).leadSeconds, 300);
        assert.equal(store.setCapitalMode(accountId, { leadSeconds: 1 }).leadSeconds, 5);
        // 缺省字段沿用已保存的值，解析不出数字时退回 10 秒（与上游一致），不会写进 NaN
        assert.equal(store.setCapitalMode(accountId, { leadSeconds: 20 }).leadSeconds, 20);
        assert.equal(store.setCapitalMode(accountId, { leadSeconds: 'abc' }).leadSeconds, 10);
        // 兼容上游旧字段名
        assert.equal(store.setCapitalMode(accountId, { secondsBeforeMature: 88 }).leadSeconds, 88);
        assert.equal(store.setCapitalMode(accountId, { dogId: -3 }).dogId, 0);
        assert.equal(store.setCapitalMode(accountId, { dogId: 'abc' }).dogId, 0);
        assert.equal(store.setCapitalMode(accountId, { selectedDogId: 605 }).dogId, 605);
        // 未提交的字段沿用已保存的值
        const kept = store.setCapitalMode(accountId, { enabled: false });
        assert.equal(kept.dogId, 605);
        assert.equal(kept.leadSeconds, 88);
        assert.equal(kept.enabled, false);

        // 落盘：重新读文件后仍然是最后一次保存的值
        store.setCapitalMode(accountId, { enabled: true, dogId: 602, leadSeconds: 45 });
        const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        assert.deepEqual(onDisk.accountConfigs?.[accountId]?.capitalMode,
            { enabled: true, dogId: 602, leadSeconds: 45 });
    }
    finally {
        store.setCapitalMode(accountId, previous);
    }
});

test('未启用资本模式时 getCapitalMode 不会读到脏值', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    assert.deepEqual(store.getCapitalMode('不存在的账号'), { enabled: false, dogId: 0, leadSeconds: 10 });
    if (accountId) {
        const mode = store.getCapitalMode(accountId);
        assert.equal(typeof mode.enabled, 'boolean');
        assert.equal(Number.isInteger(mode.dogId), true);
        assert.equal(Number.isInteger(mode.leadSeconds), true);
    }
});

// ==================== 二、务农流程挂钩 ====================

const modulePaths = {
    config: require.resolve('../dist/config/config'),
    store: require.resolve('../dist/models/store'),
    network: require.resolve('../dist/utils/network'),
    utils: require.resolve('../dist/utils/utils'),
    scheduler: require.resolve('../dist/services/scheduler'),
    automationLock: require.resolve('../dist/services/automation-lock'),
    stats: require.resolve('../dist/services/stats'),
    farmApi: require.resolve('../dist/services/farm/api'),
    landAnalysis: require.resolve('../dist/services/farm/land-analysis'),
    planting: require.resolve('../dist/services/farm/planting'),
    mall: require.resolve('../dist/services/mall'),
    capitalMode: require.resolve('../dist/services/capital-mode'),
    visitStrategy: require.resolve('../dist/services/friend/visit-strategy'),
    friendScheduler: require.resolve('../dist/services/friend/scheduler'),
};

function stubModule(pathname, exports) {
    require.cache[pathname] = { id: pathname, filename: pathname, loaded: true, exports };
}

const calls = { prepare: [], harvested: 0, harvest: 0, deployedLands: null };
const landFixture = [{ id: 1, unlocked: true, plant: { id: 101, phases: [{ phase: 6, begin_time: 1780000000 }] } }];
const analysisFixture = {
    harvestable: [1],
    needWater: [],
    needWeed: [],
    needBug: [],
    needInteractionCleanup: [],
    growing: [],
    empty: [],
    dead: [],
    unlockable: [],
    upgradable: [],
    harvestableInfo: [],
};

stubModule(modulePaths.config, { CONFIG: {} });
stubModule(modulePaths.store, {
    isAutomationOn: (name) => name !== 'land_upgrade',
    getAutomation: () => ({}),
    getFertilizerBuyOrganicCount: () => 0,
    getFertilizerBuyOrganicThresholdHours: () => 0,
    getFertilizerBuyNormalCount: () => 0,
    getFertilizerBuyNormalThresholdHours: () => 0,
    getFertilizerBuyCheckIntervalMinutes: () => 30,
});
stubModule(modulePaths.network, {
    getUserState: () => ({ gid: 123 }),
    networkEvents: { on: () => {}, off: () => {}, emit: () => {} },
});
stubModule(modulePaths.utils, {
    toNum: (value) => Number(value) || 0,
    log: () => {},
    logWarn: () => {},
    randomDelay: async () => {},
});
stubModule(modulePaths.scheduler, {
    createScheduler: () => ({ setTimeoutTask: () => {}, setIntervalTask: () => {}, clear: () => {}, clearAll: () => {} }),
});
stubModule(modulePaths.automationLock, { runExclusiveAutomationTask: async (_name, fn) => fn() });
stubModule(modulePaths.stats, { recordOperation: () => {} });
stubModule(modulePaths.farmApi, {
    getAllLands: async () => ({ lands: landFixture }),
    harvest: async () => {
        calls.harvest += 1;
        return {};
    },
    farming: async () => ({}),
    unlockLand: async () => ({}),
    upgradeLand: async () => ({}),
});
stubModule(modulePaths.landAnalysis, {
    analyzeLands: () => analysisFixture,
    getCleanableFarmSocialEventItemIds: () => [],
    getNormalFertilizerTargetsFromLands: () => [],
    resolveRemovableHarvestedLands: async () => ({ removable: [], growing: [] }),
    getLandTypeByLevel: () => 'normal',
    normalizeFertilizerLandTypes: (types) => types || [],
    filterLandIdsByTypes: (ids) => ids || [],
    ALL_FERTILIZER_LAND_TYPES: [],
});
stubModule(modulePaths.planting, {
    autoPlantEmptyLands: async () => ({ plantedLands: [] }),
    runFertilizerByConfig: async () => {},
});
stubModule(modulePaths.mall, { checkAndBuyFertilizerBoth: async () => {} });
stubModule(modulePaths.capitalMode, {
    prepareForFarmOperation: async (payload) => {
        calls.prepare.push(payload);
        calls.deployedLands = payload.lands;
        return true;
    },
    handleFarmHarvested: () => { calls.harvested += 1; },
});
stubModule(modulePaths.visitStrategy, { inFarmQuietHours: () => false });
stubModule(modulePaths.friendScheduler, { startFriendCheckLoop: () => {}, stopFriendCheckLoop: () => {} });

const farmScheduler = require('../dist/services/farm/scheduler');

test('务农前把土地与阶段的结论交给资本模式，收获后再通知它召回', async () => {
    calls.prepare.length = 0;
    calls.harvested = 0;
    calls.harvest = 0;
    calls.deployedLands = null;

    const result = await farmScheduler.runFarmOperation('all');
    assert.equal(calls.prepare.length, 1, '每次务农都只应通知一次资本模式');
    assert.equal(calls.prepare[0].opType, 'all');
    assert.equal(calls.prepare[0].analysis, analysisFixture, '资本模式拿到的是 analyzeLands 的结论，不必自己重算');
    assert.equal(calls.deployedLands, landFixture, '资本模式需要原始地块才能算成熟时间');
    assert.equal(calls.harvest, 1);
    assert.equal(calls.harvested, 1, '收获成功后应通知资本模式安排召回');
    assert.equal(result.hadWork, true);
});

test('单点务农也会经过资本模式（由服务内部按 opType 自行决定是否派出）', async () => {
    calls.prepare.length = 0;
    calls.harvested = 0;
    calls.harvest = 0;

    await farmScheduler.runFarmOperation('clear', 1);
    assert.equal(calls.prepare.length, 1);
    assert.equal(calls.prepare[0].opType, 'clear');
    assert.equal(calls.harvested, 0, '没有收获就不该通知召回');
});

// ==================== 三、worker 手动命令 ====================

test('worker 在手动上场/召回宠物前先交还资本模式的控制权', () => {
    const workerSource = fs.readFileSync(path.join(__dirname, '../dist/core/worker.js'), 'utf8');
    for (const caseName of ['deployDog', 'withdrawDog']) {
        const start = workerSource.indexOf(`case '${caseName}':`);
        assert.ok(start >= 0, `worker 应保留 ${caseName} 分支`);
        const block = workerSource.slice(start, workerSource.indexOf('break;', start));
        assert.match(block, /releaseForManualCommand\(\)/, `${caseName} 分支应在调用宠物服务前交还控制权`);
    }
});
