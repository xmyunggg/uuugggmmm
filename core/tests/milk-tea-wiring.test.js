const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { AUTOMATION_KEYS, HIRE_DURATIONS, HIRE_TALENTS } = require('../dist/services/milk-tea-auto');

// ==================== 一、账号级配置（落盘） ====================

const { getDataFile } = require('../dist/config/runtime-paths');
const store = require('../dist/models/store');

// 配置读写会写 store.json，测试前后备份还原，避免污染真实配置
const STORE_FILE = getDataFile('store.json');
const storeFileBackup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;

test.after(() => {
    if (storeFileBackup === null) {
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
    }
    else {
        fs.writeFileSync(STORE_FILE, storeFileBackup);
    }
});

const MILK_TEA_KEYS = Object.values(AUTOMATION_KEYS);

test('奶茶热销中十一个开关默认全部关闭，雇佣参数为默认档', () => {
    const snapshot = store.getConfigSnapshot();
    for (const key of MILK_TEA_KEYS) {
        assert.equal(snapshot.automation[key], false, `${key} 默认应为 false`);
    }
    assert.equal(snapshot.automation.milk_tea_hire_duration, 1);
    assert.equal(snapshot.automation.milk_tea_hire_talent, 0);
});

// 实时配置里奶茶开关可能已经被打开，先落一个已知基线，避免断言依赖运行环境
function milkTeaBaseline() {
    const baseline = { milk_tea_hire_duration: 1, milk_tea_hire_talent: 0 };
    for (const key of MILK_TEA_KEYS) baseline[key] = false;
    return baseline;
}

test('开关随 automation 一起读写', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    assert.ok(accountId, '测试环境需要一个账号用于读写账号级配置');
    const baseline = milkTeaBaseline();
    try {
        store.applyConfigSnapshot({ automation: baseline }, { accountId });
        for (const key of MILK_TEA_KEYS) {
            assert.equal(store.isAutomationOn(key, accountId), false, `${key} 基线应为 false`);
        }

        store.applyConfigSnapshot({ automation: { [AUTOMATION_KEYS.cashier]: true, [AUTOMATION_KEYS.hire]: true } }, { accountId });
        assert.equal(store.isAutomationOn(AUTOMATION_KEYS.cashier, accountId), true);
        assert.equal(store.isAutomationOn(AUTOMATION_KEYS.hire, accountId), true);
        assert.equal(store.isAutomationOn(AUTOMATION_KEYS.craft, accountId), false);

        store.applyConfigSnapshot({ automation: { [AUTOMATION_KEYS.cashier]: false } }, { accountId });
        assert.equal(store.isAutomationOn(AUTOMATION_KEYS.cashier, accountId), false);
    }
    finally {
        store.applyConfigSnapshot({ automation: baseline }, { accountId });
    }
});

test('雇佣时长/员工类型按数值保存并拒绝非法值', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    assert.ok(accountId);
    try {
        store.applyConfigSnapshot({ automation: { milk_tea_hire_duration: '3', milk_tea_hire_talent: '9002' } }, { accountId });
        assert.equal(store.getAutomation(accountId).milk_tea_hire_duration, 3);
        assert.equal(store.getAutomation(accountId).milk_tea_hire_talent, 9002);

        store.applyConfigSnapshot({ automation: { milk_tea_hire_duration: 9, milk_tea_hire_talent: 5 } }, { accountId });
        assert.equal(store.getAutomation(accountId).milk_tea_hire_duration, 3);
        assert.equal(store.getAutomation(accountId).milk_tea_hire_talent, 9002);
    }
    finally {
        store.applyConfigSnapshot({ automation: { milk_tea_hire_duration: 1, milk_tea_hire_talent: 0 } }, { accountId });
    }
});

test('旧配置缺少奶茶字段时补齐默认值', () => {
    const accountId = store.getAccounts().accounts?.[0]?.id;
    const baseline = milkTeaBaseline();
    try {
        store.applyConfigSnapshot({ automation: baseline }, { accountId });
        const legacy = { automation: { farm: true, friend_steal: true } };
        const merged = store.applyConfigSnapshot(legacy, { accountId, persist: false });
        // 旧配置没带奶茶字段，合并结果里应仍然齐备且是默认档
        for (const key of MILK_TEA_KEYS) {
            assert.ok(key in merged.automation, `${key} 应出现在合并结果里`);
            assert.equal(merged.automation[key], false, `${key} 应保持默认 false`);
        }
        assert.equal(merged.automation.milk_tea_hire_duration, 1);
        assert.equal(merged.automation.milk_tea_hire_talent, 0);
    }
    finally {
        store.applyConfigSnapshot({ automation: baseline }, { accountId });
    }
});

test('默认配置（/api/settings/default）也带奶茶字段', () => {
    const defaults = store.getDefaultAccountConfig();
    for (const key of MILK_TEA_KEYS) {
        assert.equal(defaults.automation[key], false, `${key} 默认应为 false`);
    }
    assert.equal(defaults.automation.milk_tea_hire_duration, 1);
    assert.equal(defaults.automation.milk_tea_hire_talent, 0);
});

// ==================== 二、worker 接线 ====================

const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'worker.ts'), 'utf8');

test('worker 启动序列挂上奶茶定时器，并在配置变化时重建', () => {
    assert.match(WORKER_SOURCE, /startMilkTeaTimer\(true\);/);
    assert.match(WORKER_SOURCE, /milk_tea_interval/);
    assert.match(WORKER_SOURCE, /milk_tea_immediate/);
    assert.match(WORKER_SOURCE, /runMilkTeaAutoTick\(\{ force: true \}\)/);
});

test('定时器跑在自动化互斥锁里且登录前不触发', () => {
    assert.match(WORKER_SOURCE, /runExclusiveAutomationTask\('milk_tea_auto'/);
    const tick = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf('function runMilkTeaAutoTick'));
    assert.match(tick.slice(0, 400), /if \(!loginReady\) return Promise\.resolve\(\);/);
});

test('配置变化会一并比较雇佣时长/员工类型', () => {
    assert.match(WORKER_SOURCE, /milk_tea_hire_duration/);
    assert.match(WORKER_SOURCE, /milk_tea_hire_talent/);
});

// ==================== 三、自动化服务契约 ====================

const autoSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'milk-tea-auto.ts'), 'utf8');

test('自动服务复用活动中心已有的手动能力，不重复实现协议', () => {
    assert.match(autoSource, /getMilkTeaActivity/);
    assert.match(autoSource, /operateMilkTeaActivity/);
    assert.doesNotMatch(autoSource, /sendMsgAsync/, '不应该自己发协议请求');
    assert.doesNotMatch(autoSource, /MilkTeaOperateRequest/);
    assert.doesNotMatch(autoSource, /activity_id:/);
});

test('写操作统一带 auto 标记，由 service 做前置校验', () => {
    assert.match(autoSource, /auto: true/);
});

test('开关键名沿用源仓库命名，便于对照', () => {
    assert.equal(AUTOMATION_KEYS.cashier, 'milk_tea_cashier');
    assert.equal(AUTOMATION_KEYS.wages, 'milk_tea_wages');
    assert.equal(AUTOMATION_KEYS.upgrade, 'milk_tea_upgrade');
    assert.equal(AUTOMATION_KEYS.craft, 'milk_tea_craft');
    assert.equal(AUTOMATION_KEYS.boost, 'milk_tea_boost');
    assert.equal(AUTOMATION_KEYS.hire, 'milk_tea_hire');
    assert.equal(AUTOMATION_KEYS.seedBuy, 'milk_tea_seed_buy');
    assert.equal(AUTOMATION_KEYS.interact, 'milk_tea_interact');
    assert.equal(AUTOMATION_KEYS.shareDaily, 'milk_tea_share_daily');
    assert.equal(AUTOMATION_KEYS.shareRewards, 'milk_tea_share_rewards');
    assert.equal(AUTOMATION_KEYS.fundRewards, 'milk_tea_fund_rewards');
    assert.equal(MILK_TEA_KEYS.length, 11);
    assert.deepEqual(HIRE_DURATIONS, [1, 2, 3]);
    assert.deepEqual(HIRE_TALENTS, [0, 9001, 9002, 9003, 9004]);
});

test('结算期跳过升级/制作/加速/雇佣/购买，只保留领取类动作', () => {
    assert.match(autoSource, /if \(!settling\) \{/);
    assert.match(autoSource, /isOn\('cashier'\)/);
    assert.match(autoSource, /isOn\('shareDaily'\)/);
    assert.match(autoSource, /isOn\('shareRewards'\)/);
    assert.match(autoSource, /isOn\('fundRewards'\)/);
});
