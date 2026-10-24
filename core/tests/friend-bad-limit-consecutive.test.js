const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

// 1001046 语义：单块地被拒 != 共享日额度用尽。连续被拒到阈值才停用当天；
// 服务端 operation_limits 才是额度用尽的权威信号。

const ACCOUNT_ID = '__bad_limit_probe__';
process.env.FARM_ACCOUNT_ID = ACCOUNT_ID;

const { getDataFile } = require('../dist/config/runtime-paths');
const STATE_FILE = getDataFile(`friend-bad-state-${crypto.createHash('sha256').update(ACCOUNT_ID, 'utf8').digest('hex')}.json`);
const backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;

function freshScheduler() {
    for (const key of Object.keys(require.cache)) {
        if (key.includes('services/friend/scheduler') || key.includes('services\\friend\\scheduler')) {
            delete require.cache[key];
        }
    }
    return require('../dist/services/friend/scheduler');
}

function clearStateFile() {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

test.beforeEach(() => {
    clearStateFile();
});

test.after(() => {
    if (backup === null) {
        clearStateFile();
    } else {
        fs.writeFileSync(STATE_FILE, backup);
    }
});

test('单块地被拒两次不停当天，第三次连续被拒才判定额度用尽并落盘', () => {
    const scheduler = freshScheduler();

    assert.equal(scheduler.noteBadOperationFailure('PutWeeds'), false);
    assert.equal(scheduler.noteBadOperationFailure('PutInsects'), false);
    assert.equal(scheduler.isBadOperationLimitReached(), false);
    assert.equal(fs.existsSync(STATE_FILE), false);

    assert.equal(scheduler.noteBadOperationFailure('PutWeeds'), true);
    assert.equal(scheduler.isBadOperationLimitReached(), true);

    const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.equal(persisted.stopped, true);
});

test('中间成功放过一次后连续计数清零，不会被两次零散被拒误停', () => {
    const scheduler = freshScheduler();

    scheduler.noteBadOperationFailure('PutWeeds');
    scheduler.noteBadOperationFailure('PutWeeds');
    scheduler.noteBadOperationSuccess();
    assert.equal(scheduler.noteBadOperationFailure('PutWeeds'), false);
    assert.equal(scheduler.noteBadOperationFailure('PutWeeds'), false);
    assert.equal(scheduler.isBadOperationLimitReached(), false);
});

test('服务端 operation_limits 显示共享额度用尽时立即停用当天（不走阈值）', () => {
    const scheduler = freshScheduler();

    scheduler.updateOperationLimits([{ id: 10003, day_times: 5, day_times_lt: 5 }]);

    assert.equal(scheduler.isBadOperationLimitReached(), true);
    assert.equal(scheduler.getRemainingBadOperationTimes(), 0);
});
