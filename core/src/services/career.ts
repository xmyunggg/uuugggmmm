export {};

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, logWarn } = require('../utils/utils');
const { getItemById, getItemImageById, getPlantByFruitId } = require('../config/gameConfig');

export interface CareerHarvestItem {
    seedId: number;
    fruitId: number;
    name: string;
    image: string;
    harvestCount: number;
}

export interface CareerInfo {
    gid: number;
    /** 历史累计收获（保留旧字段名，好友页/收偷比沿用） */
    harvest: number;
    /** 历史累计摘取好友作物（保留旧字段名） */
    steal: number;
    level: number;
    name: string;
    exp: number;
    avatar: string;
    items: CareerHarvestItem[];
}

function mapHarvestItems(rawItems: any[]): CareerHarvestItem[] {
    return (Array.isArray(rawItems) ? rawItems : []).map((item: any) => {
        const fruitId: number = Number(toNum(item?.fruitId ?? item?.fruit_id)) || 0;
        const itemConfig: any = getItemById(fruitId);
        const plant: any = getPlantByFruitId(fruitId);
        return {
            seedId: fruitId,
            fruitId,
            name: String(itemConfig?.name || plant?.name || `果实${fruitId}`),
            image: getItemImageById(fruitId),
            harvestCount: Number(toNum(item?.harvestCount ?? item?.harvest_count)) || 0,
        };
    });
}

async function getCareerInfo(gid: number): Promise<CareerInfo> {
    const numericGid: number = toNum(gid);
    if (!numericGid) throw new Error('缺少有效的角色 GID');

    const body: Uint8Array = types.CareerInfoGetRequest.encode(types.CareerInfoGetRequest.create({
        gid: toLong(numericGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.careerpb.CareerService', 'CareerInfoGet', body);
    const reply: any = types.CareerInfoGetReply.toObject(
        types.CareerInfoGetReply.decode(replyBody),
        { longs: Number, defaults: true },
    );

    const harvest: number = Number(toNum(reply.total_harvest_count ?? reply.totalHarvestCount)) || 0;
    const steal: number = Number(toNum(reply.total_steal_count ?? reply.totalStealCount)) || 0;

    return {
        gid: Number(toNum(reply.gid)) || numericGid,
        harvest,
        steal,
        level: Number(toNum(reply.level)) || 0,
        name: String(reply.name || ''),
        exp: Number(toNum(reply.exp)) || 0,
        avatar: String(reply.avatar_url ?? reply.avatarUrl ?? ''),
        items: mapHarvestItems(reply.harvest_items ?? reply.harvestItems),
    };
}

async function getCareerInfoOrNull(gid: number, propagateErrors: boolean = false): Promise<CareerInfo | null> {
    try {
        return await getCareerInfo(gid);
    } catch (error: any) {
        if (propagateErrors) throw error;
        logWarn('生涯', `查询失败: ${error && error.message ? error.message : error}`);
        return null;
    }
}

module.exports = { getCareerInfo, getCareerInfoOrNull, mapHarvestItems };
