import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Admin session management, role guards and danger confirmation helpers.
 * Sessions are held in-memory as token -> user descriptor.
 */

const crypto = require('node:crypto');
const { createModuleLogger } = require('../../services/logger');
const { getUserBlockReason, collectBlockedUsers, blockErrorMessage } = require('../../services/account-access');
const userStore = require('../../models/user-store');

const sessionLogger = createModuleLogger('admin');

interface SessionUser {
    username: string;
    role: 'user' | 'agent' | 'admin' | 'super_admin';
    card?: any;
    accountLimit?: number;
    mustChangePassword?: boolean;
    agent?: any;
}

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    currentUser?: SessionUser | null;
}

function generateAdminToken(): string {
    return crypto.randomBytes(24).toString('hex');
}

function toBooleanFlag(value: any): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}

const TRAILING_SLASH_RE = /\/+$/;

function createSessionManager(ctx: AdminContext) {
    function createAdminSession(user: SessionUser): string {
        const token = generateAdminToken();
        ctx.tokens.add(token);
        ctx.sessions.set(token, { ...user });
        return token;
    }

    function getSession(token: string): SessionUser | null {
        return token ? (ctx.sessions.get(token) || null) : null;
    }

    /**
     * 未改密前只放行必要的自助端点。即使绕过前端直接调接口，也会被这里挡住。
     */
    const PASSWORD_CHANGE_ALLOWED = new Set([
        'POST /api/user/change-password',
        'POST /api/logout',
        'GET /api/user/me',
        'GET /api/auth/validate',
        'GET /api/game-version',
    ]);

    /**
     * 会话在登录时快照 mustChangePassword，且改密会立即作废会话并要求重新登录，
     * 因此这里直接读会话即可，无需每个请求都回读用户文件。
     */
    function requirePasswordChanged(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
        // 只拦 API；静态资源与 SPA 页面必须放行，改密界面本身也要能加载。
        if (!String(req.path || '').startsWith('/api')) {
            next();
            return;
        }
        const token = String(req.headers['x-admin-token'] || '');
        const currentUser = token ? (ctx.sessions.get(token) || null) : null;
        if (!currentUser || currentUser.mustChangePassword !== true) {
            next();
            return;
        }
        const route = `${req.method} ${req.path}`.replace(TRAILING_SLASH_RE, '');
        if (PASSWORD_CHANGE_ALLOWED.has(route)) {
            next();
            return;
        }
        res.status(403).json({
            ok: false,
            error: '请先修改默认管理员密码',
            errorType: 'password_change_required',
        });
    }

    function invalidateAdminSession(token: string): void {
        ctx.tokens.delete(token);
        ctx.sessions.delete(token);
    }

    function disconnectAdminTokenSockets(token: string): void {
        if (!ctx.io) return;
        for (const socket of ctx.io.sockets.sockets.values()) {
            if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
        }
    }

    function invalidateAdminSessionAndDisconnect(token: string): void {
        invalidateAdminSession(token);
        disconnectAdminTokenSockets(token);
    }

    function invalidateAdminSessions(predicate: (session: SessionUser, token: string) => boolean): number {
        let count = 0;
        for (const [token, session] of ctx.sessions.entries()) {
            if (predicate(session, token)) {
                invalidateAdminSessionAndDisconnect(token);
                count += 1;
            }
        }
        return count;
    }

    function updateAdminSessions(predicate: (session: SessionUser, token: string) => boolean, updateSession: (session: SessionUser, token: string) => void): void {
        for (const [token, session] of ctx.sessions.entries()) {
            if (predicate(session, token)) {
                updateSession(session, token);
                ctx.sessions.set(token, session);
            }
        }
    }

    function getSessionRejection(currentUser: SessionUser | null): { reason: string; error: string } | null {
        const reason = getUserBlockReason(currentUser);
        return reason ? { reason, error: blockErrorMessage(reason) } : null;
    }

    function requireAdminToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
        const token = String(req.headers['x-admin-token'] || '');
        if (!token || !ctx.tokens.has(token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.currentUser = ctx.sessions.get(token) || null;
        const rejection = getSessionRejection(req.currentUser);
        if (rejection) {
            sessionLogger.warn('admin session rejected', { reason: rejection.reason, username: req.currentUser?.username });
            // 到期/封禁用户：除了踢掉会话，还要停掉他名下正在跑的账号，否则自动化会继续更新游戏数据。
            invalidateAdminSessionAndDisconnect(token);
            enforceBlockedUser(String(req.currentUser?.username || ''), rejection.reason);
            res.status(403).json({ ok: false, error: rejection.error });
            return;
        }
        next();
    }

    function cleanupInvalidAdminSessions(): void {
        const now = Date.now();
        const expired: Array<{ token: string; username: string; reason: string }> = [];
        for (const [token, session] of ctx.sessions.entries()) {
            if (session.role === 'admin' || session.role === 'super_admin') continue;
            if (session.card && session.card.enabled === false) {
                expired.push({ token, username: session.username, reason: 'banned' });
                continue;
            }
            if (session.card && session.card.expiresAt && session.card.expiresAt < now) {
                expired.push({ token, username: session.username, reason: 'expired' });
            }
        }
        const owners = new Map<string, string>();
        for (const { token, username, reason } of expired) {
            invalidateAdminSessionAndDisconnect(token);
            sessionLogger.info('admin session force logout', { reason, username });
            const owner = String(username || '').trim();
            if (owner) owners.set(owner, reason);
        }
        // 会话里的 card 是登录时的快照，这里按用户名再过一遍用户记录，顺带停掉名下账号
        for (const [owner, reason] of owners) enforceBlockedUser(owner, reason);
    }

    /** 停掉某个用户名下所有正在运行的账号（含自动换 Code，避免继续更新）。 */
    function stopAccountsForUser(username: string): number {
        const owner = String(username || '').trim();
        if (!owner || !ctx.provider || typeof ctx.provider.stopAccount !== 'function') return 0;
        let accounts: any[] = [];
        try {
            const data = typeof ctx.provider.getAccounts === 'function' ? ctx.provider.getAccounts() : null;
            accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        } catch (error: any) {
            sessionLogger.warn('list accounts for blocked user failed', { username: owner, error: error && error.message });
            return 0;
        }
        let stopped = 0;
        for (const account of accounts) {
            if (String((account && account.username) || '').trim() !== owner) continue;
            if (account && account.running !== true) continue;
            const accountId = String((account && account.id) || '').trim();
            if (!accountId) continue;
            try {
                ctx.provider.stopAccount(accountId);
                stopped += 1;
            } catch (error: any) {
                sessionLogger.warn('stop account for blocked user failed', { username: owner, accountId, error: error && error.message });
            }
        }
        return stopped;
    }

    /** 到期/封禁用户：踢掉全部会话、断开 Socket、停掉名下账号。 */
    function enforceBlockedUser(username: string, reason: string = ''): number {
        const owner = String(username || '').trim();
        if (!owner) return 0;
        const kicked = invalidateAdminSessions((session) => String(session.username || '').trim() === owner);
        const stopped = stopAccountsForUser(owner);
        if (kicked > 0 || stopped > 0) {
            sessionLogger.info('blocked user enforced', { username: owner, reason: String(reason || ''), kicked, stoppedAccounts: stopped });
        }
        return stopped;
    }

    /** 兜底扫描：所有到期/被封禁的非管理员用户都踢一遍并停账号。 */
    function enforceBlockedUsers(now: number = Date.now()): Array<{ username: string; reason: string }> {
        const users = typeof userStore.getAllUsers === 'function' ? userStore.getAllUsers() : [];
        const blocked = collectBlockedUsers(users, now);
        for (const item of blocked) enforceBlockedUser(item.username, item.reason);

        // 用户记录已被删除（例如手工改过 users.json）时，会话快照仍以为有效，这里按用户名兜底
        const known = new Set<string>(
            (Array.isArray(users) ? users : []).map((user: any) => String((user && user.username) || '').trim()).filter(Boolean),
        );
        for (const session of ctx.sessions.values()) {
            if (session.role === 'admin' || session.role === 'super_admin') continue;
            const owner = String(session.username || '').trim();
            if (owner && !known.has(owner)) enforceBlockedUser(owner, 'missing');
        }
        return blocked;
    }

    return {
        createAdminSession,
        getSession,
        invalidateAdminSession,
        invalidateAdminSessionAndDisconnect,
        invalidateAdminSessions,
        updateAdminSessions,
        requireAdminToken,
        requirePasswordChanged,
        cleanupInvalidAdminSessions,
        enforceBlockedUser,
        enforceBlockedUsers,
        stopAccountsForUser,
    };
}

function createRouteHelpers({ userStore }: { userStore: any }) {
    function requireAdminRole(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
        if (!req.currentUser || (req.currentUser.role !== 'admin' && req.currentUser.role !== 'super_admin')) {
            res.status(403).json({ ok: false, error: '需要管理员权限' });
            return;
        }
        next();
    }

    function requireSuperAdminRole(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
        if (!req.currentUser || req.currentUser.role !== 'super_admin') {
            res.status(403).json({ ok: false, error: '需要超级管理员权限' });
            return;
        }
        next();
    }

    function requireAgentRole(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
        if (!req.currentUser || req.currentUser.role !== 'agent') {
            res.status(403).json({ ok: false, error: '需要代理权限' });
            return;
        }
        next();
    }

    function requireDangerConfirmation(req: Request, res: Response, requiredConfirmation: string): boolean {
        const confirmed = req && req.body ? toBooleanFlag((req.body as any).confirmed) : false;
        if (!confirmed) {
            res.status(400).json({ ok: false, error: '危险操作未确认', requiredConfirmation });
            return false;
        }
        return true;
    }

    function getAdminUserMutationError(currentUser: SessionUser | null, targetUsername: string): string | null {
        const normalizedTarget = String(targetUsername || '').trim();
        if (!currentUser || !normalizedTarget) return null;
        if (currentUser.role === 'super_admin') return null;
        if (String(currentUser.username || '').trim() === normalizedTarget) return null;
        try {
            const users = userStore.getAllUsers();
            const targetUser = Array.isArray(users)
                ? users.find((user: any) => String(user.username || '').trim() === normalizedTarget)
                : null;
            if (targetUser && targetUser.role === 'admin') return '普通管理员不能修改或删除其他管理员账号';
        } catch {}
        return null;
    }

    return { requireAdminRole, requireSuperAdminRole, requireAgentRole, requireDangerConfirmation, getAdminUserMutationError };
}

module.exports = { createSessionManager, createRouteHelpers };
