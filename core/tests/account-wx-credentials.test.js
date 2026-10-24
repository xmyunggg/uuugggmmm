const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { getDataFile } = require('../dist/config/runtime-paths');
const accountsModule = require('../dist/models/store/accounts');
const { rememberLoginCredentials } = require('../dist/services/wx-login/pending-credentials');
const { createDataProvider } = require('../dist/runtime/data-provider');

const ACCOUNTS_FILE = getDataFile('accounts.json');
const STORE_FILE = getDataFile('store.json');
const backups = [[ACCOUNTS_FILE, fs.existsSync(ACCOUNTS_FILE) ? fs.readFileSync(ACCOUNTS_FILE, 'utf8') : null],
    [STORE_FILE, fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null]];

function restore(path, content) {
    if (content === null) {
        if (fs.existsSync(path)) fs.unlinkSync(path);
    } else {
        fs.writeFileSync(path, content);
    }
}

test.after(() => {
    for (const [path, content] of backups) restore(path, content);
});

test('扫码暂存的微信凭证会被微信账号按 code 认领并落盘，但不进返回体', () => {
    const code = `claim-code-${Date.now()}`;
    assert.equal(rememberLoginCredentials(code, {
        openid: 'openid-claim',
        loginBuffer: 'login-buffer-claim',
        refreshtoken: 'refresh-token-claim',
        accesstoken: 'access-token-claim',
        nickname: '微信昵称',
    }), true);

    const result = accountsModule.addOrUpdateAccount({ name: '__cred_claim__', code, platform: 'wx' });
    const created = result.accounts.find(account => account.name === '__cred_claim__');
    assert.ok(created, '账号应已创建');

    // 对外返回体不能带长期凭证（含 openid）
    for (const field of ['loginBuffer', 'accesstoken', 'refreshtoken', 'refreshToken', 'accessToken', 'wxid']) {
        assert.equal(created[field], undefined, `返回体不应包含 ${field}`);
    }

    // 真实落盘数据保留凭证，供服务端换发 Code
    const stored = accountsModule.getAccounts().accounts.find(account => account.name === '__cred_claim__');
    assert.equal(stored.wxid, 'openid-claim');
    assert.equal(stored.loginBuffer, 'login-buffer-claim');
    assert.equal(stored.refreshtoken, 'refresh-token-claim');
    assert.equal(stored.accesstoken, 'access-token-claim');
    assert.ok(stored.credentialUpdatedAt > 0);

    // 凭证按 code 一次性消费：同一个 code 再次建号不认领
    const second = accountsModule.addOrUpdateAccount({ name: '__cred_claim_2__', code, platform: 'wx' });
    const secondAccount = second.accounts.find(account => account.name === '__cred_claim_2__');
    assert.equal(secondAccount.wxid, undefined);
    assert.equal(secondAccount.loginBuffer, undefined);
});

test('非微信账号不会认领暂存凭证', () => {
    const code = `claim-qq-code-${Date.now()}`;
    rememberLoginCredentials(code, { openid: 'openid-qq', loginBuffer: 'login-buffer-qq' });

    const result = accountsModule.addOrUpdateAccount({ name: '__cred_qq__', code, platform: 'qq' });
    const created = result.accounts.find(account => account.name === '__cred_qq__');
    assert.equal(created.wxid, undefined);
    assert.equal(created.loginBuffer, undefined);
});

test('stripAccountSecrets 剔除长期凭证与 openid，保留 code', () => {
    const stripped = accountsModule.stripAccountSecrets({
        id: '1',
        name: '账号',
        code: 'game-code',
        wxid: 'openid-1',
        loginBuffer: 'lb',
        refreshtoken: 'rt',
        accesstoken: 'at',
    });
    assert.deepEqual(stripped, { id: '1', name: '账号', code: 'game-code' });
});

test('provider.getAccounts 返回给面板的账号列表不含微信长期凭证与 openid', () => {
    const code = `claim-provider-code-${Date.now()}`;
    rememberLoginCredentials(code, { openid: 'openid-provider', loginBuffer: 'login-buffer-provider', refreshtoken: 'rt' });
    accountsModule.addOrUpdateAccount({ name: '__cred_provider__', code, platform: 'wx' });

    const provider = createDataProvider({
        workers: {},
        globalLogs: [],
        accountLogs: [],
        store: require('../dist/models/store'),
        getAccounts: require('../dist/models/store').getAccounts,
    });
    const data = provider.getAccounts();
    assert.ok(data.accounts.length > 0);
    for (const account of data.accounts) {
        for (const field of ['loginBuffer', 'accesstoken', 'refreshtoken']) {
            assert.equal(account[field], undefined, `面板数据不应包含 ${field}`);
        }
    }
});
