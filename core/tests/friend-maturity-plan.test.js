const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_WAKE_INTERVAL_MS,
    DEFAULT_RECHECK_AFTER_DUE_MS,
    DEFAULT_BUSY_RETRY_MS,
    DEFAULT_CLAIM_LIMIT,
    normalizeAbsoluteTime,
    findNearestFutureMaturity,
    observeFriendSummary,
    observeFriendSummaries,
    observeFriendLands,
    claimDueFriends,
    getNextStealDelayMs,
    planStealWake,
    resetFriendMaturityPlans,
} = require('../dist/services/friend/maturity-plan');

const NOW_SEC = 1780000000;
const NOW_MS = NOW_SEC * 1000;

test.beforeEach(() => {
    resetFriendMaturityPlans();
});

// ---- 时间归一化 ----

test('倒计时秒按「从现在起」换算，绝对时间戳原样保留', () => {
    assert.equal(normalizeAbsoluteTime(0, NOW_SEC), 0);
    assert.equal(normalizeAbsoluteTime(undefined, NOW_SEC), 0);
    assert.equal(normalizeAbsoluteTime(1800, NOW_SEC), NOW_SEC + 1800);
    assert.equal(normalizeAbsoluteTime(NOW_SEC + 600, NOW_SEC), NOW_SEC + 600);
    // 毫秒时间戳先被 toTimeSec 压成秒，再按绝对时间处理
    assert.equal(normalizeAbsoluteTime((NOW_SEC + 600) * 1000, NOW_SEC), NOW_SEC + 600);
});

test('地块里只认未来成熟阶段，取最近的一个', () => {
    const lands = [
        { plant: { phases: [{ phase: 2, begin_time: NOW_SEC - 100 }] } },
        { plant: { phases: [{ phase: 5, begin_time: NOW_SEC + 50 }, { phase: 6, begin_time: NOW_SEC + 900 }] } },
        { plant: { phases: [{ phase: 6, phase_id: 19, begin_time: (NOW_SEC + 300) * 1000 }] } },
        // 已经成熟（过去时间）的地块不该被当成「未来成熟」
        { plant: { phases: [{ phase: 6, begin_time: NOW_SEC - 10 }] } },
    ];
    assert.equal(findNearestFutureMaturity(lands, NOW_SEC), NOW_SEC + 300);
    assert.equal(findNearestFutureMaturity([], NOW_SEC), 0);
    assert.equal(findNearestFutureMaturity(null, NOW_SEC), 0);
});

// ---- 观察 ----

test('好友列表摘要写成熟时间，名字取备注优先', () => {
    const plan = observeFriendSummary({ gid: 11, name: '小明', remark: '小明的号', plant: { ripe_time_sec: 120 } },
        { nowMs: NOW_MS, nowSec: NOW_SEC });
    assert.equal(plan.gid, 11);
    assert.equal(plan.name, '小明的号');
    assert.equal(plan.matureAt, NOW_SEC + 120);
    assert.equal(plan.source, 'summary');
    assert.equal(plan.summaryObservedAt, NOW_MS);
});

test('列表摘要给不出未来时间时保留已有成熟时间，不用列表回包冲掉', () => {
    observeFriendLands(11, [{ plant: { phases: [{ phase: 6, begin_time: NOW_SEC + 900 }] } }],
        { nowMs: NOW_MS, nowSec: NOW_SEC, name: '小明' });
    // 列表回包 ripe_time_sec = 0（没种 / 协议没填）不应抹掉进农场拿到的准确时间
    const plan = observeFriendSummary({ gid: 11, name: '小明', plant: {} }, { nowMs: NOW_MS + 1000, nowSec: NOW_SEC });
    assert.equal(plan.matureAt, NOW_SEC + 900);
    assert.equal(plan.source, 'lands');
    assert.equal(plan.summaryObservedAt, NOW_MS + 1000);
    // 反过来，列表给出更晚的未来时间时按新值走
    observeFriendSummary({ gid: 11, plant: { ripe_time_sec: 30 } }, { nowSec: NOW_SEC });
    assert.equal(claimDueFriends({ nowSec: NOW_SEC + 30 })[0].gid, 11);
});

test('没有 gid 的好友不记录', () => {
    assert.equal(observeFriendSummary({ plant: { ripe_time_sec: 60 } }, { nowSec: NOW_SEC }), null);
    assert.equal(observeFriendLands(0, [], { nowSec: NOW_SEC }), null);
});

test('批量记录好友摘要时跳过自己和黑名单', () => {
    const friends = [
        { gid: 1, name: 'me', plant: { ripe_time_sec: 60 } },
        { gid: 2, name: 'bl', plant: { ripe_time_sec: 60 } },
        { gid: 3, name: 'ok', plant: { ripe_time_sec: 60 } },
    ];
    const count = observeFriendSummaries(friends, {
        myGid: 1,
        blacklist: new Set([2]),
        nowMs: NOW_MS,
        nowSec: NOW_SEC,
    });
    assert.equal(count, 1);
    const due = claimDueFriends({ nowSec: NOW_SEC + 60 });
    assert.deepEqual(due, [{ gid: 3, name: 'ok' }]);
});

test('进农场拿到的地块成熟时间覆盖列表摘要（更准）', () => {
    observeFriendSummary({ gid: 7, name: 'f7', plant: { ripe_time_sec: 3600 } }, { nowSec: NOW_SEC });
    observeFriendLands(7, [{ plant: { phases: [{ phase: 6, begin_time: NOW_SEC + 300 }] } }],
        { nowMs: NOW_MS, nowSec: NOW_SEC, source: 'enter' });
    assert.deepEqual(claimDueFriends({ nowSec: NOW_SEC + 300 }), [{ gid: 7, name: 'f7' }]);
});

test('部分地块回包只把成熟时间提前，不会清掉已有的未来时间', () => {
    observeFriendLands(9, [{ plant: { phases: [{ phase: 6, begin_time: NOW_SEC + 600 }] } }], { nowSec: NOW_SEC });
    // lands_notify 只带一小块地且没有成熟阶段 → 保留原值
    observeFriendLands(9, [{ plant: { phases: [] } }], { nowMs: NOW_MS, nowSec: NOW_SEC, source: 'lands_notify' });
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC }), 600 * 1000);
    // 带更早的成熟时间 → 取更早的
    observeFriendLands(9, [{ plant: { phases: [{ phase: 6, begin_time: NOW_SEC + 120 }] } }],
        { nowMs: NOW_MS, nowSec: NOW_SEC, source: 'lands_notify' });
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC }), 120 * 1000);
    // 完整回包（source 不是部分来源）才会真的替换
    observeFriendLands(9, [{ plant: { phases: [] } }], { nowMs: NOW_MS, nowSec: NOW_SEC, source: 'enter' });
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC }), DEFAULT_WAKE_INTERVAL_MS);
});

// ---- 领取到点好友 ----

test('到点好友按成熟时间排序领取，并顺延复核后再领不到', () => {
    observeFriendSummary({ gid: 5, name: 'late', plant: { ripe_time_sec: 100 } }, { nowSec: NOW_SEC });
    observeFriendSummary({ gid: 6, name: 'early', plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    observeFriendSummary({ gid: 7, name: 'future', plant: { ripe_time_sec: 9000 } }, { nowSec: NOW_SEC });

    const due = claimDueFriends({ nowSec: NOW_SEC + 200 });
    assert.deepEqual(due, [{ gid: 6, name: 'early' }, { gid: 5, name: 'late' }]);
    // 领走之后顺延默认复核间隔，不会在同一时刻被反复拉起
    assert.deepEqual(claimDueFriends({ nowSec: NOW_SEC + 200 }), []);
    const afterRecheck = claimDueFriends({ nowSec: NOW_SEC + 200 + DEFAULT_RECHECK_AFTER_DUE_MS / 1000 });
    assert.deepEqual(afterRecheck.map(item => item.gid).sort(), [5, 6]);
});

test('领取数量受 limit 限制，越界时回落到默认值', () => {
    for (let gid = 1; gid <= 40; gid += 1) {
        observeFriendSummary({ gid, name: `f${gid}`, plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    }
    assert.equal(claimDueFriends({ nowSec: NOW_SEC + 60 }).length, DEFAULT_CLAIM_LIMIT);
    resetFriendMaturityPlans();
    for (let gid = 1; gid <= 40; gid += 1) {
        observeFriendSummary({ gid, name: `f${gid}`, plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    }
    assert.equal(claimDueFriends({ nowSec: NOW_SEC + 60, limit: 3 }).length, 3);
    assert.equal(claimDueFriends({ nowSec: NOW_SEC + 60, limit: 999 }).length, 30);
});

// ---- 唤醒延迟 ----

test('唤醒延迟取最近的成熟时间，没有成熟时间时回落到兜底间隔', () => {
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC }), DEFAULT_WAKE_INTERVAL_MS);
    observeFriendSummary({ gid: 1, plant: { ripe_time_sec: 300 } }, { nowSec: NOW_SEC });
    observeFriendSummary({ gid: 2, plant: { ripe_time_sec: 90 } }, { nowSec: NOW_SEC });
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC }), 90 * 1000);
    // 已经到点（或过了）时最少睡 1 秒，不能变成忙等
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC + 500 }), 1000);
    // 超过兜底间隔就按兜底走
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC, fallbackMs: 60 * 1000 }), 60 * 1000);
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC, fallbackMs: 5 }), 60 * 1000);
});

// ---- 唤醒决策 ----

test('总开关或偷菜开关关掉时只重排，不发请求', () => {
    observeFriendSummary({ gid: 1, name: 'f1', plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    const decision = planStealWake({ enabled: false, nowMs: NOW_MS, nowSec: NOW_SEC + 60 });
    assert.equal(decision.claim, false);
    assert.deepEqual(decision.targets, []);
    assert.equal(decision.delayMs, DEFAULT_BUSY_RETRY_MS);
    // 已经过期的成熟时间不该让关掉偷菜之后变成 1 秒一次的忙等
    assert.equal(planStealWake({ enabled: true, nowMs: NOW_MS, nowSec: NOW_SEC + 60 }).claim, true);
});

test('免打扰时段不领好友，且至少睡过一个重试间隔', () => {
    observeFriendSummary({ gid: 1, name: 'f1', plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    const decision = planStealWake({ enabled: true, quietHours: true, nowMs: NOW_MS, nowSec: NOW_SEC + 60 });
    assert.equal(decision.claim, false);
    assert.deepEqual(decision.targets, []);
    assert.ok(decision.delayMs >= DEFAULT_BUSY_RETRY_MS);
    // 免打扰不领好友：到点好友仍在计划里等下一个非免打扰的唤醒
    assert.deepEqual(claimDueFriends({ nowSec: NOW_SEC + 60 }), [{ gid: 1, name: 'f1' }]);
});

test('巡查正在跑时不重复发起，只等一个重试间隔', () => {
    observeFriendSummary({ gid: 1, name: 'f1', plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    const decision = planStealWake({ enabled: true, busy: true, nowMs: NOW_MS, nowSec: NOW_SEC + 60 });
    assert.equal(decision.claim, false);
    assert.equal(decision.delayMs, DEFAULT_BUSY_RETRY_MS);
    assert.deepEqual(claimDueFriends({ nowSec: NOW_SEC + 60 }), [{ gid: 1, name: 'f1' }]);
});

test('到点才 claim，领取后给出复核时间的延迟', () => {
    observeFriendSummary({ gid: 1, name: 'f1', plant: { ripe_time_sec: 600 } }, { nowSec: NOW_SEC });
    const waiting = planStealWake({ enabled: true, nowMs: NOW_MS, nowSec: NOW_SEC });
    assert.equal(waiting.claim, false);
    assert.equal(waiting.delayMs, 600 * 1000);

    const fired = planStealWake({ enabled: true, nowMs: NOW_MS, nowSec: NOW_SEC + 600 });
    assert.equal(fired.claim, true);
    assert.deepEqual(fired.targets, [{ gid: 1, name: 'f1' }]);
    assert.equal(fired.delayMs, DEFAULT_RECHECK_AFTER_DUE_MS);
});

test('列表摘要没给名字时用 GID 兜底', () => {
    observeFriendSummary({ gid: 42, plant: { ripe_time_sec: 5 } }, { nowSec: NOW_SEC });
    assert.deepEqual(claimDueFriends({ nowSec: NOW_SEC + 5 }), [{ gid: 42, name: 'GID:42' }]);
});

test('停掉巡查时清空计划表', () => {
    observeFriendSummary({ gid: 1, plant: { ripe_time_sec: 10 } }, { nowSec: NOW_SEC });
    resetFriendMaturityPlans();
    assert.deepEqual(claimDueFriends({ nowSec: NOW_SEC + 100 }), []);
    assert.equal(getNextStealDelayMs({ nowMs: NOW_MS, nowSec: NOW_SEC }), DEFAULT_WAKE_INTERVAL_MS);
});
