export {};
/**
 * 资本模式：按作物成熟时间自动安排守护宠物。
 *
 * 守护宠物的价值集中在「作物快成熟到收获完成」这一段，长期挂着既浪费护主时长，
 * 也会和用户手动上场/召回的操作互相打架。这个模块把宠物派出收到成熟时刻驱动：
 *
 * - prepareForFarmOperation() 在每次务农前被调用（农业编排里 analyzeLands 之后），
 *   只在 opType 为 all/harvest、配置已启用、最近一块作物将在 leadSeconds 内成熟时才
 *   派出宠物；已有宠物在场上（通常是用户手动派的）时不抢位置；
 * - 派出成功后挂一个 120s 的兜底召回任务（withdraw_safety），
 *   收获事件迟迟不来（作物被偷光、务农失败）也不会把宠物永久留在场上；
 * - handleFarmHarvested() 在收获成功后挂 5s 的延迟召回，避免和设备端收获动画抢时序；
 * - reconcileConfigChange() 在配置变更时（用户关掉开关或换了宠物）
 *   把自动派出的宠物收回来，用户自己派的宠物不动；
 * - releaseForManualCommand() 在用户手动上场/召回宠物前清掉自动管理状态，
 *   把宠物的控制权交还给用户。
 *
 * state 只描述「自动派出」这一路：只要有 autoDogId，就说明当前场上的宠物是
 * 资本模式挂上去的；用户手动上场时 releaseForManualCommand() 会把 autoDogId 清空，
 * 之后收获事件不会再误召回用户自己派的宠物。
 */
const { PlantPhase } = require('../config/config');
const { getCapitalMode } = require('../models/store');
const { getServerTimeSec, log, toTimeSec } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { deployDog, getPetInfo, withdrawDog } = require('./pets');

// 派出失败后的最小重试间隔，避免每轮务农都去问一次 GetDogInfo
const DEFAULT_ATTEMPT_INTERVAL_MS: number = 5000;
// 兜底召回：派出后最迟留场时间，收获事件缺失时的保险
const DEFAULT_SAFETY_WITHDRAW_MS: number = 120000;
// 收获后延迟召回：给设备端收获动画留出时间
const DEFAULT_HARVEST_WITHDRAW_MS: number = 5000;

interface CapitalModeDeps {
    getCapitalMode: () => { enabled: boolean; dogId: number; leadSeconds: number };
    deployDog: (dogId: number) => Promise<any>;
    getPetInfo: () => Promise<any>;
    withdrawDog: () => Promise<any>;
    getServerTimeSec?: () => number;
    now?: () => number;
    scheduler?: { setTimeoutTask: (name: string, delayMs: number, fn: () => any) => any; clear: (name: string) => any };
    log?: (tag: string, message: string, extra?: any) => void;
    attemptIntervalMs?: number;
    safetyWithdrawMs?: number;
    harvestWithdrawMs?: number;
}

/** 协议里的 phase 可能是 number / Long / 字符串，统一成整数再比较 */
function toInt(value: unknown): number {
    if (value === null || value === undefined || value === '') return 0;
    const n: number = Number(value as any);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function createCapitalMode(options: CapitalModeDeps): any {
    const readConfig = options.getCapitalMode;
    const deploy = options.deployDog;
    const getPet = options.getPetInfo;
    const withdraw = options.withdrawDog;
    const nowSec = options.getServerTimeSec || getServerTimeSec;
    const nowMs = options.now || (() => Date.now());
    const scheduler = options.scheduler || createScheduler('capital-mode');
    const logger = options.log || log;
    const attemptIntervalMs = Number.isFinite(Number(options.attemptIntervalMs))
        ? Number(options.attemptIntervalMs)
        : DEFAULT_ATTEMPT_INTERVAL_MS;
    const safetyWithdrawMs = Number.isFinite(Number(options.safetyWithdrawMs))
        ? Number(options.safetyWithdrawMs)
        : DEFAULT_SAFETY_WITHDRAW_MS;
    const harvestWithdrawMs = Number.isFinite(Number(options.harvestWithdrawMs))
        ? Number(options.harvestWithdrawMs)
        : DEFAULT_HARVEST_WITHDRAW_MS;

    const state: { phase: string; autoDogId: number; lastAttemptAt: number } = {
        phase: 'idle',
        autoDogId: 0,
        lastAttemptAt: 0,
    };

    /**
     * 最近一块作物还有多少秒成熟；0 表示已有可收获作物，null 表示算不出来。
     */
    function findNearestMatureSeconds(lands: any[], analysis: any): number | null {
        if (analysis && Array.isArray(analysis.harvestable) && analysis.harvestable.length) return 0;
        const now = nowSec();
        let nearest = Infinity;
        for (const land of Array.isArray(lands) ? lands : []) {
            const phases = Array.isArray(land && land.plant && land.plant.phases) ? land.plant.phases : [];
            const mature = phases.find((phase: any) => toInt(phase && phase.phase) === PlantPhase.MATURE);
            const at = toTimeSec(mature && mature.begin_time);
            if (at > now) nearest = Math.min(nearest, at - now);
        }
        return Number.isFinite(nearest) ? nearest : null;
    }

    function clearOwnership(): void {
        scheduler.clear('withdraw_after_harvest');
        scheduler.clear('withdraw_safety');
        state.phase = 'idle';
        state.autoDogId = 0;
    }

    /** 手动上场/召回宠物前调用，把宠物的控制权交还给用户 */
    function releaseForManualCommand(): void {
        clearOwnership();
    }

    /** 取当前场上宠物的 ID（0 表示没有宠物在场上） */
    async function getDeployedDogId(): Promise<number> {
        const snapshot = await getPet();
        return toInt(snapshot && snapshot.activeDogId);
    }

    /**
     * 务农前准备：最近一块作物即将成熟时，按配置把守护宠物派上场。
     * 返回是否真的派出了宠物。
     */
    async function prepareForFarmOperation({ lands, analysis, opType }: { lands: any[]; analysis: any; opType: string }): Promise<boolean> {
        if (opType !== 'all' && opType !== 'harvest') return false;
        const config = readConfig();
        if (!config.enabled || !config.dogId || state.phase !== 'idle') return false;
        const matureIn = findNearestMatureSeconds(lands, analysis);
        if (matureIn === null || matureIn > config.leadSeconds || nowMs() - state.lastAttemptAt < attemptIntervalMs) return false;
        state.lastAttemptAt = nowMs();
        state.phase = 'deploying';
        try {
            const snapshot = await getPet();
            // 已有宠物在场上（通常是用户手动派的）就不要抢位置
            if (toInt(snapshot && snapshot.activeDogId)) {
                state.phase = 'idle';
                return false;
            }
            const dog = (snapshot && Array.isArray(snapshot.dogs) ? snapshot.dogs : [])
                .find((item: any) => toInt(item && item.id) === config.dogId && item && item.owned);
            if (!dog) {
                state.phase = 'idle';
                return false;
            }
            await deploy(config.dogId);
            state.autoDogId = config.dogId;
            state.phase = 'deployed';
            scheduler.setTimeoutTask('withdraw_safety', safetyWithdrawMs, async () => {
                if (!state.autoDogId || state.phase !== 'deployed') return;
                const dogId = state.autoDogId;
                state.phase = 'withdrawing';
                try {
                    const latest = await getDeployedDogId();
                    if (latest === dogId) await withdraw();
                } catch (error: any) {
                    logger('宠物', `资本模式安全召回失败: ${error.message}`, { module: 'dog', event: '资本模式召回', result: 'error', dogId });
                } finally {
                    clearOwnership();
                }
            });
            logger('宠物', `资本模式已派出${dog.name}`, { module: 'dog', event: '资本模式派出', result: 'ok', matureIn });
            return true;
        } catch (error: any) {
            clearOwnership();
            logger('宠物', `资本模式派出失败: ${error.message}`, { module: 'dog', event: '资本模式派出', result: 'error' });
            return false;
        }
    }

    /** 收获完成后延迟召回自动派出的宠物 */
    function handleFarmHarvested(): void {
        if (!state.autoDogId || state.phase !== 'deployed') return;
        scheduler.setTimeoutTask('withdraw_after_harvest', harvestWithdrawMs, async () => {
            const dogId = state.autoDogId;
            state.phase = 'withdrawing';
            try {
                const latest = await getDeployedDogId();
                if (latest === dogId) await withdraw();
                logger('宠物', '资本模式已在收获后召回宠物', { module: 'dog', event: '资本模式召回', result: 'ok', dogId });
            } catch (error: any) {
                logger('宠物', `资本模式召回失败: ${error.message}`, { module: 'dog', event: '资本模式召回', result: 'error', dogId });
            } finally {
                clearOwnership();
            }
        });
    }

    /**
     * 配置变更后的收尾：关掉开关或换了宠物时，
     * 把资本模式派出的宠物收回来（用户自己派的宠物不动）。
     */
    async function reconcileConfigChange(previous: any, next: any): Promise<void> {
        if (!state.autoDogId || (next && next.enabled === true && Number(next.dogId) === state.autoDogId)) return;
        try {
            const latest = await getDeployedDogId();
            if (latest === state.autoDogId) await withdraw();
        } finally {
            clearOwnership();
        }
    }

    return {
        findNearestMatureSeconds,
        prepareForFarmOperation,
        handleFarmHarvested,
        reconcileConfigChange,
        releaseForManualCommand,
        _state: state,
    };
}

// 进程内单实例：worker 每个账号一个进程，不必按账号分表
const instance = createCapitalMode({ getCapitalMode, deployDog, getPetInfo, withdrawDog });

module.exports = {
    DEFAULT_ATTEMPT_INTERVAL_MS,
    DEFAULT_SAFETY_WITHDRAW_MS,
    DEFAULT_HARVEST_WITHDRAW_MS,
    toInt,
    createCapitalMode,
    findNearestMatureSeconds: instance.findNearestMatureSeconds,
    prepareForFarmOperation: instance.prepareForFarmOperation,
    handleFarmHarvested: instance.handleFarmHarvested,
    reconcileConfigChange: instance.reconcileConfigChange,
    releaseForManualCommand: instance.releaseForManualCommand,
    _state: instance._state,
};
