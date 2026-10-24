export {};
/**
 * 烟花道具（ItemInfo 里 effectDesc 为「放置烟花道具」的 6001 玉兔望月 / 6002 花好月圆）。
 *
 * 使用烟花是「放置 + 点燃」两步：先 Use 携带 target.host_gid 放下烟花桶（+30 经验），
 * 再由农场主用 Farming 的社交事件字段点燃。任何一步断掉都不能重复放桶，否则会多消耗
 * 一枚道具，所以每次先读服务器状态（AllLands 的 social_events）：
 * - phase 为 0（或协议里没有该字段）说明只放置成功、还没点燃 → 只补点燃，不再放桶；
 * - phase 非 0 且未到 state_until 说明正在燃放 → 直接拒绝；
 * - 事件已过期则按「没有烟花」处理，正常放桶。
 * 同一账号并发点击由 running 锁挡住（每个账号一个 worker 进程，进程内单实例即可）。
 */
const { getServerTimeSec } = require('../utils/utils');

const FIREWORK_ITEM_IDS: Set<number> = new Set([6001, 6002]);
// 网关拒绝燃放时返回的错误码（烟花桶已在燃放中）
const FIREWORK_BURNING_CODE: string = '1001096';
const BURNING_MESSAGE: string = '烟花：燃放中，请稍后再试';

/**
 * utils.toNum 只保证 number/Long，字符串会原样返回，用于 Set 匹配会漏判、
 * 从而退化成普通 Use（只放置不点燃）。烟花判定必须得到真正的数字。
 */
function toInt(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const parsed: number = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

function fireworkError(code: string, message: string): Error {
    const error: any = new Error(message);
    error.code = code;
    error.firework = true;
    return error;
}

function isFireworkItemId(itemId: any): boolean {
    return FIREWORK_ITEM_IDS.has(toInt(itemId));
}

function isFireworkBurningError(error: any): boolean {
    const text: string = `${error?.message || ''} ${error?.errorMessage || ''} ${error?.error || ''}`;
    return text.includes(FIREWORK_BURNING_CODE) || text.includes('烟花燃放中');
}

function isFireworkError(error: any): boolean {
    return error?.firework === true || String(error?.code || '').startsWith('FIREWORK_');
}

function createFireworkUse(options: {
    getFarmSocialEvents: () => Promise<any[]>;
    place: (itemId: number, uid: number) => Promise<any>;
    ignite: (itemId: number) => Promise<any>;
    now?: () => number;
}): (itemId: any, count?: any, uid?: any) => Promise<any> {
    const getFarmSocialEvents = options.getFarmSocialEvents;
    const place = options.place;
    const ignite = options.ignite;
    const now = options.now || getServerTimeSec;
    let running = false;

    return async function useFirework(itemId: any, count: any = 1, uid: any = 0): Promise<any> {
        const id: number = toInt(itemId);
        if (!isFireworkItemId(id)) throw new Error(`物品 ${itemId} 不是烟花`);
        if (toInt(count) !== 1) throw fireworkError('FIREWORK_INVALID_COUNT', '烟花：每次只能燃放一枚');
        if (running) throw fireworkError('FIREWORK_BUSY', '烟花：正在处理，请勿重复点击');
        running = true;
        try {
            const events: any[] = await getFarmSocialEvents();
            const current: any = (Array.isArray(events) ? events : [])
                .find((event: any) => toInt(event?.item_id) === id);
            const phase: number = toInt(current?.phase);
            const stateUntil: number = toInt(current?.state_until);
            if (current && phase !== 0 && (stateUntil <= 0 || stateUntil > now())) {
                throw fireworkError('FIREWORK_BURNING', BURNING_MESSAGE);
            }
            // 已有事件但没有在燃放 = 上次只放置成功，这里只补点燃，避免重复消耗道具
            const pending: boolean = Boolean(current) && phase === 0;
            const reply: any = pending ? { used_items: [], items: [] } : await place(id, toInt(uid));
            try {
                await ignite(id);
            }
            catch (error: any) {
                if (isFireworkBurningError(error)) throw fireworkError('FIREWORK_BURNING', BURNING_MESSAGE);
                throw fireworkError('FIREWORK_IGNITE_UNCONFIRMED', '烟花：已放置，但点燃未确认，请重试以继续放烟花');
            }
            return { ...reply, firework: true, resumed: pending };
        }
        catch (error: any) {
            if (isFireworkBurningError(error)) throw fireworkError('FIREWORK_BURNING', BURNING_MESSAGE);
            throw error;
        }
        finally {
            running = false;
        }
    };
}

module.exports = {
    FIREWORK_ITEM_IDS,
    isFireworkItemId,
    isFireworkError,
    createFireworkUse,
};
