const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
    globalConfig,
} = require('../dist/models/store/shared-state');
const {
    getOfflineReminder,
    setOfflineReminder,
    getUserOfflineReminderOverride,
    setUserOfflineReminderOverride,
    clearUserOfflineReminderOverride,
    getOfflineReminderForAccount,
} = require('../dist/models/store/global-config');
const accountsModule = require('../dist/models/store/accounts');

const USER_A = '__offline_reminder_user_a__';
const USER_B = '__offline_reminder_user_b__';

// 用户级下线提醒读写会落盘到 store.json，测试前后备份/还原，避免污染真实配置
const STORE_FILE = require('../dist/config/runtime-paths').getDataFile('store.json');
const storeFileExisted = fs.existsSync(STORE_FILE);
const originalStoreJson = storeFileExisted ? fs.readFileSync(STORE_FILE, 'utf8') : '';
const originalGlobalOfflineReminder = JSON.parse(JSON.stringify(globalConfig.offlineReminder || {}));
const originalGetAccountOwnerUsername = accountsModule.getAccountOwnerUsername;

function restoreStoreFile() {
    if (storeFileExisted) {
        fs.writeFileSync(STORE_FILE, originalStoreJson);
    } else if (fs.existsSync(STORE_FILE)) {
        fs.unlinkSync(STORE_FILE);
    }
}

function cleanupUser(username) {
    delete globalConfig.userOfflineReminders[username];
}

test.after(() => {
    cleanupUser(USER_A);
    cleanupUser(USER_B);
    globalConfig.offlineReminder = originalGlobalOfflineReminder;
    accountsModule.getAccountOwnerUsername = originalGetAccountOwnerUsername;
    restoreStoreFile();
});

test('用户默认不设置下线提醒覆盖', () => {
    assert.equal(getUserOfflineReminderOverride(USER_A), null);
    assert.equal(getUserOfflineReminderOverride(''), null);
    assert.equal(getUserOfflineReminderOverride(undefined), null);
});

test('用户级下线提醒独立于后台全局默认', () => {
    const globalBefore = JSON.stringify(globalConfig.offlineReminder);
    const saved = setUserOfflineReminderOverride(USER_A, {
        channel: 'dingtalk',
        endpoint: 'https://oapi.dingtalk.com/robot/send?access_token=user-a',
        secret: 'SECuser-a',
        title: '用户A下线提醒',
        msg: '用户A账号下线',
        offlineDeleteSec: 600,
    });

    assert.ok(saved, '用户级覆盖应返回保存后的配置');
    assert.equal(saved.channel, 'dingtalk');
    assert.equal(saved.endpoint, 'https://oapi.dingtalk.com/robot/send?access_token=user-a');
    assert.equal(saved.title, '用户A下线提醒');
    assert.equal(saved.offlineDeleteSec, 600);

    assert.deepEqual(getUserOfflineReminderOverride(USER_A), saved);
    // 不污染后台全局默认
    assert.equal(JSON.stringify(globalConfig.offlineReminder), globalBefore);

    // 返回值必须是副本
    const loaded = getUserOfflineReminderOverride(USER_A);
    loaded.title = 'mutated';
    loaded.offlineDeleteSec = 1;
    assert.equal(getUserOfflineReminderOverride(USER_A).title, '用户A下线提醒');
    assert.equal(getUserOfflineReminderOverride(USER_A).offlineDeleteSec, 600);
});

test('未提供的字段沿用当前生效值，多用户互不影响，清除后回退全局默认', () => {
    setOfflineReminder({
        channel: 'webhook',
        endpoint: 'https://global.example/hook',
        title: '全局下线提醒',
        msg: '全局账号下线',
        offlineDeleteSec: 0,
    });

    clearUserOfflineReminderOverride(USER_A);
    setUserOfflineReminderOverride(USER_A, { channel: 'webhook', endpoint: 'https://user-a.example/hook' });
    setUserOfflineReminderOverride(USER_B, { channel: 'webhook', endpoint: 'https://user-b.example/hook' });

    // 只改 endpoint 时，title/msg 继承当前生效值（首次保存继承全局默认）
    assert.equal(getUserOfflineReminderOverride(USER_A).title, '全局下线提醒');
    assert.equal(getUserOfflineReminderOverride(USER_A).endpoint, 'https://user-a.example/hook');
    assert.equal(getUserOfflineReminderOverride(USER_B).endpoint, 'https://user-b.example/hook');

    // 已单独设置的用户再次保存时继承自己的值
    setUserOfflineReminderOverride(USER_A, { title: '用户A标题' });
    assert.equal(getUserOfflineReminderOverride(USER_A).title, '用户A标题');
    assert.equal(getUserOfflineReminderOverride(USER_A).endpoint, 'https://user-a.example/hook');
    assert.equal(getUserOfflineReminderOverride(USER_B).title, '全局下线提醒');

    assert.equal(clearUserOfflineReminderOverride(USER_A), true);
    assert.equal(getUserOfflineReminderOverride(USER_A), null);
    assert.equal(getUserOfflineReminderOverride(USER_B).endpoint, 'https://user-b.example/hook');

    assert.equal(clearUserOfflineReminderOverride(USER_A), false);
    assert.equal(clearUserOfflineReminderOverride(''), false);
});

test('按账号归属用户解析下线提醒，未设置或无归属时沿用全局默认', () => {
    const owners = { '1': USER_A, '2': '' };
    accountsModule.getAccountOwnerUsername = (accountId) => owners[String(accountId)] || '';

    setOfflineReminder({
        channel: 'webhook',
        endpoint: 'https://global.example/hook',
        title: '全局下线提醒',
        msg: '全局账号下线',
        offlineDeleteSec: 0,
    });
    clearUserOfflineReminderOverride(USER_A);
    setUserOfflineReminderOverride(USER_A, {
        channel: 'dingtalk',
        endpoint: 'https://oapi.dingtalk.com/robot/send?access_token=user-a',
        title: '用户A下线提醒',
        msg: '用户A账号下线',
        offlineDeleteSec: 600,
    });

    const owned = getOfflineReminderForAccount('1');
    assert.equal(owned.channel, 'dingtalk');
    assert.equal(owned.title, '用户A下线提醒');
    assert.equal(owned.offlineDeleteSec, 600);

    // 无归属账号沿用全局默认
    const unowned = getOfflineReminderForAccount('2');
    assert.equal(unowned.channel, 'webhook');
    assert.equal(unowned.endpoint, 'https://global.example/hook');
    assert.equal(unowned.offlineDeleteSec, 0);

    // 归属用户清空后回退全局默认
    clearUserOfflineReminderOverride(USER_A);
    const fallback = getOfflineReminderForAccount('1');
    assert.equal(fallback.channel, 'webhook');
    assert.equal(fallback.endpoint, 'https://global.example/hook');

    // 返回副本，改它不影响已存配置
    const copy = getOfflineReminderForAccount('2');
    copy.title = 'mutated';
    assert.deepEqual(getOfflineReminderForAccount('2').title, '全局下线提醒');
});

test('下线提醒服务按账号归属用户取配置并推送', async () => {
    const { createReloginReminderService } = require('../dist/runtime/relogin-reminder');

    const owners = { '1': USER_A, '2': '' };
    accountsModule.getAccountOwnerUsername = (accountId) => owners[String(accountId)] || '';

    setOfflineReminder({
        channel: 'webhook',
        endpoint: 'https://global.example/hook',
        token: '',
        secret: '',
        title: '全局下线提醒',
        msg: '全局账号下线',
        offlineDeleteSec: 0,
    });
    setUserOfflineReminderOverride(USER_A, {
        channel: 'webhook',
        endpoint: 'https://user-a.example/hook',
        token: '',
        secret: '',
        title: '用户A下线提醒',
        msg: '用户A账号下线',
        offlineDeleteSec: 600,
    });

    const sent = [];
    const service = createReloginReminderService({
        store: { getOfflineReminderForAccount, getOfflineReminder },
        sendPushooMessage: async (payload) => { sent.push(payload); return { ok: true }; },
        log: () => {},
    });

    // 离线自动删除时长按账号归属用户取值（0 表示不删除）
    assert.equal(service.getOfflineAutoDeleteMs('1'), 600 * 1000);
    assert.equal(service.getOfflineAutoDeleteMs('2'), Infinity);

    // 推送使用账号归属用户的配置
    await service.triggerOfflineReminder({ accountId: '1', accountName: '账号A', reason: 'ws_close' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, 'https://user-a.example/hook');
    assert.equal(sent[0].title, '用户A下线提醒 账号A');
    assert.match(sent[0].content, /用户A账号下线/);

    // 无归属账号沿用全局默认
    await service.triggerOfflineReminder({ accountId: '2', accountName: '账号B', reason: 'ws_close' });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].endpoint, 'https://global.example/hook');
    assert.equal(sent[1].title, '全局下线提醒 账号B');
    assert.match(sent[1].content, /全局账号下线/);

    // 事件提醒（push_notify）同样按账号取值
    await service.sendConfiguredPush({ accountId: '1', accountName: '账号A', title: '事件', content: '内容' });
    assert.equal(sent.length, 3);
    assert.equal(sent[2].endpoint, 'https://user-a.example/hook');
});
