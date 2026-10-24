/**
 * 好友巡查调度 - 循环管理、每日重置、经验限制、自动接受好友、启动捣乱
 */

const { CONFIG } = require('../../config/config');
const crypto = require('node:crypto');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, getSystemDateKey, log, logWarn, randomDelay } = require('../../utils/utils');
const { getDataFile } = require('../../config/runtime-paths');
const { createScheduler } = require('../scheduler');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { setOperationLimitsCallback } = require('../farm');
const {
    isAutomationOn,
    getFriendBlacklist,
    getAutoAcceptFriendMinLevel,
    getAutoAcceptRequireOwnLevel,
    getAutoAcceptHarvestStealEnabled,
    getAutoAcceptHarvestStealHarvest,
    getAutoAcceptHarvestStealSteal,
} = require('../../models/store');
const { sellAllFruits } = require('../warehouse');
const { getCareerInfo } = require('../career');
const {
    getAllFriends,
    acceptFriends,
    rejectFriends,
    getApplications,
} = require('./api');
const {
    isHarvestStealFilterEnabled,
    evaluateLevelFilter,
    evaluateHarvestStealFilter,
} = require('./application-filter');
const {
    extractReplyFriends,
    clearAllInvalidKnownFriendGidCooldowns,
} = require('./gid-manager');
const {
    visitFriend,
    inFriendQuietHours,
    cacheFriendsListFromReply,
    clearFriendsListCache,
} = require('./visit-strategy');
const { buildFriendVisitPlan } = require('./visit-plan');
const { selectFriendVisitBatch, resetFriendVisitPacing } = require('./visit-pacing');
const {
    getNextStealDelayMs,
    observeFriendSummaries,
    planStealWake,
    resetFriendMaturityPlans,
} = require('./maturity-plan');
const { getFriendDogState, flushFriendPetCacheNow } = require('./pet-cache');

// 延迟引用 pet-sync，它反向依赖本模块的 isFriendCheckRunning
function petSyncRef(): any {
    return require('./pet-sync');
}

// ============ 内部状态 ============
let isCheckingFriends: boolean = false;
let friendLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let lastResetDate: string = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler: any = createScheduler('friend');

const operationLimits: Map<number, any> = new Map();

let canGetHelpExp: boolean = true;
let helpAutoDisabledByLimit: boolean = false;
let badOperationLimitReached: boolean = false;
let consecutiveBadFailures: number = 0;

// Captured PutWeeds/PutInsects replies both consume operation 10003.
// PutInsects additionally reports 10004, but 10003 is the shared daily quota.
const BAD_SHARED_LIMIT_ID: number = 10003;
const BAD_DAILY_STATE_VERSION: number = 1;
// 单块地返回 1001046 只说明「这一块现在放不了」——可能是该地块/该好友的条件不满足，也可能是
// 共享日额度用尽。连续这么多块被拒才判定额度用尽、停用当天；服务端 operation_limits 才是
// 额度用尽的权威信号，不走这个阈值。
const BAD_CONSECUTIVE_FAILURE_LIMIT: number = 3;
// 一轮最多对多少位「没可偷也没可帮」的好友做纯捣乱访问（按等级降序）；有可偷/可帮的好友是顺手放，不占这个上限
const MAX_BAD_ONLY_VISITS_PER_ROUND: number = 20;

const OP_NAMES: Record<number, string> = {
    10001: '浇水',
    10002: '除虫',
    10003: '捣乱共享额度',
    10004: '放虫',
    10005: '帮助操作 #10005',
    10006: '帮助操作 #10006',
    10007: '帮助操作 #10007',
    10008: '铲除',
};

// ============ 操作限制相关 ============

function getBadDailyStateFile(): string {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token: string = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-bad-state-${token}.json`);
}

function loadBadDailyStop(today: string): boolean {
    const state: any = readJsonFile(getBadDailyStateFile(), () => ({}));
    return Number(state?.version) === BAD_DAILY_STATE_VERSION
        && String(state?.date || '') === today
        && state?.stopped === true;
}

function persistBadDailyStop(today: string): void {
    writeJsonFileAtomic(getBadDailyStateFile(), {
        version: BAD_DAILY_STATE_VERSION,
        date: today,
        stopped: true,
    });
}

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
export function checkDailyReset(): void {
    const today: string = getSystemDateKey();
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        badOperationLimitReached = loadBadDailyStop(today);
        consecutiveBadFailures = 0;
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }
}

export function isBadOperationLimitReached(): boolean {
    checkDailyReset();
    return badOperationLimitReached;
}

export function markBadOperationLimitReached(method: string = ''): boolean {
    checkDailyReset();
    if (badOperationLimitReached) return false;
    badOperationLimitReached = true;
    try {
        persistBadDailyStop(lastResetDate || getSystemDateKey());
    } catch (e: any) {
        logWarn('好友', `保存当日捣乱停用状态失败: ${e.message}`);
    }
    log('好友', '今日放虫/放草次数已达上限，停止两类操作', {
        module: 'friend',
        event: '放虫放草次数上限',
        result: 'limit',
        code: 1001046,
        method: String(method || ''),
    });
    return true;
}

/**
 * 记录一次放草/放虫被拒（网关错误码 1001046），返回当前是否已判定「今日额度用尽」。
 * 连续被拒到 BAD_CONSECUTIVE_FAILURE_LIMIT 次之前只是跳过这一块，不停用当天。
 */
export function noteBadOperationFailure(method: string = ''): boolean {
    checkDailyReset();
    if (badOperationLimitReached) return true;
    consecutiveBadFailures += 1;
    if (consecutiveBadFailures >= BAD_CONSECUTIVE_FAILURE_LIMIT) {
        markBadOperationLimitReached(method || 'consecutive_failures');
        return true;
    }
    log('好友', `放草/放虫被拒(${method || '未知方法'})，连续 ${consecutiveBadFailures}/${BAD_CONSECUTIVE_FAILURE_LIMIT} 次，跳过该地块继续`, {
        module: 'friend',
        event: '放虫放草失败',
        result: 'error',
        code: 1001046,
        method: String(method || ''),
        consecutiveFailures: consecutiveBadFailures,
    });
    return false;
}

/** 成功放过一次草或虫：连续被拒计数清零。 */
export function noteBadOperationSuccess(): void {
    if (consecutiveBadFailures !== 0) consecutiveBadFailures = 0;
}

export function autoDisableHelpByExpLimit(): void {
    if (!canGetHelpExp) return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
    });
}

/**
 * 更新操作限制状态
 */
export function updateOperationLimits(limits: any[]): void {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id: number = toNum(limit.id);
        if (id > 0) {
            const data: any = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
            if (id === BAD_SHARED_LIMIT_ID && data.dayTimesLimit > 0 && data.dayTimes >= data.dayTimesLimit) {
                markBadOperationLimitReached('operation_limit');
            }
        }
    }
}

export function canGetExpByCandidates(opIds: number[] = []): boolean {
    const ids: number[] = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
export function canGetExp(opId: number): boolean {
    const limit: any = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
export function canOperate(opId: number): boolean {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached) return false;
    const limit: any = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
export function getRemainingTimes(opId: number): number {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

export function getRemainingBadOperationTimes(): number {
    checkDailyReset();
    if (badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(BAD_SHARED_LIMIT_ID);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
export function getOperationLimits(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit: any = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}

// ============ 帮助经验状态访问器 ============

export function getCanGetHelpExp(): boolean {
    return canGetHelpExp;
}

export function setCanGetHelpExp(val: boolean): void {
    canGetHelpExp = val;
}

// ============ 好友巡查主循环 ============

interface CheckFriendsOptions {
    onlyHelp?: boolean;
    onlySteal?: boolean;
    onlyBad?: boolean;
    ignoreExpLimit?: boolean;
    /** 点名优先访问的好友（成熟唤醒带上刚成熟的那几位，跳过访问冷却）。 */
    focusGids?: number[];
}

// 好友巡查与面板的好友天气扫描共用“进入好友农场”这一游戏状态，
// 扫描靠这个标志让位，保证好友任务优先执行。
export function isFriendCheckRunning(): boolean {
    return isCheckingFriends;
}

export async function checkFriends(options: CheckFriendsOptions = {}): Promise<boolean> {
    const state: any = getUserState();
    if (!isAutomationOn('friend')) return false;

    const accountId: string = process.env.FARM_ACCOUNT_ID || '';

    const helpEnabled: boolean = !!isAutomationOn('friend_help');
    const stealEnabled: boolean = !!isAutomationOn('friend_steal');
    const badEnabled: boolean = !!isAutomationOn('friend_bad');

    const onlyHelp: boolean = options.onlyHelp || false;
    const onlySteal: boolean = options.onlySteal || false;
    const onlyBad: boolean = options.onlyBad || false;
    const ignoreExpLimit: boolean = options.ignoreExpLimit || false;

    const effectiveHelpEnabled: boolean = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled: boolean = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled: boolean = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);

    const hasAnyFriendOp: boolean = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;

    isCheckingFriends = true;
    checkDailyReset();

    try {
        const friendsReply: any = await getAllFriends();
        // 巡查结果同时刷新面板好友列表缓存，避免页面再次请求同一份列表。
        cacheFriendsListFromReply(friendsReply);
        const friends: any[] = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }

        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));

        // 列表回包里的成熟倒计时是成熟计划最便宜的来源（列表本来就要拉），顺手记下，
        // 并立刻按新的成熟时间重排偷菜唤醒。
        observeFriendSummaries(friends, { myGid: state.gid, blacklist });
        refreshStealMaturitySchedule();

        // 经验满不帮时，本轮只帮当天缓存已确认是护主犬的好友；缓存没结论的交给每日宠物同步补齐。
        const stopWhenExpLimit: boolean = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
        const protectDogBypassEnabled: boolean = !!isAutomationOn('friend_help_protect_dog_ignore_exp_limit');
        const helpAllowedForAll: boolean = !stopWhenExpLimit || canGetHelpExp;

        // 一次算清每位好友这轮要做哪几件事，然后每位好友只进一次农场把三件事一起做完。
        const plan: any = buildFriendVisitPlan({
            friends,
            myGid: state.gid,
            blacklist,
            stealEnabled: effectiveStealEnabled,
            helpEnabled: effectiveHelpEnabled,
            badEnabled: effectiveBadEnabled && !isBadOperationLimitReached(),
            helpAllowedForAll,
            protectDogBypassEnabled,
            getDogState: getFriendDogState,
            badBudget: getRemainingBadOperationTimes(),
            maxBadOnlyVisits: MAX_BAD_ONLY_VISITS_PER_ROUND,
        });

        const totalActions: any = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };

        if (plan.skippedExpLimit > 0) {
            log('好友', `经验已达上限，本轮跳过 ${plan.skippedExpLimit} 位非护主犬好友（未进农场，其中 ${plan.skippedUnknownDog} 位宠物待同步）`, {
                module: 'friend',
                event: '好友巡查跳过',
                reason: 'protect_dog_cache_filtered',
                count: plan.skippedExpLimit,
                unknownDog: plan.skippedUnknownDog,
            });
        }

        if (plan.visits.length === 0) return false;

        // 每轮只访问一小批（默认 12 位）并轮转，好友多的时候不会一轮把网关打满；
        // 成熟唤醒点名的那几位跳过冷却排在最前面。
        const visitBatch: any[] = selectFriendVisitBatch(plan.visits, {
            accountId,
            mode: 'friend',
            priorityGids: options.focusGids,
        });
        if (visitBatch.length === 0) return false;

        const batchSteal: number = visitBatch.filter((item: any) => item.wantSteal).length;
        const batchHelp: number = visitBatch.filter((item: any) => item.wantHelp).length;
        const batchBad: number = visitBatch.filter((item: any) => item.wantBad).length;

        log('好友', `开始好友巡查，本轮 ${visitBatch.length} 位（可偷 ${batchSteal} / 需帮 ${batchHelp} / 捣乱 ${batchBad}）`, {
            module: 'friend',
            event: '开始好友巡查',
            count: visitBatch.length,
            steal: batchSteal,
            help: batchHelp,
            bad: batchBad,
        });

        // 经验在本轮中途满掉之后被跳过的好友数
        let midRoundExpSkipped: number = 0;
        // 中途额度用完、本来要顺手捣乱的好友数（偷/帮照常做，只是不放草放虫）
        let badSkippedByLimit: number = 0;

        for (const target of visitBatch) {
            let allowBad: boolean = !!target.wantBad;
            if (allowBad && (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0)) {
                // 额度可能在本轮中途用尽：顺手捣乱降级为「不放」，偷/帮不受影响
                allowBad = false;
                badSkippedByLimit += 1;
                // 纯捣乱的好友排在队尾，额度用完就没必要为它多进一次农场了
                if (!target.wantSteal && !target.wantHelp) continue;
            } else if (target.wantHelp && !target.wantSteal && stopWhenExpLimit && !canGetHelpExp) {
                // 帮忙是这次进农场的唯一目的，但经验在本轮中途满了：不是护主犬就别进去了
                if (!protectDogBypassEnabled || getFriendDogState(target.gid) !== 'protect') {
                    midRoundExpSkipped += 1;
                    continue;
                }
            }

            try {
                await visitFriend(target, totalActions, state.gid, state.accountId, {
                    allowSteal: target.wantSteal,
                    allowHelp: target.wantHelp,
                    allowBad,
                    ignoreExpLimit,
                });
            } catch (e: any) {
                log('好友', `巡查好友失败: ${target.name}, 错误: ${e.message}`, {
                    module: 'friend', event: '好友巡查失败', friendName: target.name, error: e.message,
                });
            }

            // 真的放了草/虫就放慢一些，其余保持原节奏
            if (allowBad) await randomDelay(2000, 3500);
            else await randomDelay(500, 800);
        }

        if (midRoundExpSkipped > 0) {
            log('好友', `本轮帮助经验在中途达到上限，跳过剩余 ${midRoundExpSkipped} 位非护主犬好友`, {
                module: 'friend', event: '好友巡查跳过', reason: 'exp_limit', count: midRoundExpSkipped,
            });
        }

        if (badSkippedByLimit > 0) {
            log('好友', `放虫放草次数已用完，本轮 ${badSkippedByLimit} 位好友不再顺手捣乱`, {
                module: 'friend', event: '放虫放草次数用完', count: badSkippedByLimit,
            });
        }

        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await sellAllFruits();
            } catch {
                // ignore
            }
        }

        // 生成总结日志
        const summary: string[] = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.farming > 0) summary.push(`一键务农${totalActions.farming}`);
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        const totalVisited: number = visitBatch.length;
        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend', event: '好友巡查循环', result: 'ok', visited: totalVisited, summary
            });
        }
        return summary.length > 0;

    } catch (err: any) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

// ============ 成熟计划驱动的偷菜唤醒 ============

const STEAL_MATURITY_TASK: string = 'friend_steal_maturity';
let stealMaturityLoopRunning: boolean = false;

/** 已经排进去的唤醒时刻（毫秒），没排程时返回 0。 */
function getScheduledStealWakeAt(): number {
    const snapshot: any = friendScheduler.getSnapshot ? friendScheduler.getSnapshot() : null;
    const task: any = ((snapshot && snapshot.tasks) || []).find((item: any) => item.name === STEAL_MATURITY_TASK);
    return Number(task && task.nextRunAt) || 0;
}

/**
 * 排下一次唤醒。只在「新目标更早」时才改排程：固定间隔巡查每十几秒就会调一次本函数，
 * 若无条件重排，兜底定时器会被一直往后推，永远不会触发。
 */
function scheduleStealMaturityWake(delayMs?: number): void {
    if (!stealMaturityLoopRunning) return;
    const nextDelay: number = Math.max(0, toNum(delayMs) || getNextStealDelayMs());
    const scheduledAt: number = getScheduledStealWakeAt();
    if (scheduledAt > 0 && scheduledAt <= Date.now() + nextDelay) return;
    friendScheduler.setTimeoutTask(STEAL_MATURITY_TASK, nextDelay, () => friendStealMaturityLoop());
}

/** 计划表更新后立刻生效（好友列表刚算出的成熟时间不用等下一次兜底唤醒）。 */
function refreshStealMaturitySchedule(): void {
    scheduleStealMaturityWake();
}

/**
 * 成熟唤醒：睡到最近一位好友成熟的那一刻，醒来只跑一轮偷菜。
 * 这里不判断 externalSchedulerMode——正式运行时好友巡查正是外部统一调度的，
 * 但成熟唤醒有自己的节奏，固定间隔巡查与它互不影响（后者仍是兜底）。
 */
async function friendStealMaturityLoop(): Promise<void> {
    if (!stealMaturityLoopRunning) return;
    const decision: any = planStealWake({
        enabled: isAutomationOn('friend') && isAutomationOn('friend_steal'),
        quietHours: inFriendQuietHours(),
        busy: isFriendCheckRunning(),
    });
    if (decision.claim) {
        log('好友', `成熟计划：${decision.targets.length} 位好友作物已到成熟时间，提前巡查偷菜`, {
            module: 'friend',
            event: '成熟唤醒',
            result: 'run',
            friends: decision.targets.map((item: any) => item.name).join(', '),
        });
        // 巡查正跑着时上面的 busy 判断会挡住；这里再拿一次自动化锁，和面板等入口互斥。
        const focusGids: number[] = decision.targets.map((item: any) => toNum(item.gid));
        await runExclusiveAutomationTask(STEAL_MATURITY_TASK, () => checkFriends({ onlySteal: true, focusGids })).catch(() => null);
    }
    if (!stealMaturityLoopRunning) return;
    // 刚跑完巡查时计划表已经是最新的，直接按最新结果重排；没跑巡查时用决策算出的延迟。
    const nextDelay: number = decision.claim ? getNextStealDelayMs() : decision.delayMs;
    friendScheduler.setTimeoutTask(STEAL_MATURITY_TASK, Math.max(0, toNum(nextDelay)), () => friendStealMaturityLoop());
}

// ============ 循环控制 ============

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop(): Promise<void> {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await runExclusiveAutomationTask('friend_check_loop', checkFriends);
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

interface StartOptions {
    externalScheduler?: boolean;
}

export function startFriendCheckLoop(options: StartOptions = {}): void {
    if (friendLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;

    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);

    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);

    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
    }

    // 成熟唤醒循环：等首轮巡查把成熟计划填上之后再接手偷菜时机。
    stealMaturityLoopRunning = true;
    friendScheduler.setTimeoutTask(STEAL_MATURITY_TASK, 30 * 1000, () => friendStealMaturityLoop());

    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => (
        runExclusiveAutomationTask('friend_applications_bootstrap', checkAndAcceptApplications).catch(() => null)
    ));

    // 好友宠物每日同步（自带启动错峰与定时重试）
    petSyncRef().startFriendPetSyncTimer();
}

export function stopFriendCheckLoop(): void {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    stealMaturityLoopRunning = false;
    resetFriendMaturityPlans();
    resetFriendVisitPacing();
    petSyncRef().stopFriendPetSyncTimer();
    flushFriendPetCacheNow();
    clearAllInvalidKnownFriendGidCooldowns();
    clearFriendsListCache();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

export function refreshFriendCheckLoop(delayMs: number = 200): void {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

let applicationQueue: Promise<void> = Promise.resolve();

function getApplicationFilterConfig(): any {
    return {
        minLevel: getAutoAcceptFriendMinLevel(),
        requireOwnLevel: getAutoAcceptRequireOwnLevel(),
        ownLevel: toNum((getUserState() || {}).level),
        harvestStealEnabled: getAutoAcceptHarvestStealEnabled(),
        harvestPart: getAutoAcceptHarvestStealHarvest(),
        stealPart: getAutoAcceptHarvestStealSteal(),
    };
}

function enqueueApplications(applications: any[]): void {
    applicationQueue = applicationQueue
        .then(() => runExclusiveAutomationTask('friend_applications_push', () => processFriendApplications(applications)))
        .catch((e: any) => {
            logWarn('申请', `处理好友申请失败: ${e && e.message ? e.message : e}`);
        });
}

/**
 * 处理服务器推送的好友申请
 */
export function onFriendApplicationReceived(applications: any[]): void {
    if (!Array.isArray(applications) || applications.length === 0) return;
    const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);
    enqueueApplications(applications);
}

/**
 * 检查并处理所有待处理的好友申请
 */
async function checkAndAcceptApplications(): Promise<void> {
    if (!isAutomationOn('friend_auto_accept')) return;
    try {
        const reply: any = await getApplications();
        const applications: any[] = reply.applications || [];
        if (applications.length === 0) return;

        const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);
        await processFriendApplications(applications);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

async function processFriendApplications(applications: any[]): Promise<void> {
    if (!isAutomationOn('friend_auto_accept')) return;
    const list: any[] = Array.isArray(applications) ? applications : [];
    if (list.length === 0) return;

    const config = getApplicationFilterConfig();
    const checkRatio = isHarvestStealFilterEnabled(config);
    const accountId: string = process.env.FARM_ACCOUNT_ID || '';
    const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
    const toAccept: number[] = [];
    const toReject: Array<{ gid: number; name: string; reason: string }> = [];

    for (let i = 0; i < list.length; i++) {
        const app: any = list[i];
        const gid: number = toNum(app && app.gid);
        const name: string = (app && app.name) || `GID:${gid}`;
        const level: number = toNum(app && app.level);
        if (!gid) continue;

        if (blacklist.has(gid)) {
            toReject.push({ gid, name, reason: '已在本地黑名单' });
            continue;
        }

        const levelDecision = evaluateLevelFilter(level, config);
        if (levelDecision.action === 'reject') {
            toReject.push({ gid, name, reason: levelDecision.reason || '等级不足' });
            continue;
        }

        if (!checkRatio) {
            toAccept.push(gid);
            continue;
        }

        try {
            const career = await getCareerInfo(gid);
            const ratioDecision = evaluateHarvestStealFilter(career.harvest, career.steal, config);
            if (ratioDecision.action === 'reject') {
                toReject.push({ gid, name, reason: ratioDecision.reason || '收偷比不足' });
            } else {
                toAccept.push(gid);
            }
        } catch (e: any) {
            logWarn('申请', `${name} 生涯查询失败，暂不处理: ${e && e.message ? e.message : e}`);
        }

        if (i < list.length - 1 && checkRatio) {
            await randomDelay(150, 300);
        }
    }

    for (const item of toReject) {
        log('申请', `拒绝 ${item.name}: ${item.reason}`);
    }

    await rejectFriendsWithRetry(toReject.map((item) => item.gid));
    await acceptFriendsWithRetry(toAccept);
}

async function rejectFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        await rejectFriends(gids);
        log('申请', `已拒绝 ${gids.length} 人`);
    } catch (e: any) {
        logWarn('申请', `拒绝失败: ${e.message}`);
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        const reply: any = await acceptFriends(gids);
        const friends: any[] = reply.friends || [];
        if (friends.length > 0) {
            const names: string = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e: any) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 公开状态查询 ============

// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
export function isHelpExpLimitReached(): boolean {
    return helpAutoDisabledByLimit;
}

