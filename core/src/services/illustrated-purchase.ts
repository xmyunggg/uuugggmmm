export {};

/**
 * 图鉴一键购买。
 *
 * 把图鉴（作物 / 超变）里「未解锁 且 种子商店在售 且 等级达标」的条目挑出来，逐个下单。
 * 果实 → 种子 的映射完全取自本地 gameConfig（Plant.json 的 seed_id + ItemInfo.json 的 level），
 * 不依赖任何外部数据源：黄金 / 活动 / 装扮果实本身没有可购买种子，本地配置已能正确判定。
 */

const { getItemById, getPlantByFruitId } = require('../config/gameConfig');
const { createModuleLogger } = require('./logger');
const { getUserState } = require('../utils/network');
const { toNum } = require('../utils/utils');
const { getShopInfo, buyGoods } = require('./farm/api');
const { getIllustratedSnapshot } = require('./illustrated');

const logger: any = createModuleLogger('illustrated-purchase');

/** 种子商店（shop_id = 2） */
const SEED_SHOP_TYPE = 2;
/** 批量下单间隔，避免请求过于密集 */
const BUY_ALL_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getUserLevel(): number {
    return toNum(getUserState().level) || 0;
}

/**
 * 种子商店在售种子映射：种子物品ID -> { goodsId, price }
 * 取不到商店（未连接 / 请求失败）时返回空表，让图鉴照常展示，只是全部标记为不可购买。
 */
async function getSeedShopGoodsMap(): Promise<Map<number, any>> {
    const goodsMap = new Map<number, any>();
    try {
        const shopInfo = await getShopInfo(SEED_SHOP_TYPE);
        const goodsList = Array.isArray(shopInfo && shopInfo.goods_list) ? shopInfo.goods_list : [];
        for (const goods of goodsList) {
            const itemId = toNum(goods && goods.item_id) || 0;
            const goodsId = toNum(goods && goods.id) || 0;
            const price = toNum(goods && goods.price) || 0;
            if (itemId > 0 && goodsId > 0) {
                goodsMap.set(itemId, { goodsId, price });
            }
        }
        logger.debug('种子商店映射', { mapSize: goodsMap.size });
    } catch (err: any) {
        logger.warn('获取种子商店失败，图鉴可购买判断将全部置为否', { error: err?.message });
    }
    return goodsMap;
}

/**
 * 由果实ID解析出可购买种子与所需等级。
 * 果实ID 即图鉴 item.seedId（游戏里字段名为 seed_id，实际存的是果实ID）。
 */
function resolveSeedInfo(fruitId: number): { seedId: number, seedLevel: number } {
    const plant = getPlantByFruitId(fruitId);
    const seedId = toNum(plant && plant.seed_id) || 0;
    const seedLevel = seedId > 0 ? (toNum(getItemById(seedId)?.level) || 0) : 0;
    return { seedId, seedLevel };
}

function canBuyItem(item: any, seedId: number, seedLevel: number, goods: any, userLevel: number): boolean {
    return !!item
        && item.unlocked !== true
        && seedId > 0
        && seedLevel > 0
        && userLevel >= seedLevel
        && !!goods;
}

/** 给单个图鉴分册补上可购买信息（返回新对象，不改动快照缓存里的原对象） */
function annotateBook(book: any, seedGoodsMap: Map<number, any>, userLevel: number): any {
    if (!book || !Array.isArray(book.items)) return book;
    const items = book.items.map((item: any) => {
        const fruitId = toNum(item && item.seedId) || 0;
        const { seedId, seedLevel } = resolveSeedInfo(fruitId);
        const goods = seedGoodsMap.get(seedId);
        return {
            ...item,
            seedLevel,
            goodsId: goods ? goods.goodsId : 0,
            price: goods ? goods.price : 0,
            canBuy: canBuyItem(item, seedId, seedLevel, goods, userLevel),
        };
    });
    return { ...book, userLevel, items };
}

/** 图鉴快照 + 可购买标记 */
async function getIllustratedSnapshotWithPurchase(): Promise<any> {
    const [snapshot, seedGoodsMap] = await Promise.all([
        getIllustratedSnapshot(),
        getSeedShopGoodsMap(),
    ]);
    const userLevel = getUserLevel();
    const result = { ...snapshot, userLevel };
    result.crop = annotateBook(snapshot && snapshot.crop, seedGoodsMap, userLevel);
    result.mutant = annotateBook(snapshot && snapshot.mutant, seedGoodsMap, userLevel);
    return result;
}

/** 从图鉴条目里挑出可购买项（纯函数，便于测试） */
function collectBuyableItemsFrom(
    rawItems: any[],
    seedGoodsMap: Map<number, any>,
    userLevel: number,
): any[] {
    const items: any[] = [];
    for (const item of (Array.isArray(rawItems) ? rawItems : [])) {
        const fruitId = toNum(item && item.seedId) || 0;
        const { seedId, seedLevel } = resolveSeedInfo(fruitId);
        const goods = seedGoodsMap.get(seedId);
        if (!canBuyItem(item, seedId, seedLevel, goods, userLevel)) continue;
        items.push({
            seedId: fruitId,
            name: String(item && item.name || `果实${fruitId}`),
            goodsId: goods.goodsId,
            price: goods.price,
            seedLevel,
        });
    }
    return items;
}

/** 收集某一册里全部可购买的条目 */
async function collectBuyableItems(type: number): Promise<{ userLevel: number, items: any[] }> {
    const seedGoodsMap = await getSeedShopGoodsMap();
    const userLevel = getUserLevel();
    const snapshot = await getIllustratedSnapshot();
    const book = type === 2 ? snapshot && snapshot.mutant : snapshot && snapshot.crop;
    return { userLevel, items: collectBuyableItemsFrom(book && book.items, seedGoodsMap, userLevel) };
}

/** 购买单个种子 */
async function buyIllustratedGoods(goodsId: unknown, price: unknown): Promise<any> {
    const id = toNum(goodsId) || 0;
    if (id <= 0) throw new Error('缺少商品ID');
    const result = await buyGoods(id, 1, toNum(price) || 0);
    logger.info('图鉴购买种子', { goodsId: id, price: toNum(price) || 0 });
    return result;
}

/** 一键购买某一册图鉴中所有可购买的种子 */
async function buyAllIllustratedGoods(type: unknown): Promise<any> {
    const illustratedType = toNum(type) === 2 ? 2 : 1;
    const { items } = await collectBuyableItems(illustratedType);

    const results: any[] = [];
    let successCount = 0;
    let failCount = 0;
    logger.info('图鉴一键购买开始', { illustratedType, count: items.length });

    for (const item of items) {
        try {
            await buyGoods(item.goodsId, 1, item.price);
            results.push({ ...item, success: true });
            successCount++;
            // 失败时不必等待，成功才需要节流
            await delay(BUY_ALL_DELAY_MS);
        } catch (err: any) {
            results.push({ ...item, success: false, error: err?.message || String(err) });
            failCount++;
        }
    }

    logger.info('图鉴一键购买完成', { illustratedType, successCount, failCount });
    return { total: items.length, successCount, failCount, results };
}

module.exports = {
    getIllustratedSnapshotWithPurchase,
    collectBuyableItemsFrom,
    resolveSeedInfo,
    buyIllustratedGoods,
    buyAllIllustratedGoods,
};
