import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    currentUser?: any;
}

let accountAccess: any = null;

function createAccountAccess({ ctx }: { ctx: AdminContext }) {
    function getAccountsForUser(username: string | null = null): any[] {
        try {
            if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
                const data = ctx.provider.getAccounts();
                if (Array.isArray(data?.accounts)) {
                    return username ? data.accounts.filter((a: any) => a.username === username) : data.accounts;
                }
            }
        } catch {
            // Fall back to persistent storage.
        }
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        const visible = username ? accounts.filter((a: any) => a.username === username) : accounts;
        return store.stripAccountSecrets ? visible.map((account: any) => store.stripAccountSecrets(account)) : visible;
    }

    function isElevated(user: any): boolean {
        return !!user && (user.role === 'admin' || user.role === 'super_admin');
    }

    function canAccessAccount(req: AuthenticatedRequest, accountId: string): boolean {
        const currentUser = req.currentUser;
        if (!currentUser) return false;
        if (isElevated(currentUser)) return true;
        const account = getAccountsForUser().find((item: any) => item.id === accountId);
        if (!account) return false;
        return account.username === currentUser.username;
    }

    function getAccessibleAccountIdsForUser(user: any): string[] {
        if (!user) return [];
        if (isElevated(user)) return getAccountsForUser().map((a: any) => a.id);
        return getAccountsForUser(user.username).map((a: any) => a.id);
    }

    function getAccessibleAccountIdsFromRequest(req: AuthenticatedRequest): string[] {
        return getAccessibleAccountIdsForUser(req.currentUser);
    }

    function couldAccessAccount(req: AuthenticatedRequest, accountRef: any): boolean {
        const currentUser = req.currentUser;
        if (!currentUser) return true;
        if (isElevated(currentUser)) return true;
        const resolved = resolveAccId(ctx, accountRef);
        if (!resolved) return false;
        return canAccessAccount(req, resolved);
    }

    return {
        getAccountsForUser,
        canAccessAccount,
        getAccessibleAccountIdsForUser,
        getAccessibleAccountIdsFromRequest,
        couldAccessAccount,
    };
}

function getAccountAccess(ctx: AdminContext): any {
    if (!accountAccess) accountAccess = createAccountAccess({ ctx });
    return accountAccess;
}

function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first) return first;
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        if (!token || !ctx.tokens.has(token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.currentUser = ctx.sessions.get(token) || null;
        next();
    };
}

function getAccountList(ctx: AdminContext): any[] {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) return data.accounts;
        }
    } catch {
        // Fall back to persistent storage.
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function getAccountIds(ctx: AdminContext): string[] {
    return getAccountList(ctx).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s+(?:\S.*?)??)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    return message.match(/\bcode=\d+\b\s*(.*)$/)?.[1]?.trim() || '';
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider) return resolvedByProvider;
    }
    return resolveAccountId(getAccountList(ctx), input) || input;
}

function getAccId(ctx: AdminContext, req: Request): string {
    return resolveAccId(ctx, req.headers['x-account-id']);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
    };
}

module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccountAccess,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
