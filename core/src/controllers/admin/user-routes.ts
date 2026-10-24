import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * User administration, login logs and super-admin routes.
 */

function mountUserRoutes(
    app: Application,
    ctx: AdminContext,
    helpers: any,
): void {
    const userStore = require('../../models/user-store');
    const { getUserBlockReason } = require('../../services/account-access');
    const { requireAdminToken, requireAdminRole, requireDangerConfirmation, updateAdminSessions, getAdminUserMutationError } = helpers;

    // 到期/封禁/删除用户后立即生效：踢掉会话 + 断开 Socket + 停掉他名下正在跑的账号
    function enforceBlocked(username: string, reason: string): void {
        try {
            if (ctx.sessionManager && typeof ctx.sessionManager.enforceBlockedUser === 'function') {
                ctx.sessionManager.enforceBlockedUser(username, reason);
            }
        } catch (error: any) {
            console.warn('[admin] enforce blocked user failed', error && error.message);
        }
    }

    app.get('/api/admin/users', requireAdminToken, requireAdminRole, (_req: Request, res: Response) => {
        try {
            // 代理单独在「代理」页管理，普通用户列表不混入代理
            const data = userStore.getAllUsers().filter((user: any) => user.role !== 'agent');
            res.json({ ok: true, data });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/clear-expired', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'CLEAR_EXPIRED_USERS')) return;
            const result = userStore.clearExpiredUsers();
            if (result.ok && result.deletedCount > 0) {
                for (const username of result.deletedUsers) {
                    enforceBlocked(username, 'expired');
                }
            }
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/:username', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_USER_STATUS')) return;
            const { username } = req.params;
            const mutationError = getAdminUserMutationError((req as any).currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const user = userStore.updateUser(username, req.body || {});
            if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
            const blockReason = getUserBlockReason(user);
            if (blockReason) enforceBlocked(user.username, blockReason);
            res.json({ ok: true, data: user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/:username/edit', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'EDIT_USER')) return;
            const { username } = req.params;
            const mutationError = getAdminUserMutationError((req as any).currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const { newUsername, password, accountLimit, expiresAt, isPermanent } = req.body || {};
            const result = userStore.editUser(username, { newUsername, password, accountLimit, expiresAt, isPermanent });
            if (!result.ok) return res.status(400).json(result);

            updateAdminSessions(
                (session: any) => session.username === username || session.username === newUsername,
                (session: any) => {
                    session.username = result.user.username;
                    session.card = result.user.card;
                    session.accountLimit = result.user.accountLimit;
                },
            );
            const blockReason = getUserBlockReason(result.user);
            if (blockReason) enforceBlocked(result.user.username, blockReason);
            res.json({ ok: true, data: result.user });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/admin/users/:username', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'DELETE_USER')) return;
            const { username } = req.params;
            const currentUser = (req as any).currentUser;
            if (currentUser && currentUser.username === username) {
                return res.status(400).json({ ok: false, error: '不能删除自己的账号' });
            }
            const mutationError = getAdminUserMutationError(currentUser, username);
            if (mutationError) return res.status(403).json({ ok: false, error: mutationError });

            const result = userStore.deleteUser(username, true);
            if (!result.ok) return res.status(400).json(result);

            enforceBlocked(String(username || ''), 'deleted');
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/users/:username/renew', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'RENEW_USER')) return;
            const { username } = req.params;
            const { cardCode } = req.body || {};
            if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });

            const result = userStore.renewUser(username, String(cardCode));
            if (!result.ok) return res.status(400).json(result);

            updateAdminSessions(
                (session: any) => session.username === username,
                (session: any) => {
                    session.card = result.card;
                    session.accountLimit = result.accountLimit;
                },
            );
            res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // ---- 登录日志 ----
    app.get('/api/admin/login-logs', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            const { limit, offset } = req.query || {};
            res.json({ ok: true, data: userStore.getLoginLogs(limit, offset) });
        } catch (err: any) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    app.delete('/api/admin/login-logs', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'CLEAR_LOGIN_LOGS')) return;
            res.json(userStore.clearLoginLogs());
        } catch (err: any) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
}

module.exports = { mountUserRoutes };
