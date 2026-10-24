const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
    globalConfig,
} = require('../dist/models/store/shared-state');
const {
    getUserSystemConfigOverride,
    setUserSystemConfigOverride,
    clearUserSystemConfigOverride,
} = require('../dist/models/store/global-config');
const {
    getRuntimeConfig,
    updateRuntimeConfig,
} = require('../dist/config/config');
const {
    createRuntimeState,
} = require('../dist/runtime/runtime-state');

const USER_A = '__system_config_user_a__';
const USER_B = '__system_config_user_b__';

// 用户级运行环境读写会落盘到 store.json，测试前后备份/还原，避免污染真实配置
const STORE_FILE = require('../dist/config/runtime-paths').getDataFile('store.json');
const storeFileExisted = fs.existsSync(STORE_FILE);
const originalStoreJson = storeFileExisted ? fs.readFileSync(STORE_FILE, 'utf8') : '';
const originalGlobalSystemConfig = JSON.parse(JSON.stringify(globalConfig.systemConfig || null));
const originalRuntimeConfig = JSON.parse(JSON.stringify(getRuntimeConfig()));

function restoreStoreFile() {
    if (storeFileExisted) {
        fs.writeFileSync(STORE_FILE, originalStoreJson);
    } else if (fs.existsSync(STORE_FILE)) {
        fs.unlinkSync(STORE_FILE);
    }
}

function cleanupUser(username) {
    delete globalConfig.userSystemConfigs[username];
}

test.after(() => {
    cleanupUser(USER_A);
    cleanupUser(USER_B);
    globalConfig.systemConfig = originalGlobalSystemConfig;
    updateRuntimeConfig(originalRuntimeConfig);
    restoreStoreFile();
});

test('用户默认不设置运行环境覆盖', () => {
    assert.equal(getUserSystemConfigOverride(USER_A), null);
    assert.equal(getUserSystemConfigOverride(''), null);
    assert.equal(getUserSystemConfigOverride(undefined), null);
});

test('用户级运行环境独立于后台全局默认', () => {
    const globalBefore = JSON.stringify(globalConfig.systemConfig);
    const saved = setUserSystemConfigOverride(USER_A, {
        serverUrl: 'wss://user-a.example/ws',
        platform: 'qq',
        os: 'Android',
        timeZone: 'Asia/Tokyo',
        deviceInfo: { clientVersion: '1.14.1.10_20260916', os: 'Android', memory: '8192' },
    });

    assert.ok(saved, '用户级覆盖应返回保存后的配置');
    assert.equal(saved.serverUrl, 'wss://user-a.example/ws');
    assert.equal(saved.platform, 'qq');
    assert.equal(saved.os, 'Android');
    assert.equal(saved.timeZone, 'Asia/Tokyo');
    assert.equal(saved.deviceInfo.memory, '8192');

    assert.deepEqual(getUserSystemConfigOverride(USER_A), saved);
    // 不污染后台全局默认
    assert.equal(JSON.stringify(globalConfig.systemConfig), globalBefore);

    // 返回值必须是副本
    const loaded = getUserSystemConfigOverride(USER_A);
    loaded.serverUrl = 'wss://mutated.example/ws';
    loaded.deviceInfo.memory = 'mutated';
    assert.equal(getUserSystemConfigOverride(USER_A).serverUrl, 'wss://user-a.example/ws');
    assert.equal(getUserSystemConfigOverride(USER_A).deviceInfo.memory, '8192');
});

test('多个用户的运行环境互不影响，清除后回退全局默认', () => {
    setUserSystemConfigOverride(USER_A, { serverUrl: 'wss://user-a.example/ws', platform: 'qq' });
    setUserSystemConfigOverride(USER_B, { serverUrl: 'wss://user-b.example/ws', platform: 'qq' });

    assert.equal(getUserSystemConfigOverride(USER_A).serverUrl, 'wss://user-a.example/ws');
    assert.equal(getUserSystemConfigOverride(USER_B).serverUrl, 'wss://user-b.example/ws');

    setUserSystemConfigOverride(USER_B, { serverUrl: 'wss://user-b2.example/ws', platform: 'qq' });
    assert.equal(getUserSystemConfigOverride(USER_A).serverUrl, 'wss://user-a.example/ws');
    assert.equal(getUserSystemConfigOverride(USER_B).serverUrl, 'wss://user-b2.example/ws');

    assert.equal(clearUserSystemConfigOverride(USER_A), true);
    assert.equal(getUserSystemConfigOverride(USER_A), null);
    assert.equal(getUserSystemConfigOverride(USER_B).serverUrl, 'wss://user-b2.example/ws');

    assert.equal(clearUserSystemConfigOverride(USER_A), false);
    assert.equal(clearUserSystemConfigOverride(''), false);
});

test('配置快照按账号归属用户取运行环境，未设置时沿用全局', () => {
    // 账号 1 归属 USER_A；账号 2 无归属（管理员直建/历史账号）
    const owners = { 1: USER_A, 2: '' };
    const store = {
        getConfigSnapshot: () => ({}),
        getAccountOwnerUsername: (accountId) => owners[String(accountId)] || '',
        getUserSystemConfigOverride,
    };
    const runtimeState = createRuntimeState({ store });

    setUserSystemConfigOverride(USER_A, {
        serverUrl: 'wss://user-a.example/ws',
        platform: 'qq',
        os: 'Android',
        timeZone: 'Asia/Tokyo',
        deviceInfo: { clientVersion: '1.14.1.10_20260916', os: 'Android', memory: '8192' },
    });
    updateRuntimeConfig({ serverUrl: 'wss://global.example/ws', platform: 'qq', os: 'Windows' });

    const snapshotA = runtimeState.buildConfigSnapshotForAccount('1');
    assert.equal(snapshotA.systemServerUrl, 'wss://user-a.example/ws');
    assert.equal(snapshotA.systemPlatform, 'qq');
    assert.equal(snapshotA.systemTimeZone, 'Asia/Tokyo');
    assert.equal(snapshotA.systemDeviceInfo.memory, '8192');

    // 无归属账号沿用全局默认
    const snapshotB = runtimeState.buildConfigSnapshotForAccount('2');
    assert.equal(snapshotB.systemServerUrl, 'wss://global.example/ws');
    assert.equal(snapshotB.systemPlatform, 'qq');
    assert.ok(snapshotB.systemDeviceInfo, '快照应包含设备信息');

    // 快照中的设备信息为副本
    snapshotA.systemDeviceInfo.os = 'iOS';
    assert.equal(getUserSystemConfigOverride(USER_A).deviceInfo.os, 'Android');
});
