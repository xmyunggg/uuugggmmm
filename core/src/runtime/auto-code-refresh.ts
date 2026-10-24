export {};

const { createScheduler } = require('../services/scheduler');
const { WxLoginService } = require('../services/wx-login/service');
const { getOwnerBlockState } = require('../services/account-access');
const userStore = require('../models/user-store');

/**
 * 微信账号「自动刷新登录 Code / 自动重登」。
 *
 * 小游戏登录 Code 一次性有效，重启或掉线后旧 Code 必然失效；账号上持久化了
 * 扫码时拿到的应用宝凭证（loginBuffer + refreshtoken），可以随时换发新 Code：
 *  - 启动/手动启动前先换新 Code，重启后免扫码；
 *  - 连接断开/登录失效（400）后自动换 Code 并重连；
 *  - 按设置间隔定时换 Code 重连 + 定时轮换凭证保活。
 * 被踢下线（其他终端登录）不自动重登，避免和用户手机端互踢。
 */

const FARM_APP_ID = 'wx5306c5978fdb76e4';
const RELOGIN_DELAY_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 30 * 60_000;
const PREPARE_TIMEOUT_MS = 30_000;
const MAX_DAILY_RECOVERIES = 8;
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 30 * 60_000;

const RECOVERY_REASON_PREFIXES = ['ws_400', 'ws_reconnect_failed:', 'disconnect:', 'refresh_failed'];

function isRecoveryReason(reason: any): boolean {
    const text = String(reason || '');
    return RECOVERY_REASON_PREFIXES.some(prefix => text.includes(prefix));
}

function errorMessage(error: any): string {
    return error && error.message ? String(error.message) : String(error);
}

/**
 * refresh token 本身被微信拒绝（已失效/无权限）：只能重新扫码，重试没有意义。
 * code=-109 RC_PARAMS_INVALID 属于这一类。
 */
function isRefreshTokenDead(message: string): boolean {
    return /-109|RC_PARAMS_INVALID|RefreshToken empty/i.test(String(message || ''));
}

/**
 * 换 loginBuffer 时被微信拒绝，但 refresh token 仍有效（invalid scope / 40188）。
 * 凭证续期已成功，通常是微信侧对本次换发的临时拒绝，可稍后重试。
 */
function isTransientCredentialRejection(message: string): boolean {
    return /invalid scope|40188|too frequent|frequenc/i.test(String(message || ''));
}

/** 失败原因附上可操作的处理建议，避免面板只显示一串服务端原始错误码 */
function describeCredentialError(error: any): string {
    const message = errorMessage(error);
    if (isRefreshTokenDead(message)) {
        return `${message}（refresh token 已失效，请重新扫码登录）`;
    }
    if (isTransientCredentialRejection(message)) {
        return `${message}（微信侧拒绝了本次换发，凭证仍有效，可稍后重试）`;
    }
    return message;
}

/** loginBuffer 失效错误：需要先用 refreshtoken 续期再换 Code */
function isLoginBufferRejected(message: string): boolean {
    return message.includes('ManualAuth rejected');
}

function createAutoCodeRefreshService(deps: any) {
    const {
        store,
        getAccounts,
        addOrUpdateAccount,
        resolveWorkerControls,
        log = () => {},
        addAccountLog = () => {},
    } = deps || {};

    const scheduler = createScheduler('auto_code_refresh');
    const wxLogin = new WxLoginService();
    const recoveryState = new Map<string, any>();
    const locks = new Map<string, Promise<any>>();

    const refreshTaskName = (accountId: any) => `refresh_${String(accountId || '')}`;
    const keepaliveTaskName = (accountId: any) => `wx_keepalive_${String(accountId || '')}`;
    const reloginTaskName = (accountId: any) => `relogin_${String(accountId || '')}`;

    function listAccounts(): any[] {
        try {
            const data = typeof getAccounts === 'function' ? getAccounts() : store.getAccounts();
            return Array.isArray(data && data.accounts) ? data.accounts : [];
        } catch {
            return [];
        }
    }

    function findAccount(accountId: any): any {
        const id = String(accountId || '');
        if (!id) return null;
        return listAccounts().find(account => String(account.id) === id) || null;
    }

    /** 归属用户已到期/被封禁/已删除时，不再为这个账号自动换 Code 或重登 */
    function isOwnerBlocked(account: any): boolean {
        const owner = String((account && account.username) || '').trim();
        if (!owner) return false;
        const findUser = (username: string) => (typeof userStore.getUser === 'function' ? userStore.getUser(username) : null);
        return getOwnerBlockState(owner, findUser).blocked;
    }

    function getConfig(accountId: any): { enabled: boolean; intervalMinutes: number } {
        try {
            if (typeof store.getAutoCodeRefreshConfig === 'function') {
                const cfg = store.getAutoCodeRefreshConfig(accountId);
                return {
                    enabled: cfg.enabled === true,
                    intervalMinutes: Math.max(1, Math.min(1440, Number(cfg.intervalMinutes) || 60)),
                };
            }
        } catch {
            // fall through to defaults
        }
        return { enabled: false, intervalMinutes: 60 };
    }

    /** 微信扫码账号是否已持久化可换发 Code 的凭证（与开关状态无关） */
    function hasWxCredentials(account: any): boolean {
        if (!account) return false;
        if (String(account.platform || '') !== 'wx') return false;
        if (!String(account.wxid || '').trim()) return false;
        if (!String(account.loginBuffer || '').trim()) return false;
        return true;
    }

    /** 只有微信扫码账号 + 已存凭证 + 开关打开才参与自动刷新 */
    function isEligible(account: any): boolean {
        if (!hasWxCredentials(account)) return false;
        return getConfig(account.id).enabled;
    }

    function withLock<T>(accountId: any, operation: () => Promise<T>): Promise<T> {
        const key = String(accountId || '');
        const previous = locks.get(key) || Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        locks.set(key, current);
        return current.finally(() => {
            if (locks.get(key) === current) locks.delete(key);
        }) as Promise<T>;
    }

    function getRecoveryState(accountId: any): any {
        const key = String(accountId || '');
        const date = new Date().toISOString().slice(0, 10);
        const current = recoveryState.get(key);
        if (!current || current.date !== date) {
            const fresh = { date, attempts: 0, failures: 0, blockedUntil: 0, lastError: '' };
            recoveryState.set(key, fresh);
            return fresh;
        }
        return current;
    }

    function isBlocked(recovery: any): boolean {
        if (!recovery) return false;
        if (recovery.failures >= MAX_CONSECUTIVE_FAILURES && Date.now() < recovery.blockedUntil) return true;
        return recovery.attempts >= MAX_DAILY_RECOVERIES;
    }

    /** 重登成功后重置熔断计数；新扫码写入凭证时也应调用 */
    function resetRecovery(accountId: any): void {
        const state = recoveryState.get(String(accountId || ''));
        if (!state) return;
        state.failures = 0;
        state.blockedUntil = 0;
    }

    /** 只有凭证真的滚动时才写盘（并记录更新时间） */
    function persistAccount(account: any, patch: Record<string, any>): void {
        if (typeof addOrUpdateAccount !== 'function') return;
        const changes: Record<string, any> = { id: account.id };
        for (const [key, value] of Object.entries(patch)) {
            if (key === 'credentialUpdatedAt') continue;
            if (value === undefined || value === null || value === '') continue;
            if (String(account[key] || '') !== String(value)) changes[key] = value;
        }
        if (Object.keys(changes).length <= 1) return;
        changes.credentialUpdatedAt = Date.now();
        try {
            addOrUpdateAccount(changes);
        } catch (e: any) {
            log('错误', `保存账号 ${account.name || account.id} 微信凭证失败: ${errorMessage(e)}`, {
                accountId: String(account.id),
                accountName: account.name || '',
            });
        }
    }

    /**
     * 用账号持久化凭证换发小游戏登录 Code。
     * loginBuffer 失效时用 refreshtoken 续期并重试；续期成功但换 Code 失败，
     * 也必须落盘滚动后的新凭证（旧 token 已失效）。
     */
    async function issueFarmCode(account: any): Promise<string> {
        const openid = String(account.wxid || '').trim();
        let loginBuffer = String(account.loginBuffer || '').trim();
        let refreshtoken = String(account.refreshtoken || '');
        let accesstoken = String(account.accesstoken || '');
        if (!openid) throw new Error('账号缺少 wxid，请重新扫码登录');
        if (!loginBuffer) throw new Error('缺少登录凭证（loginBuffer），请重新扫码登录');

        let code = '';
        try {
            code = await wxLogin.issueCode({ loginBuffer }, FARM_APP_ID);
        } catch (error: any) {
            const message = errorMessage(error);
            if (!refreshtoken || !isLoginBufferRejected(message)) throw error;
            let refreshed: any = null;
            try {
                refreshed = await wxLogin.refreshLoginBuffer({ openid, refreshtoken, accesstoken });
            } catch (refreshError: any) {
                const rotated = refreshError || {};
                if (rotated.refreshtoken || rotated.accesstoken) {
                    persistAccount(account, {
                        refreshtoken: rotated.refreshtoken,
                        accesstoken: rotated.accesstoken,
                    });
                }
                throw new Error(`凭证续期失败: ${describeCredentialError(refreshError)}`);
            }
            loginBuffer = String(refreshed.loginBuffer || '');
            refreshtoken = String(refreshed.refreshtoken || refreshtoken);
            accesstoken = String(refreshed.accesstoken || accesstoken);
            code = await wxLogin.issueCode({ loginBuffer }, FARM_APP_ID);
        }
        if (!code) throw new Error('服务端未返回登录 Code');
        persistAccount(account, { loginBuffer, refreshtoken, accesstoken });
        return String(code);
    }

    /**
     * 换发新 Code 并重启账号。reason 用于区分定时/启动/掉线恢复，
     * 掉线恢复类原因计入每日次数与连续失败熔断。
     * reason='manual' 是用户在面板上主动点的，只校验凭证是否具备，不受开关与熔断限制。
     */
    async function refreshAccountCode(accountId: any, reason = 'timer'): Promise<boolean> {
        const account = findAccount(accountId);
        if (!account) return false;
        const manual = reason === 'manual';
        if (isOwnerBlocked(account)) {
            // 到期/封禁后不再换 Code，顺手清掉该账号的定时任务，避免反复触发
            stopAccount(accountId);
            log('系统', `账号 ${account.name} 归属用户已到期或封禁，已停止自动刷新 Code`, { accountId: String(account.id), accountName: account.name, reason });
            return false;
        }
        if (manual ? !hasWxCredentials(account) : !isEligible(account)) return false;

        const recovery = isRecoveryReason(reason) ? getRecoveryState(accountId) : null;
        if (recovery && isBlocked(recovery)) {
            addAccountLog('auto_relogin_blocked', `自动重登已暂停（今日尝试 ${recovery.attempts} 次，连续失败 ${recovery.failures} 次），请检查网络或重新扫码`, account.id, account.name, { reason });
            return false;
        }
        if (recovery) recovery.attempts += 1;

        try {
            const code = await withLock(accountId, () => issueFarmCode(account));
            const nextAccount = { ...account, code };
            if (typeof addOrUpdateAccount === 'function') addOrUpdateAccount({ id: account.id, code });
            const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
            if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);
            if (recovery) {
                recovery.failures = 0;
                recovery.lastError = '';
            }
            addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${account.name}`, account.id, account.name, { reason });
            log('系统', `自动刷新 Code 成功: ${account.name}`, { accountId: String(account.id), accountName: account.name, reason });
            return true;
        } catch (error: any) {
            const message = errorMessage(error);
            if (recovery) {
                recovery.failures += 1;
                recovery.lastError = message;
                if (recovery.failures >= MAX_CONSECUTIVE_FAILURES) {
                    recovery.blockedUntil = Date.now() + FAILURE_COOLDOWN_MS;
                }
            }
            addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${message}`, account.id, account.name, { reason });
            log('错误', `自动刷新 Code 失败: ${account.name} - ${message}`, { accountId: String(account.id), accountName: account.name, reason });
            return false;
        }
    }

    /** 掉线/登录失效后延迟重登（同一账号重复调用会重置延迟，避免并发刷新） */
    function scheduleRelogin(accountId: any, reason = 'disconnect'): boolean {
        const account = findAccount(accountId);
        if (!account) return false;
        if (isOwnerBlocked(account)) return false;
        if (String(reason || '').startsWith('kickout')) {
            // 被踢下线说明用户在其他终端登录了，自动重登会互踢；暂停自动刷新，等用户手动启动
            stopAccount(accountId);
            addAccountLog('auto_relogin_skipped', '账号被踢下线（可能在其他终端登录），已暂停自动刷新；手动启动账号后自动恢复', account.id, account.name, { reason });
            return false;
        }
        if (!isEligible(account)) return false;
        const recovery = getRecoveryState(accountId);
        if (isBlocked(recovery)) {
            addAccountLog('auto_relogin_blocked', `自动重登已暂停（今日尝试 ${recovery.attempts} 次，连续失败 ${recovery.failures} 次），请检查网络或重新扫码`, account.id, account.name, { reason });
            return false;
        }
        scheduler.setTimeoutTask(reloginTaskName(accountId), RELOGIN_DELAY_MS, () => refreshAccountCode(accountId, reason));
        return true;
    }

    /** 定时刷新 + 凭证保活（只对微信扫码账号生效，其它账号静默跳过） */
    function scheduleAccount(accountId: any): void {
        scheduler.clear(refreshTaskName(accountId));
        scheduler.clear(keepaliveTaskName(accountId));
        scheduler.clear(reloginTaskName(accountId));

        const account = findAccount(accountId);
        if (!account || String(account.platform || '') !== 'wx') return;
        if (isOwnerBlocked(account)) {
            log('系统', `账号 ${account.name} 归属用户已到期或封禁，跳过自动刷新 Code 调度`, { accountId: String(accountId), accountName: account.name });
            return;
        }
        if (!String(account.wxid || '').trim() || !String(account.loginBuffer || '').trim()) return;
        const cfg = getConfig(accountId);

        if (account.refreshtoken) {
            scheduler.setIntervalTask(keepaliveTaskName(accountId), KEEPALIVE_INTERVAL_MS, async () => {
                const latest = findAccount(accountId);
                // 保活只轮换凭证，与「自动刷新」开关解耦：关闭开关后凭证仍需续期，
                // 否则 refresh token 过期会连带未来手动刷新一起失败。
                if (!latest || !hasWxCredentials(latest)) return;
                try {
                    await withLock(accountId, async () => {
                        const refreshed = await wxLogin.refreshLoginBuffer({
                            openid: latest.wxid,
                            refreshtoken: latest.refreshtoken,
                            accesstoken: latest.accesstoken,
                        });
                        persistAccount(latest, {
                            loginBuffer: refreshed.loginBuffer,
                            refreshtoken: refreshed.refreshtoken,
                            accesstoken: refreshed.accesstoken,
                        });
                    });
                } catch (error: any) {
                    log('错误', `微信凭证保活失败: ${latest.name} - ${errorMessage(error)}`, {
                        accountId: String(accountId),
                        accountName: latest.name,
                    });
                }
            }, { preventOverlap: true });
        }

        if (!cfg.enabled) {
            log('系统', `自动刷新 Code 已关闭: ${account.name}`, { accountId: String(accountId), accountName: account.name });
            return;
        }

        scheduler.setIntervalTask(refreshTaskName(accountId), cfg.intervalMinutes * 60_000, () => refreshAccountCode(accountId, 'timer'), { preventOverlap: true });
        log('系统', `自动刷新 Code 已启用: ${account.name}，间隔 ${cfg.intervalMinutes} 分钟`, { accountId: String(accountId), accountName: account.name });
    }

    function rescheduleAll(): void {
        scheduler.clearAll();
        for (const account of listAccounts()) scheduleAccount(account.id);
    }

    /** 主动停止/删除账号时清掉待执行的自动重登，避免和用户操作打架 */
    function stopAccount(accountId: any): void {
        scheduler.clear(refreshTaskName(accountId));
        scheduler.clear(keepaliveTaskName(accountId));
        scheduler.clear(reloginTaskName(accountId));
    }

    function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`刷新 Code 超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
            promise.then(
                value => { clearTimeout(timer); resolve(value); },
                error => { clearTimeout(timer); reject(error); },
            );
        });
    }

    /**
     * 启动账号前的准备：先换新 Code（重启后免扫码）。失败不阻断启动，
     * 旧 Code 连不上时会走掉线自动重登。
     */
    async function prepareAccountForStart(account: any): Promise<any> {
        if (!account) return account;
        const latest = findAccount(account.id) || account;
        // 启动（含被踢下线后手动启动）即重新武装定时任务
        scheduleAccount(latest.id);
        if (!isEligible(latest)) return latest;
        try {
            const code = await withTimeout(withLock(latest.id, () => issueFarmCode(latest)), PREPARE_TIMEOUT_MS);
            if (typeof addOrUpdateAccount === 'function') addOrUpdateAccount({ id: latest.id, code });
            log('系统', `启动前已刷新登录 Code: ${latest.name}`, { accountId: String(latest.id), accountName: latest.name });
            resetRecovery(latest.id);
            return { ...latest, code };
        } catch (error: any) {
            addAccountLog('auto_code_refresh_failed', `启动前刷新 Code 失败: ${errorMessage(error)}`, latest.id, latest.name, { reason: 'startup' });
            log('错误', `启动前刷新 Code 失败: ${latest.name} - ${errorMessage(error)}`, { accountId: String(latest.id), accountName: latest.name });
            return latest;
        }
    }

    function getAccountStatus(accountId: any): any {
        const key = String(accountId || '');
        const account = findAccount(key);
        const state = recoveryState.get(key) || { attempts: 0, failures: 0, blockedUntil: 0, lastError: '', date: '' };
        return {
            eligible: isEligible(account),
            enabled: getConfig(key).enabled,
            intervalMinutes: getConfig(key).intervalMinutes,
            attempts: Number(state.attempts) || 0,
            failures: Number(state.failures) || 0,
            blocked: isBlocked(state),
            lastError: String(state.lastError || ''),
            hasRefreshTask: scheduler.has(refreshTaskName(key)),
            hasKeepaliveTask: scheduler.has(keepaliveTaskName(key)),
        };
    }

    return {
        prepareAccountForStart,
        refreshAccountCode,
        scheduleRelogin,
        scheduleAccount,
        rescheduleAll,
        stopAccount,
        getAccountStatus,
        resetRecovery,
    };
}

module.exports = { createAutoCodeRefreshService, isRecoveryReason };
