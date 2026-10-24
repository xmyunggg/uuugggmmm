import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const userStore = require('../../models/user-store');

const {
    getClientIp,
    getAccId,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

const PUBLIC_API_PATHS = new Set([
    '/login',
    '/register',
    '/game-version',
    '/card-claim/status',
    '/card-claim/claim',
    '/public/renew',
    '/public/reset-password/verify',
    '/public/reset-password/confirm',
    '/user-count',
    '/anti-resale-config',
    '/super-admin-announcement',
    '/super-admin-announcement/verify',
]);

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const { requireAdminToken } = ctx.sessionManager;

    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        const ip = getClientIp(req);
        const userAgent = String(req.headers['user-agent'] || '');

        if (!username || !password) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        const validationResult = userStore.validateUser(String(username), String(password), ip);
        if (validationResult && validationResult.error) {
            const status = validationResult.error === 'rate_limit' ? 429
                : validationResult.error === 'locked' ? 423 : 401;
            adminLogger.warn('登录失败', { username, error: validationResult.error, ip });
            userStore.addLoginLog('login_failed', String(username), validationResult.error, ip, userAgent);
            return res.status(status).json({
                ok: false,
                error: validationResult.message,
                errorType: validationResult.error,
                remainingMs: validationResult.remainingMs,
            });
        }

        if (validationResult.role === 'agent') {
            if (!validationResult.agent || validationResult.agent.enabled === false) {
                userStore.addLoginLog('login_failed', String(username), 'banned', ip, userAgent);
                return res.status(403).json({ ok: false, error: '代理账号已被停用，请联系管理员' });
            }
        } else if (validationResult.role !== 'admin' && validationResult.role !== 'super_admin') {
            if (validationResult.card && validationResult.card.enabled === false) {
                userStore.addLoginLog('login_failed', String(username), 'banned', ip, userAgent);
                return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
            }
            if (validationResult.card && validationResult.card.expiresAt && validationResult.card.expiresAt < Date.now()) {
                userStore.addLoginLog('login_failed', String(username), 'expired', ip, userAgent);
                return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
            }
        }

        userStore.addLoginLog('login_success', String(username), null, ip, userAgent);
        const token = ctx.sessionManager.createAdminSession(validationResult);
        return res.json({
            ok: true,
            data: {
                token,
                role: validationResult.role,
                card: validationResult.card,
                accountLimit: validationResult.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
                user: { username: validationResult.username },
                mustChangePassword: validationResult.mustChangePassword === true,
                agent: validationResult.agent || null,
            },
        });
    });

    app.post('/api/register', (req: Request, res: Response) => {
        const { username, password, cardCode } = req.body || {};
        if (!username || !password || !cardCode) {
            return res.status(400).json({ ok: false, error: '请填写完整信息' });
        }
        const result = userStore.registerUser(String(username), String(password), String(cardCode));
        if (!result.ok) return res.status(400).json(result);
        res.json({ ok: true, data: result.user });
    });

    app.get('/api/card/info/:code', (req: Request, res: Response) => {
        try {
            const { code } = req.params;
            const card = userStore.getAllCards().find((item: any) => item.code === code);
            if (!card) return res.status(404).json({ ok: false, error: '卡密不存在' });
            if (!card.enabled) return res.status(400).json({ ok: false, error: '卡密已被禁用' });
            if (card.usedBy) return res.status(400).json({ ok: false, error: '卡密已被使用' });

            res.json({
                ok: true,
                data: {
                    type: card.type || 'time',
                    days: card.days,
                    value: card.value,
                    durationValue: card.durationValue,
                    durationUnit: card.durationUnit,
                    durationMs: card.durationMs,
                    isPermanent: card.isPermanent === true || card.days === -1,
                    accountLimit: card.accountLimit,
                    description: card.description,
                },
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/user/renew', requireAdminToken, (req: Request, res: Response) => {
        const { cardCode } = req.body || {};
        const username = (req as any).currentUser?.username;
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });

        const result = userStore.renewUser(username, String(cardCode));
        if (!result.ok) return res.status(400).json(result);

        ctx.sessionManager.updateAdminSessions(
            (session: any) => session.username === username,
            (session: any) => {
                session.card = result.card;
                session.accountLimit = result.accountLimit;
            },
        );
        res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
    });

    app.post('/api/public/renew', (req: Request, res: Response) => {
        try {
            const ip = getClientIp(req);
            const rateLimit = userStore.checkRateLimit(ip);
            if (!rateLimit.allowed) {
                return res.status(429).json({ ok: false, error: rateLimit.message, errorType: 'rate_limit', remainingMs: rateLimit.remainingMs });
            }
            const { username, cardCode } = req.body || {};
            if (!username) return res.status(400).json({ ok: false, error: '请提供用户名' });
            if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });

            const result = userStore.renewUser(String(username), String(cardCode));
            if (!result.ok) return res.status(400).json(result);

            adminLogger.info('公开续费成功', { username, cardType: result.cardType, ip });
            res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
        } catch (error: any) {
            adminLogger.error('公开续费失败', { error: error.message });
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/public/reset-password/verify', (req: Request, res: Response) => {
        try {
            const ip = getClientIp(req);
            const rateLimit = userStore.checkRateLimit(ip);
            if (!rateLimit.allowed) {
                return res.status(429).json({ ok: false, error: rateLimit.message, errorType: 'rate_limit', remainingMs: rateLimit.remainingMs });
            }
            const { username, cardCode } = req.body || {};
            if (!username || !cardCode) return res.status(400).json({ ok: false, error: '请提供用户名和卡密' });

            const result = userStore.verifyCardOwnership(String(username), String(cardCode));
            if (!result.ok) return res.status(400).json(result);
            res.json({ ok: true });
        } catch (error: any) {
            adminLogger.error('找回密码验证失败', { error: error.message });
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/public/reset-password/confirm', (req: Request, res: Response) => {
        try {
            const ip = getClientIp(req);
            const rateLimit = userStore.checkRateLimit(ip);
            if (!rateLimit.allowed) {
                return res.status(429).json({ ok: false, error: rateLimit.message, errorType: 'rate_limit', remainingMs: rateLimit.remainingMs });
            }
            const { username, cardCode, newPassword } = req.body || {};
            if (!username || !cardCode || !newPassword) {
                return res.status(400).json({ ok: false, error: '请提供用户名、卡密和新密码' });
            }
            const result = userStore.resetPasswordByCard(String(username), String(cardCode), String(newPassword));
            if (!result.ok) return res.status(400).json(result);

            adminLogger.info('找回密码重置成功', { username, ip });
            res.json({ ok: true, message: result.message });
        } catch (error: any) {
            adminLogger.error('找回密码重置失败', { error: error.message });
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/user/change-password', requireAdminToken, (req: Request, res: Response) => {
        const { oldPassword, newPassword } = req.body || {};
        const username = (req as any).currentUser?.username;
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }

        const result = userStore.changePassword(username, String(oldPassword), String(newPassword));
        if (result.ok) {
            const token = (req as any).adminToken;
            if (token) ctx.sessionManager.invalidateAdminSessionAndDisconnect(token);
        }
        return res.json(result);
    });

    app.use('/api', (req: Request, res: Response, next: any) => {
        // 根证书下载链接发给手机，仅靠不可猜测的 flowId+token 鉴权，不能再要求后台 Token
        if (PUBLIC_API_PATHS.has(req.path) || req.path.startsWith('/public/capture-certificate/')) return next();
        return requireAdminToken(req, res, next);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        res.json({ ok: true, clientVersion: getRuntimeConfig().clientVersion, botVersion: version });
    });

    app.get('/api/auth/validate', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { valid: true } });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken;
        if (token) ctx.sessionManager.invalidateAdminSessionAndDisconnect(token);
        res.json({ ok: true });
    });

    app.get('/api/user/me', (req: Request, res: Response) => {
        const current = (req as any).currentUser;
        if (!current) return res.status(401).json({ ok: false, error: '未登录' });
        res.json({
            ok: true,
            data: {
                username: current.username,
                role: current.role,
                card: current.card || null,
                accountLimit: current.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT,
                mustChangePassword: current.mustChangePassword === true,
                agent: current.agent || null,
            },
        });
    });
}

module.exports = { mountAuthRoutes };
