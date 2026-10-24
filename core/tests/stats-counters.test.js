const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { getDataFile } = require('../dist/config/runtime-paths');
const stats = require('../dist/services/stats');

const ACCOUNT_ID = '__stats_counter_probe__';
const STATS_FILE = path.join(path.dirname(getDataFile('accounts.json')), 'stats', `${ACCOUNT_ID}.json`);
const backup = fs.existsSync(STATS_FILE) ? fs.readFileSync(STATS_FILE, 'utf8') : null;

function restore() {
    if (backup === null) {
        if (fs.existsSync(STATS_FILE)) fs.unlinkSync(STATS_FILE);
    } else {
        fs.writeFileSync(STATS_FILE, backup);
    }
}

test.after(async () => {
    // 统计落盘有 2s 防抖，先等定时器跑完再清理，避免清理后又被写回
    await new Promise(resolve => setTimeout(resolve, 2500));
    restore();
});

test('放草/放虫/同气礼包计数会被记录并进入状态快照，未知键仍被忽略', () => {
    stats.initStatsWithPersistence(ACCOUNT_ID, 0, 0, 0);
    stats.recordOperation('weed', 2);
    stats.recordOperation('bug', 3);
    stats.recordOperation('tongQiGift', 1);
    stats.recordOperation('not_a_real_key', 99);

    const snapshot = stats.getStats({}, {}, false, {});
    assert.equal(snapshot.operations.weed, 2);
    assert.equal(snapshot.operations.bug, 3);
    assert.equal(snapshot.operations.tongQiGift, 1);
    assert.equal(snapshot.operations.not_a_real_key, undefined);
});

test('新增计数能落盘并在同一账号重新初始化时恢复', () => {
    stats.initStatsWithPersistence(ACCOUNT_ID, 0, 0, 0);
    stats.recordOperation('weed', 5);
    stats.recordOperation('tongQiGift', 4);
    stats.saveStats();

    const persisted = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    assert.equal(persisted.operations.weed, 5);
    assert.equal(persisted.operations.tongQiGift, 4);

    // 模拟 worker 重启：重新初始化后应恢复今日计数
    stats.initStatsWithPersistence(ACCOUNT_ID, 0, 0, 0);
    const snapshot = stats.getStats({}, {}, false, {});
    assert.equal(snapshot.operations.weed, 5);
    assert.equal(snapshot.operations.tongQiGift, 4);
    assert.equal(snapshot.operations.bug, 0);
});
