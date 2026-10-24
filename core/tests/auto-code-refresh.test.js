const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAutoCodeRefreshService } = require('../dist/runtime/auto-code-refresh');
const { WxLoginService } = require('../dist/services/wx-login/service');
const { getSchedulerRegistrySnapshot } = require('../dist/services/scheduler');

const WX_ACCOUNT = {
    id: 'wx-1',
    name: '微信号',
    platform: 'wx',
    wxid: 'openid-1',
    loginBuffer: 'login-buffer-1',
    accesstoken: 'access-token-1',
    refreshtoken: 'refresh-token-1',
    code: 'old-code',
};

const QQ_ACCOUNT = {
    id: 'qq-1',
    name: 'QQ号',
    platform: 'qq',
    code: 'qq-code',
};

// 定时任务会持有 setInterval，测试结束必须显式清理，否则 node --test 无法退出
const harnesses = [];

// ==================== 接口层：手动刷新入口 ====================

const ROUTES_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'admin', 'account-routes.ts'), 'utf8');

test('暴露单账号刷新接口，且与批量接口共用同一套校验', () => {
    assert.match(ROUTES_SOURCE, /app\.post\('\/api\/accounts\/refresh-wx-codes'/);
    assert.match(ROUTES_SOURCE, /app\.post\('\/api\/accounts\/:id\/refresh-wx-code'/);
    // 两个入口都必须走 refreshWxAccounts，避免校验逻辑分叉
    const single = ROUTES_SOURCE.slice(ROUTES_SOURCE.indexOf("'/api/accounts/:id/refresh-wx-code'"));
    assert.match(single.slice(0, 1200), /refreshWxAccounts\(\[target\]\)/);
    assert.match(ROUTES_SOURCE, /async function refreshWxAccounts/);
});

test('单账号接口做归属校验，不能越权刷别人的账号', () => {
    const single = ROUTES_SOURCE.slice(ROUTES_SOURCE.indexOf("'/api/accounts/:id/refresh-wx-code'"));
    const body = single.slice(0, 1200);
    assert.match(body, /canAccessAccount\(req, accountId\)/);
    assert.match(body, /403/);
});

test('刷新入口把凭证缺失与平台不符都算作跳过，不去发无意义请求', () => {
    const helper = ROUTES_SOURCE.slice(
        ROUTES_SOURCE.indexOf('async function refreshWxAccounts'),
        ROUTES_SOURCE.indexOf("'/api/accounts/refresh-wx-codes'"),
    );
    assert.match(helper, /不是微信账号/);
    assert.match(helper, /缺少微信凭证/);
    assert.match(helper, /skipped: true/);
    // 只有确实具备凭证的微信账号才调用刷新
    assert.match(helper, /await ctx\.provider\.refreshAccountCode\(accountId\)/);
});

const AUTO_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'auto-code-refresh.ts'), 'utf8');

test('手动刷新绕过开关与熔断，但仍要求扫码凭证', () => {
    const fn = AUTO_SOURCE.slice(
        AUTO_SOURCE.indexOf('async function refreshAccountCode'),
        AUTO_SOURCE.indexOf('/** 掉线/登录失效后延迟重登'),
    );
    assert.match(fn, /const manual = reason === 'manual'/);
    assert.match(fn, /manual \? !hasWxCredentials\(account\) : !isEligible\(account\)/);
    // 熔断只挂在恢复类原因上，手动不应被 blocked 拦住
    assert.match(fn, /const recovery = isRecoveryReason\(reason\) \? getRecoveryState\(accountId\) : null/);
});

test('自动调度仍然只看开关，手动开放不会顺带打开自动刷新', () => {
    const eligible = AUTO_SOURCE.slice(
        AUTO_SOURCE.indexOf('function isEligible'),
        AUTO_SOURCE.indexOf('async function refreshAccountCode'),
    );
    assert.match(eligible, /hasWxCredentials\(account\)/);
    assert.match(eligible, /getConfig\(account\.id\)\.enabled/);
    // scheduleAccount 必须继续受 enabled 约束（定时刷新任务只在开关打开时挂）
    const schedule = AUTO_SOURCE.slice(
        AUTO_SOURCE.indexOf('function scheduleAccount'),
        AUTO_SOURCE.indexOf('function rescheduleAll'),
    );
    assert.match(schedule, /if \(!cfg\.enabled\)/);
    assert.match(schedule, /scheduler\.setIntervalTask\(refreshTaskName\(accountId\)/);
    // enabled 判断必须在挂定时刷新之前，否则开关形同虚设
    assert.ok(
        schedule.indexOf('if (!cfg.enabled)') < schedule.indexOf('scheduler.setIntervalTask(refreshTaskName(accountId)'),
        '开关判断应早于定时刷新任务的注册',
    );
});

// ==================== 三、手动刷新端到端 ====================

test('开着开关与关着开关，手动刷新结果一致', async () => {
    const results = [];
    for (const enabled of [true, false]) {
        const harness = createHarness({ config: { enabled, intervalMinutes: 60 } });
        const originalIssueCode = WxLoginService.prototype.issueCode;
        WxLoginService.prototype.issueCode = async () => `code-${enabled}`;
        try {
            results.push(await harness.service.refreshAccountCode('wx-1', 'manual'));
        }
        finally {
            WxLoginService.prototype.issueCode = originalIssueCode;
        }
    }
    assert.deepEqual(results, [true, true], '手动刷新不应受开关影响');
});

test.after(() => {
    for (const harness of harnesses) {
        for (const account of harness.accounts) harness.service.stopAccount(account.id);
    }
});

function createHarness(options = {}) {
    // 每个 harness 用独立副本，避免用例之间通过账号对象串状态
    const accounts = (options.accounts || [WX_ACCOUNT, QQ_ACCOUNT]).map(account => ({ ...account }));
    const updated = [];
    const logs = [];
    const accountLogs = [];
    const restarted = [];
    const started = [];
    const config = options.config || { enabled: true, intervalMinutes: 60 };

    const service = createAutoCodeRefreshService({
        store: {
            getAutoCodeRefreshConfig: () => ({ ...config }),
            getAccounts: () => ({ accounts }),
        },
        getAccounts: () => ({ accounts }),
        addOrUpdateAccount: (patch) => {
            updated.push(patch);
            const target = accounts.find(account => account.id === patch.id);
            if (target) Object.assign(target, patch);
            return { accounts };
        },
        resolveWorkerControls: () => ({
            startWorker: (account) => { started.push(account); return true; },
            stopWorker: () => {},
            restartWorker: (account) => { restarted.push(account); },
        }),
        log: (tag, msg) => { logs.push({ tag, msg }); },
        addAccountLog: (action, msg) => { accountLogs.push({ action, msg }); },
    });

    const harness = { service, accounts, updated, logs, accountLogs, restarted, started };
    harnesses.push(harness);
    return harness;
}

function schedulerTasks(namespace) {
    const snapshot = getSchedulerRegistrySnapshot(namespace);
    const entry = snapshot.schedulers[0];
    return entry ? entry.tasks.map(task => task.name) : [];
}

/**
 * 用假的 scheduler 重新加载一份 auto-code-refresh，把定时任务的回调本体抓出来。
 * 真实 scheduler 只暴露任务名，保活这类「到点才跑」的逻辑需要手动触发回调来断言。
 */
function loadServiceCapturingRunners() {
    const schedulerPath = require.resolve('../dist/services/scheduler');
    const autoPath = require.resolve('../dist/runtime/auto-code-refresh');
    const runners = new Map();
    const stub = {
        createScheduler: () => ({
            setTimeoutTask: (name, _delay, runner) => { runners.set(String(name), runner); return 1; },
            setIntervalTask: (name, _delay, runner) => { runners.set(String(name), runner); return 1; },
            clear: name => { runners.delete(String(name)); },
            clearAll: () => runners.clear(),
            has: name => runners.has(String(name)),
            getTaskNames: () => [...runners.keys()],
            getSnapshot: () => ({ namespace: 'auto_code_refresh', createdAt: 0, taskCount: runners.size, tasks: [] }),
        }),
    };
    const originalScheduler = require.cache[schedulerPath];
    require.cache[schedulerPath] = { id: schedulerPath, filename: schedulerPath, loaded: true, exports: stub, paths: [] };
    delete require.cache[autoPath];
    let loaded;
    try {
        loaded = require('../dist/runtime/auto-code-refresh');
    }
    finally {
        if (originalScheduler) require.cache[schedulerPath] = originalScheduler;
        else delete require.cache[schedulerPath];
        delete require.cache[autoPath];
    }
    return { createAutoCodeRefreshService: loaded.createAutoCodeRefreshService, runners };
}

test('开关关闭时自动路径全部静默跳过，手动刷新仍然可用', async () => {
    const harness = createHarness({ config: { enabled: false, intervalMinutes: 60 } });
    const originalIssueCode = WxLoginService.prototype.issueCode;
    WxLoginService.prototype.issueCode = async () => 'new-code';
    try {
        // 自动路径：定时/掉线都不应发请求
        assert.equal(await harness.service.refreshAccountCode('wx-1', 'timer'), false);
        assert.equal(await harness.service.refreshAccountCode('wx-1', 'disconnect:ws_close'), false);
        assert.equal(harness.service.scheduleRelogin('wx-1', 'disconnect:ws_close'), false);
        assert.deepEqual(harness.updated, [], '关闭时自动路径不应换 Code');

        // 手动路径：用户在面板上主动点，应当可直接成功
        assert.equal(await harness.service.refreshAccountCode('wx-1', 'manual'), true);
        assert.deepEqual(harness.updated, [{ id: 'wx-1', code: 'new-code' }]);
        assert.deepEqual(harness.restarted.map(account => account.code), ['new-code']);
        assert.equal(harness.accountLogs.at(-1).action, 'auto_code_refresh');
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
    }
});

test('手动刷新同样要求微信扫码凭证，缺凭证或非微信账号直接拒绝', async () => {
    const harness = createHarness({
        accounts: [
            { id: 'wx-2', name: '半成品', platform: 'wx', code: 'old', wxid: 'openid-2' },
            QQ_ACCOUNT,
        ],
        config: { enabled: false, intervalMinutes: 60 },
    });
    const originalIssueCode = WxLoginService.prototype.issueCode;
    WxLoginService.prototype.issueCode = async () => 'new-code';
    try {
        // 缺 loginBuffer、QQ 账号：手动也不应空跑
        assert.equal(await harness.service.refreshAccountCode('wx-2', 'manual'), false);
        assert.equal(await harness.service.refreshAccountCode('qq-1', 'manual'), false);
        assert.deepEqual(harness.updated, []);
        assert.deepEqual(harness.restarted, []);
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
    }
});

test('QQ 账号不参与自动刷新，也不占用调度任务', async () => {
    const harness = createHarness({ accounts: [QQ_ACCOUNT] });
    assert.equal(await harness.service.refreshAccountCode('qq-1', 'disconnect:ws_close'), false);
    assert.equal(harness.service.scheduleRelogin('qq-1', 'disconnect:ws_close'), false);

    harness.service.rescheduleAll();
    assert.deepEqual(schedulerTasks('auto_code_refresh'), []);
});

test('微信账号缺凭证时不会空跑，报错但不动 worker', async () => {
    const harness = createHarness({
        accounts: [{ id: 'wx-2', name: '半成品', platform: 'wx', code: 'old', wxid: 'openid-2' }],
    });
    assert.equal(harness.service.scheduleRelogin('wx-2', 'disconnect:ws_close'), false);
    assert.equal(harness.service.scheduleRelogin('wx-3', 'disconnect:ws_close'), false);
    assert.deepEqual(harness.restarted, []);
});

test('被踢下线不自动重登，同时暂停自动刷新任务', () => {
    const harness = createHarness();
    harness.service.scheduleAccount('wx-1');
    assert.ok(schedulerTasks('auto_code_refresh').includes('refresh_wx-1'));

    assert.equal(harness.service.scheduleRelogin('wx-1', 'kickout:其他终端登录'), false);
    assert.deepEqual(schedulerTasks('auto_code_refresh').filter(name => name.includes('wx-1')), []);
    assert.equal(harness.accountLogs.at(-1).action, 'auto_relogin_skipped');
});

test('掉线后按延迟排定重登，主动停止会撤销未执行的重登', () => {
    const harness = createHarness();
    assert.equal(harness.service.scheduleRelogin('wx-1', 'disconnect:ws_close'), true);
    assert.ok(schedulerTasks('auto_code_refresh').includes('relogin_wx-1'));

    harness.service.stopAccount('wx-1');
    assert.deepEqual(schedulerTasks('auto_code_refresh').filter(name => name.includes('wx-1')), []);
});

test('凭证保活的回调即使开关关闭也会真正续期并落盘', async () => {
    // 回归：保活任务曾用 isEligible（含开关）做守卫，导致关闭开关后
    // refresh token 不再轮换、最终失效，连手动刷新都会跟着失败。
    const { createAutoCodeRefreshService: create, runners } = loadServiceCapturingRunners();
    const accounts = [{ id: 'wx-1', name: '微信号', platform: 'wx', wxid: 'openid-1', loginBuffer: 'lb-1', refreshtoken: 'rt-1', accesstoken: 'at-1' }];
    const updated = [];
    const service = create({
        store: { getAutoCodeRefreshConfig: () => ({ enabled: false, intervalMinutes: 30 }) },
        getAccounts: () => ({ accounts }),
        addOrUpdateAccount: (patch) => { updated.push(patch); return { accounts }; },
        resolveWorkerControls: () => ({}),
        log: () => {},
        addAccountLog: () => {},
    });

    const originalRefresh = WxLoginService.prototype.refreshLoginBuffer;
    let refreshCalls = 0;
    WxLoginService.prototype.refreshLoginBuffer = async () => {
        refreshCalls += 1;
        return { openid: 'openid-1', loginBuffer: 'lb-2', refreshtoken: 'rt-2', accesstoken: 'at-2' };
    };
    try {
        service.scheduleAccount('wx-1');
        const runner = runners.get('wx_keepalive_wx-1');
        assert.ok(runner, '关闭开关后仍应注册凭证保活任务');
        await runner();

        assert.equal(refreshCalls, 1, '关闭开关后保活仍必须调用续期');
        assert.equal(updated.length, 1, '滚动后的凭证必须落盘');
        assert.equal(updated[0].refreshtoken, 'rt-2');
        assert.equal(updated[0].accesstoken, 'at-2');
        assert.ok(updated[0].credentialUpdatedAt > 0);
    }
    finally {
        WxLoginService.prototype.refreshLoginBuffer = originalRefresh;
        service.stopAccount('wx-1');
    }
});

test('续期失败按原因分级：token 失效才提示重新扫码，invalid scope 提示可重试', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'auto-code-refresh.ts'), 'utf8');
    const describe = source.slice(source.indexOf('function describeCredentialError'), source.indexOf('function createAutoCodeRefreshService'));
    assert.match(describe, /isRefreshTokenDead\(message\)/);
    assert.match(describe, /请重新扫码登录/);
    assert.match(describe, /isTransientCredentialRejection\(message\)/);
    assert.match(describe, /可稍后重试/);

    // 判据必须能覆盖真实日志里的两种错误
    const dead = source.slice(source.indexOf('function isRefreshTokenDead'), source.indexOf('function isTransientCredentialRejection'));
    assert.match(dead, /-109|RC_PARAMS_INVALID/);
    const transient = source.slice(source.indexOf('function isTransientCredentialRejection'), source.indexOf('function describeCredentialError'));
    assert.match(transient, /invalid scope|40188/);

    // 续期失败路径要使用分级文案，而不是直接透传原始 message
    const issue = source.slice(source.indexOf('async function issueFarmCode'), source.indexOf('async function refreshAccountCode'));
    assert.match(issue, /describeCredentialError\(refreshError\)/);
});

test('换 Code 成功后落盘并重启账号', async () => {
    const harness = createHarness();
    const originalIssueCode = WxLoginService.prototype.issueCode;
    WxLoginService.prototype.issueCode = async () => 'new-code';
    try {
        assert.equal(await harness.service.refreshAccountCode('wx-1', 'timer'), true);
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
    }

    assert.deepEqual(harness.updated, [{ id: 'wx-1', code: 'new-code' }]);
    assert.deepEqual(harness.restarted.map(account => account.code), ['new-code']);
    assert.equal(harness.accountLogs.at(-1).action, 'auto_code_refresh');
});

test('loginBuffer 失效时自动续期重试，并落盘滚动后的凭证', async () => {
    const harness = createHarness();
    const originalIssueCode = WxLoginService.prototype.issueCode;
    const originalRefresh = WxLoginService.prototype.refreshLoginBuffer;
    const issueCalls = [];
    WxLoginService.prototype.issueCode = async (session) => {
        issueCalls.push(session.loginBuffer);
        if (session.loginBuffer === 'login-buffer-1') throw new Error('ManualAuth rejected: code=1 message=expired');
        return 'new-code';
    };
    WxLoginService.prototype.refreshLoginBuffer = async () => ({
        openid: 'openid-1',
        loginBuffer: 'login-buffer-2',
        refreshtoken: 'refresh-token-2',
        accesstoken: 'access-token-2',
    });
    try {
        assert.equal(await harness.service.refreshAccountCode('wx-1', 'ws_400'), true);
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
        WxLoginService.prototype.refreshLoginBuffer = originalRefresh;
    }

    assert.deepEqual(issueCalls, ['login-buffer-1', 'login-buffer-2']);
    assert.deepEqual(harness.updated, [
        {
            id: 'wx-1',
            loginBuffer: 'login-buffer-2',
            refreshtoken: 'refresh-token-2',
            accesstoken: 'access-token-2',
            credentialUpdatedAt: harness.updated[0].credentialUpdatedAt,
        },
        { id: 'wx-1', code: 'new-code' },
    ]);
    assert.ok(harness.updated[0].credentialUpdatedAt > 0);
});

test('续期失败但凭证已滚动时，仍要落盘新 token 避免下次续期断裂', async () => {
    const harness = createHarness();
    const originalIssueCode = WxLoginService.prototype.issueCode;
    const originalRefresh = WxLoginService.prototype.refreshLoginBuffer;
    WxLoginService.prototype.issueCode = async () => { throw new Error('ManualAuth rejected: code=1 message=expired'); };
    WxLoginService.prototype.refreshLoginBuffer = async () => {
        const error = new Error('WeChat login buffer refresh failed: code=-1');
        error.refreshtoken = 'refresh-token-2';
        error.accesstoken = 'access-token-2';
        throw error;
    };
    try {
        assert.equal(await harness.service.refreshAccountCode('wx-1', 'ws_400'), false);
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
        WxLoginService.prototype.refreshLoginBuffer = originalRefresh;
    }

    assert.deepEqual(harness.updated, [
        {
            id: 'wx-1',
            refreshtoken: 'refresh-token-2',
            accesstoken: 'access-token-2',
            credentialUpdatedAt: harness.updated[0].credentialUpdatedAt,
        },
    ]);
    assert.ok(harness.updated[0].credentialUpdatedAt > 0);
    assert.equal(harness.accountLogs.at(-1).action, 'auto_code_refresh_failed');
});

test('连续失败触发熔断，暂停自动重登并写审计日志', async () => {
    const harness = createHarness();
    const originalIssueCode = WxLoginService.prototype.issueCode;
    WxLoginService.prototype.issueCode = async () => { throw new Error('无法连接微信服务器'); };
    try {
        for (let i = 0; i < 3; i += 1) {
            assert.equal(await harness.service.refreshAccountCode('wx-1', 'disconnect:ws_close'), false);
        }
        const status = harness.service.getAccountStatus('wx-1');
        assert.equal(status.attempts, 3);
        assert.equal(status.failures, 3);
        assert.equal(status.blocked, true);

        assert.equal(await harness.service.refreshAccountCode('wx-1', 'disconnect:ws_close'), false);
        assert.equal(harness.accountLogs.at(-1).action, 'auto_relogin_blocked');
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
    }
    // 熔断后不再排定新的重登
    assert.equal(harness.service.scheduleRelogin('wx-1', 'disconnect:ws_close'), false);
});

test('启动前准备：微信账号换新 Code 后返回新账号对象，失败时退回原账号', async () => {
    const harness = createHarness();
    const originalIssueCode = WxLoginService.prototype.issueCode;
    WxLoginService.prototype.issueCode = async () => 'boot-code';
    let prepared;
    try {
        prepared = await harness.service.prepareAccountForStart(harness.accounts[0]);
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
    }
    assert.equal(prepared.code, 'boot-code');
    assert.deepEqual(harness.updated, [{ id: 'wx-1', code: 'boot-code' }]);

    WxLoginService.prototype.issueCode = async () => { throw new Error('网络不可用'); };
    let fallback;
    try {
        fallback = await harness.service.prepareAccountForStart(harness.accounts[0]);
    }
    finally {
        WxLoginService.prototype.issueCode = originalIssueCode;
    }
    assert.equal(fallback.id, 'wx-1');
    assert.equal(harness.accountLogs.at(-1).action, 'auto_code_refresh_failed');

    // QQ 账号直接返回，不触发任何请求
    const qqPrepared = await harness.service.prepareAccountForStart(harness.accounts[1]);
    assert.equal(qqPrepared.code, 'qq-code');
});

test('开关关闭时不排定定时刷新，凭证保活仍保留；重新打开后恢复定时刷新', async () => {
    const config = { enabled: false, intervalMinutes: 30 };
    const harness = createHarness({ config });
    harness.service.scheduleAccount('wx-1');
    const disabledTasks = schedulerTasks('auto_code_refresh');
    assert.ok(!disabledTasks.includes('refresh_wx-1'));
    // 凭证保活只轮换凭证、不重连，与定时刷新开关解耦
    assert.ok(disabledTasks.includes('wx_keepalive_wx-1'));

    config.enabled = true;
    harness.service.scheduleAccount('wx-1');
    const tasks = schedulerTasks('auto_code_refresh');
    assert.ok(tasks.includes('refresh_wx-1'));
    assert.ok(tasks.includes('wx_keepalive_wx-1'));
    assert.ok(!tasks.includes('relogin_wx-1'));
});
