const assert = require('node:assert/strict');
const test = require('node:test');

const {
    GOLDEN_BUG_ITEM_ID,
    GOLDEN_BUG_DAILY_LIMIT,
    MIN_RUN_INTERVAL_MS,
    MAX_ROUND_LIMIT,
    createGoldenBugPlacement,
    getGoldenBugCount,
} = require('../dist/services/golden-bug');

const NOW = 1780000000000;

/**
 * 注入式替身：把巡逻/背包/投放都换成可观测的假实现，
 * 用它们的调用记录断言「投放几只、投给谁、有没有落盘」。
 */
function createHarness(overrides = {}) {
    const calls = { placeOnFriend: [], setPlacedToday: [], logs: [], warns: [] };
    let clockMs = overrides.nowMs || NOW;
    let placedToday = overrides.placedToday || 0;
    let running = 0;
    let maxConcurrent = 0;

    const placement = createGoldenBugPlacement({
        isEnabled: () => overrides.enabled !== false,
        isQuietHours: () => overrides.quietHours === true,
        getSelfGid: () => (overrides.selfGid === undefined ? 9001 : overrides.selfGid),
        listFriends: async () => (overrides.friends || []),
        getBlacklist: () => (overrides.blacklist || []),
        getInventoryCount: async () => (overrides.inventory === undefined ? 50 : overrides.inventory),
        getKeepCount: () => (overrides.keepCount || 0),
        getRoundLimit: () => (overrides.roundLimit === undefined ? 24 : overrides.roundLimit),
        placeOnFriend: async (friendGid, count) => {
            running += 1;
            maxConcurrent = Math.max(maxConcurrent, running);
            calls.placeOnFriend.push({ friendGid, count });
            try {
                if (overrides.placeError) throw new Error(overrides.placeError);
                if (overrides.placeDelay) await overrides.placeDelay();
                const placed = typeof overrides.placedFor === 'function'
                    ? overrides.placedFor(friendGid, count)
                    : Math.min(count, overrides.placedPerFriend === undefined ? count : overrides.placedPerFriend);
                return { placed, ownerName: `好友${friendGid}` };
            }
            finally {
                running -= 1;
            }
        },
        getPlacedToday: () => placedToday,
        setPlacedToday: (count) => {
            placedToday = count;
            calls.setPlacedToday.push(count);
        },
        log: (tag, message, extra) => calls.logs.push({ tag, message, extra }),
        logWarn: (tag, message, extra) => calls.warns.push({ tag, message, extra }),
        now: () => clockMs,
        minRunIntervalMs: overrides.minRunIntervalMs,
        dailyLimit: overrides.dailyLimit,
    });

    return {
        calls,
        get placedToday() { return placedToday; },
        get maxConcurrent() { return maxConcurrent; },
        setClock: (value) => { clockMs = value; },
        run: (options) => placement(options),
    };
}

function friends(...levels) {
    return levels.map((level, index) => ({ gid: 1000 + index, name: `好友${index}`, level }));
}

// ==================== 库存统计 ====================

test('getGoldenBugCount 合并同一物品的多条堆叠，忽略其他物品与字符串 id', () => {
    assert.equal(getGoldenBugCount([
        { id: GOLDEN_BUG_ITEM_ID, count: 3 },
        { id: String(GOLDEN_BUG_ITEM_ID), count: '2' },
        { item_id: GOLDEN_BUG_ITEM_ID, count: 5 },
        { id: 5003, count: 99 },
        { id: GOLDEN_BUG_ITEM_ID, count: -4 },
    ]), 10);
    assert.equal(getGoldenBugCount(null), 0);
});

// ==================== 开关与节流 ====================

test('开关关闭时不投放', async () => {
    const h = createHarness({ enabled: false, friends: friends(10) });
    assert.equal(await h.run(), null);
    assert.equal(h.calls.placeOnFriend.length, 0);
});

test('安静时段不投放', async () => {
    const h = createHarness({ quietHours: true, friends: friends(10) });
    assert.equal(await h.run(), null);
    assert.equal(h.calls.placeOnFriend.length, 0);
});

test('自己 GID 取不到时直接放弃', async () => {
    const h = createHarness({ selfGid: 0, friends: friends(10) });
    assert.equal(await h.run(), null);
    assert.equal(h.calls.placeOnFriend.length, 0);
});

test('两次执行间隔小于最小间隔时跳过，force 可绕过', async () => {
    const h = createHarness({ friends: friends(10), inventory: 5, roundLimit: 2 });
    await h.run();
    assert.equal(h.calls.placeOnFriend.length, 1);

    // 仍在节流窗口内
    h.setClock(NOW + MIN_RUN_INTERVAL_MS - 1);
    assert.equal(await h.run(), null);
    assert.equal(h.calls.placeOnFriend.length, 1);

    // force 跳过节流
    await h.run({ force: true });
    assert.equal(h.calls.placeOnFriend.length, 2);
});

// ==================== 额度计算 ====================

test('剩余额度取「库存-保留」「每日剩余」「单轮上限」三者最小值', async () => {
    const h = createHarness({ friends: friends(10), inventory: 50, keepCount: 30, roundLimit: 5 });
    const result = await h.run();
    assert.equal(result.placed, 5);
    assert.equal(h.calls.placeOnFriend[0].count, 5);
});

test('每日额度消耗完后不再投放', async () => {
    const h = createHarness({ friends: friends(10), inventory: 50, placedToday: GOLDEN_BUG_DAILY_LIMIT });
    const result = await h.run();
    assert.deepEqual(result, { placed: 0, inventory: 50, dailyRemaining: 0 });
    assert.equal(h.calls.placeOnFriend.length, 0);
});

test('每日剩余额度小于单轮上限时按每日剩余投放', async () => {
    const h = createHarness({ friends: friends(10), inventory: 50, placedToday: 98, roundLimit: 24 });
    const result = await h.run();
    assert.equal(result.placed, 2);
    assert.equal(h.calls.placeOnFriend[0].count, 2);
    assert.equal(h.placedToday, 100);
});

test('库存不足保留数量时整轮跳过', async () => {
    const h = createHarness({ friends: friends(10), inventory: 3, keepCount: 3 });
    const result = await h.run();
    assert.equal(result.placed, 0);
    assert.equal(h.calls.placeOnFriend.length, 0);
});

// ==================== 好友筛选与循环 ====================

test('按等级降序投放，跳过自己与黑名单好友', async () => {
    const h = createHarness({
        friends: [
            { gid: 9001, name: '自己', level: 99 },
            { gid: 1001, name: '低', level: 1 },
            { gid: 1002, name: '高', level: 50 },
            { gid: 1003, name: '被拉黑', level: 40 },
        ],
        blacklist: [1003],
        inventory: 10,
        roundLimit: 1,
    });
    await h.run();
    assert.deepEqual(h.calls.placeOnFriend.map(call => call.friendGid), [1002]);
});

test('剩余额度用完后不再进入下一位好友农场', async () => {
    const h = createHarness({ friends: friends(5, 4, 3), inventory: 10, roundLimit: 2 });
    const result = await h.run();
    assert.equal(result.placed, 2);
    assert.equal(h.calls.placeOnFriend.length, 1);
});

test('单个好友投放失败只记警告，继续下一位', async () => {
    let first = true;
    const h = createHarness({
        friends: friends(5, 4),
        inventory: 10,
        roundLimit: 3,
        placedFor: () => {
            if (first) {
                first = false;
                throw new Error('进入农场失败');
            }
            return 1;
        },
    });
    const result = await h.run();
    assert.equal(result.placed, 1);
    assert.equal(h.calls.placeOnFriend.length, 2);
    assert.equal(h.calls.warns.length, 1);
});

test('好友没有可放置地块（返回 0）时继续下一位且不计数', async () => {
    const h = createHarness({ friends: friends(5, 4), inventory: 10, roundLimit: 3, placedPerFriend: 0 });
    const result = await h.run();
    assert.equal(result.placed, 0);
    assert.equal(h.calls.placeOnFriend.length, 2);
    assert.deepEqual(h.calls.setPlacedToday, []);
    assert.equal(h.calls.logs.length, 0);
});

test('累计投放数量落盘，跨好友累加', async () => {
    const h = createHarness({ friends: friends(5, 4, 3), inventory: 10, roundLimit: 6, placedPerFriend: 2 });
    const result = await h.run();
    assert.equal(result.placed, 6);
    assert.deepEqual(h.calls.setPlacedToday, [2, 4, 6]);
    assert.equal(h.placedToday, 6);
});

// ==================== 并发与日志 ====================

test('投放进行中时并发调用直接被拒', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = createHarness({ friends: friends(5), inventory: 10, roundLimit: 1, placeDelay: () => gate });
    const first = h.run();
    assert.equal(await h.run(), null);
    release();
    await first;
    assert.equal(h.maxConcurrent, 1);
});

test('投放到数量后记录经验日志', async () => {
    const h = createHarness({ friends: friends(5), inventory: 10, roundLimit: 2, placedPerFriend: 2 });
    await h.run();
    assert.equal(h.calls.logs.length, 1);
    assert.match(h.calls.logs[0].message, /黄金虫投放完成 2 只/);
    assert.equal(h.calls.logs[0].extra.exp, 60);
});

test('单轮上限被夹到 1-100', async () => {
    const high = createHarness({ friends: friends(5), inventory: 500, roundLimit: 999 });
    await high.run();
    assert.equal(high.calls.placeOnFriend[0].count, MAX_ROUND_LIMIT);

    const low = createHarness({ friends: friends(5), inventory: 500, roundLimit: -5 });
    await low.run();
    assert.equal(low.calls.placeOnFriend[0].count, 1);
});
