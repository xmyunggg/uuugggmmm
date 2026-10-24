const assert = require('node:assert/strict');
const test = require('node:test');

const {
    FIREWORK_ITEM_IDS,
    isFireworkItemId,
    isFireworkError,
    createFireworkUse,
} = require('../dist/services/firework-use');

const NOW = 1780000000;

function harness({ events = [], place, ignite } = {}) {
    const calls = [];
    const useFirework = createFireworkUse({
        now: () => NOW,
        getFarmSocialEvents: async () => {
            calls.push('events');
            return events;
        },
        place: async (itemId, uid) => {
            calls.push(`place:${itemId}:${uid}`);
            if (place) return place(itemId, uid);
            return { used_items: [{ id: itemId, count: 1 }], items: [] };
        },
        ignite: async (itemId) => {
            calls.push(`ignite:${itemId}`);
            if (ignite) return ignite(itemId);
            return {};
        },
    });
    return { useFirework, calls };
}

const event = (overrides = {}) => ({ item_id: 6001, phase: 0, ...overrides });

test('烟花道具 ID 只认 6001 与 6002', () => {
    assert.deepEqual([...FIREWORK_ITEM_IDS].sort(), [6001, 6002]);
    assert.equal(isFireworkItemId(6001), true);
    assert.equal(isFireworkItemId('6002'), true);
    assert.equal(isFireworkItemId(5005), false, '青蛙使坏瓶不是烟花');
    assert.equal(isFireworkItemId(5001), false, '天气采集瓶不是烟花');
    assert.equal(isFireworkItemId(6003), false);
    assert.equal(isFireworkItemId(undefined), false);
});

test('每次只能燃放一枚', async () => {
    const { useFirework, calls } = harness();
    await assert.rejects(() => useFirework(6001, 2), (error) => {
        assert.equal(error.code, 'FIREWORK_INVALID_COUNT');
        assert.match(error.message, /每次只能燃放一枚/);
        return true;
    });
    assert.deepEqual(calls, [], '数量非法时不发任何请求');
});

test('非烟花道具不能走烟花流程', async () => {
    const { useFirework, calls } = harness();
    await assert.rejects(() => useFirework(5005, 1), /不是烟花/);
    assert.deepEqual(calls, []);
});

test('农场里没有烟花时先放置再点燃', async () => {
    const { useFirework, calls } = harness();
    const result = await useFirework(6001, 1, 77);
    assert.deepEqual(calls, ['events', 'place:6001:77', 'ignite:6001']);
    assert.equal(result.firework, true);
    assert.equal(result.resumed, false);
    assert.deepEqual(result.used_items, [{ id: 6001, count: 1 }]);
});

test('已放置未点燃时只补点燃，不再消耗道具', async () => {
    const { useFirework, calls } = harness({ events: [event({ phase: 0 })] });
    const result = await useFirework(6001, 1, 77);
    assert.deepEqual(calls, ['events', 'ignite:6001'], '不重复放桶');
    assert.equal(result.resumed, true);
    assert.deepEqual(result.used_items, []);
});

test('协议里没有 phase 字段时按已放置处理，避免重复消耗', async () => {
    // 本仓库 proto 的 FarmSocialEvent 只声明 item_id/visitor_gid/timestamp，
    // phase 缺失时按 0 处理（已放置未点燃），宁可少放也不重复消耗道具。
    const { useFirework, calls } = harness({ events: [{ item_id: '6002', visitor_gid: 9, timestamp: 123 }] });
    const result = await useFirework(6002, 1);
    assert.deepEqual(calls, ['events', 'ignite:6002'], '字符串形式的 item_id 也要能匹配');
    assert.equal(result.resumed, true);
});

test('不同烟花道具各自判断，互不影响', async () => {
    const { useFirework, calls } = harness({ events: [event({ item_id: 6001, phase: 0 })] });
    const result = await useFirework(6002, 1);
    assert.deepEqual(calls, ['events', 'place:6002:0', 'ignite:6002'], '6001 的桶不挡 6002');
    assert.equal(result.resumed, false);
});

test('正在燃放时直接拒绝，不发请求', async () => {
    const { useFirework, calls } = harness({ events: [event({ phase: 2, state_until: NOW + 600 })] });
    await assert.rejects(() => useFirework(6001, 1), (error) => {
        assert.equal(error.code, 'FIREWORK_BURNING');
        assert.match(error.message, /燃放中/);
        return true;
    });
    assert.deepEqual(calls, ['events']);
});

test('燃放已结束的残留事件按没有烟花处理', async () => {
    const { useFirework, calls } = harness({ events: [event({ phase: 2, state_until: NOW - 1 })] });
    const result = await useFirework(6001, 1);
    assert.deepEqual(calls, ['events', 'place:6001:0', 'ignite:6001']);
    assert.equal(result.resumed, false);
});

test('点燃失败区分「燃放中」与「未确认」', async () => {
    const burning = harness({ ignite: async () => { throw new Error('PlantService.Farming 错误: code=1001096 烟花燃放中'); } });
    await assert.rejects(() => burning.useFirework(6001, 1), (error) => {
        assert.equal(error.code, 'FIREWORK_BURNING');
        return true;
    });

    const unconfirmed = harness({ ignite: async () => { throw new Error('network down'); } });
    await assert.rejects(() => unconfirmed.useFirework(6001, 1), (error) => {
        assert.equal(error.code, 'FIREWORK_IGNITE_UNCONFIRMED');
        assert.match(error.message, /已放置，但点燃未确认/);
        return true;
    });
});

test('放置阶段返回 1001096 时转换成燃放中提示', async () => {
    const { useFirework } = harness({ place: async () => { throw new Error('ItemService.Use 错误: code=1001096 烟花燃放中'); } });
    await assert.rejects(() => useFirework(6001, 1), (error) => {
        assert.equal(error.code, 'FIREWORK_BURNING');
        return true;
    });
});

test('失败后锁会释放，可以重试', async () => {
    let fail = true;
    const { useFirework, calls } = harness({
        ignite: async () => {
            if (fail) throw new Error('boom');
            return {};
        },
    });
    await assert.rejects(() => useFirework(6001, 1), /已放置，但点燃未确认/);
    fail = false;
    const result = await useFirework(6001, 1);
    assert.equal(result.resumed, false);
    assert.deepEqual(calls, ['events', 'place:6001:0', 'ignite:6001', 'events', 'place:6001:0', 'ignite:6001']);
});

test('并发点击被进行中锁挡住', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const useFirework = createFireworkUse({
        now: () => NOW,
        getFarmSocialEvents: async () => {
            calls.push('events');
            return [];
        },
        place: async () => {
            calls.push('place');
            await gate;
            return { used_items: [], items: [] };
        },
        ignite: async () => {
            calls.push('ignite');
            return {};
        },
    });

    const first = useFirework(6001, 1);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => useFirework(6001, 1), (error) => {
        assert.equal(error.code, 'FIREWORK_BUSY');
        return true;
    });
    release();
    await first;
    assert.deepEqual(calls, ['events', 'place', 'ignite']);
});

test('isFireworkError 只认烟花错误', () => {
    const error = new Error('烟花：燃放中，请稍后再试');
    error.code = 'FIREWORK_BURNING';
    assert.equal(isFireworkError(error), true);
    assert.equal(isFireworkError(new Error('普通错误')), false);
    assert.equal(isFireworkError(null), false);
});
