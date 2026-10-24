const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { getDataFile } = require('../dist/config/runtime-paths');
const store = require('../dist/models/store');

const STORE_FILE = getDataFile('store.json');
const backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;

test.after(() => {
    if (backup === null) {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
    } else {
        fs.writeFileSync(STORE_FILE, backup);
    }
});

// 配置快照只改内存，避免测试污染真实 store.json
function configFor(accountId) {
    return store.getAutoCodeRefreshConfig(accountId);
}

test('自动刷新 Code 默认关闭：未配置过的账号不会自动换 Code 或重登', () => {
    const accountId = `__acr_default_${Date.now()}`;
    const config = configFor(accountId);
    assert.equal(config.enabled, false);
    assert.equal(config.intervalMinutes, 60);
});

test('显式开启后按设置的间隔生效，显式关闭后保持关闭', () => {
    const accountId = `__acr_toggle_${Date.now()}`;

    store.applyConfigSnapshot({ autoCodeRefreshEnabled: true, autoCodeRefreshIntervalMinutes: 15 }, { accountId, persist: false });
    const enabled = configFor(accountId);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.intervalMinutes, 15);

    store.applyConfigSnapshot({ autoCodeRefreshEnabled: false }, { accountId, persist: false });
    const disabled = configFor(accountId);
    assert.equal(disabled.enabled, false);
    // 关闭开关不应丢掉已设置的间隔
    assert.equal(disabled.intervalMinutes, 15);
});

test('间隔会被收敛到 1..1440 分钟', () => {
    const accountId = `__acr_clamp_${Date.now()}`;
    store.applyConfigSnapshot({ autoCodeRefreshEnabled: true, autoCodeRefreshIntervalMinutes: 0 }, { accountId, persist: false });
    assert.equal(configFor(accountId).intervalMinutes, 60);
    store.applyConfigSnapshot({ autoCodeRefreshIntervalMinutes: 100000 }, { accountId, persist: false });
    assert.equal(configFor(accountId).intervalMinutes, 1440);
});
