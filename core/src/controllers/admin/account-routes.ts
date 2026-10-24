import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');

const {
    getAccId,
    getAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
    getAccountAccess,
    getClientIp,
} = require('./middleware');

const userStore = require('../../models/user-store');

function isAdminUser(user: any): boolean {
    return !!user && (user.role === 'admin' || user.role === 'super_admin');
}

/** 后台「系统 → 运行环境」全局默认属于管理员配置项；账号级运行环境由账号归属校验保护 */
function requireAdminUser(req: Request, res: Response): boolean {
    if (isAdminUser((req as any).currentUser)) return true;
    res.status(403).json({ ok: false, error: '需要管理员权限' });
    return false;
}

function mountAccountRoutes(app: Application, ctx: AdminContext): void {
    const access = getAccountAccess(ctx);

    // 非管理员：账号级接口做归属校验
    app.use('/api', (req: Request, res: Response, next: any) => {
        const currentUser = (req as any).currentUser;
        if (!currentUser || isAdminUser(currentUser)) return next();

        const rawHeader = String(req.headers['x-account-id'] || '').trim();
        const rawQuery = String((req.query && req.query.accountId) || '').trim();
        const rawBody = (req.body && typeof req.body === 'object')
            ? String(req.body.id || req.body.accountId || req.body.uin || '').trim()
            : '';
        const rawRef = rawHeader || rawQuery || rawBody;

        if (!rawRef || rawRef === 'all') return next();

        const resolved = resolveAccId(ctx, rawRef);
        const allowed = resolved
            ? access.canAccessAccount(req, resolved)
            : access.getAccountsForUser(currentUser.username).some((a: any) => String(a.uin) === rawRef || String(a.qq) === rawRef);
        if (!allowed) {
            return res.status(403).json({ ok: false, error: '无权访问该账号' });
        }
        return next();
    });

    // API: 账号管理
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const data = ctx.provider.getAccounts();
            const currentUser = (req as any).currentUser;
            if (currentUser && !isAdminUser(currentUser)) {
                const visible = access.getAccountsForUser(currentUser.username);
                return res.json({ ok: true, data: { ...data, accounts: visible } });
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = access.getAccountsForUser(isAdminUser((req as any).currentUser) ? null : (req as any).currentUser?.username);
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/accounts', (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            if (!requestedName) {
                return res.status(400).json({ ok: false, error: '账号备注不能为空' });
            }
            const visibleAccounts = getAccountList(ctx);
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(updateRef) } : body;

            const currentUser = (req as any).currentUser;
            if (currentUser && !isAdminUser(currentUser)) {
                if (isUpdate && !access.canAccessAccount(req, String(payload.id))) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号' });
                }
                if (!isUpdate) {
                    const accountCount = access.getAccountsForUser(currentUser.username).length;
                    const accountLimit = currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;
                    if (accountCount >= accountLimit) {
                        return res.status(403).json({ ok: false, error: `账号数量已达上限（${accountLimit}个），请购买额度卡密增加额度` });
                    }
                    payload.username = currentUser.username;
                }
            }

            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: any) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            const data = addOrUpdateAccount(payload);
            if (ctx.provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts.at(-1) || {}).id || '');
                const accountName = payload.name || '';
                ctx.provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isRemarkRelogin
                        ? `通过备注重新登录账号: ${accountName || accountId}`
                        : isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts.at(-1);
                if (newAcc) ctx.provider.startAccount(newAcc.id);
            } else if (isRemarkRelogin) {
                // Adding with an existing remark is a relogin operation, including for stopped accounts.
                ctx.provider.restartAccount(payload.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                ctx.provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * 换发微信登录 Code 的公共实现。手动刷新只要求账号是微信扫码账号且已存凭证，
     * 不受「自动刷新登录 Code」开关限制。
     * @param accounts 待刷新的可见账号；非微信账号计入 skipped
     */
    async function refreshWxAccounts(accounts: any[]) {
        const storedById = new Map<string, any>(
            (store.getAccounts().accounts || []).map((account: any) => [String(account.id), account]),
        );
        const results: any[] = [];
        let skipped = 0;

        for (const account of accounts) {
            const accountId = String(account.id || '');
            const name = String(account.name || account.nick || accountId);
            if (String(account.platform || '') !== 'wx') {
                skipped += 1;
                results.push({ accountId, name, ok: false, skipped: true, error: '不是微信账号' });
                continue;
            }
            const stored = storedById.get(accountId);
            const missingCredential = !String(stored?.wxid || '').trim() || !String(stored?.loginBuffer || '').trim();
            if (missingCredential) {
                skipped += 1;
                results.push({ accountId, name, ok: false, skipped: true, error: '缺少微信凭证（未扫码登录）' });
                continue;
            }
            try {
                const result = await ctx.provider.refreshAccountCode(accountId);
                const ok = !!(result && result.ok);
                results.push({ accountId, name, ok, skipped: false, error: ok ? '' : String(result?.error || '刷新失败') });
            } catch (error: any) {
                results.push({ accountId, name, ok: false, skipped: false, error: String(error?.message || error || '刷新失败') });
            }
        }

        const success = results.filter((item: any) => item.ok).length;
        const failed = results.filter((item: any) => !item.ok && !item.skipped).length;
        return {
            ok: failed === 0 && success > 0,
            error: failed > 0 ? `${failed} 个账号刷新失败` : undefined,
            data: { total: results.length, success, failed, skipped, results },
        };
    }

    // API: 批量立即刷新微信登录 Code（管理员=全部账号，普通用户=自己的账号）
    app.post('/api/accounts/refresh-wx-codes', async (req: Request, res: Response) => {
        try {
            const currentUser = (req as any).currentUser;
            if (!currentUser) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }
            if (!ctx.provider || typeof ctx.provider.refreshAccountCode !== 'function') {
                return res.status(500).json({ ok: false, error: '自动刷新服务不可用' });
            }

            const accessible = access.getAccountsForUser(isAdminUser(currentUser) ? null : currentUser.username);
            if (accessible.length === 0) {
                return res.json({
                    ok: false,
                    error: '没有可刷新的账号',
                    data: { total: 0, success: 0, failed: 0, skipped: 0, results: [] },
                });
            }

            res.json(await refreshWxAccounts(accessible));
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 立即刷新指定账号的微信登录 Code（账号卡片上的按钮）
    app.post('/api/accounts/:id/refresh-wx-code', async (req: Request, res: Response) => {
        try {
            const currentUser = (req as any).currentUser;
            if (!currentUser) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }
            if (!ctx.provider || typeof ctx.provider.refreshAccountCode !== 'function') {
                return res.status(500).json({ ok: false, error: '自动刷新服务不可用' });
            }

            const requested = String(req.params.id || '').trim();
            const accessible = access.getAccountsForUser(isAdminUser(currentUser) ? null : currentUser.username);
            const accountId = resolveAccId(ctx, requested) || requested;
            if (!accountId || !access.canAccessAccount(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问该账号' });
            }
            const target = accessible.find((account: any) => String(account.id) === String(accountId));
            if (!target) {
                return res.status(404).json({ ok: false, error: '账号不存在' });
            }

            res.json(await refreshWxAccounts([target]));
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/accounts/:id', (req: Request, res: Response) => {
        try {
            const resolvedId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');

            const before = ctx.provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            ctx.provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt(req.query.limit as string) || 100;
            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 日志
    app.get('/api/logs', (req: Request, res: Response) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(ctx, queryAccountIdRaw)) : getAccId(ctx, req);
        // 如果没有指定账号ID，获取所有账号的日志
        if (!id) {
            const accountIds = getAccountIds(ctx);
            const allLogs: any[] = [];
            const options = {
                limit: Number.parseInt(req.query.limit as string) || 100,
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
            };

            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 按时间排序并限制数量
            allLogs.sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: Number.parseInt(req.query.limit as string) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.clearLogs(id);

            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                const accountLogs = ctx.provider.getLogs(id, { limit: 100 });
                ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = ctx.provider.getLogs('', { limit: 100 });
                ctx.io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但 worker 尚未确认应用') : undefined,
                data: data || {},
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req: Request, res: Response) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /** 某个用户当前生效的下线提醒（用户级设置优先，其次后台全局默认） */
    function getEffectiveOfflineReminderForUser(username: string): any {
        if (username && typeof store.getUserOfflineReminderOverride === 'function') {
            const override = store.getUserOfflineReminderOverride(username);
            if (override) return override;
        }
        return store.getOfflineReminder ? store.getOfflineReminder() : {};
    }

    /** 校验钉钉 Webhook，非法时返回错误文案 */
    function validateOfflineReminderChannel(body: any): string {
        const channel = String(body?.channel || '').trim().toLowerCase();
        if (channel !== 'dingtalk') return '';
        try {
            const { buildDingTalkWebhook } = require('../../services/push');
            buildDingTalkWebhook(body.endpoint, body.token, body.secret);
            return '';
        } catch (error: any) {
            return error?.message || '钉钉 Webhook 地址格式无效';
        }
    }

    // API: 当前登录用户自己的下线提醒（用户级）
    app.get('/api/settings/offline-reminder', (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            const override = username && typeof store.getUserOfflineReminderOverride === 'function'
                ? store.getUserOfflineReminderOverride(username)
                : null;
            const globalDefault = store.getOfflineReminder ? store.getOfflineReminder() : {};
            res.json({
                ok: true,
                data: {
                    saved: override || globalDefault,
                    overridden: !!override,
                    scope: 'user',
                    username,
                    globalDefault,
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 保存当前登录用户自己的下线提醒（只影响其名下账号，不改后台全局默认）
    app.post('/api/settings/offline-reminder', async (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            if (!username) {
                return res.status(401).json({ ok: false, error: 'Unauthorized' });
            }
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const validationError = validateOfflineReminderChannel(body);
            if (validationError) {
                return res.status(400).json({ ok: false, error: validationError });
            }
            const data = store.setUserOfflineReminderOverride
                ? store.setUserOfflineReminderOverride(username, body)
                : {};
            res.json({ ok: true, data: { saved: data || {}, overridden: true, scope: 'user', username } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 清除当前登录用户的下线提醒设置，回退到后台全局默认
    app.post('/api/settings/offline-reminder/reset', (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            if (!username) {
                return res.status(401).json({ ok: false, error: 'Unauthorized' });
            }
            if (typeof store.clearUserOfflineReminderOverride === 'function') {
                store.clearUserOfflineReminderOverride(username);
            }
            const saved = getEffectiveOfflineReminderForUser(username);
            res.json({ ok: true, data: { saved, overridden: false, scope: 'user', username } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 后台「系统 → 下线提醒」的全局默认（仅管理员）
    app.get('/api/settings/offline-reminder/global', (req: Request, res: Response) => {
        try {
            if (!requireAdminUser(req, res)) return;
            res.json({
                ok: true,
                data: {
                    saved: store.getOfflineReminder ? store.getOfflineReminder() : {},
                    overridden: false,
                    scope: 'global',
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/offline-reminder/global', (req: Request, res: Response) => {
        try {
            if (!requireAdminUser(req, res)) return;
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const validationError = validateOfflineReminderChannel(body);
            if (validationError) {
                return res.status(400).json({ ok: false, error: validationError });
            }
            const saved = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: { saved: saved || {}, overridden: false, scope: 'global' } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/offline-reminder/global/reset', (req: Request, res: Response) => {
        try {
            if (!requireAdminUser(req, res)) return;
            const saved = store.resetOfflineReminder
                ? store.resetOfflineReminder()
                : store.setOfflineReminder({ channel: 'webhook', endpoint: '', token: '', secret: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 });
            res.json({ ok: true, data: { saved: saved || {}, overridden: false, scope: 'global' } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            const saved = getEffectiveOfflineReminderForUser(username);
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const secret = String(cfg.secret || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }
            if (channel === 'dingtalk' && !endpoint && !token) {
                return res.status(400).json({ ok: false, error: '钉钉渠道需要填写 Webhook 地址' });
            }
            if (channel === 'wxpusher' && token && !endpoint && !token.includes('#')) {
                return res.status(400).json({ ok: false, error: 'WxPusher 渠道需要填写接收者（UID_xxx 或 TopicID）' });
            }
            if (channel !== 'webhook' && channel !== 'dingtalk' && !token) {
                return res.status(400).json({ ok: false, error: channel === 'wxpusher' ? 'WxPusher 渠道需要填写应用 Token（AT_ 开头）' : '当前推送渠道需要填写 Token' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                secret,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }

            // 成功判定统一由 sendPushooMessage 的结果归一化负责，这里不再按文案兜底
            if (!ret.ok) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const goldenBugKeepCount = id && (typeof store.getGoldenBugKeepCount === 'function') ? store.getGoldenBugKeepCount(id) : 0;
            const goldenBugRoundLimit = id && (typeof store.getGoldenBugRoundLimit === 'function') ? store.getGoldenBugRoundLimit(id) : 24;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedMultiLandReservationEnabled = id && (typeof store.getBagSeedMultiLandReservationEnabled === 'function') ? store.getBagSeedMultiLandReservationEnabled(id) : false;
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            const autoCodeRefresh = typeof store.getAutoCodeRefreshConfig === 'function' ? store.getAutoCodeRefreshConfig(id) : { enabled: false, intervalMinutes: 60 };
            const ui = store.getUI();
            // 下线提醒按「账号归属用户的用户级设置 → 后台全局默认」取值
            const offlineReminder = typeof store.getOfflineReminderForAccount === 'function'
                ? store.getOfflineReminderForAccount(id)
                : (store.getOfflineReminder ? store.getOfflineReminder() : { channel: 'webhook', endpoint: '', token: '', secret: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 });
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, goldenBugKeepCount, goldenBugRoundLimit, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedMultiLandReservationEnabled, bagSeedLandTypes, bagSeedFallbackStrategy, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, autoCodeRefresh, ui, offlineReminder } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/device-presets', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 运行环境：用户级（每个登录用户一份，作用于其名下所有游戏账号）+ 后台全局默认
    function isTransportChanged(previous: any, next: any): boolean {
        if (!previous || !next) return false;
        return previous.serverUrl !== next.serverUrl
            || previous.clientVersion !== next.clientVersion
            || previous.platform !== next.platform
            || previous.os !== next.os;
    }

    function broadcastSystemConfigToAccount(accountId: string): void {
        if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
            ctx.provider.broadcastConfig(accountId);
        }
    }

    function restartRunningAccounts(accountIds: string[]): void {
        if (!ctx.provider || typeof ctx.provider.isAccountRunning !== 'function' || typeof ctx.provider.restartAccount !== 'function') {
            return;
        }
        for (const id of accountIds) {
            if (id && ctx.provider.isAccountRunning(id)) {
                ctx.provider.restartAccount(id);
            }
        }
    }

    function getCurrentUsername(req: Request): string {
        return String((req as any).currentUser?.username || '').trim();
    }

    function getAccountIdsForUser(username: string): string[] {
        if (!username) return [];
        return getAccountList(ctx)
            .filter((account: any) => String(account?.username || '').trim() === username)
            .map((account: any) => String(account.id || ''))
            .filter(Boolean);
    }

    /** 用后台全局默认的账号：无归属，或归属用户未单独设置运行环境 */
    function getAccountsUsingGlobalSystemConfig(): string[] {
        return getAccountList(ctx)
            .filter((account: any) => {
                if (!account?.id) return false;
                const owner = String(account.username || '').trim();
                if (!owner) return true;
                const override = typeof store.getUserSystemConfigOverride === 'function'
                    ? store.getUserSystemConfigOverride(owner)
                    : null;
                return !override;
            })
            .map((account: any) => String(account.id));
    }

    /** 某个用户当前生效的运行环境（用户级覆盖优先，其次后台全局默认） */
    function getEffectiveSystemConfigForUser(username: string): any {
        if (username && typeof store.getUserSystemConfigOverride === 'function') {
            const override = store.getUserSystemConfigOverride(username);
            if (override) return override;
        }
        return store.getSystemConfig() || getRuntimeConfig();
    }

    function broadcastUserSystemConfig(username: string): string[] {
        const ids = getAccountIdsForUser(username);
        for (const id of ids) broadcastSystemConfigToAccount(id);
        return ids;
    }

    function broadcastGlobalSystemConfig(): void {
        if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
            ctx.provider.broadcastConfig('');
        }
    }

    // API: 当前登录用户的运行环境（用户级）
    app.get('/api/settings/system-config', (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            const override = username && typeof store.getUserSystemConfigOverride === 'function'
                ? store.getUserSystemConfigOverride(username)
                : null;
            res.json({
                ok: true,
                data: {
                    saved: override || store.getSystemConfig(),
                    overridden: !!override,
                    scope: 'user',
                    username,
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                    loginSettings: store.getLoginSettings
                        ? store.getLoginSettings()
                        : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' },
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/login-config', (_req: Request, res: Response) => {
        try {
            const loginSettings = store.getLoginSettings
                ? store.getLoginSettings()
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/login-config', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const loginSettings = store.setLoginSettings
                ? store.setLoginSettings({
                    wechatQrLogin: body.wechatQrLogin,
                    qqQrLogin: body.qqQrLogin,
                    napCatEndpoint: body.napCatEndpoint,
                    napCatSignature: body.napCatSignature,
                })
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 保存当前登录用户自己的运行环境（只影响其名下账号，不改后台全局默认）
    app.post('/api/settings/system-config', (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            if (!username) {
                return res.status(401).json({ ok: false, error: 'Unauthorized' });
            }
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const previous = getEffectiveSystemConfigForUser(username);
            const saved = store.setUserSystemConfigOverride(username, body);
            const ids = broadcastUserSystemConfig(username);
            if (isTransportChanged(previous, saved)) {
                restartRunningAccounts(ids);
            }
            return res.json({
                ok: true,
                data: { saved, current: saved, overridden: true, scope: 'user', username },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 清除当前登录用户的运行环境设置，回退到后台全局默认
    app.post('/api/settings/system-config/reset', (req: Request, res: Response) => {
        try {
            const username = getCurrentUsername(req);
            if (!username) {
                return res.status(401).json({ ok: false, error: 'Unauthorized' });
            }
            const previous = getEffectiveSystemConfigForUser(username);
            const cleared = store.clearUserSystemConfigOverride(username);
            const saved = getEffectiveSystemConfigForUser(username);
            const ids = broadcastUserSystemConfig(username);
            if (cleared && isTransportChanged(previous, saved)) {
                restartRunningAccounts(ids);
            }
            return res.json({
                ok: true,
                data: { saved, current: saved, overridden: false, scope: 'user', username },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 后台「系统 → 运行环境」的全局默认（仅管理员）
    app.get('/api/settings/system-config/global', (req: Request, res: Response) => {
        try {
            if (!requireAdminUser(req, res)) return;
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    overridden: false,
                    scope: 'global',
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                    // 后台「系统」页同屏展示登录设置，沿用同一接口返回
                    loginSettings: store.getLoginSettings
                        ? store.getLoginSettings()
                        : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' },
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config/global', (req: Request, res: Response) => {
        try {
            if (!requireAdminUser(req, res)) return;
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const { serverUrl, clientVersion, platform, os, timeZone, deviceInfo } = body;
            const previous = getRuntimeConfig();
            const saved = store.setSystemConfig({ serverUrl, clientVersion, platform, os, timeZone, deviceInfo });
            updateRuntimeConfig(saved);
            broadcastGlobalSystemConfig();
            if (isTransportChanged(previous, saved)) {
                // 只重启仍沿用全局默认的账号；已单独设置运行环境的用户不受影响
                restartRunningAccounts(getAccountsUsingGlobalSystemConfig());
            }
            return res.json({
                ok: true,
                data: { saved, current: getRuntimeConfig(), overridden: false, scope: 'global' },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config/global/reset', (req: Request, res: Response) => {
        try {
            if (!requireAdminUser(req, res)) return;
            const previous = getRuntimeConfig();
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            broadcastGlobalSystemConfig();
            if (isTransportChanged(previous, saved)) {
                restartRunningAccounts(getAccountsUsingGlobalSystemConfig());
            }
            return res.json({
                ok: true,
                data: { saved, current: getRuntimeConfig(), overridden: false, scope: 'global' },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountAccountRoutes };
