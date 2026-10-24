const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_ATTEMPT_INTERVAL_MS,
    DEFAULT_SAFETY_WITHDRAW_MS,
    DEFAULT_HARVEST_WITHDRAW_MS,
    createCapitalMode,
    toInt,
} = require('../dist/services/capital-mode');

const NOW_SEC = 1780000000;

/** 最小可用的调度器替身：记录任务名/延迟，并允许手动触发或检查是否被清掉 */
function createFakeScheduler() {
    const tasks = new Map();
    const delays = new Map();
    return {
        tasks,
        delays,
        setTimeoutTask(name, delayMs, fn) {
            tasks.set(name, fn);
            delays.set(name, delayMs);
            return { name, delayMs };
        },
        clear(name) {
            const existed = tasks.delete(name);
            delays.delete(name);
            return existed;
        },
    };
}

function createHarness(overrides = {}) {
    const calls = { deploy: [], withdraw: 0, logs: [] };
    const scheduler = createFakeScheduler();
    let config = overrides.config || { enabled: true, dogId: 501, leadSeconds: 30 };
    let petInfo = overrides.petInfo || { activeDogId: 0, dogs: [{ id: 501, name: '旺财', owned: true }] };
    let clockMs = overrides.nowMs || NOW_SEC * 1000;

    const instance = createCapitalMode({
        getCapitalMode: () => config,
        deployDog: async (dogId) => {
            calls.deploy.push(dogId);
            if (overrides.deployError) throw new Error(overrides.deployError);
            petInfo = { ...petInfo, activeDogId: dogId };
            return petInfo;
        },
        getPetInfo: async () => {
            if (overrides.petInfoError) throw new Error(overrides.petInfoError);
            return petInfo;
        },
        withdrawDog: async () => {
            calls.withdraw += 1;
            if (overrides.withdrawError) throw new Error(overrides.withdrawError);
            petInfo = { ...petInfo, activeDogId: 0 };
            return petInfo;
        },
        getServerTimeSec: () => overrides.nowSec || NOW_SEC,
        now: () => clockMs,
        scheduler,
        log: (tag, message, extra) => calls.logs.push({ tag, message, extra }),
        attemptIntervalMs: overrides.attemptIntervalMs,
        safetyWithdrawMs: overrides.safetyWithdrawMs,
        harvestWithdrawMs: overrides.harvestWithdrawMs,
    });

    return {
        instance,
        calls,
        scheduler,
        setConfig: (next) => { config = next; },
        setPetInfo: (next) => { petInfo = next; },
        getPetInfo: () => petInfo,
        advanceMs: (delta) => { clockMs += delta; },
    };
}

const LANDS_MATURE_SOON = [{ plant: { phases: [{ phase: 5, begin_time: NOW_SEC }, { phase: 6, begin_time: NOW_SEC + 20 }] } }];
const LANDS_MATURE_LATER = [{ plant: { phases: [{ phase: 6, begin_time: NOW_SEC + 3600 }] } }];
const ANALYSIS_SOON = { harvestable: [] };

test('toInt 只接受真整数', () => {
    assert.equal(toInt(6), 6);
    assert.equal(toInt('6'), 6);
    assert.equal(toInt(6.9), 6);
    assert.equal(toInt(null), 0);
    assert.equal(toInt(''), 0);
    assert.equal(toInt(undefined), 0);
    assert.equal(toInt('abc'), 0);
});

// ---- 成熟时间计算 ----

test('已有可收获作物时视为马上要收获（0 秒）', () => {
    const { instance } = createHarness();
    assert.equal(instance.findNearestMatureSeconds([], { harvestable: [1, 2] }), 0);
});

test('取最近一块未来成熟的地块，已经成熟的忽略', () => {
    const { instance } = createHarness();
    const lands = [
        { plant: { phases: [{ phase: 6, begin_time: NOW_SEC - 10 }] } },
        { plant: { phases: [{ phase: 6, begin_time: NOW_SEC + 900 }] } },
        { plant: { phases: [{ phase: 5, begin_time: NOW_SEC + 60 }, { phase: 6, begin_time: NOW_SEC + 120 }] } },
    ];
    assert.equal(instance.findNearestMatureSeconds(lands, { harvestable: [] }), 120);
});

test('没有任何未来成熟时间时返回 null', () => {
    const { instance } = createHarness();
    assert.equal(instance.findNearestMatureSeconds([], { harvestable: [] }), null);
    assert.equal(instance.findNearestMatureSeconds(null, null), null);
    assert.equal(instance.findNearestMatureSeconds([{ plant: { phases: [{ phase: 6, begin_time: NOW_SEC - 5 }] } }], {}), null);
});

// ---- 派出前的门槛 ----

test('只有 all/harvest 会触发自动派出', async () => {
    const harness = createHarness();
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'clear' }), false);
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'plant' }), false);
    assert.equal(harness.calls.deploy.length, 0);
});

test('未启用或没选宠物时什么都不做', async () => {
    const disabled = createHarness({ config: { enabled: false, dogId: 501, leadSeconds: 30 } });
    assert.equal(await disabled.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);

    const noDog = createHarness({ config: { enabled: true, dogId: 0, leadSeconds: 30 } });
    assert.equal(await noDog.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    assert.equal(noDog.calls.deploy.length, 0);
});

test('成熟时间还在提前量之外时不派出', async () => {
    const harness = createHarness({ config: { enabled: true, dogId: 501, leadSeconds: 30 } });
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_LATER, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    assert.equal(harness.calls.deploy.length, 0);
});

// ---- 派出 ----

test('成熟前按配置派出守护宠物并挂上兜底召回', async () => {
    const harness = createHarness();
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), true);
    assert.deepEqual(harness.calls.deploy, [501]);
    assert.equal(harness.instance._state.phase, 'deployed');
    assert.equal(harness.instance._state.autoDogId, 501);
    assert.equal(harness.scheduler.delays.get('withdraw_safety'), DEFAULT_SAFETY_WITHDRAW_MS);
});

test('已有宠物在场上时不抢位置', async () => {
    const harness = createHarness({ petInfo: { activeDogId: 777, dogs: [{ id: 501, name: '旺财', owned: true }] } });
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    assert.equal(harness.calls.deploy.length, 0);
    assert.equal(harness.instance._state.phase, 'idle');
});

test('宠物未获得时不派出', async () => {
    const harness = createHarness({ petInfo: { activeDogId: 0, dogs: [{ id: 501, name: '旺财', owned: false }] } });
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    assert.equal(harness.calls.deploy.length, 0);
    assert.equal(harness.instance._state.phase, 'idle');
});

test('派出失败时回到 idle，不会留下半吊子状态', async () => {
    const harness = createHarness({ deployError: '网络错误' });
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    assert.equal(harness.instance._state.phase, 'idle');
    assert.equal(harness.instance._state.autoDogId, 0);
});

test('5 秒内不重复尝试，避免每轮务农都去问一次宠物信息', async () => {
    const harness = createHarness({ config: { enabled: true, dogId: 999, leadSeconds: 30 } });
    // 第一次：宠物不在图鉴里，触发尝试并失败
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    // 立刻改成一个已获得的宠物，但节流窗口内仍然不尝试
    harness.setConfig({ enabled: true, dogId: 501, leadSeconds: 30 });
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), false);
    assert.equal(harness.calls.deploy.length, 0);
    // 过了节流窗口后恢复正常
    harness.advanceMs(DEFAULT_ATTEMPT_INTERVAL_MS + 1);
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), true);
    assert.deepEqual(harness.calls.deploy, [501]);
});

// ---- 召回 ----

test('收获完成后延迟召回自动派出的宠物', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    harness.instance.handleFarmHarvested();
    assert.equal(harness.scheduler.delays.get('withdraw_after_harvest'), DEFAULT_HARVEST_WITHDRAW_MS);

    await harness.scheduler.tasks.get('withdraw_after_harvest')();
    assert.equal(harness.calls.withdraw, 1);
    assert.equal(harness.instance._state.autoDogId, 0);
    assert.equal(harness.instance._state.phase, 'idle');
});

test('没有自动派出过时收获不触发召回', async () => {
    const harness = createHarness();
    harness.instance.handleFarmHarvested();
    assert.equal(harness.scheduler.tasks.has('withdraw_after_harvest'), false);
});

test('场上已经不是我们的宠物时收获召回是空操作', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    harness.setPetInfo({ activeDogId: 777, dogs: [{ id: 501, name: '旺财', owned: true }] });
    harness.instance.handleFarmHarvested();
    await harness.scheduler.tasks.get('withdraw_after_harvest')();
    assert.equal(harness.calls.withdraw, 0);
    assert.equal(harness.instance._state.autoDogId, 0);
});

test('兜底召回任务到点后收回宠物', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    await harness.scheduler.tasks.get('withdraw_safety')();
    assert.equal(harness.calls.withdraw, 1);
    assert.equal(harness.instance._state.phase, 'idle');
});

test('兜底召回失败也要清掉自动管理状态', async () => {
    const harness = createHarness({ withdrawError: '超时' });
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    await harness.scheduler.tasks.get('withdraw_safety')();
    assert.equal(harness.instance._state.autoDogId, 0);
    assert.equal(harness.instance._state.phase, 'idle');
    assert.equal(harness.calls.logs.some(entry => entry.message.includes('安全召回失败')), true);
});

// ---- 配置变更 ----

test('关掉开关时收回自动派出的宠物', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    await harness.instance.reconcileConfigChange({ enabled: true, dogId: 501 }, { enabled: false, dogId: 501 });
    assert.equal(harness.calls.withdraw, 1);
    assert.equal(harness.instance._state.autoDogId, 0);
});

test('换成别的宠物时收回原来的宠物', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    await harness.instance.reconcileConfigChange({ enabled: true, dogId: 501 }, { enabled: true, dogId: 502 });
    assert.equal(harness.calls.withdraw, 1);
});

test('配置没变（还是同一只宠物）时保持不动', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    await harness.instance.reconcileConfigChange({ enabled: true, dogId: 501 }, { enabled: true, dogId: 501 });
    assert.equal(harness.calls.withdraw, 0);
    assert.equal(harness.instance._state.autoDogId, 501);
});

test('没有自动派出过时配置变更不碰用户的宠物', async () => {
    const harness = createHarness({ petInfo: { activeDogId: 777, dogs: [{ id: 501, name: '旺财', owned: true }] } });
    await harness.instance.reconcileConfigChange({ enabled: true, dogId: 501 }, { enabled: false, dogId: 0 });
    assert.equal(harness.calls.withdraw, 0);
});

// ---- 手动命令 ----

test('手动上场/召回会先交还控制权，收获事件不再召回', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    harness.instance.releaseForManualCommand();
    assert.equal(harness.instance._state.autoDogId, 0);
    assert.equal(harness.instance._state.phase, 'idle');
    assert.equal(harness.scheduler.tasks.has('withdraw_safety'), false);

    harness.instance.handleFarmHarvested();
    assert.equal(harness.scheduler.tasks.has('withdraw_after_harvest'), false);
});

test('交还控制权后还能重新自动派出', async () => {
    const harness = createHarness();
    await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' });
    // 用户手动召回：控制权交还，宠物离开场上
    harness.instance.releaseForManualCommand();
    harness.setPetInfo({ activeDogId: 0, dogs: [{ id: 501, name: '旺财', owned: true }] });
    harness.advanceMs(DEFAULT_ATTEMPT_INTERVAL_MS + 1);
    assert.equal(await harness.instance.prepareForFarmOperation({ lands: LANDS_MATURE_SOON, analysis: ANALYSIS_SOON, opType: 'all' }), true);
    assert.deepEqual(harness.calls.deploy, [501, 501]);
});
