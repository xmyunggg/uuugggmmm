export {};

/**
 * 扫码登录成功后暂存微信长期凭证，等账号落库时按登录 code 认领。
 *
 * 时序：前端先调 `/api/wx-login/tasks/:id/code` 拿到小游戏登录 code，
 * 再用这个 code 调 `POST /api/accounts` 创建/重登账号；任务此时已销毁，
 * 所以凭证必须在这里按 code 留一份短时副本。
 */

export interface PendingLoginCredentials {
    openid: string;
    loginBuffer: string;
    accesstoken: string;
    refreshtoken: string;
    nickname: string;
    avatar: string;
    createdAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const pending = new Map<string, PendingLoginCredentials>();

function cleanupExpired(now: number): void {
    for (const [code, entry] of pending) {
        if (now - entry.createdAt > TTL_MS) pending.delete(code);
    }
}

function rememberLoginCredentials(code: unknown, credentials: Partial<PendingLoginCredentials> & { openid?: string }): boolean {
    const key = String(code || '').trim();
    if (!key || !credentials || !credentials.openid) return false;
    const now = Date.now();
    cleanupExpired(now);
    pending.set(key, {
        openid: String(credentials.openid || ''),
        loginBuffer: String(credentials.loginBuffer || ''),
        accesstoken: String(credentials.accesstoken || ''),
        refreshtoken: String(credentials.refreshtoken || ''),
        nickname: String(credentials.nickname || ''),
        avatar: String(credentials.avatar || ''),
        createdAt: now,
    });
    return true;
}

/** 取一次并删除（凭证只能被一个账号认领） */
function takeLoginCredentials(code: unknown): PendingLoginCredentials | null {
    const key = String(code || '').trim();
    if (!key) return null;
    cleanupExpired(Date.now());
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    return entry;
}

function peekLoginCredentials(code: unknown): PendingLoginCredentials | null {
    const key = String(code || '').trim();
    if (!key) return null;
    cleanupExpired(Date.now());
    return pending.get(key) || null;
}

function size(): number {
    cleanupExpired(Date.now());
    return pending.size;
}

module.exports = {
    rememberLoginCredentials,
    takeLoginCredentials,
    peekLoginCredentials,
    size,
    TTL_MS,
};
