const assert = require('node:assert/strict');
const test = require('node:test');

const networkPath = require.resolve('../dist/utils/network');
const protoPath = require.resolve('../dist/utils/proto');
const utilsPath = require.resolve('../dist/utils/utils');
const petCachePath = require.resolve('../dist/services/friend/pet-cache');
const gidManagerPath = require.resolve('../dist/services/friend/gid-manager');

const BASE_SEC = 1780000000;
const entered = [];

const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        getServerTimeSec: () => BASE_SEC,
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
        randomDelay: async () => {},
    },
};
require.cache[networkPath] = {
    exports: {
        sendMsgAsync: async (service, method, body) => {
            entered.push({ service, method, body });
            return { body: Buffer.alloc(0) };
        },
        getUserState: () => ({ gid: 1009631504 }),
        GatewayError: class GatewayError extends Error {},
    },
};
let enterReply = {};
require.cache[protoPath] = {
    exports: {
        types: {
            VisitEnterRequest: {
                create: value => value,
                encode: value => ({ finish: () => JSON.stringify(value) }),
            },
            VisitEnterReply: { decode: () => enterReply },
        },
    },
};
require.cache[petCachePath] = {
    exports: { recordFriendDogFromEnterReply: () => {}, flushFriendPetCacheNow: () => {} },
};
require.cache[gidManagerPath] = {
    exports: {
        syncKnownFriendGidsFromRecentVisitors: () => {},
        fetchQqFriendsByKnownGids: async () => [],
        syncKnownFriendGidsFromFriends: () => {},
        getEffectiveKnownQqFriendGids: () => [],
        fetchQqFriendsByLegacyMethod: async () => [],
        dedupeFriendsByGid: value => value,
        buildFriendReply: value => value,
    },
};

const { enterFriendFarm } = require('../dist/services/friend/api');
const { claimDueFriends, resetFriendMaturityPlans } = require('../dist/services/friend/maturity-plan');

test.beforeEach(() => {
    entered.length = 0;
    enterReply = {};
    resetFriendMaturityPlans();
});

test('进好友农场的回包顺带把地块成熟时间写进成熟计划', async () => {
    enterReply = {
        lands: [{ plant: { phases: [{ phase: 2, begin_time: BASE_SEC - 60 }, { phase: 6, begin_time: BASE_SEC + 300 }] } }],
    };
    await enterFriendFarm(12345);
    assert.equal(entered.length, 1);
    assert.equal(entered[0].service, 'gamepb.visitpb.VisitService');
    assert.equal(entered[0].method, 'Enter');
    assert.deepEqual(claimDueFriends({ nowSec: BASE_SEC + 300 }), [{ gid: 12345, name: 'GID:12345' }]);
});

test('成熟阶段用记录 ID 19 也能认出来', async () => {
    enterReply = { lands: [{ plant: { phases: [{ phase: 6, phase_id: 19, begin_time: (BASE_SEC + 900) * 1000 }] } }] };
    await enterFriendFarm(666);
    assert.deepEqual(claimDueFriends({ nowSec: BASE_SEC + 900 }), [{ gid: 666, name: 'GID:666' }]);
});

test('回包没有地块或地块里没有未来成熟时间时不记任何成熟时间', async () => {
    await enterFriendFarm(777);
    enterReply = { lands: [{ plant: { phases: [{ phase: 6, begin_time: BASE_SEC - 10 }] } }] };
    await enterFriendFarm(888);
    assert.deepEqual(claimDueFriends({ nowSec: BASE_SEC + 100000 }), []);
});
