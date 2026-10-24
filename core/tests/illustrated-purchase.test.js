const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const {
    collectBuyableItemsFrom,
    resolveSeedInfo,
} = require('../dist/services/illustrated-purchase');
const {
    getItemById,
    getPlantByFruitId,
} = require('../dist/config/gameConfig');

const illustratedConfig = require(path.resolve(__dirname, '../src/gameConfig/Illustrated.json'));

const CROP_TYPES = new Set(['普通果实']);

function paramEntries() {
    return illustratedConfig.map(entry => Number(entry && entry.param) || 0).filter(id => id > 0);
}

function seedShopMap({ onlySeedIds } = {}) {
    const map = new Map();
    for (const seedId of (onlySeedIds || allSeedIds())) {
        map.set(seedId, { goodsId: 900000 + seedId, price: 10 });
    }
    return map;
}

function allSeedIds() {
    const ids = [];
    for (const param of paramEntries()) {
        const { seedId } = resolveSeedInfo(param);
        if (seedId > 0 && !ids.includes(seedId)) ids.push(seedId);
    }
    return ids;
}

// 图鉴条目里的 seedId 字段实际存的是「果实ID」（与 Illustrated.json 的 param、Plant.json 的 fruit.id 同一空间）
// 牧场图鉴（牧场主产物）是独立于作物图鉴/超变图鉴的新分类，不落在 Plant.json 的果实空间内，跳过。
const NON_PLANT_ILLUSTRATED_TYPES = new Set(['牧场图鉴']);
test('illustrated entries resolve through the fruit id space', () => {
    const params = illustratedConfig
        .filter(entry => !NON_PLANT_ILLUSTRATED_TYPES.has(String(entry && entry.illustrated_type)))
        .map(entry => Number(entry && entry.param) || 0)
        .filter(id => id > 0);
    assert.ok(params.length > 0);
    for (const param of params) {
        assert.ok(getPlantByFruitId(param), `果实ID ${param} 应能在 Plant.json 中找到植物`);
    }
});

// 本地配置足以判断作物图鉴的可购买性：普通果实全部能解析出种子与等级，
// 黄金/活动/装扮果实本身没有可购买种子（因此不依赖任何外部数据源兜底）。
test('local game config resolves seeds for every crop album entry', () => {
    const cropParams = [];
    const mutantParams = [];
    for (const entry of illustratedConfig) {
        const param = Number(entry && entry.param) || 0;
        if (!param) continue;
        (CROP_TYPES.has(String(entry.type)) ? cropParams : mutantParams).push(param);
    }

    assert.equal(cropParams.length + mutantParams.length, illustratedConfig.length);
    assert.ok(cropParams.length > 0);

    for (const param of cropParams) {
        const { seedId, seedLevel } = resolveSeedInfo(param);
        assert.ok(seedId > 0, `普通果实 ${param} 应解析出种子ID`);
        assert.ok(seedLevel > 0, `普通果实 ${param} 的种子应带等级`);
        assert.ok(getItemById(seedId), `种子 ${seedId} 应存在于 ItemInfo.json`);
    }

    for (const param of mutantParams) {
        const { seedId } = resolveSeedInfo(param);
        assert.equal(seedId, 0, `变异果实 ${param} 不应解析出可购买种子`);
    }
});

test('collectBuyableItemsFrom keeps only locked, affordable, in-shop entries', () => {
    const shop = seedShopMap();
    const sampleSeedId = allSeedIds()[0];
    const { seedLevel } = (() => {
        const param = paramEntries().find(id => resolveSeedInfo(id).seedId === sampleSeedId);
        return resolveSeedInfo(param);
    })();

    const base = { seedId: 0, name: 'x', unlocked: false };
    const cropParams = paramEntries().filter(id => resolveSeedInfo(id).seedId > 0);

    // 等级达标 + 未解锁 + 商店在售 -> 全部可购买
    const allBuyable = collectBuyableItemsFrom(
        cropParams.map(id => ({ ...base, seedId: id })),
        shop,
        9999,
    );
    assert.equal(allBuyable.length, cropParams.length);

    // 已解锁 -> 排除
    assert.equal(collectBuyableItemsFrom(
        cropParams.map(id => ({ ...base, seedId: id, unlocked: true })),
        shop,
        9999,
    ).length, 0);

    // 等级不足 -> 排除（用户等级 0 低于所有种子等级）
    assert.equal(collectBuyableItemsFrom(
        cropParams.filter(id => resolveSeedInfo(id).seedLevel > 0).map(id => ({ ...base, seedId: id })),
        shop,
        0,
    ).length, 0);

    // 种子不在售 -> 排除
    assert.equal(collectBuyableItemsFrom(
        [{ ...base, seedId: cropParams[0] }],
        new Map(),
        9999,
    ).length, 0);

    // 单个种子只在售其自身商品 -> 只回该条
    const single = collectBuyableItemsFrom(
        cropParams.map(id => ({ ...base, seedId: id })),
        seedShopMap({ onlySeedIds: [sampleSeedId] }),
        9999,
    );
    assert.equal(single.length, 1);
    assert.equal(single[0].price, 10);
    assert.equal(single[0].seedLevel, seedLevel);
    assert.ok(single[0].goodsId > 0);
});

test('mutant album entries are never collected even when all seeds are on sale', () => {
    const collected = collectBuyableItemsFrom(
        paramEntries().map(id => ({ seedId: id, name: `果实${id}`, unlocked: false })),
        seedShopMap(),
        9999,
    );
    assert.ok(collected.length > 0);
    for (const item of collected) {
        assert.ok(resolveSeedInfo(item.seedId).seedId > 0);
    }
    assert.ok(collected.length < paramEntries().length);
});

// ---- 服务层集成：mock 掉网络依赖，验证快照标注与批量下单行为 ----

function cropParams() {
    return illustratedConfig
        .filter(entry => CROP_TYPES.has(String(entry.type)))
        .map(entry => Number(entry.param) || 0)
        .filter(id => id > 0 && resolveSeedInfo(id).seedId > 0);
}

function mutantParams() {
    return illustratedConfig
        .filter(entry => !CROP_TYPES.has(String(entry.type)))
        .map(entry => Number(entry.param) || 0)
        .filter(id => id > 0);
}

function bookOf(params) {
    return { items: params.map(id => ({ seedId: id, name: `果实${id}`, unlocked: false })) };
}

function harness({ goods, userLevel = 9999, crop, mutant, buyGoodsImpl, shopFails = false } = {}) {
    const bought = [];
    const mock = (name, exports) => {
        const id = require.resolve(name);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    mock('../dist/services/logger', {
        createModuleLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    });
    mock('../dist/utils/network', { getUserState: () => ({ level: userLevel }) });
    mock('../dist/services/farm/api', {
        getShopInfo: async (shopId) => {
            assert.equal(shopId, 2, '必须读取种子商店(shop_id=2)');
            if (shopFails) throw new Error('shop offline');
            return { goods_list: goods };
        },
        buyGoods: async (goodsId, num, price) => {
            bought.push({ goodsId, num, price });
            if (buyGoodsImpl) return buyGoodsImpl(goodsId, num, price);
            return { success: true };
        },
    });
    const snapshot = { crop: crop || bookOf(cropParams()), mutant: mutant || bookOf(mutantParams()) };
    mock('../dist/services/illustrated', { getIllustratedSnapshot: async () => snapshot });

    const id = require.resolve('../dist/services/illustrated-purchase');
    delete require.cache[id];
    return { service: require(id), bought, snapshot };
}

test('snapshot annotation marks buyable entries and leaves the cached snapshot untouched', async () => {
    const params = cropParams();
    const [first, second, third] = params;
    const mutant = mutantParams()[0];
    const seedOf = id => resolveSeedInfo(id).seedId;
    const { service, snapshot } = harness({
        goods: [{ id: 111, item_id: seedOf(first), price: 50, unlocked: true }],
        crop: bookOf([first, second, third]),
        mutant: bookOf([mutant]),
        userLevel: 77,
    });

    const result = await service.getIllustratedSnapshotWithPurchase();

    assert.equal(result.userLevel, 77);
    assert.equal(result.crop.userLevel, 77);

    const [buyable, notOnSale, alreadyUnlocked] = result.crop.items;
    assert.equal(buyable.canBuy, true);
    assert.equal(buyable.goodsId, 111);
    assert.equal(buyable.price, 50);
    assert.equal(buyable.seedLevel, resolveSeedInfo(first).seedLevel);

    assert.equal(notOnSale.canBuy, false);
    assert.equal(notOnSale.goodsId, 0);
    assert.equal(notOnSale.price, 0);

    assert.equal(alreadyUnlocked.canBuy, false);

    // 变异果实没有可购买种子
    assert.equal(result.mutant.items[0].canBuy, false);

    // 原始快照对象未被写入标注字段（快照本身是并发合并的缓存）
    assert.equal(snapshot.crop.items[0].canBuy, undefined);
    assert.equal(snapshot.userLevel, undefined);
});

test('level gate and shop failures only disable buying, never break the snapshot', async () => {
    const params = cropParams();
    const seedOf = id => resolveSeedInfo(id).seedId;
    const goods = [{ id: 222, item_id: seedOf(params[0]), price: 30, unlocked: true }];

    const tooLow = harness({ goods, crop: bookOf([params[0]]), userLevel: 0 });
    const lowResult = await tooLow.service.getIllustratedSnapshotWithPurchase();
    assert.equal(lowResult.crop.items[0].canBuy, false);
    // 等级不足仍返回种子信息，前端可展示所需等级
    assert.equal(lowResult.crop.items[0].seedLevel, resolveSeedInfo(params[0]).seedLevel);

    const ok = harness({ goods, crop: bookOf([params[0]]), userLevel: 9999 });
    const okResult = await ok.service.getIllustratedSnapshotWithPurchase();
    assert.equal(okResult.crop.items[0].canBuy, true);

    const broken = harness({
        goods: [],
        crop: bookOf([params[0]]),
        userLevel: 9999,
        shopFails: true,
    });
    const brokenResult = await broken.service.getIllustratedSnapshotWithPurchase();
    assert.equal(brokenResult.crop.items.length, 1);
    assert.equal(brokenResult.crop.items[0].canBuy, false);
    assert.equal(brokenResult.crop.items[0].price, 0);

    // 商店读取失败时批量购买不应下单
    const brokenBuy = await broken.service.buyAllIllustratedGoods(1);
    assert.equal(brokenBuy.total, 0);
    assert.equal(broken.bought.length, 0);
});

test('buy-all orders every buyable seed once and keeps going after a failure', async () => {
    const params = cropParams();
    const seedOf = id => resolveSeedInfo(id).seedId;
    const [first, second, third] = params;
    const goods = [
        { id: 301, item_id: seedOf(first), price: 10, unlocked: true },
        { id: 302, item_id: seedOf(second), price: 20, unlocked: true },
    ];
    const { service, bought } = harness({
        goods,
        crop: bookOf([first, second, third]),
        userLevel: 9999,
        buyGoodsImpl: async (goodsId) => {
            if (goodsId === 301) throw new Error('金币不足');
            return { success: true };
        },
    });

    const result = await service.buyAllIllustratedGoods(1);

    assert.equal(result.total, 2);
    assert.equal(result.successCount, 1);
    assert.equal(result.failCount, 1);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].success, false);
    assert.equal(result.results[0].error, '金币不足');
    assert.equal(result.results[1].success, true);
    assert.deepEqual(bought, [
        { goodsId: 301, num: 1, price: 10 },
        { goodsId: 302, num: 1, price: 20 },
    ]);
});

test('buy-all uses the mutant album when type 2 is requested and rejects a missing goods id', async () => {
    const seedOf = id => resolveSeedInfo(id).seedId;
    const cropOnly = cropParams()[0];
    const { service, bought } = harness({
        goods: [{ id: 401, item_id: seedOf(cropOnly), price: 5, unlocked: true }],
        crop: bookOf([cropOnly]),
        mutant: bookOf([]),
        userLevel: 9999,
    });

    const mutantResult = await service.buyAllIllustratedGoods(2);
    assert.deepEqual({ total: mutantResult.total, successCount: mutantResult.successCount }, { total: 0, successCount: 0 });
    assert.equal(bought.length, 0);

    await assert.rejects(() => service.buyIllustratedGoods(0, 5), /缺少商品ID/);
    await assert.rejects(() => service.buyIllustratedGoods(undefined, 5), /缺少商品ID/);

    await service.buyIllustratedGoods(401, 5);
    assert.deepEqual(bought, [{ goodsId: 401, num: 1, price: 5 }]);
});
