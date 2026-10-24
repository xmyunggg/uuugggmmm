const assert = require('node:assert/strict');
const test = require('node:test');

const networkPath = require.resolve('../dist/utils/network');
const protoPath = require.resolve('../dist/utils/proto');
const utilsPath = require.resolve('../dist/utils/utils');

// ---- 打桩：只保留仓库既有的 require.cache 替身方式，真实协议结构由纯逻辑测试覆盖 ----
const replies = new Map();
function stub(type, ...values) {
    replies.set(type, values.slice());
}
function take(type, fallback) {
    const queue = replies.get(type);
    if (queue && queue.length) return queue.shift();
    return fallback;
}
function messageType(type, fallback) {
    return {
        create: (value) => value,
        encode: (value) => ({ finish: () => JSON.stringify(value) }),
        decode: () => take(type, fallback),
    };
}

const calls = [];
require.cache[networkPath] = {
    exports: {
        sendMsgAsync: async (service, method, body) => {
            calls.push({ service, method, body });
            return { body: Buffer.alloc(0) };
        },
        networkEvents: { emit: () => {}, on: () => {} },
        getUserState: () => ({ gid: 1009631504 }),
    },
};
require.cache[protoPath] = {
    exports: {
        types: {
            AllLandsRequest: messageType('AllLandsRequest', {}),
            AllLandsReply: messageType('AllLandsReply', { social_events: [] }),
            BagRequest: messageType('BagRequest', {}),
            BagReply: messageType('BagReply', { item_bag: { items: [] } }),
            UseRequest: messageType('UseRequest', {}),
            UseReply: messageType('UseReply', { used_items: [] }),
            BatchUseRequest: messageType('BatchUseRequest', {}),
            BatchUseReply: messageType('BatchUseReply', { used_items: [] }),
            FarmingRequest: messageType('FarmingRequest', {}),
            FarmingReply: messageType('FarmingReply', {}),
        },
    },
};
require.cache[utilsPath] = {
    exports: {
        toLong: value => value,
        toNum: value => Number(value) || 0,
        toTimeSec: value => Math.floor(Number(value) / 1000),
        getServerTimeSec: () => 1780000000,
        getSystemDateKey: () => '2026-09-24',
        sleep: async () => {},
        randomDelay: async () => {},
        log: () => {},
        logWarn: () => {},
    },
};

const warehouse = require('../dist/services/warehouse');

function bagWith(items) {
    stub('BagReply', { item_bag: { items } });
}

function bodies(method) {
    return calls.filter(call => call.method === method).map(call => JSON.parse(call.body));
}

function reset() {
    calls.length = 0;
    replies.clear();
}

test('烟花走「放置 + 点燃」两步：Use 带 target，Farming 带 social_event_item_ids', async () => {
    reset();
    bagWith([{ id: 6001, count: 2, uid: 55 }]);

    const result = await warehouse.useItem(6001, 1, [], 0);

    assert.deepEqual(calls.map(call => `${call.service}.${call.method}`), [
        'gamepb.plantpb.PlantService.AllLands',
        'gamepb.itempb.ItemService.Bag',
        'gamepb.itempb.ItemService.Use',
        'gamepb.plantpb.PlantService.Farming',
    ]);
    assert.deepEqual(bodies('Use'), [{
        item: { id: 6001, count: 1, uid: 55 },
        target: { host_gid: 1009631504, use_config_id: 0 },
    }], '放置必须带 target.host_gid');
    assert.deepEqual(bodies('Farming'), [{
        land_ids: [],
        host_gid: 1009631504,
        field_3: 0,
        field_4: 0,
        social_event_item_ids: [6001],
    }], '点燃通过农场级社交事件字段完成，且不传 land_ids');
    assert.equal(result.firework, true);
    assert.equal(result.resumed, false);
});

test('农场里已有同款烟花桶时只补点燃，不再发 Use', async () => {
    reset();
    stub('AllLandsReply', { social_events: [{ item_id: 6002, visitor_gid: 9, timestamp: 1 }] });
    bagWith([{ id: 6002, count: 1, uid: 7 }]);

    const result = await warehouse.useItem(6002, 1);

    assert.deepEqual(calls.map(call => call.method), ['AllLands', 'Farming']);
    assert.deepEqual(bodies('Farming')[0].social_event_item_ids, [6002]);
    assert.equal(result.resumed, true);
    assert.deepEqual(result.used_items, [], '补点燃不再消耗道具');
});

test('烟花数量必须为 1，且不会发送任何请求', async () => {
    reset();
    bagWith([{ id: 6001, count: 5, uid: 55 }]);
    await assert.rejects(() => warehouse.useItem(6001, 3), /每次只能燃放一枚/);
    assert.deepEqual(calls, []);
});

test('已在燃放中的烟花会被拒绝', async () => {
    reset();
    stub('AllLandsReply', { social_events: [{ item_id: 6001, phase: 2, state_until: 1780000600 }] });
    bagWith([{ id: 6001, count: 1, uid: 55 }]);
    await assert.rejects(() => warehouse.useItem(6001, 1), /燃放中/);
    assert.deepEqual(calls.map(call => call.method), ['AllLands']);
});

test('普通道具仍走原有 Use 路径（不带 target）', async () => {
    reset();
    bagWith([{ id: 80001, count: 3, uid: 21 }]);

    const result = await warehouse.useItem(80001, 2);

    assert.deepEqual(calls.map(call => call.method), ['Bag', 'Use']);
    assert.deepEqual(bodies('Use'), [{ item: { id: 80001, count: 2, uid: 21 } }]);
    assert.equal(result.firework, undefined);
});

test('多个背包条目凑数量时仍走 BatchUse', async () => {
    reset();
    bagWith([
        { id: 80001, count: 1, uid: 21 },
        { id: 80001, count: 1, uid: 22 },
    ]);

    await warehouse.useItem(80001, 2);

    assert.deepEqual(calls.map(call => call.method), ['Bag', 'BatchUse']);
    assert.deepEqual(bodies('BatchUse'), [{
        items: [
            { id: 80001, count: 1, uid: 21 },
            { id: 80001, count: 1, uid: 22 },
        ],
    }]);
});

test('锁定条目不参与使用', async () => {
    reset();
    bagWith([
        { id: 80001, count: 5, uid: 21, locked: true },
        { id: 80001, count: 1, uid: 22 },
    ]);

    await warehouse.useItem(80001, 1);

    assert.deepEqual(bodies('Use'), [{ item: { id: 80001, count: 1, uid: 22 } }]);
});
