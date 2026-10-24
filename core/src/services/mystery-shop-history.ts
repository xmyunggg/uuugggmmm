export {};

const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const MAX_HISTORY_RECORDS = 100;

function safeAccountId(accountId: any): string {
    return String(accountId || '').trim().replace(/[^\w-]/g, '_');
}

function getHistoryFile(accountId: any): string {
    const id = safeAccountId(accountId);
    if (!id) throw new Error('缺少账号 ID');
    return path.join(getDataFile('mystery_shop_history'), `${id}.json`);
}

function getMysteryShopHistory(accountId: any): any[] {
    const data = readJsonFile(getHistoryFile(accountId), () => ({ records: [] }));
    return Array.isArray(data?.records) ? data.records.slice(0, MAX_HISTORY_RECORDS) : [];
}

function buildMysteryShopHistoryRecord(offer: any, result: any, source = 'manual'): any {
    const reward = result?.reward || offer?.reward || {};
    const price = result?.price || offer?.price || {};
    const npcId = Number(result?.npcId || offer?.id || 0);
    const itemId = Number(reward.id || 0);
    const currencyId = Number(price.id || 0);
    return {
        id: `${Date.now()}-${npcId}`,
        purchasedAt: Date.now(),
        source: source === 'auto' ? 'auto' : 'manual',
        npcId,
        itemId,
        itemName: String(reward.name || `物品${itemId}`),
        itemImage: String(reward.image || ''),
        itemCount: Number(reward.count || 0),
        currencyId,
        currencyName: String(price.name || `货币${currencyId}`),
        price: Number(price.count || 0),
        originalPrice: Number(result?.originalPrice || offer?.originalPrice || 0),
        discount: Number(result?.discountPercent ?? offer?.discountPercent ?? 0),
    };
}

function appendMysteryShopHistory(accountId: any, offer: any, result: any, source = 'manual'): any {
    const record = buildMysteryShopHistoryRecord(offer, result, source);
    const records = [record, ...getMysteryShopHistory(accountId)].slice(0, MAX_HISTORY_RECORDS);
    writeJsonFileAtomic(getHistoryFile(accountId), { records });
    return record;
}

module.exports = {
    MAX_HISTORY_RECORDS,
    buildMysteryShopHistoryRecord,
    getMysteryShopHistory,
    appendMysteryShopHistory,
};
