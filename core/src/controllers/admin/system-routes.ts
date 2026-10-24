import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 公告、防倒卖声明与用户数统计。
 *
 * 公开（无需 token）：/api/user-count、/api/anti-resale-config、
 * /api/super-admin-announcement、/api/super-admin-announcement/verify
 * 登录用户：/api/announcement、/api/announcement/read、/api/support-config
 * 管理员：/api/admin/announcement、/api/admin/support-config
 * 超级管理员：/api/super-admin/anti-resale-config、/api/super-admin/check-account-limit
 */

function mountSystemRoutes(app: Application, ctx: AdminContext, helpers: any): void {
    const store = require('../../models/store');
    const userStore = require('../../models/user-store');
    const { createModuleLogger } = require('../../services/logger');
    const logger = createModuleLogger('admin');
    const {
        requireAdminToken,
        requireAdminRole,
        requireSuperAdminRole,
        requireDangerConfirmation,
    } = helpers;

    /** 当前处于已连接（运行中）状态的账号数 */
    function getRunningAccountCount(): number {
        try {
            const data = (typeof store.getAccounts === 'function') ? store.getAccounts() : { accounts: [] };
            const accounts = Array.isArray(data.accounts) ? data.accounts : [];
            if (!ctx.provider || typeof ctx.provider.getStatus !== 'function') return 0;
            let count = 0;
            for (const account of accounts) {
                const status = ctx.provider.getStatus(account.id);
                if (status && status.connected) count += 1;
            }
            return count;
        } catch (error: any) {
            logger.warn('统计运行中账号失败', { error: error.message });
            return 0;
        }
    }

    /** 账号数量上限检查：仅告警，不做破坏性动作 */
    function checkAccountLimit(mode: string): any {
        const config = store.getAntiResaleConfig();
        if (!config.accountLimitEnabled) {
            return { ok: true, enabled: false, triggered: false, mode, message: '账号数量限制功能未启用' };
        }
        const runningCount = getRunningAccountCount();
        const threshold = config.accountLimitThreshold || 25;
        const triggered = runningCount > threshold;
        return {
            ok: true,
            enabled: true,
            triggered,
            runningCount,
            threshold,
            mode,
            message: triggered
                ? `检测到运行账号数量(${runningCount})超过阈值(${threshold})`
                : `当前运行账号数量(${runningCount})未超过阈值(${threshold})`,
        };
    }

    // ==================== 公开接口 ====================

    app.get('/api/user-count', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, count: userStore.getUserCount() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/anti-resale-config', (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                config: store.getAntiResaleConfig(),
                userCount: userStore.getUserCount(),
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/super-admin-announcement', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: store.getSuperAdminAnnouncement() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/super-admin-announcement/verify', (req: Request, res: Response) => {
        try {
            const { password } = req.body || {};
            res.json({ ok: true, valid: store.verifySuperAdminAnnouncementPassword(password) });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // ==================== 登录用户接口 ====================

    app.get('/api/announcement', requireAdminToken, (req: any, res: Response) => {
        try {
            const announcement = { ...store.getAnnouncement() };
            announcement.shouldShow = store.shouldShowAnnouncement(req.currentUser?.username);
            res.json({ ok: true, data: announcement });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/announcement/read', requireAdminToken, (req: any, res: Response) => {
        try {
            if (req.currentUser?.username) store.markAnnouncementRead(req.currentUser.username);
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/support-config', requireAdminToken, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: store.getSupportConfig() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // ==================== 管理员接口 ====================

    app.post('/api/admin/announcement', requireAdminToken, requireAdminRole, (req: any, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_ANNOUNCEMENT')) return;
            const { content, showOnce } = req.body || {};
            const data = store.setAnnouncement(content, showOnce);
            logger.warn('更新系统公告', {
                admin: req.currentUser?.username || '',
                hasContent: !!String(content || '').trim(),
                showOnce: showOnce !== false,
                confirmation: 'UPDATE_ANNOUNCEMENT',
            });
            res.json({ ok: true, data });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/support-config', requireAdminToken, requireAdminRole, (req: any, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_SUPPORT_CONFIG')) return;
            const data = store.setSupportConfig(req.body);
            logger.warn('更新联系客服配置', {
                admin: req.currentUser?.username || '',
                enabled: data?.enabled === true,
                confirmation: 'UPDATE_SUPPORT_CONFIG',
            });
            res.json({ ok: true, data });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // ==================== 超级管理员接口 ====================

    app.post('/api/super-admin/announcement', requireAdminToken, requireSuperAdminRole, (req: any, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_SUPER_ADMIN_ANNOUNCEMENT')) return;
            const { content, password } = req.body || {};
            const data = store.setSuperAdminAnnouncement(content, password);
            logger.warn('更新超级管理员公告', {
                admin: req.currentUser?.username || '',
                hasContent: !!String(content || '').trim(),
                hasPassword: !!String(password || '').trim(),
                confirmation: 'UPDATE_SUPER_ADMIN_ANNOUNCEMENT',
            });
            res.json({ ok: true, data });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/super-admin/anti-resale-config', requireAdminToken, requireSuperAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, config: store.getAntiResaleConfig() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/super-admin/anti-resale-config', requireAdminToken, requireSuperAdminRole, (req: any, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_ANTI_RESALE_CONFIG')) return;
            const config = store.setAntiResaleConfig(req.body);
            logger.warn('更新防倒卖配置', {
                admin: req.currentUser?.username || '',
                accountLimitEnabled: config?.accountLimitEnabled === true,
                accountLimitThreshold: config?.accountLimitThreshold,
                confirmation: 'UPDATE_ANTI_RESALE_CONFIG',
            });
            res.json({ ok: true, config });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/super-admin/check-account-limit', requireAdminToken, requireSuperAdminRole, (req: any, res: Response) => {
        try {
            const result = checkAccountLimit('manual');
            logger.warn('手动检查账号数量上限', {
                admin: req.currentUser?.username || '',
                ok: result?.ok === true,
                triggered: result?.triggered === true,
                runningCount: result?.runningCount,
                threshold: result?.threshold,
            });
            if (!result.ok) return res.status(500).json(result);
            if (result.enabled && result.triggered) {
                result.message = `${result.message}，当前版本仅告警，不会自动处理账号`;
            }
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountSystemRoutes };
