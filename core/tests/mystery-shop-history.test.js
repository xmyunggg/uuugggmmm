const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { getDataFile } = require('../dist/config/runtime-paths');
const history = require('../dist/services/mystery-shop-history');

const ACCOUNT_ID = '__mystery_history_test__';
const HISTORY_DIR = getDataFile('mystery_shop_history');
const ACCOUNT_FILE = path.join(HISTORY_DIR, `${ACCOUNT_ID}.json`);

test.after(() => {
    try {
        if (fs.existsSync(ACCOUNT_FILE)) fs.unlinkSync(ACCOUNT_FILE);
    }
    catch {
        // ignore cleanup errors
    }
});

// 与本项目 commerce.getMysteryShop 的 offer 结构一致
function offer(overrides = {}) {
    return {
        id: 9001,
        reward: { id: 5001, count: 3, name: '草莓种子', image: 'berry.png', rarity: 2 },
        price: { id: 1001, count: 300, name: '金币', balance: 9999 },
        originalPrice: 450,
        discountPercent: 33,
        ...overrides,
    };
}

function purchaseResult(overrides = {}) {
    const base = offer();
    return {
        npcId: 9001,
        reward: base.reward,
        price: base.price,
        originalPrice: base.originalPrice,
        discountPercent: base.discountPercent,
        ...overrides,
    };
}

test('神秘商人购买记录按账号落盘，最新在前', () => {
    history.appendMysteryShopHistory(ACCOUNT_ID, offer(), purchaseResult(), 'manual');
    history.appendMysteryShopHistory(ACCOUNT_ID, offer({ id: 9002 }), purchaseResult({ npcId: 9002 }), 'auto');

    const records = history.getMysteryShopHistory(ACCOUNT_ID);
    assert.equal(records.length, 2);
    assert.equal(records[0].npcId, 9002, '最新记录排在最前');
    assert.equal(records[1].npcId, 9001);

    const latest = records[0];
    assert.equal(latest.source, 'auto');
    assert.equal(latest.itemId, 5001);
    assert.equal(latest.itemName, '草莓种子');
    assert.equal(latest.itemImage, 'berry.png');
    assert.equal(latest.itemCount, 3);
    assert.equal(latest.currencyId, 1001);
    assert.equal(latest.currencyName, '金币');
    assert.equal(latest.price, 300);
    assert.equal(latest.originalPrice, 450);
    assert.equal(latest.discount, 33);
    assert.equal(typeof latest.purchasedAt, 'number');
    assert.equal(latest.id.startsWith(`${latest.purchasedAt}-`), true);
});

test('未购买过的账号返回空列表', () => {
    assert.deepEqual(history.getMysteryShopHistory('__mystery_history_empty__'), []);
});

test('记录数量上限 100，超出后丢弃最旧的', () => {
    const accountId = '__mystery_history_cap__';
    for (let index = 0; index < 105; index += 1)
        history.appendMysteryShopHistory(accountId, offer({ id: 1000 + index }), purchaseResult({ npcId: 1000 + index }), 'manual');

    const records = history.getMysteryShopHistory(accountId);
    assert.equal(records.length, history.MAX_HISTORY_RECORDS);
    assert.equal(records[0].npcId, 1104, '保留最新 100 条');
    assert.equal(records.at(-1).npcId, 1005);

    fs.unlinkSync(path.join(HISTORY_DIR, `${accountId}.json`));
});

test('账号 ID 会被清洗，不能逃出数据目录', () => {
    const record = history.appendMysteryShopHistory('../evil', offer(), purchaseResult(), 'manual');
    assert.equal(record.npcId, 9001);
    const written = fs.readdirSync(HISTORY_DIR).filter(name => name.includes('evil'));
    assert.deepEqual(written, ['___evil.json'], '路径分隔符与点号被替换为下划线');
    for (const name of written)
        fs.unlinkSync(path.join(HISTORY_DIR, name));
});

test('缺少账号 ID 时拒绝读写', () => {
    assert.throws(() => history.getMysteryShopHistory('   '), /缺少账号 ID/);
});

test('记录构造在后端结果缺字段时回落到 offer', () => {
    const record = history.buildMysteryShopHistoryRecord(offer(), { npcId: 9001 }, 'manual');
    assert.equal(record.itemId, 5001);
    assert.equal(record.itemName, '草莓种子');
    assert.equal(record.price, 300);
    assert.equal(record.discount, 33);
});

// ---------------- 购买时写入记录（commerce 集成） ----------------

const commerce = require('../dist/services/commerce');
const mysteryShopService = require('../dist/services/mystery-shop');

const PURCHASE_ACCOUNT = '__mystery_history_purchase__';
const PURCHASE_FILE = path.join(HISTORY_DIR, `${PURCHASE_ACCOUNT}.json`);

function fakeShopReply(active) {
    return {
        is_active: active,
        active_time: 1,
        expire_time: 2,
        npc: active
            ? {
                    npc_id: 9001,
                    reward_item_id: 5001,
                    reward_count: 3,
                    currency_item_id: 1001,
                    price: 100,
                    original_price: 150,
                    discount_percent: 33,
                }
            : null,
    };
}

function stubMysteryShop(t) {
    const originals = { getActiveNPC: mysteryShopService.getActiveNPC, buy: mysteryShopService.buy };
    let active = true;
    let buyCalls = 0;
    mysteryShopService.getActiveNPC = async () => fakeShopReply(active);
    mysteryShopService.buy = async () => {
        buyCalls += 1;
        active = false;
    };
    t.after(() => {
        mysteryShopService.getActiveNPC = originals.getActiveNPC;
        mysteryShopService.buy = originals.buy;
    });
    return () => buyCalls;
}

test('手动购买成功后写入来源为 manual 的记录', async (t) => {
    const buyCalls = stubMysteryShop(t);
    const previousAccountId = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = PURCHASE_ACCOUNT;
    t.after(() => {
        if (previousAccountId === undefined) delete process.env.FARM_ACCOUNT_ID;
        else process.env.FARM_ACCOUNT_ID = previousAccountId;
        if (fs.existsSync(PURCHASE_FILE)) fs.unlinkSync(PURCHASE_FILE);
    });

    const result = await commerce.purchaseMysteryOffer('9001');
    assert.equal(buyCalls(), 1);
    assert.equal(result.purchase.reward.count, 3);

    const records = history.getMysteryShopHistory(PURCHASE_ACCOUNT);
    assert.equal(records.length, 1);
    assert.equal(records[0].source, 'manual');
    assert.equal(records[0].itemId, 5001);
    assert.equal(records[0].currencyId, 1001);
    assert.equal(records[0].price, 300, '总价为单价 × 数量');
});

test('自动购买写入来源为 auto 的记录', async (t) => {
    const buyCalls = stubMysteryShop(t);
    const previousAccountId = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = PURCHASE_ACCOUNT;
    t.after(() => {
        if (previousAccountId === undefined) delete process.env.FARM_ACCOUNT_ID;
        else process.env.FARM_ACCOUNT_ID = previousAccountId;
        if (fs.existsSync(PURCHASE_FILE)) fs.unlinkSync(PURCHASE_FILE);
    });

    await commerce.purchaseMysteryOffer('9001', { source: 'auto' });
    assert.equal(buyCalls(), 1);

    const records = history.getMysteryShopHistory(PURCHASE_ACCOUNT);
    assert.equal(records[0].source, 'auto');
});

test('写盘异常不会影响购买结果', async (t) => {
    const buyCalls = stubMysteryShop(t);
    const originalAppend = history.appendMysteryShopHistory;
    history.appendMysteryShopHistory = () => {
        throw new Error('磁盘写入失败');
    };
    const previousAccountId = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = PURCHASE_ACCOUNT;
    if (fs.existsSync(PURCHASE_FILE)) fs.unlinkSync(PURCHASE_FILE);
    t.after(() => {
        history.appendMysteryShopHistory = originalAppend;
        if (previousAccountId === undefined) delete process.env.FARM_ACCOUNT_ID;
        else process.env.FARM_ACCOUNT_ID = previousAccountId;
    });

    const result = await commerce.purchaseMysteryOffer('9001');
    assert.equal(buyCalls(), 1);
    assert.equal(result.purchase.npcId, 9001);
    assert.equal(fs.existsSync(PURCHASE_FILE), false, '写盘失败时不留下记录文件');
});
