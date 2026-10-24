export {};
/**
 * 奶茶热销中（S4）自动化。
 *
 * 严格复用 `milk-tea` service 的手动能力（`getMilkTeaActivity` / `operateMilkTeaActivity`），
 * 不绕过任何前置校验（限购、资源、活动窗口、结算期限制、拒绝钻石）。所有写操作都走
 * `{ auto: true }`，由 service 用刚读取的服务器快照自行选择材料 / 员工 / 目标商品。
 *
 * 执行顺序（对齐官方客户端与源仓库 worker）：
 *   领取收益 → 领取工资 → 升级店铺 → 制作奶茶 → 使用宣传喇叭 → 雇佣员工 → 购买种子
 *   → 工作互动 → 领取每日快乐值 → 领取快乐值档位奖励 → 领取成长基金奖励
 *
 * 设计约束：
 * - 每次运行最多读 2-4 份快照（店铺 / 快乐值 / 成长基金 / 兑换商店），写操作各自独立 try/catch，
 *   单步失败只记日志，不阻断其它步骤。
 * - 结算期只保留「领取类」动作（收益 / 工资 / 快乐值 / 基金）。
 * - 活动未开放或子活动未下发（MILK_TEA_UNAVAILABLE）静默跳过，不当成错误反复告警。
 * - 每个账号一个 worker 进程，进程内单实例 + running 锁即可挡住并发执行。
 */

const DEFAULT_MIN_RUN_INTERVAL_MS: number = 5 * 60 * 1000;
const DEFAULT_HIRE_DURATION: number = 1;
const HIRE_DURATIONS: number[] = [1, 2, 3];
const HIRE_TALENTS: number[] = [0, 9001, 9002, 9003, 9004];

const AUTOMATION_KEYS: Record<string, string> = {
    cashier: 'milk_tea_cashier',
    wages: 'milk_tea_wages',
    upgrade: 'milk_tea_upgrade',
    craft: 'milk_tea_craft',
    boost: 'milk_tea_boost',
    hire: 'milk_tea_hire',
    seedBuy: 'milk_tea_seed_buy',
    interact: 'milk_tea_interact',
    shareDaily: 'milk_tea_share_daily',
    shareRewards: 'milk_tea_share_rewards',
    fundRewards: 'milk_tea_fund_rewards',
};

const ACTION_LABELS: Record<string, string> = {
    cashier: '领取收益',
    wages: '领取工资',
    upgrade: '升级店铺',
    craft: '制作奶茶',
    boost: '使用宣传喇叭',
    hire: '雇佣员工',
    seedBuy: '购买商品',
    interact: '工作互动',
    shareDaily: '领取每日快乐值',
    shareRewards: '领取快乐值奖励',
    fundRewards: '领取成长基金奖励',
};

/** 活动未开放 / 渠道未下发子活动：跳过即可，不值得每 5 分钟告警一次。 */
const INACTIVE_CODES: Set<string> = new Set(['MILK_TEA_UNAVAILABLE']);

function errorCode(error: any): string {
    const raw: any = error && (error.code ?? error.errorCode);
    if (raw !== undefined && raw !== null && String(raw).length > 0) return String(raw);
    return '';
}

function isInactiveError(error: any): boolean {
    return INACTIVE_CODES.has(errorCode(error));
}

function toNum(value: any): number {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function clampDuration(value: any): number {
    const parsed: number = toNum(value);
    return HIRE_DURATIONS.includes(parsed) ? parsed : DEFAULT_HIRE_DURATION;
}

function clampTalent(value: any): number {
    const parsed: number = toNum(value);
    return HIRE_TALENTS.includes(parsed) ? parsed : 0;
}

interface MilkTeaAutomationDeps {
    /** 读取某一个自动化开关。 */
    isEnabled: (key: string) => boolean;
    /** 雇佣时长档位：1（4h）/ 2（12h）/ 3（24h）。 */
    getHireDuration: () => number;
    /** 雇佣偏好员工类型：0（不限）/ 9001-9004。 */
    getHireTalent: () => number;
    /** 活动快照：`getMilkTeaActivity(page, input)`。 */
    getActivity: (page: string, input?: any) => Promise<any>;
    /** 活动操作：`operateMilkTeaActivity(action, input)`。 */
    operate: (action: string, input?: any) => Promise<any>;
    log: (tag: string, message: string, extra?: any) => void;
    logWarn: (tag: string, message: string, extra?: any) => void;
    now?: () => number;
    minRunIntervalMs?: number;
}

interface MilkTeaAutomationResult {
    skipped: string | null;
    actions: string[];
}

function createMilkTeaAutomation(deps: MilkTeaAutomationDeps): (options?: { force?: boolean }) => Promise<MilkTeaAutomationResult | null> {
    const now: () => number = deps.now || (() => Date.now());
    const minRunIntervalMs: number = Math.max(0, Number(deps.minRunIntervalMs) || DEFAULT_MIN_RUN_INTERVAL_MS);
    let running: boolean = false;
    let lastRunAt: number = 0;

    const isOn = (name: string): boolean => !!deps.isEnabled(AUTOMATION_KEYS[name]);

    const readPage = async (page: string, input?: any): Promise<any> => {
        try {
            return await deps.getActivity(page, input);
        } catch (error: any) {
            if (!isInactiveError(error)) {
                deps.logWarn('活动', `奶茶热销中读取活动状态失败: ${error?.message || error}`, {
                    module: 'activity',
                    event: '奶茶热销中自动任务',
                    page,
                    result: 'error',
                });
            }
            return null;
        }
    };

    return async function runMilkTeaAutomation(options: { force?: boolean } = {}): Promise<MilkTeaAutomationResult | null> {
        if (running) return null;
        const anyEnabled: boolean = Object.keys(AUTOMATION_KEYS).some(isOn);
        if (!anyEnabled) return null;

        const startedAt: number = now();
        if (!options.force && startedAt - lastRunAt < minRunIntervalMs) return null;

        running = true;
        lastRunAt = startedAt;
        const result: MilkTeaAutomationResult = { skipped: null, actions: [] };

        /** 单步执行：成功后记录动作名，失败只记日志。 */
        const step = async (name: string, action: string, input: any = {}): Promise<void> => {
            try {
                const reply: any = await deps.operate(action, { ...input, auto: true });
                if (reply?.skipped) return;
                result.actions.push(name);
                deps.log('活动', `奶茶热销中${ACTION_LABELS[name]}完成`, {
                    module: 'activity',
                    event: `奶茶热销中${ACTION_LABELS[name]}`,
                    result: 'ok',
                });
            } catch (error: any) {
                if (isInactiveError(error)) return;
                deps.logWarn('活动', `奶茶热销中${ACTION_LABELS[name]}失败: ${error?.message || error}`, {
                    module: 'activity',
                    event: `奶茶热销中${ACTION_LABELS[name]}`,
                    result: 'error',
                });
            }
        };

        try {
            const needsShop: boolean = ['cashier', 'wages', 'upgrade', 'craft', 'boost', 'hire', 'seedBuy', 'interact'].some(isOn);
            const state: any = needsShop ? await readPage('shop') : null;
            if (needsShop && !state) {
                result.skipped = '活动未开放';
                return result;
            }
            if (needsShop && !state.active) {
                result.skipped = '活动未开放';
                return result;
            }

            if (state) {
                const opened: boolean = toNum(state.summary?.shop_open_at) > 0;
                const settling: boolean = !!state.settling;
                const shop: any = state.shop || {};
                const balances: any = state.balances || {};

                if (isOn('cashier') && opened && (shop.pending_rewards || []).some((v: any) => toNum(v.count) > 0)) {
                    await step('cashier', 'claim');
                }
                if (isOn('wages') && opened && state.summary?.has_unclaimed_wage) {
                    await step('wages', 'wages');
                }
                if (!settling) {
                    if (isOn('upgrade') && opened && state.summary?.can_upgrade) {
                        await step('upgrade', 'upgrade');
                    }
                    if (isOn('craft') && opened && (state.recipes || []).some((v: any) =>
                        v.unlocked && v.is_advanced && toNum(balances[String(toNum(v.fruitId))]) > 0)) {
                        await step('craft', 'craft');
                    }
                    if (isOn('boost') && opened && !shop.is_settling && toNum(balances[String(toNum(shop.sales_item_id))]) > 0) {
                        await step('boost', 'boost', { count: 1 });
                    }
                    if (isOn('hire') && opened) {
                        const level = (state.levels || []).find((v: any) => toNum(v.level) === toNum(shop.level));
                        const capacity: number = toNum(level?.employee_slot_count);
                        const slots: any[] = shop.slots || [];
                        let slot: number | null = null;
                        for (let index = 0; index < capacity; index += 1) {
                            if (!slots.some((v: any) => toNum(v.slot_index) === index && toNum(v.end_at) > toNum(state.serverTime))) {
                                slot = index;
                                break;
                            }
                        }
                        if (slot != null) {
                            await step('hire', 'hire', {
                                slotIndex: slot,
                                durationId: clampDuration(deps.getHireDuration()),
                                talentId: clampTalent(deps.getHireTalent()),
                            });
                        }
                    }
                    if (isOn('interact') && opened) {
                        // 互动只在班次进行中有效，且一个班次通常只允许一次；先读工作页避免每轮空转告警。
                        const work: any = await readPage('work');
                        const shift: any = work?.work?.my_shift;
                        if (work && shift && !work.work.interact_done
                            && toNum(shift.end_at) > toNum(work.serverTime)
                            && toNum(shift.interact_count) < toNum(shift.interact_limit)) {
                            await step('interact', 'interact');
                        }
                    }
                    if (isOn('seedBuy')) {
                        const exchange: any = await readPage('exchange');
                        if (exchange && exchange.active && !exchange.settling) {
                            const goods = (exchange.goods || []).find((v: any) => v.category === 'seed' && v.available
                                && toNum(v.remaining ?? 1) > 0
                                && (v.costs || []).every((cost: any) => toNum(exchange.balances?.[String(toNum(cost.id))]) >= toNum(cost.count)));
                            if (goods) await step('seedBuy', 'exchange', { goodsId: goods.id, count: 1 });
                        }
                    }
                }
            }

            // 快乐值 / 成长基金与店铺经营相互独立，店铺未开业也要尝试领取。
            if (isOn('shareDaily') || isOn('shareRewards')) {
                const share: any = await readPage('share');
                if (share && share.active && share.share) {
                    if (isOn('shareDaily') && !share.share.daily?.claimed) {
                        await step('shareDaily', 'shareDaily');
                    }
                    if (isOn('shareRewards') && (share.share.milestones || []).some((v: any) => toNum(v.state) === 2)) {
                        await step('shareRewards', 'shareRewards');
                    }
                }
            }
            if (isOn('fundRewards')) {
                const fund: any = await readPage('fund');
                if (fund && fund.active && fund.fund?.unlocked && (fund.fund.tiers || []).some((v: any) => toNum(v.state) === 2)) {
                    await step('fundRewards', 'fundClaim');
                }
            }

            return result;
        } finally {
            running = false;
        }
    };
}

// ============ 生产依赖（延迟 require，避免与活动模块形成加载环） ============

let instance: ((options?: { force?: boolean }) => Promise<MilkTeaAutomationResult | null>) | null = null;

function buildProductionDeps(): MilkTeaAutomationDeps {
    const store = require('../models/store');
    const { log, logWarn } = require('../utils/utils');
    const milk = require('./milk-tea');

    return {
        isEnabled: (key: string) => !!store.isAutomationOn(key),
        getHireDuration: () => clampDuration(store.getAutomation ? store.getAutomation().milk_tea_hire_duration : DEFAULT_HIRE_DURATION),
        getHireTalent: () => clampTalent(store.getAutomation ? store.getAutomation().milk_tea_hire_talent : 0),
        getActivity: (page: string, input?: any) => milk.getMilkTeaActivity(page, input),
        operate: (action: string, input?: any) => milk.operateMilkTeaActivity(action, input),
        log,
        logWarn,
    };
}

function runMilkTeaAutomation(options: { force?: boolean } = {}): Promise<MilkTeaAutomationResult | null> {
    if (!instance) instance = createMilkTeaAutomation(buildProductionDeps());
    return instance(options);
}

/** 仅测试用：清掉单例，让下次调用重新构建依赖。 */
function __resetMilkTeaAutomationInstance(): void {
    instance = null;
}

module.exports = {
    DEFAULT_MIN_RUN_INTERVAL_MS,
    DEFAULT_HIRE_DURATION,
    HIRE_DURATIONS,
    HIRE_TALENTS,
    AUTOMATION_KEYS,
    ACTION_LABELS,
    clampDuration,
    clampTalent,
    createMilkTeaAutomation,
    runMilkTeaAutomation,
    __resetMilkTeaAutomationInstance,
};
