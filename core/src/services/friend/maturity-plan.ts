export {};
/**
 * 好友作物成熟计划。
 *
 * 偷菜能不能抢到，取决于「作物成熟之后多久才发现」。固定间隔巡查只能靠碰运气，
 * 这个模块把每次顺手拿到的成熟信息攒成一张计划表（哪位好友、什么时候成熟），
 * 让偷菜由成熟时刻驱动：
 *
 * - 好友列表回包里的 plant.ripe_time_sec 是最便宜的来源（列表本来就要拉），
 *   但协议里它是「还有多少秒成熟」的倒计时，只有 > 0 才有意义；
 * - 进好友农场回包里的 lands 带每个地块各阶段的开始时间，成熟阶段
 *   （phase = 6，或记录 ID 19）的开始时间就是最准的成熟时刻，来自这里的
 *   数据不会被列表回包覆盖掉，因为列表回包经常给不出倒计时；
 * - claimDueFriends() 一次领走所有已到点的好友，并把它们顺延 5 分钟再复核，
 *   避免同一位好友被每一轮反复拉进扫描；
 * - getNextStealDelayMs() 给出「下次该醒来的延迟」，没有已知成熟时间时回落到 15 分钟。
 *
 * 醒来之后走的仍然是常规的好友巡查（checkFriends({ onlySteal: true })），
 * 固定间隔循环也照常保留：计划表算错了最坏只是少一次提前量，不会漏偷。
 */
const { getServerTimeSec, toNum, toTimeSec } = require('../../utils/utils');

// 没有已知成熟时间时的兜底唤醒间隔
const DEFAULT_WAKE_INTERVAL_MS: number = 15 * 60 * 1000;
// 到点好友复核间隔：领走之后先按这个时间顺延，防止同一批好友被连续拉起扫描
const DEFAULT_RECHECK_AFTER_DUE_MS: number = 5 * 60 * 1000;
// 巡查正在跑（或处于免打扰时段）时的重试间隔
const DEFAULT_BUSY_RETRY_MS: number = 60 * 1000;
// 单次唤醒最多带走的好友数
const DEFAULT_CLAIM_LIMIT: number = 12;
const MAX_CLAIM_LIMIT: number = 30;
// 大于这个量级的秒数按「绝对时间戳」解释，否则按「从现在起的倒计时秒」解释
const ABSOLUTE_TIME_THRESHOLD: number = 1_000_000_000;

interface FriendMaturityPlan {
    gid: number;
    name: string;
    /** 服务器秒；0 表示还没有任何成熟时间信息 */
    matureAt: number;
    /** 最近一次从好友列表摘要更新时间（本地毫秒） */
    summaryObservedAt: number;
    /** 最近一次从农场地块更新时间（本地毫秒） */
    landsObservedAt: number;
    source: string;
}

interface ObserveOptions {
    nowMs?: number;
    nowSec?: number;
    source?: string;
    name?: string;
}

interface ClaimOptions {
    nowSec?: number;
    limit?: number;
}

interface StealWakeOptions {
    enabled?: boolean;
    quietHours?: boolean;
    busy?: boolean;
    nowMs?: number;
    nowSec?: number;
    limit?: number;
    fallbackMs?: number;
    busyRetryMs?: number;
}

interface DueFriend {
    gid: number;
    name: string;
}

interface StealWakeDecision {
    /** 本次唤醒是否要真的跑一趟巡查 */
    claim: boolean;
    targets: DueFriend[];
    delayMs: number;
}

const plans: Map<number, FriendMaturityPlan> = new Map();

function resolveNowMs(value: any): number {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function resolveNowSec(value: any): number {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : getServerTimeSec();
}

function toInt(value: any): number {
    const parsed: number = Number(toNum(value));
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/**
 * 把协议里的时间统一成绝对服务器秒。
 * 协议同时存在「绝对时间戳」和「倒计时秒」两种写法（不同回包不一样），靠量级区分；
 * toTimeSec 已经把毫秒时间戳压成秒，这里不用再处理毫秒。
 */
function normalizeAbsoluteTime(value: any, nowSec: number = getServerTimeSec()): number {
    const raw: number = toTimeSec(value);
    if (raw <= 0) return 0;
    return raw > ABSOLUTE_TIME_THRESHOLD ? raw : nowSec + raw;
}

/** 地块里最近的未来成熟时刻；没有（作物已熟、空地和还没种）时返回 0。 */
function findNearestFutureMaturity(lands: any[], nowSec: number = getServerTimeSec()): number {
    let nearest: number = 0;
    for (const land of Array.isArray(lands) ? lands : []) {
        const phases: any[] = land && land.plant && Array.isArray(land.plant.phases) ? land.plant.phases : [];
        for (const phase of phases) {
            const phaseCode: number = toInt(phase && phase.phase);
            const phaseId: number = toInt(phase && phase.phase_id);
            // 成熟阶段：枚举值 6（成熟）或配置记录 ID 19
            if (phaseCode !== 6 && phaseId !== 19) continue;
            const matureAt: number = normalizeAbsoluteTime(phase.begin_time, nowSec);
            if (matureAt <= nowSec) continue;
            if (!nearest || matureAt < nearest) nearest = matureAt;
        }
    }
    return nearest;
}

function updatePlan(gid: any, patch: Partial<FriendMaturityPlan>): FriendMaturityPlan | null {
    const numericGid: number = toInt(gid);
    if (!numericGid) return null;
    const current: FriendMaturityPlan = plans.get(numericGid) || {
        gid: numericGid,
        name: '',
        matureAt: 0,
        summaryObservedAt: 0,
        landsObservedAt: 0,
        source: '',
    };
    const next: FriendMaturityPlan = { ...current, ...patch, gid: numericGid };
    plans.set(numericGid, next);
    return next;
}

/**
 * 记录好友列表摘要。倒计时给不出未来时间（作物已熟、没种、协议没填）时保留原值：
 * 列表回包每十几秒就来一次，如果按它清空，进农场才拿到的准确成熟时间会被冲掉。
 */
function observeFriendSummary(friend: any, options: ObserveOptions = {}): FriendMaturityPlan | null {
    const nowMs: number = resolveNowMs(options.nowMs);
    const nowSec: number = resolveNowSec(options.nowSec);
    const gid: number = toInt(friend && friend.gid);
    if (!gid) return null;
    const plant: any = (friend && friend.plant) || {};
    const current: FriendMaturityPlan | undefined = plans.get(gid);
    const observedMatureAt: number = normalizeAbsoluteTime(plant.ripe_time_sec, nowSec);
    const hasFuture: boolean = observedMatureAt > nowSec;
    return updatePlan(gid, {
        name: friend.remark || friend.name || (current && current.name) || `GID:${gid}`,
        matureAt: hasFuture ? observedMatureAt : ((current && current.matureAt) || 0),
        summaryObservedAt: nowMs,
        source: hasFuture ? 'summary' : ((current && current.source) || 'summary'),
    });
}

/**
 * 批量记录好友列表摘要，跳过自己和黑名单好友：
 * 黑名单好友不会被访问，给它们排唤醒只会白跑一趟巡查。
 */
function observeFriendSummaries(friends: any[], options: { myGid?: number; blacklist?: Set<number> | null } & ObserveOptions = {}): number {
    const myGid: number = toInt(options.myGid);
    const blacklist: Set<number> = options.blacklist instanceof Set ? options.blacklist : new Set();
    let observed: number = 0;
    for (const friend of Array.isArray(friends) ? friends : []) {
        const gid: number = toInt(friend && friend.gid);
        if (!gid || (myGid && gid === myGid) || blacklist.has(gid)) continue;
        if (observeFriendSummary(friend, options)) observed += 1;
    }
    return observed;
}

/**
 * 记录好友农场地块里的成熟时间。
 * source 为 lands_notify / harvest_reply 的回包只带部分地块，只用来把成熟时间提前，
 * 不能当成「没有成熟作物」而把已知的未来成熟时间抹掉。
 */
function observeFriendLands(gid: any, lands: any[], options: ObserveOptions = {}): FriendMaturityPlan | null {
    const nowMs: number = resolveNowMs(options.nowMs);
    const nowSec: number = resolveNowSec(options.nowSec);
    const numericGid: number = toInt(gid);
    if (!numericGid) return null;
    const source: string = options.source || 'lands';
    const current: FriendMaturityPlan | undefined = plans.get(numericGid);
    const currentMatureAt: number = (current && current.matureAt) || 0;
    const observedMatureAt: number = findNearestFutureMaturity(lands, nowSec);
    const partial: boolean = source === 'lands_notify' || source === 'harvest_reply';
    let matureAt: number = observedMatureAt;
    if (partial && currentMatureAt > nowSec) {
        matureAt = observedMatureAt > nowSec ? Math.min(currentMatureAt, observedMatureAt) : currentMatureAt;
    }
    return updatePlan(numericGid, {
        name: options.name || (current && current.name) || `GID:${numericGid}`,
        matureAt,
        landsObservedAt: nowMs,
        source,
    });
}

/**
 * 领走所有已到点的好友（按成熟时间排序），并把它们顺延 5 分钟再复核。
 * 顺延是为了让「已经偷过 / 其实没熟」的好友不会每轮都被拉起来。
 */
function claimDueFriends(options: ClaimOptions = {}): DueFriend[] {
    const nowSec: number = resolveNowSec(options.nowSec);
    const limit: number = Math.max(1, Math.min(toInt(options.limit) || DEFAULT_CLAIM_LIMIT, MAX_CLAIM_LIMIT));
    const due: FriendMaturityPlan[] = [...plans.values()]
        .filter((plan: FriendMaturityPlan) => plan.matureAt > 0 && plan.matureAt <= nowSec)
        .sort((a: FriendMaturityPlan, b: FriendMaturityPlan) => a.matureAt - b.matureAt || a.gid - b.gid)
        .slice(0, limit);
    for (const plan of due) {
        updatePlan(plan.gid, {
            matureAt: nowSec + Math.ceil(DEFAULT_RECHECK_AFTER_DUE_MS / 1000),
            source: 'due-recheck',
        });
    }
    return due.map((plan: FriendMaturityPlan) => ({ gid: plan.gid, name: plan.name || `GID:${plan.gid}` }));
}

/** 到下一次成熟（或兜底间隔）为止该睡多久。 */
function getNextStealDelayMs(options: { nowMs?: number; nowSec?: number; fallbackMs?: number } = {}): number {
    const nowMs: number = resolveNowMs(options.nowMs);
    const nowSec: number = resolveNowSec(options.nowSec);
    const fallbackMs: number = Math.max(60 * 1000, toInt(options.fallbackMs) || DEFAULT_WAKE_INTERVAL_MS);
    let wakeAt: number = 0;
    for (const plan of plans.values()) {
        if (plan.matureAt <= 0) continue;
        const matureMs: number = nowMs + Math.max(0, plan.matureAt - nowSec) * 1000;
        if (!wakeAt || matureMs < wakeAt) wakeAt = matureMs;
    }
    if (!wakeAt) return fallbackMs;
    return Math.max(1000, Math.min(fallbackMs, wakeAt - nowMs));
}

/**
 * 唤醒决策（纯逻辑，便于单测）：开关关着、免打扰、巡查正跑着都不发请求，
 * 只在真的到点时才 claim，并把顺延后的下次延迟一起算出来。
 * 不发请求的几种情况都不许用 getNextStealDelayMs() 的 1 秒下限：那几秒里没有巡查
 * 本身的耗时兜着，计划表里躺着的过期成熟时间会变成 1 秒一次的忙等。
 */
function planStealWake(options: StealWakeOptions = {}): StealWakeDecision {
    const nowMs: number = resolveNowMs(options.nowMs);
    const nowSec: number = resolveNowSec(options.nowSec);
    const busyRetryMs: number = Math.max(1000, toInt(options.busyRetryMs) || DEFAULT_BUSY_RETRY_MS);
    if (!options.enabled) {
        const delayMs: number = Math.max(busyRetryMs, getNextStealDelayMs({ nowMs, nowSec, fallbackMs: options.fallbackMs }));
        return { claim: false, targets: [], delayMs };
    }
    if (options.quietHours) {
        const delayMs: number = Math.max(busyRetryMs, getNextStealDelayMs({ nowMs, nowSec, fallbackMs: options.fallbackMs }));
        return { claim: false, targets: [], delayMs };
    }
    if (options.busy) {
        return { claim: false, targets: [], delayMs: busyRetryMs };
    }
    const targets: DueFriend[] = claimDueFriends({ nowSec, limit: options.limit });
    return {
        claim: targets.length > 0,
        targets,
        delayMs: getNextStealDelayMs({ nowMs, nowSec, fallbackMs: options.fallbackMs }),
    };
}

/** 停掉好友巡查时清空计划表，避免带着上一轮账号的成熟时间重新开始。 */
function resetFriendMaturityPlans(): void {
    plans.clear();
}

module.exports = {
    DEFAULT_WAKE_INTERVAL_MS,
    DEFAULT_RECHECK_AFTER_DUE_MS,
    DEFAULT_BUSY_RETRY_MS,
    DEFAULT_CLAIM_LIMIT,
    normalizeAbsoluteTime,
    findNearestFutureMaturity,
    observeFriendSummary,
    observeFriendSummaries,
    observeFriendLands,
    claimDueFriends,
    getNextStealDelayMs,
    planStealWake,
    resetFriendMaturityPlans,
};
