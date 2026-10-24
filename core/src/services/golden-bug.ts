export {};
/**
 * 黄金虫投放（ItemInfo 301101，社交道具，只能放到好友农场）。
 *
 * 背包里的黄金虫除了留一部分自用（goldenBugKeepCount）之外，其余按单轮上限
 * （goldenBugRoundLimit）和每日上限（100 只）分散投放到好友农场的未成熟作物上。
 * 每只 +30 经验，因此这里和放草放虫一样按「每日额度 + 背包库存」双重收敛，
 * 避免一天之内把库存一次性打空。
 *
 * 实现要点：
 * - 只投「非成熟、非枯死且上面还没有黄金虫」的地块，判断逻辑复用好友互动道具的选地逻辑；
 * - 好友按等级降序访问，跳过自己与黑名单，等级高的好友土地多、空位也多；
 * - 两次执行之间至少间隔 MIN_RUN_INTERVAL_MS（默认 10 分钟），避免巡查循环把
 *   好友农场打满；开启开关或手动触发时 force 跳过该节流；
 * - 每日已投放数量落盘到账号数据目录，跨天按系统时区自动清零；
 * - 每个账号一个 worker 进程，进程内单实例 + running 锁即可挡住并发点击。
 */

const GOLDEN_BUG_ITEM_ID: number = 301101;
const GOLDEN_BUG_DAILY_LIMIT: number = 100;
const MIN_RUN_INTERVAL_MS: number = 10 * 60 * 1000;
const DEFAULT_ROUND_LIMIT: number = 24;
const MAX_ROUND_LIMIT: number = 100;
const GOLDEN_BUG_EXP_PER_ITEM: number = 30;
const STATE_VERSION: number = 1;

/**
 * utils.toNum 只保证 number|Long，字符串会原样返回，用于严格相等比较会漏判
 * （库存里的 id/count 有时是字符串），这里统一转成安全整数。
 */
function toInt(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const parsed: number = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

function clampRoundLimit(value: any): number {
    const parsed: number = toInt(value) || DEFAULT_ROUND_LIMIT;
    return Math.max(1, Math.min(MAX_ROUND_LIMIT, parsed));
}

/** 统计背包里的黄金虫数量（合并同一物品的多条堆叠）。 */
function getGoldenBugCount(items: any[]): number {
    return (Array.isArray(items) ? items : []).reduce((total: number, item: any) => {
        const id: number = toInt(item && (item.id ?? item.item_id));
        if (id !== GOLDEN_BUG_ITEM_ID) return total;
        return total + Math.max(0, toInt(item && item.count));
    }, 0);
}

interface FriendSummary {
    gid: number;
    name: string;
    level: number;
}

interface GoldenBugPlacementDeps {
    /** 好友总开关 + 黄金虫开关都打开时才为 true。 */
    isEnabled: () => boolean;
    isQuietHours: () => boolean;
    getSelfGid: () => number;
    listFriends: () => Promise<FriendSummary[]>;
    getBlacklist: () => number[];
    getInventoryCount: () => Promise<number>;
    getKeepCount: () => number;
    getRoundLimit: () => number;
    /** 进入好友农场，把最多 count 只黄金虫放到可放置的地块上，返回实际放下的数量。 */
    placeOnFriend: (friendGid: number, count: number) => Promise<{ placed: number; ownerName?: string }>;
    getPlacedToday: () => number;
    setPlacedToday: (count: number) => void;
    log: (tag: string, message: string, extra?: any) => void;
    logWarn: (tag: string, message: string, extra?: any) => void;
    now?: () => number;
    minRunIntervalMs?: number;
    dailyLimit?: number;
}

interface GoldenBugRunResult {
    placed: number;
    inventory: number;
    dailyRemaining: number;
}

function createGoldenBugPlacement(deps: GoldenBugPlacementDeps): (options?: { force?: boolean }) => Promise<GoldenBugRunResult | null> {
    const now: () => number = deps.now || (() => Date.now());
    const minRunIntervalMs: number = Math.max(0, toInt(deps.minRunIntervalMs) || MIN_RUN_INTERVAL_MS);
    const dailyLimit: number = Math.max(1, toInt(deps.dailyLimit) || GOLDEN_BUG_DAILY_LIMIT);
    let running: boolean = false;
    let lastRunAt: number = 0;

    return async function runGoldenBugPlacement(options: { force?: boolean } = {}): Promise<GoldenBugRunResult | null> {
        if (running) return null;
        if (!deps.isEnabled()) return null;
        if (deps.isQuietHours()) return null;

        const startedAt: number = now();
        if (!options.force && startedAt - lastRunAt < minRunIntervalMs) return null;

        running = true;
        lastRunAt = startedAt;
        try {
            const selfGid: number = toInt(deps.getSelfGid());
            if (selfGid <= 0) return null;

            const keepCount: number = Math.max(0, toInt(deps.getKeepCount()));
            const roundLimit: number = clampRoundLimit(deps.getRoundLimit());
            const inventory: number = Math.max(0, toInt(await deps.getInventoryCount()));
            const usable: number = Math.max(0, inventory - keepCount);

            const dailyLimitRemaining: number = Math.max(0, dailyLimit - Math.max(0, toInt(deps.getPlacedToday())));
            let remaining: number = Math.min(usable, dailyLimitRemaining, roundLimit);
            if (remaining <= 0) {
                return { placed: 0, inventory, dailyRemaining: dailyLimitRemaining };
            }

            const blacklist: Set<number> = new Set(deps.getBlacklist().map(toInt));
            const friends: FriendSummary[] = (await deps.listFriends())
                .filter((friend: FriendSummary) => friend.gid > 0 && friend.gid !== selfGid && !blacklist.has(friend.gid))
                .sort((a: FriendSummary, b: FriendSummary) => b.level - a.level);

            let placed: number = 0;
            let dailyPlaced: number = dailyLimit - dailyLimitRemaining;
            for (const friend of friends) {
                if (remaining <= 0) break;
                try {
                    const result: any = await deps.placeOnFriend(friend.gid, remaining);
                    const count: number = Math.max(0, toInt(result && result.placed));
                    if (count <= 0) continue;
                    placed += count;
                    remaining -= count;
                    dailyPlaced += count;
                    deps.setPlacedToday(dailyPlaced);
                } catch (error: any) {
                    deps.logWarn('好友', `给 ${friend.name || `GID:${friend.gid}`} 投放黄金虫失败: ${error?.message || error}`, {
                        module: 'friend',
                        event: '投放黄金虫',
                        result: 'error',
                        friendGid: friend.gid,
                    });
                }
            }

            if (placed > 0) {
                deps.log('好友', `黄金虫投放完成 ${placed} 只，获得经验 ${placed * GOLDEN_BUG_EXP_PER_ITEM}`, {
                    module: 'friend',
                    event: '投放黄金虫',
                    result: 'ok',
                    count: placed,
                    exp: placed * GOLDEN_BUG_EXP_PER_ITEM,
                    inventoryBefore: inventory,
                });
            }
            return { placed, inventory, dailyRemaining: Math.max(0, dailyLimit - dailyPlaced) };
        } catch (error: any) {
            deps.logWarn('好友', `黄金虫投放检查失败: ${error?.message || error}`, {
                module: 'friend',
                event: '投放黄金虫',
                result: 'error',
            });
            return null;
        } finally {
            running = false;
        }
    };
}

// ============ 生产依赖（延迟 require，避免与好友/仓库模块形成加载环） ============

function getStateFile(accountId: any): string {
    const { getDataFile } = require('../config/runtime-paths');
    const id: string = String(accountId || '').trim().replace(/[^\w-]/g, '_') || 'default';
    return getDataFile(`golden-bug-state-${id}.json`);
}

function readPlacedToday(accountId: any, dateKey: string): number {
    const { readJsonFile } = require('./json-db');
    const state: any = readJsonFile(getStateFile(accountId), () => ({}));
    if (Number(state?.version) !== STATE_VERSION || String(state?.date || '') !== dateKey) return 0;
    return Math.max(0, toInt(state?.placed));
}

function writePlacedToday(accountId: any, dateKey: string, placed: number): void {
    const { writeJsonFileAtomic } = require('./json-db');
    try {
        writeJsonFileAtomic(getStateFile(accountId), { version: STATE_VERSION, date: dateKey, placed: Math.max(0, toInt(placed)) });
    } catch {
        // 计数落盘失败不影响本轮投放，最坏情况是次日额度判断偏保守
    }
}

function buildProductionDeps(): GoldenBugPlacementDeps {
    const { isAutomationOn, getFriendBlacklist, getGoldenBugKeepCount, getGoldenBugRoundLimit } = require('../models/store');
    const { getUserState } = require('../utils/network');
    const { log, logWarn, toNum, getSystemDateKey } = require('../utils/utils');
    const { getAllFriends } = require('./friend/api');
    const { extractReplyFriends } = require('./friend/gid-manager');
    const { inFriendQuietHours } = require('./friend/visit-strategy');
    const { getBag, getBagItems } = require('./warehouse');
    const { placeGoldenBugOnFriendFarm } = require('./friend-interaction-items');

    const resolveAccountId = (): string => String(process.env.FARM_ACCOUNT_ID || '');

    return {
        isEnabled: () => !!isAutomationOn('friend') && !!isAutomationOn('friend_golden_bug'),
        isQuietHours: () => inFriendQuietHours(),
        getSelfGid: () => toNum(getUserState()?.gid),
        listFriends: async (): Promise<FriendSummary[]> => {
            const reply: any = await getAllFriends();
            return extractReplyFriends(reply).map((friend: any) => ({
                gid: toNum(friend && friend.gid),
                name: String((friend && (friend.remark || friend.name)) || ''),
                level: toNum(friend && friend.level),
            }));
        },
        getBlacklist: () => getFriendBlacklist(resolveAccountId()),
        getInventoryCount: async (): Promise<number> => getGoldenBugCount(getBagItems(await getBag())),
        getKeepCount: () => getGoldenBugKeepCount(resolveAccountId()),
        getRoundLimit: () => getGoldenBugRoundLimit(resolveAccountId()),
        placeOnFriend: (friendGid: number, count: number) => placeGoldenBugOnFriendFarm(friendGid, count),
        getPlacedToday: () => readPlacedToday(resolveAccountId(), getSystemDateKey()),
        setPlacedToday: (count: number) => writePlacedToday(resolveAccountId(), getSystemDateKey(), count),
        log,
        logWarn,
    };
}

let instance: ((options?: { force?: boolean }) => Promise<GoldenBugRunResult | null>) | null = null;

function runGoldenBugPlacement(options: { force?: boolean } = {}): Promise<GoldenBugRunResult | null> {
    if (!instance) instance = createGoldenBugPlacement(buildProductionDeps());
    return instance(options);
}

/** 仅测试用：清掉单例，让下次调用重新构建依赖。 */
function __resetGoldenBugPlacementInstance(): void {
    instance = null;
}

module.exports = {
    GOLDEN_BUG_ITEM_ID,
    GOLDEN_BUG_DAILY_LIMIT,
    MIN_RUN_INTERVAL_MS,
    DEFAULT_ROUND_LIMIT,
    MAX_ROUND_LIMIT,
    createGoldenBugPlacement,
    getGoldenBugCount,
    runGoldenBugPlacement,
    __resetGoldenBugPlacementInstance,
};
