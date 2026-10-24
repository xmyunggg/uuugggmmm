const assert = require('node:assert/strict');
const test = require('node:test');

const networkPath = require.resolve('../dist/utils/network');
const utilsPath = require.resolve('../dist/utils/utils');
const storePath = require.resolve('../dist/models/store');
const farmPath = require.resolve('../dist/services/farm');
const warehousePath = require.resolve('../dist/services/warehouse');
const careerPath = require.resolve('../dist/services/career');
const apiPath = require.resolve('../dist/services/friend/api');
const gidManagerPath = require.resolve('../dist/services/friend/gid-manager');
const visitStrategyPath = require.resolve('../dist/services/friend/visit-strategy');
const visitPlanPath = require.resolve('../dist/services/friend/visit-plan');
const petCachePath = require.resolve('../dist/services/friend/pet-cache');
const petSyncPath = require.resolve('../dist/services/friend/pet-sync');

// 服务器时间用「真实流逝」模拟：唤醒到点后计划表里的成熟时间真的会过期。
const START_MS = Date.now();
const BASE_SEC = 1780000000;
function serverNowSec() {
    return BASE_SEC + Math.floor((Date.now() - START_MS) / 1000);
}

const realUtils = require('../dist/utils/utils');
const calls = { friends: 0, visits: 0, visited: [] };
const state = { quietHours: false, friend: true, steal: true };
// 巡查计划由测试直接给定：本测试只关心节流与成熟唤醒怎么挑人
let planTargets = [];

require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        getServerTimeSec: () => serverNowSec(),
        log: () => {},
        logWarn: () => {},
        randomDelay: async () => {},
    },
};

require.cache[networkPath] = {
    exports: {
        getUserState: () => ({ gid: 1009631504, accountId: 'acc-1' }),
        networkEvents: { on: () => {}, off: () => {}, emit: () => {} },
    },
};

require.cache[storePath] = {
    exports: {
        isAutomationOn: (name) => (name === 'friend' ? state.friend : (name === 'friend_steal' ? state.steal : true)),
        getFriendBlacklist: () => [],
        getAutoAcceptFriendMinLevel: () => 0,
        getAutoAcceptRequireOwnLevel: () => false,
        getAutoAcceptHarvestStealEnabled: () => false,
        getAutoAcceptHarvestStealHarvest: () => true,
        getAutoAcceptHarvestStealSteal: () => true,
    },
};

require.cache[farmPath] = { exports: { setOperationLimitsCallback: () => {} } };
require.cache[warehousePath] = { exports: { sellAllFruits: async () => ({}) } };
require.cache[careerPath] = { exports: { getCareerInfo: () => null } };
require.cache[petSyncPath] = {
    exports: { startFriendPetSyncTimer: () => {}, stopFriendPetSyncTimer: () => {} },
};
require.cache[petCachePath] = {
    exports: {
        getFriendDogState: () => 'unknown',
        flushFriendPetCacheNow: () => {},
        recordFriendDogFromEnterReply: () => {},
    },
};
require.cache[gidManagerPath] = {
    exports: {
        extractReplyFriends: (reply) => (reply && reply.friends) || [],
        clearAllInvalidKnownFriendGidCooldowns: () => {},
        syncKnownFriendGidsFromFriends: () => {},
        syncKnownFriendGidsFromRecentVisitors: () => {},
    },
};
require.cache[visitStrategyPath] = {
    exports: {
        visitFriend: async (target) => {
            calls.visits += 1;
            calls.visited.push(target.gid);
        },
        inFriendQuietHours: () => state.quietHours,
        cacheFriendsListFromReply: () => {},
        clearFriendsListCache: () => {},
    },
};
require.cache[visitPlanPath] = {
    // 巡查计划由测试给定：默认留空，不真的进好友农场
    exports: {
        buildFriendVisitPlan: () => ({
            visits: planTargets, stealCount: 0, helpCount: 0, badOnlyCount: 0,
            skippedExpLimit: 0, skippedUnknownDog: 0,
        }),
    },
};
let friendReply = { friends: [] };
require.cache[apiPath] = {
    exports: {
        getAllFriends: async () => { calls.friends += 1; return friendReply; },
        acceptFriends: async () => {},
        rejectFriends: async () => {},
        getApplications: async () => [],
    },
};

const {
    checkFriends,
    startFriendCheckLoop,
    stopFriendCheckLoop,
} = require('../dist/services/friend/scheduler');
const { getSchedulerRegistrySnapshot } = require('../dist/services/scheduler');
const { claimDueFriends, getNextStealDelayMs } = require('../dist/services/friend/maturity-plan');

function stealWakeAt() {
    const snapshot = getSchedulerRegistrySnapshot('friend');
    const scheduler = (snapshot.schedulers || [])[0] || { tasks: [] };
    const task = (scheduler.tasks || []).find(item => item.name === 'friend_steal_maturity');
    return task ? task.nextRunAt : 0;
}

function sleep(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}

test.beforeEach(() => {
    friendReply = { friends: [] };
    planTargets = [];
    calls.friends = 0;
    calls.visits = 0;
    calls.visited = [];
    state.quietHours = false;
    state.friend = true;
    state.steal = true;
    stopFriendCheckLoop();
});

test('好友巡查把列表摘要写进成熟计划，并把唤醒提前到成熟时刻', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    const before = stealWakeAt();
    assert.ok(before > 0, '成熟唤醒应该已经排程');

    friendReply = { friends: [{ gid: 55, name: '小美', plant: { ripe_time_sec: 1 } }] };
    assert.equal(await checkFriends(), false);

    const after = stealWakeAt();
    assert.ok(after < before, `唤醒时刻应提前到成熟时间（${after} < ${before}）`);
    assert.ok(after - Date.now() < 3000, '唤醒应排在 1 秒左右之后');
});

test('到点后成熟唤醒自己跑一轮只偷菜巡查，并点名访问刚成熟的好友', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    friendReply = { friends: [{ gid: 55, name: '小美', plant: { ripe_time_sec: 1 } }] };
    planTargets = [{ gid: 55, name: '小美', wantSteal: true, wantHelp: false, wantBad: false }];
    await checkFriends();
    assert.equal(calls.friends, 1);
    assert.deepEqual(calls.visited, [55]);

    // 到点之后这一轮巡查看到的成熟时间变远了：如果唤醒真的跑了巡查，计划表应该跟着更新
    friendReply = { friends: [{ gid: 55, name: '小美', plant: { ripe_time_sec: 3600 } }] };
    await sleep(1400);
    assert.equal(calls.friends, 2, '到点后应再拉一次好友列表（只偷菜巡查）');
    // 刚访问过（在冷却里）也要点名访问，否则到点唤醒会被节流挡掉
    assert.deepEqual(calls.visited, [55, 55]);
    // 唤醒里的那一轮巡查把成熟时间从 1 秒更新成了 1 小时
    assert.deepEqual(claimDueFriends({ nowSec: serverNowSec() + 3000 }), []);
    assert.deepEqual(claimDueFriends({ nowSec: serverNowSec() + 4000 }), [{ gid: 55, name: '小美' }]);
});

test('每轮只访问一小批，剩下的下几轮轮到', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    planTargets = [];
    for (let gid = 1; gid <= 20; gid += 1) {
        planTargets.push({ gid, name: `f${gid}`, wantSteal: true, wantHelp: false, wantBad: false });
        friendReply.friends.push({ gid, name: `f${gid}`, plant: { steal_plant_num: 1 } });
    }
    await checkFriends();
    assert.deepEqual(calls.visited, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await checkFriends();
    // 前 12 位还在访问冷却里，这一轮只剩后面 8 位可访问
    assert.deepEqual(calls.visited.slice(12), [13, 14, 15, 16, 17, 18, 19, 20]);
});

test('点名好友跳过访问冷却、排在这一批最前面', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    planTargets = [];
    for (let gid = 1; gid <= 20; gid += 1) {
        planTargets.push({ gid, name: `f${gid}`, wantSteal: true, wantHelp: false, wantBad: false });
        friendReply.friends.push({ gid, name: `f${gid}`, plant: { steal_plant_num: 1 } });
    }
    await checkFriends();
    calls.visited = [];
    await checkFriends({ onlySteal: true, focusGids: [5, 9] });
    assert.deepEqual(calls.visited, [5, 9, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test('偷菜开关关掉时不发起巡查，但计划照旧记录', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    state.steal = false;
    friendReply = { friends: [{ gid: 55, name: '小美', plant: { ripe_time_sec: 1 } }] };
    await checkFriends();
    await sleep(1400);
    assert.equal(calls.friends, 1, '关掉偷菜后成熟唤醒不应再拉列表');
    assert.equal(calls.visits, 0);
});

test('停掉好友巡查会清空成熟计划与唤醒定时器', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    friendReply = { friends: [{ gid: 55, name: '小美', plant: { ripe_time_sec: 1 } }] };
    await checkFriends();
    stopFriendCheckLoop();
    assert.equal(stealWakeAt(), 0);
    assert.deepEqual(claimDueFriends(), []);
    assert.equal(getNextStealDelayMs(), 15 * 60 * 1000);
});
