export {};
/**
 * 好友访问节流。
 *
 * 好友巡查是「一轮进一次每位好友的农场」，好友多的时候一轮就是几百次 Enter/Leave，
 * 网关会被打满；而且按「可偷数量 / 需要帮忙」排序之后，靠后的好友永远轮不到。
 * 所以每轮只挑一小批（默认 12 位）去访问：
 *
 * - 最近访问过的好友（默认 10 分钟内）先让给别人，一轮一轮往下轮转；
 * - 所有人都刚访问过时不再空转，按轮转顺序照常挑一批（好友少时行为和以前一样）；
 * - priorityGids 里的好友（例如刚算出来作物成熟的那几位）跳过冷却优先排在最前面，
 *   保证「到点唤醒」真的去访问那几位，而不是被节流挡掉。
 *
 * 状态按「账号 + 用途」分开存，账号切换或停掉巡查时用 resetFriendVisitPacing 清空。
 */
const DEFAULT_MAX_VISITS_PER_RUN: number = 12;
const MAX_VISITS_PER_RUN_LIMIT: number = 30;
const DEFAULT_COOLDOWN_MS: number = 10 * 60 * 1000;

interface VisitPacingOptions {
    accountId?: string;
    mode?: string;
    now?: number;
    maxVisits?: number;
    cooldownMs?: number;
    priorityGids?: Array<number | string> | Set<number>;
}

const recentVisits: Map<string, Map<number, number>> = new Map();
const cursors: Map<string, number> = new Map();

function toInt(value: any): number {
    const parsed: number = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function stateKey(accountId: any, mode: any): string {
    return `${String(accountId || 'default')}:${String(mode || 'friend')}`;
}

function pruneRecent(recent: Map<number, number>, now: number, cooldownMs: number): void {
    for (const [gid, visitedAt] of recent.entries()) {
        if (now - visitedAt >= cooldownMs) recent.delete(gid);
    }
}

function resolvePriorityGids(priorityGids: any): Set<number> {
    const set: Set<number> = new Set();
    const list: any[] = priorityGids instanceof Set ? [...priorityGids] : (Array.isArray(priorityGids) ? priorityGids : []);
    for (const gid of list) {
        const numeric: number = toInt(gid);
        if (numeric) set.add(numeric);
    }
    return set;
}

function selectFriendVisitBatch(candidates: any[], options: VisitPacingOptions = {}): any[] {
    const list: any[] = Array.isArray(candidates) ? candidates.filter((item: any) => toInt(item && item.gid) > 0) : [];
    if (list.length === 0) return [];

    const now: number = Number(options.now) || Date.now();
    const maxVisits: number = Math.max(1, Math.min(toInt(options.maxVisits) || DEFAULT_MAX_VISITS_PER_RUN, MAX_VISITS_PER_RUN_LIMIT));
    const cooldownMs: number = options.cooldownMs === undefined
        ? DEFAULT_COOLDOWN_MS
        : Math.max(0, toInt(options.cooldownMs));
    const key: string = stateKey(options.accountId, options.mode);
    const recent: Map<number, number> = recentVisits.get(key) || new Map();
    pruneRecent(recent, now, cooldownMs);

    const priority: Set<number> = resolvePriorityGids(options.priorityGids);
    // 到点好友排在最前面，并且不吃冷却；剩下的按轮转顺序补满这一批。
    const selected: any[] = [];
    if (priority.size > 0) {
        for (const item of list) {
            if (selected.length >= maxVisits) break;
            if (priority.has(toInt(item.gid))) selected.push(item);
        }
    }

    const cursor: number = Math.max(0, toInt(cursors.get(key))) % list.length;
    const rotated: any[] = [...list.slice(cursor), ...list.slice(0, cursor)];
    let eligible: any[] = rotated.filter((item: any) => !recent.has(toInt(item.gid)));
    if (eligible.length === 0) eligible = rotated;
    for (const item of eligible) {
        if (selected.length >= maxVisits) break;
        if (selected.includes(item)) continue;
        selected.push(item);
    }

    for (const item of selected) recent.set(toInt(item.gid), now);
    recentVisits.set(key, recent);
    cursors.set(key, (cursor + Math.max(1, selected.length)) % list.length);
    return selected;
}

function resetFriendVisitPacing(): void {
    recentVisits.clear();
    cursors.clear();
}

module.exports = {
    DEFAULT_MAX_VISITS_PER_RUN,
    DEFAULT_COOLDOWN_MS,
    selectFriendVisitBatch,
    resetFriendVisitPacing,
};
