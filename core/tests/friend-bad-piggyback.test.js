const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

// 「进农场有额度就顺手放」：偷/帮的好友也顺手放草放虫，额度在同一轮里可能中途用尽。
// 额度用尽时必须只是「不放」，不能像以前那样 break 掉整轮，否则排在后面的偷/帮好友全都会被跳过。

const ACCOUNT_ID = 'acc-piggyback';
process.env.FARM_ACCOUNT_ID = ACCOUNT_ID;

const networkPath = require.resolve('../dist/utils/network');
const utilsPath = require.resolve('../dist/utils/utils');
const storePath = require.resolve('../dist/models/store');
const farmPath = require.resolve('../dist/services/farm');
const warehousePath = require.resolve('../dist/services/warehouse');
const careerPath = require.resolve('../dist/services/career');
const apiPath = require.resolve('../dist/services/friend/api');
const gidManagerPath = require.resolve('../dist/services/friend/gid-manager');
const visitStrategyPath = require.resolve('../dist/services/friend/visit-strategy');
const petCachePath = require.resolve('../dist/services/friend/pet-cache');
const petSyncPath = require.resolve('../dist/services/friend/pet-sync');
const { getDataFile } = require('../dist/config/runtime-paths');

const STATE_FILE = getDataFile(`friend-bad-state-${crypto.createHash('sha256').update(ACCOUNT_ID, 'utf8').digest('hex')}.json`);
const stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
function clearStateFile() {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

const realUtils = require('../dist/utils/utils');
const calls = { visited: [], allowBad: [] };
const logs = [];
const state = { quietHours: false, friend: true, steal: true, help: true, bad: true };
let friendReply = { friends: [] };

require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        log: (tag, message) => { logs.push(String(message)); },
        logWarn: () => {},
        randomDelay: async () => {},
    },
};

require.cache[networkPath] = {
    exports: {
        getUserState: () => ({ gid: 1009631504, accountId: ACCOUNT_ID }),
        networkEvents: { on: () => {}, off: () => {}, emit: () => {} },
    },
};

require.cache[storePath] = {
    exports: {
        isAutomationOn: (name) => {
            if (name === 'friend') return state.friend;
            if (name === 'friend_steal') return state.steal;
            if (name === 'friend_help') return state.help;
            if (name === 'friend_bad') return state.bad;
            return true;
        },
        getFriendBlacklist: () => [],
        getAutoAcceptFriendMinLevel: () => 0,
        getAutoAcceptRequireOwnLevel: () => false,
        getAutoAcceptHarvestStealEnabled: () => false,
        getAutoAcceptHarvestStealHarvest: () => true,
        getAutoAcceptHarvestStealSteal: () => true,
        getFriendQuietHours: () => null,
    },
};

require.cache[farmPath] = { exports: { setOperationLimitsCallback: () => {} } };
require.cache[warehousePath] = { exports: { sellAllFruits: async () => ({}) } };
require.cache[careerPath] = { exports: { getCareerInfo: () => null } };
require.cache[petSyncPath] = { exports: { startFriendPetSyncTimer: () => {}, stopFriendPetSyncTimer: () => {} } };
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
require.cache[apiPath] = {
    exports: {
        getAllFriends: async () => friendReply,
        acceptFriends: async () => {},
        rejectFriends: async () => {},
        getApplications: async () => [],
    },
};

// 第 1 位好友走完，额度就被真实用尽（3 次用完 → 共享额度 10003 打满）
let exhaustAfterGid = 0;
require.cache[visitStrategyPath] = {
    exports: {
        visitFriend: async (target, _total, _gid, _accountId, options) => {
            calls.visited.push(target.gid);
            calls.allowBad.push(!!options.allowBad);
            if (target.gid === exhaustAfterGid) {
                require('../dist/services/friend/scheduler')
                    .updateOperationLimits([{ id: 10003, day_times: 3, day_times_lt: 3 }]);
            }
        },
        inFriendQuietHours: () => state.quietHours,
        cacheFriendsListFromReply: () => {},
        clearFriendsListCache: () => {},
    },
};

const { checkFriends, stopFriendCheckLoop, startFriendCheckLoop, updateOperationLimits } = require('../dist/services/friend/scheduler');

// gid 1/2/3/4 都有可偷（顺手放的对象），gid 5 只能捣乱
function friendSet() {
    return [
        { gid: 1, name: 'f1', level: 40, plant: { steal_plant_num: 9 } },
        { gid: 2, name: 'f2', level: 35, plant: { steal_plant_num: 5 } },
        { gid: 3, name: 'f3', level: 30, plant: { steal_plant_num: 3, dry_num: 1 } },
        { gid: 4, name: 'f4', level: 25, plant: { steal_plant_num: 1 } },
        { gid: 5, name: 'f5', level: 50, plant: {} },
    ];
}

test.beforeEach(() => {
    clearStateFile();
    friendReply = { friends: friendSet() };
    calls.visited = [];
    calls.allowBad = [];
    logs.length = 0;
    state.quietHours = false;
    state.friend = true;
    state.steal = true;
    state.help = true;
    state.bad = true;
    exhaustAfterGid = 0;
    stopFriendCheckLoop();
});

test.after(() => {
    if (stateBackup === null) clearStateFile();
    else fs.writeFileSync(STATE_FILE, stateBackup);
});
test('额度先给偷/帮的好友顺手放，额度不够时纯捣乱好友干脆不进农场', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    // 剩余 3 次：按「偷得多」的顺序给 gid 1、2、3 顺手放，第 4 位偷菜好友就没额度了，
    // 也正因为额度被顺手放吃掉，只为捣乱的 gid 5 不再多进一次农场。
    updateOperationLimits([{ id: 10003, day_times: 0, day_times_lt: 3 }]);

    await checkFriends();

    assert.deepEqual(calls.visited, [1, 2, 3, 4]);
    assert.deepEqual(calls.allowBad, [true, true, true, false]);
});

test('额度有富余时，纯捣乱好友才排进这一轮', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    // 剩余 5 次：4 位偷菜好友全部顺手放，多出来的 1 个名额才给纯捣乱好友
    updateOperationLimits([{ id: 10003, day_times: 0, day_times_lt: 5 }]);

    await checkFriends();

    assert.deepEqual(calls.visited, [1, 2, 3, 4, 5]);
    assert.deepEqual(calls.allowBad, [true, true, true, true, true]);
});

test('额度中途用尽：剩下的偷/帮好友照常访问，只是不再放草放虫；纯捣乱好友不再进农场', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    updateOperationLimits([{ id: 10003, day_times: 0, day_times_lt: 5 }]);
    exhaustAfterGid = 1; // 第 1 位好友就放完了共享额度

    await checkFriends();

    // 1 放了草/虫 → 额度用尽；2、3、4 仍要被访问（偷菜/帮忙），5 只为了捣乱所以直接跳过
    assert.deepEqual(calls.visited, [1, 2, 3, 4]);
    assert.deepEqual(calls.allowBad, [true, false, false, false]);
    assert.ok(
        logs.some(line => line.includes('放虫放草次数已用完')),
        `额度用尽应有明确日志，实际：${JSON.stringify(logs)}`,
    );
});

test('捣乱开关关闭时一个顺手捣乱都不安排', async () => {
    startFriendCheckLoop({ externalScheduler: true });
    updateOperationLimits([{ id: 10003, day_times: 0, day_times_lt: 5 }]);
    state.bad = false;

    await checkFriends();

    assert.deepEqual(calls.visited, [1, 2, 3, 4]);
    assert.deepEqual(calls.allowBad, [false, false, false, false]);
});

test.after(() => {
    stopFriendCheckLoop();
});
