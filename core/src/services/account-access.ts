/**
 * 账号归属用户的可用性判定。
 *
 * 用户到期 / 被封禁 / 记录已被删除时，他名下的账号不能再跑自动化：进程重启时由
 * runtime-engine 过滤掉，运行期由后台兜底任务停掉。判定放在这里做成纯函数，便于单测，
 * 也避免 admin 层和 runtime 层各写一份口径。
 */

const ELEVATED_ROLES: string[] = ['admin', 'super_admin'];

type BlockReason = 'expired' | 'banned' | 'missing';

interface OwnerBlockState {
    blocked: boolean;
    reason: BlockReason | null;
}

function normalizeText(value: any): string {
    return String(value ?? '').trim();
}

/** 统一的对外文案，登录/鉴权/续费各处保持一致 */
export function blockErrorMessage(reason: string): string {
    return reason === 'banned' ? '账号已被封禁，请联系管理员' : '账号已过期，请续费后重新登录';
}

/**
 * 用户记录本身是否被拦。管理员/超管豁免（没有卡密概念，也不该被到期影响）。
 * 传 null 时返回 null，由调用方决定"查不到用户"怎么处理。
 */
export function getUserBlockReason(user: any, now: number = Date.now()): 'expired' | 'banned' | null {
    if (!user) return null;
    if (user.role && ELEVATED_ROLES.includes(String(user.role))) return null;
    // 代理没有农场卡密概念，只看代理档案是否被停用
    if (String(user.role || '') === 'agent') {
        return user.agent && user.agent.enabled === false ? 'banned' : null;
    }
    if (user.card && user.card.enabled === false) return 'banned';
    const expiresAt: number = Number(user.card && user.card.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < now) return 'expired';
    return null;
}

/**
 * 账号归属用户的封堵状态。
 * - 没有归属（管理员直接建的账号）→ 放行
 * - 归属用户名查不到（用户已删除）→ missing
 */
export function getOwnerBlockState(
    ownerUsername: any,
    findUser: (username: string) => any,
    now: number = Date.now(),
): OwnerBlockState {
    const username: string = normalizeText(ownerUsername);
    if (!username) return { blocked: false, reason: null };
    const user: any = typeof findUser === 'function' ? findUser(username) : null;
    if (!user) return { blocked: true, reason: 'missing' };
    const reason: 'expired' | 'banned' | null = getUserBlockReason(user, now);
    return reason ? { blocked: true, reason } : { blocked: false, reason: null };
}

/** 启动账号时过滤：归属用户被拦的账号一个都不拉起。 */
export function filterStartableAccounts(
    accounts: any[],
    findUser: (username: string) => any,
    now: number = Date.now(),
): { startable: any[]; skipped: Array<{ id: string; username: string; reason: string }> } {
    const startable: any[] = [];
    const skipped: Array<{ id: string; username: string; reason: string }> = [];
    for (const account of Array.isArray(accounts) ? accounts : []) {
        const state: OwnerBlockState = getOwnerBlockState(account && account.username, findUser, now);
        if (state.blocked) {
            skipped.push({
                id: normalizeText(account && account.id),
                username: normalizeText(account && account.username),
                reason: String(state.reason || ''),
            });
        } else {
            startable.push(account);
        }
    }
    return { startable, skipped };
}

/** 后台兜底扫描：列出所有需要踢下线并停账号的非管理员用户。 */
export function collectBlockedUsers(
    users: any[],
    now: number = Date.now(),
): Array<{ username: string; reason: 'expired' | 'banned' }> {
    const result: Array<{ username: string; reason: 'expired' | 'banned' }> = [];
    for (const user of Array.isArray(users) ? users : []) {
        const reason: 'expired' | 'banned' | null = getUserBlockReason(user, now);
        const username: string = normalizeText(user && user.username);
        if (reason && username) result.push({ username, reason });
    }
    return result;
}
