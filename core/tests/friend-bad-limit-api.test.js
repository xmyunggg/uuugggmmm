const assert = require('node:assert/strict');
const test = require('node:test');

// putWeeds/putInsects 遇到 1001046 时的接线：跳过这一块继续试下一块，
// 只有连续被拒（由 scheduler 计数）到阈值才停用当天，成功一次则清零。

const networkPath = require.resolve('../dist/utils/network');
const protoPath = require.resolve('../dist/utils/proto');
const utilsPath = require.resolve('../dist/utils/utils');
const statsPath = require.resolve('../dist/services/stats');
const petCachePath = require.resolve('../dist/services/friend/pet-cache');
const maturityPlanPath = require.resolve('../dist/services/friend/maturity-plan');
const gidManagerPath = require.resolve('../dist/services/friend/gid-manager');
const schedulerPath = require.resolve('../dist/services/friend/scheduler');

const sent = [];
const failures = [];
const stopCalls = [];
let successCount = 0;
let stopped = false;
let replyLands = [];
// 每次请求按顺序取一个行为：'reject' = 网关返回 1001046，'ok' = 正常回包
let behaviorQueue = [];

class FakeGatewayError extends Error {
    constructor(code) {
        super(`gateway 错误: code=${code}`);
        this.name = 'GatewayError';
        this.code = code;
    }
}

const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        log: () => {},
        logWarn: () => {},
        randomDelay: async () => {},
        sleep: async () => {},
    },
};

require.cache[networkPath] = {
    exports: {
        GatewayError: FakeGatewayError,
        getUserState: () => ({ gid: 1009631504 }),
        sendMsgAsync: async (service, method, body) => {
            const behavior = behaviorQueue.shift() || 'ok';
            sent.push({ service, method, body, behavior });
            if (behavior === 'reject') throw new FakeGatewayError(1001046);
            return { body: Buffer.alloc(0) };
        },
    },
};

require.cache[protoPath] = {
    exports: {
        types: {
            PutWeedsRequest: {
                create: value => value,
                encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
            },
            PutInsectsRequest: {
                create: value => value,
                encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
            },
            PutWeedsReply: { decode: () => ({ land: replyLands, operation_limits: [] }) },
            PutInsectsReply: { decode: () => ({ land: replyLands, operation_limits: [] }) },
        },
    },
};

require.cache[statsPath] = { exports: { recordOperation: () => {} } };
require.cache[petCachePath] = { exports: { recordFriendDogFromEnterReply: () => {} } };
require.cache[maturityPlanPath] = { exports: { observeFriendLands: () => {} } };
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

// 替身 limit 状态机（真实阈值由 friend-bad-limit-consecutive.test.js 覆盖），
// 这里只验证 api 层的调用契约。
require.cache[schedulerPath] = {
    exports: {
        noteBadOperationFailure: (method) => {
            failures.push(method);
            if (failures.length >= 3) stopped = true;
            return stopped;
        },
        noteBadOperationSuccess: () => { successCount += 1; },
        isBadOperationLimitReached: () => stopped,
        getRemainingBadOperationTimes: () => 999,
        updateOperationLimits: () => {},
        markBadOperationLimitReached: (method) => { stopCalls.push(method); },
    },
};

const { putWeeds } = require('../dist/services/friend/api');

test.beforeEach(() => {
    sent.length = 0;
    failures.length = 0;
    stopCalls.length = 0;
    successCount = 0;
    stopped = false;
    behaviorQueue = [];
    replyLands = [];
});

test('1001046 只跳过该地块，不打断同一批的后续地块', async () => {
    behaviorQueue = ['reject', 'ok'];
    replyLands = [{ id: 2 }];

    const ok = await putWeeds(12345, [1, 2], true);

    assert.equal(sent.length, 2, '两块地都要发请求');
    assert.equal(ok, 1);
    assert.deepEqual(failures, ['PutWeeds']);
    assert.equal(successCount, 1, '第二块成功要清零连续计数');
    assert.deepEqual(stopCalls, [], 'api 层遇 1001046 不该自己停用当天');
});

test('连续被拒到阈值后由状态机接管，本批剩余地块不再发请求', async () => {
    behaviorQueue = ['reject', 'reject', 'reject'];

    const ok = await putWeeds(12345, [1, 2, 3, 4], true);

    assert.equal(ok, 0);
    assert.equal(failures.length, 3);
    assert.equal(sent.length, 3, '阈值达成后第四块不再请求');
    assert.equal(stopped, true);
});
