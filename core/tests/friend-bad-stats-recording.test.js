const assert = require('node:assert/strict');
const test = require('node:test');

// 自动（巡查）放草放虫过去只累加 totalActions，没写统计，导致面板「今日统计」里
// 放草/放虫永远是 0。这里用假的 api 边界驱动 visitFriend，锁住「成功几次就记几次」。

const utilsPath = require.resolve('../dist/utils/utils');
const storePath = require.resolve('../dist/models/store');
const farmPath = require.resolve('../dist/services/farm');
const careerPath = require.resolve('../dist/services/career');
const statsPath = require.resolve('../dist/services/stats');
const warehousePath = require.resolve('../dist/services/warehouse');
const apiPath = require.resolve('../dist/services/friend/api');
const gidManagerPath = require.resolve('../dist/services/friend/gid-manager');
const petCachePath = require.resolve('../dist/services/friend/pet-cache');
const schedulerPath = require.resolve('../dist/services/friend/scheduler');

const recorded = [];
const putCalls = [];
let weedReply = 0;
let bugReply = 0;

const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
        randomDelay: async () => {},
    },
};

require.cache[storePath] = {
    exports: {
        // 只开捣乱：偷菜/帮忙关掉，验证捣乱这条分支自己就能把统计写对
        isAutomationOn: (key) => key === 'friend_bad',
        getFriendQuietHours: () => ({ enabled: false }),
        getFriendBlacklist: () => [],
        getPlantBlacklist: () => [],
        getFriendsListCacheTtlSec: () => 60,
    },
};

require.cache[farmPath] = {
    exports: {
        getCurrentPhase: () => ({ phase: 2 }), // 生长期：不是成熟也不是枯死
        buildLandMap: () => ({}),
        buildLandDetail: () => ({}),
        getPlantStatusFlags: () => ({ needWater: false, needWeed: false, needBug: false }),
        isOccupiedSlaveLand: () => false,
    },
};

require.cache[careerPath] = { exports: { getCareerInfoOrNull: () => null } };
require.cache[warehousePath] = { exports: { sellAllFruits: async () => {} } };
require.cache[statsPath] = {
    exports: { recordOperation: (type, count) => recorded.push([type, count]) },
};
require.cache[gidManagerPath] = {
    exports: {
        extractReplyFriends: value => value,
        postToMaster: async () => {},
        removeKnownFriendGid: () => {},
    },
};
require.cache[petCachePath] = {
    exports: {
        PROTECT_DOG_ID: 9001,
        getFriendDogState: () => 'unknown',
        getFriendDogId: () => 0,
    },
};
require.cache[schedulerPath] = {
    exports: {
        isBadOperationLimitReached: () => false,
        getRemainingBadOperationTimes: () => 999,
        setCanGetHelpExp: () => {},
        getCanGetHelpExp: () => true,
        canGetExpByCandidates: () => false,
    },
};

// 一块空地的生长期作物：草和虫都没人放过，两块都可捣乱
const ENTER_REPLY = {
    lands: [{
        id: 1,
        plant: { id: 1001, name: '测试作物', phases: [{ phase: 2 }], weed_owners: [], insect_owners: [] },
    }],
};

require.cache[apiPath] = {
    exports: {
        getAllFriends: async () => ({}),
        delFriend: async () => {},
        enterFriendFarm: async () => ENTER_REPLY,
        leaveFriendFarm: async () => {},
        helpFarming: async () => 0,
        stealHarvest: async () => {},
        putWeeds: async (gid, landIds) => { putCalls.push(['weed', gid, landIds]); return weedReply; },
        putInsects: async (gid, landIds) => { putCalls.push(['insect', gid, landIds]); return bugReply; },
        putWeedsDetailed: async () => ({ ok: 0, failed: [] }),
        putInsectsDetailed: async () => ({ ok: 0, failed: [] }),
    },
};

const { visitFriend } = require('../dist/services/friend/visit-strategy');

function newTotalActions() {
    return { steal: 0, farming: 0, putBug: 0, putWeed: 0 };
}

test.beforeEach(() => {
    recorded.length = 0;
    putCalls.length = 0;
    weedReply = 0;
    bugReply = 0;
});

test('自动放草放虫成功后写进统计（放草/放虫各一次）', async () => {
    weedReply = 2;
    bugReply = 1;
    const totalActions = newTotalActions();

    const result = await visitFriend({ gid: 12345, name: 'GID:12345' }, totalActions, 1009631504, '__bad_stats_probe__', {
        allowSteal: false,
        allowHelp: false,
        allowBad: true,
    });

    assert.equal(result.acted, true);
    assert.deepEqual(recorded, [['weed', 2], ['bug', 1]]);
    assert.equal(totalActions.putWeed, 2);
    assert.equal(totalActions.putBug, 1);
    // 每类只发一次请求，地块都来自 canPutWeed/canPutBug
    assert.deepEqual(putCalls, [['weed', 12345, [1]], ['insect', 12345, [1]]]);
});

test('一块都没放成功时不写统计', async () => {
    const totalActions = newTotalActions();

    const result = await visitFriend({ gid: 54321, name: 'GID:54321' }, totalActions, 1009631504, '__bad_stats_probe__', {
        allowSteal: false,
        allowHelp: false,
        allowBad: true,
    });

    assert.equal(result.acted, false);
    assert.deepEqual(recorded, []);
    assert.equal(totalActions.putWeed, 0);
    assert.equal(totalActions.putBug, 0);
});
