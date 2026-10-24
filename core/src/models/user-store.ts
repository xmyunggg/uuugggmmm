export {};
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const security = require('./auth-security');

const USERS_FILE: string = getDataFile('users.json');
const CARDS_FILE: string = getDataFile('cards.json');
const LOGIN_ATTEMPTS_FILE: string = getDataFile('login-attempts-users.json');
const CARD_CLAIM_FILE: string = getDataFile('card-claim.json');
const LOGIN_LOGS_FILE: string = getDataFile('login-logs.json');
const AGENT_SPECS_FILE: string = getDataFile('agent-specs.json');
const AGENT_RECHARGE_FILE: string = getDataFile('agent-recharge-cards.json');
const LEGACY_ADMIN_FILE: string = getDataFile('admin.json');

const DEFAULT_ACCOUNT_LIMIT = 2;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 6;
const IP_LOCKOUT_DURATION = 10 * 60 * 1000;

const CLAIM_WINDOW_MS = 86400000;
const CLAIM_RECORD_TTL_MS = 2592000000;
const LOGIN_LOG_LIMIT = 5000;

type Role = 'user' | 'agent' | 'admin' | 'super_admin';

interface CardDurationFields {
    days: number;
    durationValue: number;
    durationUnit: 'hour' | 'day';
    durationMs: number | null;
    isPermanent: boolean;
}

interface CardRecord extends Partial<CardDurationFields> {
    code: string;
    description?: string;
    expiresAt: number | null;
    enabled: boolean;
}

/**
 * 代理发卡规格：管理员预置的固定卡密模板，代理只能按规格发卡。
 * type='time' 使用 durationValue/durationUnit/isPermanent/accountLimit；
 * type='quota' 使用 value（增加的账号额度数量）。
 * price 为生成 1 张卡扣除的代理余额，0 表示免费。
 */
interface AgentCardSpec {
    id: string;
    name: string;
    type: 'time' | 'quota';
    description?: string;
    enabled: boolean;
    createdAt: number;
    durationValue?: number;
    durationUnit?: 'hour' | 'day';
    isPermanent?: boolean;
    accountLimit?: number;
    value?: number;
    price: number;
}

/** 代理档案：挂在 role='agent' 的用户记录上。quotaTotal/quotaDaily 为 -1 表示不限量，balance 为余额。 */
interface AgentProfile {
    enabled: boolean;
    note?: string;
    quotaTotal: number;
    quotaDaily: number;
    usedTotal: number;
    usedDaily: number;
    dailyDate: string;
    specIds: string[] | null;
    balance: number;
    createdAt: number;
}

/** 代理充值卡：管理员生成、面额自定义，代理凭卡密充值余额。与用户注册卡密完全隔离。 */
interface AgentRechargeCard {
    code: string;
    amount: number;
    description?: string;
    enabled: boolean;
    usedBy: string | null;
    usedAt: number | null;
    createdAt: number;
    createdBy?: string | null;
}

interface UserRecord {
    username: string;
    password: string;
    role: Role;
    cardCode?: string | null;
    card?: CardRecord | null;
    accountLimit?: number;
    mustChangePassword?: boolean;
    createdAt: number;
    /** 代理档案（仅 role='agent'） */
    agent?: AgentProfile | null;
    /** 该用户由哪个代理发卡引入（客户归属） */
    agentUsername?: string | null;
}

interface UserCard {
    code: string;
    description?: string;
    expiresAt: number | null;
    enabled: boolean;
}

interface CardEntity extends Partial<CardDurationFields> {
    code: string;
    description?: string;
    type: 'time' | 'quota';
    enabled: boolean;
    usedBy: string | null;
    usedAt: number | null;
    createdAt: number;
    value?: number;
    accountLimit?: number;
    /** 发卡人用户名；管理员发的卡为空/未设置 */
    createdBy?: string | null;
    creatorRole?: 'agent' | 'admin' | null;
}

interface LoginAttempt {
    count: number;
    windowStart?: number;
    firstAttempt?: number;
    lastAttempt?: number;
    lockedUntil?: number;
    locked?: boolean;
}

interface CardClaimRecord {
    uaHash: string;
    claimTime: number;
    cardCode: string;
    username: string | null;
}

interface LoginLogEntry {
    id: string;
    timestamp: number;
    event: string;
    username: string;
    errorType: string | null;
    ip: string;
    userAgent: string;
}

function readJson(file: string): any {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(file: string, data: any): void {
    ensureDataDir();
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e: any) {
        console.error('写入数据文件失败:', file, e.message);
    }
}

// ==================== 登录尝试追踪 ====================

let loginAttempts: Record<string, LoginAttempt> = {};

function loadLoginAttempts(): void {
    const data = readJson(LOGIN_ATTEMPTS_FILE);
    loginAttempts = data && typeof data === 'object' ? data : {};
}

function saveLoginAttempts(): void {
    writeJson(LOGIN_ATTEMPTS_FILE, loginAttempts);
}

function cleanExpiredAttempts(): void {
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(loginAttempts)) {
        const entry = loginAttempts[key];
        if (!entry || typeof entry !== 'object') {
            delete loginAttempts[key];
            changed = true;
            continue;
        }
        if (entry.lockedUntil && entry.lockedUntil < now) {
            delete loginAttempts[key];
            changed = true;
        } else if (entry.windowStart && now - entry.windowStart > RATE_LIMIT_WINDOW && !entry.lockedUntil) {
            delete loginAttempts[key];
            changed = true;
        }
    }
    if (changed) saveLoginAttempts();
}

function checkRateLimit(ip: string): { allowed: boolean; remainingMs?: number; message?: string } {
    cleanExpiredAttempts();
    const key = `ip:${ip}`;
    const now = Date.now();
    const entry = loginAttempts[key];

    if (!entry) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }

    if (entry.lockedUntil) {
        if (entry.lockedUntil > now) {
            const remainingMs = entry.lockedUntil - now;
            return { allowed: false, remainingMs, message: `该 IP 登录失败过多，请 ${Math.ceil(remainingMs / 1000)} 秒后重试` };
        }
        delete loginAttempts[key];
        saveLoginAttempts();
        return { allowed: true };
    }

    if (now - (entry.windowStart || 0) > RATE_LIMIT_WINDOW) {
        loginAttempts[key] = { count: 1, windowStart: now };
        saveLoginAttempts();
        return { allowed: true };
    }

    if (entry.count >= MAX_ATTEMPTS_PER_IP) {
        entry.lockedUntil = now + IP_LOCKOUT_DURATION;
        saveLoginAttempts();
        const remainingMs = IP_LOCKOUT_DURATION;
        return { allowed: false, remainingMs, message: `该 IP 登录失败过多，请 ${Math.ceil(remainingMs / 1000)} 秒后重试` };
    }

    entry.count++;
    saveLoginAttempts();
    return { allowed: true };
}

function checkAccountLockout(username: string): { locked: boolean; remainingMs?: number; message?: string } {
    cleanExpiredAttempts();
    const key = `user:${username}`;
    const entry = loginAttempts[key];
    if (entry && entry.lockedUntil) {
        const now = Date.now();
        if (entry.lockedUntil > now) {
            const remainingMs = entry.lockedUntil - now;
            return { locked: true, remainingMs, message: `账户已被锁定，请 ${Math.ceil(remainingMs / 60000)} 分钟后重试` };
        }
        delete loginAttempts[key];
        saveLoginAttempts();
    }
    return { locked: false };
}

function recordFailedAttempt(username: string): { locked: boolean; message?: string; remainingAttempts?: number } {
    const key = `user:${username}`;
    const now = Date.now();
    if (!loginAttempts[key]) {
        loginAttempts[key] = { count: 1, firstAttempt: now };
    } else {
        loginAttempts[key].count++;
        loginAttempts[key].lastAttempt = now;
    }
    if (loginAttempts[key].count >= MAX_LOGIN_ATTEMPTS) {
        loginAttempts[key].lockedUntil = now + LOCKOUT_DURATION;
        saveLoginAttempts();
        return { locked: true, message: `登录失败次数过多，账户已被锁定 ${LOCKOUT_DURATION / 60000} 分钟` };
    }
    saveLoginAttempts();
    return { locked: false, remainingAttempts: MAX_LOGIN_ATTEMPTS - loginAttempts[key].count };
}

function clearFailedAttempts(username: string): void {
    const key = `user:${username}`;
    if (loginAttempts[key]) {
        delete loginAttempts[key];
        saveLoginAttempts();
    }
}

function clearIpAttempts(ip: string): void {
    const key = `ip:${ip}`;
    if (loginAttempts[key]) {
        delete loginAttempts[key];
        saveLoginAttempts();
    }
}

// ==================== 时间/额度工具 ====================

const generateCardCode = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 16; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
};

function normalizeDurationUnit(unit: any): 'hour' | 'day' {
    return unit === 'hour' ? 'hour' : 'day';
}

function toPositiveNumber(value: any, fallback = 1): number {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getQuotaValue(card: any): number {
    return Math.max(Number.parseInt(card?.value ?? card?.days, 10) || 1, 1);
}

function getTimeCardAccountLimitGrant(card: any): number {
    const limit = Number.parseInt(card?.accountLimit, 10);
    if (Number.isFinite(limit) && limit > 0) return limit;
    return 0;
}

function applyTimeCardAccountLimit(user: any, card: any, { isRegister = false }: { isRegister?: boolean } = {}): void {
    const grant = getTimeCardAccountLimitGrant(card);
    if (grant <= 0) {
        if (isRegister) user.accountLimit = DEFAULT_ACCOUNT_LIMIT;
        return;
    }
    user.accountLimit = grant;
}

function normalizeTimeDuration(input: any = {}): CardDurationFields {
    const isPermanent = input.isPermanent === true
        || Number(input.durationValue) === -1
        || Number(input.days) === -1;

    if (isPermanent) {
        return { days: -1, durationValue: -1, durationUnit: 'day', durationMs: null, isPermanent: true };
    }

    if (Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0) {
        const durationMs = Number(input.durationMs);
        const durationUnit = normalizeDurationUnit(input.durationUnit);
        const durationValue = Number.isFinite(Number(input.durationValue)) && Number(input.durationValue) > 0
            ? Number(input.durationValue)
            : durationMs / (durationUnit === 'hour' ? HOUR_MS : DAY_MS);
        return { days: durationMs / DAY_MS, durationValue, durationUnit, durationMs, isPermanent: false };
    }

    const durationUnit = input.durationUnit ? normalizeDurationUnit(input.durationUnit) : 'day';
    const rawValue = input.durationValue !== undefined ? input.durationValue : input.days;
    const rawNumber = Number(rawValue);
    const durationValue = input.allowZero === true && Number.isFinite(rawNumber) && rawNumber >= 0
        ? rawNumber
        : toPositiveNumber(rawValue, 1);
    const durationMs = durationUnit === 'hour' ? durationValue * HOUR_MS : durationValue * DAY_MS;
    return { days: durationMs / DAY_MS, durationValue, durationUnit, durationMs, isPermanent: false };
}

function assignDurationFields(target: any, duration: CardDurationFields): void {
    target.days = duration.days;
    target.durationValue = duration.durationValue;
    target.durationUnit = duration.durationUnit;
    target.durationMs = duration.durationMs;
    target.isPermanent = duration.isPermanent;
}

function normalizeCardForResponse(card: any): any {
    if (!card || card.type === 'quota') return card;
    const duration = normalizeTimeDuration(card);
    return { ...card, ...duration };
}

// ==================== 用户/卡密存储 ====================

let users: UserRecord[] = [];
let cards: CardEntity[] = [];

function loadUsers(): void {
    const data = readJson(USERS_FILE);
    if (data && Array.isArray(data.users)) {
        users = data.users;
    } else {
        users = [];
        if (!fs.existsSync(USERS_FILE)) saveUsers();
    }
}

function saveUsers(): void {
    writeJson(USERS_FILE, { users });
}

function loadCards(): void {
    const data = readJson(CARDS_FILE);
    if (data && Array.isArray(data.cards)) {
        cards = data.cards;
    } else {
        cards = [];
        if (!fs.existsSync(CARDS_FILE)) saveCards();
    }
}

function saveCards(): void {
    writeJson(CARDS_FILE, { cards });
}

// ==================== 代理发卡规格存储 ====================

let agentSpecs: AgentCardSpec[] = [];

const generateSpecId = (): string => `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normalizeAgentSpec(raw: any): AgentCardSpec {
    const source = raw && typeof raw === 'object' ? raw : {};
    const type: 'time' | 'quota' = source.type === 'quota' ? 'quota' : 'time';
    const spec: AgentCardSpec = {
        id: String(source.id || generateSpecId()),
        name: String(source.name || '未命名规格').trim() || '未命名规格',
        type,
        enabled: source.enabled !== false,
        createdAt: Number(source.createdAt) || Date.now(),
        price: normalizeAmount(source.price),
    };
    const description = String(source.description || '').trim();
    if (description) spec.description = description;
    if (type === 'quota') {
        spec.value = toPositiveNumber(source.value, 1);
    } else {
        const duration = normalizeTimeDuration(source);
        spec.durationValue = duration.durationValue;
        spec.durationUnit = duration.durationUnit;
        spec.isPermanent = duration.isPermanent;
        const limit = Number.parseInt(source.accountLimit, 10);
        if (Number.isFinite(limit) && limit > 0) spec.accountLimit = limit;
    }
    return spec;
}

function createDefaultAgentSpecs(): AgentCardSpec[] {
    const now = Date.now();
    const timeSpec = (id: string, name: string, durationValue: number, accountLimit?: number): AgentCardSpec => ({
        id,
        name,
        type: 'time',
        enabled: true,
        createdAt: now,
        durationValue,
        durationUnit: 'day',
        isPermanent: false,
        price: 0,
        ...(accountLimit ? { accountLimit } : {}),
    });
    return [
        timeSpec('sp_1d', '1天卡', 1),
        timeSpec('sp_7d', '7天卡', 7),
        timeSpec('sp_30d', '30天卡', 30),
        { id: 'sp_forever', name: '永久卡', type: 'time', enabled: true, createdAt: now, durationValue: -1, durationUnit: 'day', isPermanent: true, price: 0 },
        { id: 'sp_quota2', name: '额度卡 +2', type: 'quota', enabled: true, createdAt: now, value: 2, price: 0 },
    ];
}

function loadAgentSpecs(): void {
    const data = readJson(AGENT_SPECS_FILE);
    if (data && Array.isArray(data.specs)) {
        agentSpecs = data.specs.map(normalizeAgentSpec);
    } else {
        agentSpecs = [];
        if (!fs.existsSync(AGENT_SPECS_FILE)) {
            agentSpecs = createDefaultAgentSpecs();
            saveAgentSpecs();
        }
    }
}

function saveAgentSpecs(): void {
    writeJson(AGENT_SPECS_FILE, { specs: agentSpecs });
}

/** 仍在用默认口令的管理员一律标记为「必须先改密」，覆盖升级上来的老实例。 */
function flagDefaultAdminPassword(): void {
    const changed = users.some((user) => {
        if ((user.role !== 'admin' && user.role !== 'super_admin') || user.mustChangePassword === true) return false;
        if (!security.verifyPassword('admin', user.password)) return false;
        user.mustChangePassword = true;
        return true;
    });
    if (changed) {
        saveUsers();
        console.log('[用户系统] 检测到管理员仍在使用默认密码，已要求首次登录后立即修改');
    }
}

function initDefaultAdmin(): void {
    loadUsers();
    const adminExists = users.find(u => u.username === 'admin');
    const anyAdmin = users.some(u => u.role === 'admin' || u.role === 'super_admin');
    if (adminExists || anyAdmin) {
        flagDefaultAdminPassword();
        return;
    }

    const legacy = readJson(LEGACY_ADMIN_FILE);
    const legacyAdmin = legacy && (legacy.admin || legacy);
    if (legacyAdmin && String(legacyAdmin.password || '').trim()) {
        users.push({
            username: String(legacyAdmin.username || 'admin').trim() || 'admin',
            password: String(legacyAdmin.password),
            role: 'admin',
            mustChangePassword: legacyAdmin.mustChangePassword === true || undefined,
            createdAt: Number(legacyAdmin.createdAt) || Date.now(),
        });
        saveUsers();
        console.log('[用户系统] 已从 admin.json 迁移管理员账号');
        flagDefaultAdminPassword();
        return;
    }

    users.push({
        username: 'admin',
        password: security.hashPassword('admin'),
        role: 'admin',
        mustChangePassword: true,
        createdAt: Date.now(),
    });
    saveUsers();
    console.log('[用户系统] 已创建默认管理员账号，默认密码: admin（首次登录后必须修改）');
}

// ==================== 用户验证 ====================

function validateUser(username: string, password: string, ip = 'unknown'): any {
    loadUsers();
    loadLoginAttempts();

    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
        return { error: 'rate_limit', message: rateLimit.message, remainingMs: rateLimit.remainingMs };
    }

    const lockout = checkAccountLockout(username);
    if (lockout.locked) {
        return { error: 'locked', message: lockout.message, remainingMs: lockout.remainingMs };
    }

    const user = users.find(u => u.username === username);
    if (!user) {
        recordFailedAttempt(username);
        return { error: 'invalid_credentials', message: '用户名或密码错误' };
    }

    if (!security.verifyPassword(password, user.password)) {
        const result = recordFailedAttempt(username);
        if (result.locked) return { error: 'locked', message: result.message };
        return { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${result.remainingAttempts}` };
    }

    clearFailedAttempts(username);
    clearIpAttempts(ip);

    if (security.needsRehash(user.password)) {
        user.password = security.hashPassword(password);
        saveUsers();
        console.log(`[安全] 用户 ${username} 密码已升级为新哈希算法`);
    }

    return {
        username: user.username,
        role: user.role,
        cardCode: user.cardCode || null,
        card: user.card || null,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT,
        mustChangePassword: user.mustChangePassword === true,
        agent: user.role === 'agent' ? publicAgent(user) : null,
    };
}

// ==================== 用户注册 ====================

function registerUser(username: string, password: string, cardCode: string): any {
    loadUsers();
    loadCards();

    if (!username || username.length < 3 || username.length > 32) {
        return { ok: false, error: '用户名长度需在3-32位之间' };
    }
    if (!/^\w+$/.test(username)) {
        return { ok: false, error: '用户名只能包含字母、数字和下划线' };
    }
    if (users.some(u => u.username === username)) {
        return { ok: false, error: '用户名已存在' };
    }

    const pwdResult = security.validatePasswordStrength(password);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    const card = cards.find(c => c.code === cardCode);
    if (!card) return { ok: false, error: '卡密不存在' };
    if (!card.enabled) return { ok: false, error: '卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };

    const cardType = card.type || 'time';
    if (cardType === 'quota') {
        return { ok: false, error: '注册只能使用时间卡密，额度卡密请登录后在续费中使用' };
    }

    const now = Date.now();
    const duration = normalizeTimeDuration(card);
    const cardRecord: CardRecord = {
        code: card.code,
        description: card.description,
        expiresAt: duration.isPermanent ? null : now + (duration.durationMs || 0),
        enabled: true,
    };
    assignDurationFields(cardRecord, duration);

    const newUser: UserRecord = {
        username,
        password: security.hashPassword(password),
        role: 'user',
        cardCode,
        card: cardRecord,
        accountLimit: DEFAULT_ACCOUNT_LIMIT,
        createdAt: now,
    };
    if (card.creatorRole === 'agent' && card.createdBy) newUser.agentUsername = String(card.createdBy);
    applyTimeCardAccountLimit(newUser, card, { isRegister: true });

    users.push(newUser);
    card.usedBy = username;
    card.usedAt = now;
    saveUsers();
    saveCards();
    clearFailedAttempts(username);

    return {
        ok: true,
        user: { username: newUser.username, role: newUser.role, card: newUser.card, accountLimit: newUser.accountLimit },
    };
}

// ==================== 用户续费 ====================

function renewUser(username: string, cardCode: string): any {
    loadUsers();
    loadCards();

    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户不存在' };

    const card = cards.find(c => c.code === cardCode);
    if (!card) return { ok: false, error: '卡密不存在' };
    if (!card.enabled) return { ok: false, error: '卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: '卡密已被使用' };

    const now = Date.now();
    const cardType = card.type || 'time';

    if (cardType === 'quota') {
        const current = user.accountLimit || DEFAULT_ACCOUNT_LIMIT;
        user.accountLimit = current + getQuotaValue(card);
    } else {
        const duration = normalizeTimeDuration(card);
        if (!user.card) {
            user.card = { code: card.code, description: card.description, days: 0, expiresAt: null, enabled: true };
        }
        const prevExpiresAt = user.card.expiresAt || 0;
        const prevDuration = normalizeTimeDuration({ ...user.card, allowZero: true });

        if (duration.isPermanent) {
            user.card.expiresAt = null;
            assignDurationFields(user.card, duration);
        } else if (prevDuration.isPermanent) {
            user.card.expiresAt = null;
        } else {
            const totalMs = (prevDuration.durationMs || 0) + (duration.durationMs || 0);
            const totalDuration = normalizeTimeDuration({
                durationMs: totalMs,
                durationUnit: totalMs % DAY_MS === 0 ? 'day' : 'hour',
            });
            assignDurationFields(user.card, totalDuration);
            if (prevExpiresAt && prevExpiresAt > now) {
                user.card.expiresAt = prevExpiresAt + (duration.durationMs || 0);
            } else {
                user.card.expiresAt = now + (duration.durationMs || 0);
            }
        }
        applyTimeCardAccountLimit(user, card);
    }

    if (card.creatorRole === 'agent' && card.createdBy) user.agentUsername = String(card.createdBy);

    card.usedBy = username;
    card.usedAt = now;
    saveUsers();
    saveCards();

    return {
        ok: true,
        card: user.card,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT,
        cardType,
    };
}

// ==================== 用户管理 ====================

function getAllUsers(): any[] {
    loadUsers();
    return users
        .filter(u => u.role !== 'super_admin')
        .map(u => ({
            username: u.username,
            role: u.role,
            card: u.card,
            accountLimit: u.accountLimit || DEFAULT_ACCOUNT_LIMIT,
            // 代理档案供会话兜底清理判断是否被停用；普通用户不下发
            agent: u.role === 'agent' ? normalizeAgentProfile(u.agent) : undefined,
        }));
}

function getUser(username: string): UserRecord | null {
    loadUsers();
    return users.find(u => u.username === username) || null;
}

function updateUser(username: string, updates: any): any {
    loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return null;

    if (updates.expiresAt !== undefined) {
        if (!user.card) user.card = { code: '', enabled: true, expiresAt: null };
        user.card.expiresAt = updates.expiresAt;
    }
    if (updates.enabled !== undefined) {
        if (!user.card) user.card = { code: '', enabled: true, expiresAt: null };
        user.card.enabled = updates.enabled;
    }

    saveUsers();
    return { username: user.username, role: user.role, card: user.card, accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT };
}

function editUser(username: string, updates: any): any {
    loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户不存在' };

    if (updates.newUsername && updates.newUsername !== username) {
        if (!/^\w{3,32}$/.test(updates.newUsername)) {
            return { ok: false, error: '用户名只能包含字母、数字和下划线，长度3-32位' };
        }
        if (users.some(u => u.username === updates.newUsername)) {
            return { ok: false, error: '用户名已存在' };
        }
        user.username = updates.newUsername;
    }

    if (updates.password) {
        const pwdResult = security.validatePasswordStrength(updates.password);
        if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };
        user.password = security.hashPassword(updates.password);
        delete user.mustChangePassword;
    }

    if (updates.accountLimit !== undefined) {
        user.accountLimit = Number.parseInt(updates.accountLimit, 10) || DEFAULT_ACCOUNT_LIMIT;
    }

    if (updates.isPermanent) {
        if (!user.card) user.card = { code: '', enabled: true, expiresAt: null };
        assignDurationFields(user.card, normalizeTimeDuration({ isPermanent: true }));
        user.card.expiresAt = null;
    } else if (updates.expiresAt !== undefined) {
        if (!user.card) user.card = { code: '', enabled: true, expiresAt: null };
        if (updates.expiresAt === null) {
            assignDurationFields(user.card, { days: 0, durationValue: 0, durationUnit: 'day', durationMs: 0, isPermanent: false });
            user.card.expiresAt = null;
        } else {
            const expiresAt = Number.parseInt(updates.expiresAt, 10);
            user.card.expiresAt = Number.isFinite(expiresAt) ? expiresAt : null;
            const remaining = (Number.isFinite(expiresAt) ? expiresAt : 0) - Date.now();
            const durationMs = remaining > 0 ? remaining : 0;
            const duration = durationMs > 0
                ? normalizeTimeDuration({ durationMs, durationUnit: durationMs % DAY_MS === 0 ? 'day' : 'hour' })
                : { days: 0, durationValue: 0, durationUnit: 'day' as const, durationMs: 0, isPermanent: false };
            assignDurationFields(user.card, duration);
        }
    }

    saveUsers();
    return { ok: true, user: { username: user.username, role: user.role, card: user.card, accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT } };
}

function deleteUser(username: string, force = false): any {
    loadUsers();
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return { ok: false, error: '用户不存在' };
    if (!force && users[idx].role === 'admin') {
        return { ok: false, error: '不能删除管理员账号' };
    }

    users.splice(idx, 1);
    saveUsers();
    return { ok: true };
}

function changePassword(username: string, currentPassword: string, newPassword: string): any {
    loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户不存在' };

    if (!security.verifyPassword(currentPassword, user.password)) {
        return { ok: false, error: '当前密码错误' };
    }

    const pwdResult = security.validatePasswordStrength(newPassword);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    user.password = security.hashPassword(newPassword);
    delete user.mustChangePassword;
    saveUsers();
    return { ok: true, message: '密码修改成功' };
}

// ==================== 卡密管理 ====================

function getAllCards(): any[] {
    loadCards();
    return cards.map(normalizeCardForResponse);
}

/** 记录卡密的发卡人：代理发的卡带 createdBy/creatorRole='agent'，管理员发卡不带。 */
function applyCardCreator(card: CardEntity, options: any = {}): void {
    const creator = String(options.createdBy || '').trim();
    if (!creator) return;
    card.createdBy = creator;
    card.creatorRole = options.creatorRole === 'agent' ? 'agent' : 'admin';
}

function createCard(description: string, days: any, type = 'time', options: any = {}): any {
    loadCards();
    const cardType = type === 'quota' ? 'quota' : 'time';
    const card: CardEntity = {
        code: generateCardCode(),
        description,
        type: cardType,
        enabled: true,
        usedBy: null,
        usedAt: null,
        createdAt: Date.now(),
    };
    applyCardCreator(card, options);
    if (cardType === 'quota') {
        const value = getQuotaValue({ value: options.value, days });
        card.days = value;
        card.value = value;
    } else {
        assignDurationFields(card, normalizeTimeDuration({ ...options, days }));
        const accountLimit = Number.parseInt(options.accountLimit, 10);
        if (Number.isFinite(accountLimit) && accountLimit > 0) card.accountLimit = accountLimit;
    }
    cards.push(card);
    saveCards();
    return card;
}

function createCardsBatch(description: string, days: any, count: any, type = 'time', options: any = {}): any[] {
    loadCards();
    const created: CardEntity[] = [];
    const countNum = Math.min(Math.max(Number.parseInt(count, 10) || 1, 1), 100);
    const cardType = type === 'quota' ? 'quota' : 'time';
    const quotaValue = getQuotaValue({ value: options.value, days });
    const duration = normalizeTimeDuration({ ...options, days });

    for (let i = 0; i < countNum; i++) {
        const card: CardEntity = {
            code: generateCardCode(),
            description,
            type: cardType,
            enabled: true,
            usedBy: null,
            usedAt: null,
            createdAt: Date.now(),
        };
        applyCardCreator(card, options);
        if (cardType === 'quota') {
            card.days = quotaValue;
            card.value = quotaValue;
        } else {
            assignDurationFields(card, duration);
            if (Number.isFinite(Number(options.accountLimit)) && Number(options.accountLimit) > 0) {
                card.accountLimit = Number.parseInt(options.accountLimit, 10);
            }
        }
        cards.push(card);
        created.push(card);
    }

    saveCards();
    return created;
}

function updateCard(code: string, updates: any): any {
    loadCards();
    const card = cards.find(c => c.code === code);
    if (!card) return null;
    if (updates.description !== undefined) card.description = updates.description;
    if (updates.enabled !== undefined) card.enabled = updates.enabled;
    saveCards();
    return card;
}

function deleteCard(code: string): boolean {
    loadCards();
    const idx = cards.findIndex(c => c.code === code);
    if (idx === -1) return false;
    cards.splice(idx, 1);
    saveCards();
    return true;
}

function deleteCardsBatch(codes: any): any {
    loadCards();
    if (!Array.isArray(codes) || codes.length === 0) {
        return { ok: false, error: '请提供要删除的卡密列表' };
    }
    let deletedCount = 0;
    const notFound: string[] = [];
    for (const code of codes) {
        const idx = cards.findIndex(c => c.code === code);
        if (idx !== -1) {
            cards.splice(idx, 1);
            deletedCount++;
        } else {
            notFound.push(code);
        }
    }
    saveCards();
    return {
        ok: true,
        deletedCount,
        notFoundCount: notFound.length,
        notFoundCodes: notFound.length > 0 ? notFound : undefined,
    };
}

/**
 * 批量清空卡密。
 * - scope='used'：只清掉已被使用过的卡密（usedBy 有值），未使用的库存保留；
 * - scope='all' ：清空全部卡密。
 * 续费结果记在用户记录里（expiresAt / 额度），删卡密不会影响已续费的账号。
 */
function clearCards(scope: string): any {
    loadCards();
    if (scope !== 'used' && scope !== 'all') {
        return { ok: false, error: '清空范围不正确' };
    }
    const target = (card: CardEntity): boolean => scope === 'all' || !!card.usedBy;
    const kept = cards.filter(card => !target(card));
    const deletedCount = cards.length - kept.length;
    if (deletedCount > 0) {
        cards = kept;
        saveCards();
    }
    return { ok: true, scope, deletedCount, remainingCount: cards.length };
}

// ==================== 代理系统 ====================

/** 本地日期键（YYYY-MM-DD），用于代理每日发卡额度重置。 */
function todayKey(now: number = Date.now()): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 发卡额度：-1 或非数字表示不限量，其余取非负整数。 */
function normalizeQuotaValue(value: any): number {
    if (value === '' || value === null || value === undefined) return -1;
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) return -1;
    return num < 0 ? -1 : num;
}

/** 金额（余额/单价）：非负数字，保留两位小数，非法值按 0 处理。 */
function normalizeAmount(value: any): number {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    return Math.round(num * 100) / 100;
}

function normalizeAgentProfile(raw: any): AgentProfile {
    const source = raw && typeof raw === 'object' ? raw : {};
    const today = todayKey();
    const dailyDate = String(source.dailyDate || '') || today;
    const sameDay = dailyDate === today;
    return {
        enabled: source.enabled !== false,
        note: String(source.note || ''),
        quotaTotal: normalizeQuotaValue(source.quotaTotal),
        quotaDaily: normalizeQuotaValue(source.quotaDaily),
        usedTotal: Math.max(Number.parseInt(source.usedTotal, 10) || 0, 0),
        usedDaily: sameDay ? Math.max(Number.parseInt(source.usedDaily, 10) || 0, 0) : 0,
        dailyDate: today,
        specIds: Array.isArray(source.specIds) ? source.specIds.map((item: any) => String(item)) : null,
        balance: normalizeAmount(source.balance),
        createdAt: Number(source.createdAt) || Date.now(),
    };
}

/** 计算代理剩余额度：-1 表示不限量。 */
function computeAgentRemaining(agent: AgentProfile): { remainingTotal: number; remainingDaily: number; usedDailyToday: number } {
    const usedDailyToday = agent.dailyDate === todayKey() ? agent.usedDaily : 0;
    return {
        remainingTotal: agent.quotaTotal < 0 ? -1 : Math.max(agent.quotaTotal - agent.usedTotal, 0),
        remainingDaily: agent.quotaDaily < 0 ? -1 : Math.max(agent.quotaDaily - usedDailyToday, 0),
        usedDailyToday,
    };
}

function publicAgent(user: UserRecord): any {
    const agent = normalizeAgentProfile(user.agent);
    const remaining = computeAgentRemaining(agent);
    return {
        username: user.username,
        role: 'agent',
        enabled: agent.enabled,
        note: agent.note || '',
        quotaTotal: agent.quotaTotal,
        quotaDaily: agent.quotaDaily,
        usedTotal: agent.usedTotal,
        usedDaily: remaining.usedDailyToday,
        remainingTotal: remaining.remainingTotal,
        remainingDaily: remaining.remainingDaily,
        specIds: agent.specIds,
        balance: agent.balance,
        createdAt: agent.createdAt || user.createdAt,
    };
}

function findAgentRecord(username: string): UserRecord | null {
    loadUsers();
    return users.find(u => u.username === username && u.role === 'agent') || null;
}

function getAllAgents(): any[] {
    loadUsers();
    return users.filter(u => u.role === 'agent').map(publicAgent);
}

function getAgent(username: string): any {
    const user = findAgentRecord(username);
    return user ? publicAgent(user) : null;
}

function isAgent(username: string): boolean {
    return !!findAgentRecord(username);
}

function createAgent(input: any = {}): any {
    loadUsers();
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!/^\w{3,32}$/.test(username)) return { ok: false, error: '用户名只能包含字母、数字和下划线，长度3-32位' };
    if (users.some(u => u.username === username)) return { ok: false, error: '用户名已存在' };
    const pwdResult = security.validatePasswordStrength(password);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    const user: UserRecord = {
        username,
        password: security.hashPassword(password),
        role: 'agent',
        agent: normalizeAgentProfile({
            enabled: input.enabled !== false,
            note: input.note,
            quotaTotal: input.quotaTotal,
            quotaDaily: input.quotaDaily,
            specIds: Array.isArray(input.specIds) ? input.specIds : null,
            balance: input.balance,
        }),
        createdAt: Date.now(),
    };
    users.push(user);
    saveUsers();
    return { ok: true, agent: publicAgent(user) };
}

function editAgent(username: string, updates: any = {}): any {
    loadUsers();
    const user = users.find(u => u.username === username && u.role === 'agent');
    if (!user) return { ok: false, error: '代理不存在' };
    if (!user.agent) user.agent = normalizeAgentProfile({});

    if (updates.newUsername && updates.newUsername !== username) {
        const newUsername = String(updates.newUsername).trim();
        if (!/^\w{3,32}$/.test(newUsername)) return { ok: false, error: '用户名只能包含字母、数字和下划线，长度3-32位' };
        if (users.some(u => u.username === newUsername)) return { ok: false, error: '用户名已存在' };
        user.username = newUsername;
    }
    if (updates.password) {
        const pwdResult = security.validatePasswordStrength(updates.password);
        if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };
        user.password = security.hashPassword(updates.password);
    }
    if (updates.enabled !== undefined) user.agent.enabled = !!updates.enabled;
    if (updates.note !== undefined) user.agent.note = String(updates.note || '');
    if (updates.quotaTotal !== undefined) user.agent.quotaTotal = normalizeQuotaValue(updates.quotaTotal);
    if (updates.quotaDaily !== undefined) user.agent.quotaDaily = normalizeQuotaValue(updates.quotaDaily);
    if (updates.balance !== undefined) user.agent.balance = normalizeAmount(updates.balance);
    if (updates.specIds !== undefined) {
        user.agent.specIds = Array.isArray(updates.specIds) && updates.specIds.length > 0
            ? updates.specIds.map((item: any) => String(item))
            : null;
    }
    saveUsers();
    return { ok: true, agent: publicAgent(user) };
}

function deleteAgent(username: string): any {
    loadUsers();
    const idx = users.findIndex(u => u.username === username && u.role === 'agent');
    if (idx === -1) return { ok: false, error: '代理不存在' };
    users.splice(idx, 1);
    saveUsers();
    return { ok: true };
}

// ---------- 规格管理 ----------

function getAllAgentSpecs(): AgentCardSpec[] {
    loadAgentSpecs();
    return agentSpecs.map(spec => ({ ...spec }));
}

function createAgentSpec(input: any = {}): any {
    loadAgentSpecs();
    const name = String(input.name || '').trim();
    if (!name) return { ok: false, error: '请提供规格名称' };
    const type: 'time' | 'quota' = input.type === 'quota' ? 'quota' : 'time';
    if (type === 'quota') {
        const value = Number.parseInt(input.value, 10);
        if (!Number.isFinite(value) || value <= 0) return { ok: false, error: '额度卡数量必须大于 0' };
    } else {
        const permanent = input.isPermanent === true || Number(input.durationValue) === -1 || Number(input.days) === -1;
        if (!permanent) {
            const value = Number(input.durationValue !== undefined ? input.durationValue : input.days);
            if (!Number.isFinite(value) || value <= 0) return { ok: false, error: '时间卡时长必须大于 0，永久卡请使用 -1' };
        }
    }
    const spec = normalizeAgentSpec({ ...input, name, type, id: generateSpecId(), createdAt: Date.now() });
    agentSpecs.push(spec);
    saveAgentSpecs();
    return { ok: true, spec };
}

function updateAgentSpec(id: string, updates: any = {}): any {
    loadAgentSpecs();
    const idx = agentSpecs.findIndex(spec => spec.id === id);
    if (idx === -1) return { ok: false, error: '规格不存在' };
    const current = agentSpecs[idx];
    if (updates.enabled !== undefined) current.enabled = !!updates.enabled;
    if (updates.name !== undefined) {
        const name = String(updates.name || '').trim();
        if (!name) return { ok: false, error: '规格名称不能为空' };
        current.name = name;
    }
    if (updates.description !== undefined) {
        const description = String(updates.description || '').trim();
        if (description) current.description = description;
        else delete current.description;
    }
    const structural = updates.type !== undefined || updates.value !== undefined || updates.durationValue !== undefined
        || updates.durationUnit !== undefined || updates.isPermanent !== undefined || updates.accountLimit !== undefined || updates.days !== undefined
        || updates.price !== undefined;
    if (structural) {
        const merged = normalizeAgentSpec({ ...current, ...updates, id: current.id, createdAt: current.createdAt });
        merged.enabled = current.enabled;
        agentSpecs[idx] = merged;
    }
    saveAgentSpecs();
    return { ok: true, spec: agentSpecs[idx] };
}

function deleteAgentSpec(id: string): any {
    loadAgentSpecs();
    const before = agentSpecs.length;
    agentSpecs = agentSpecs.filter(spec => spec.id !== id);
    if (agentSpecs.length === before) return { ok: false, error: '规格不存在' };
    saveAgentSpecs();
    return { ok: true };
}

// ---------- 代理发卡 ----------

function generateAgentCards(username: string, input: any = {}): any {
    loadUsers();
    loadAgentSpecs();
    const user = users.find(u => u.username === username && u.role === 'agent');
    if (!user) return { ok: false, error: '代理不存在' };
    if (!user.agent) user.agent = normalizeAgentProfile({});
    if (!user.agent.enabled) return { ok: false, error: '代理已被停用' };

    const spec = agentSpecs.find(item => item.id === String(input.specId || ''));
    if (!spec) return { ok: false, error: '卡密规格不存在' };
    if (!spec.enabled) return { ok: false, error: '该卡密规格已停用' };
    if (Array.isArray(user.agent.specIds) && user.agent.specIds.length > 0 && !user.agent.specIds.includes(spec.id)) {
        return { ok: false, error: '该代理无权发放此规格' };
    }

    const count = Math.min(Math.max(Number.parseInt(input.count, 10) || 1, 1), 100);
    const today = todayKey();
    if (user.agent.dailyDate !== today) {
        user.agent.dailyDate = today;
        user.agent.usedDaily = 0;
    }
    const remaining = computeAgentRemaining(user.agent);
    if (remaining.remainingTotal >= 0 && count > remaining.remainingTotal) {
        return { ok: false, error: `发卡额度不足，剩余 ${remaining.remainingTotal} 张` };
    }
    if (remaining.remainingDaily >= 0 && count > remaining.remainingDaily) {
        return { ok: false, error: `今日发卡额度不足，剩余 ${remaining.remainingDaily} 张` };
    }

    // 余额校验：整单失败，不做部分发放
    const unitPrice = normalizeAmount(spec.price);
    const cost = normalizeAmount(unitPrice * count);
    if (cost > 0 && user.agent.balance < cost) {
        const shortfall = normalizeAmount(cost - user.agent.balance);
        return { ok: false, error: `余额不足，本单需 ${cost}，当前余额 ${user.agent.balance}，还差 ${shortfall}` };
    }

    const description = String(input.description || '').trim() || spec.name;
    const days = spec.type === 'quota' ? spec.value : spec.durationValue;
    const options = {
        createdBy: user.username,
        creatorRole: 'agent',
        value: spec.value,
        accountLimit: spec.accountLimit,
        durationValue: spec.durationValue,
        durationUnit: spec.durationUnit,
        isPermanent: spec.isPermanent,
    };
    const created = createCardsBatch(description, days, count, spec.type, options);
    user.agent.usedTotal += created.length;
    user.agent.usedDaily += created.length;
    user.agent.balance = normalizeAmount(user.agent.balance - cost);
    saveUsers();
    return { ok: true, cards: created, count: created.length, cost, unitPrice, agent: publicAgent(user) };
}

function getAgentSelf(username: string): any {
    const user = findAgentRecord(username);
    if (!user) return null;
    return { ...publicAgent(user), specs: getAllAgentSpecs().filter(spec => !Array.isArray(user.agent?.specIds) || user.agent!.specIds!.length === 0 || user.agent!.specIds!.includes(spec.id)) };
}

function getCardsByCreator(username: string): any[] {
    loadCards();
    return cards
        .filter(card => card.creatorRole === 'agent' && card.createdBy === username)
        .map(normalizeCardForResponse);
}

function getAgentCustomers(username: string): any[] {
    loadUsers();
    return users
        .filter(u => u.role === 'user' && String(u.agentUsername || '') === username)
        .map(u => ({
            username: u.username,
            role: u.role,
            card: u.card || null,
            accountLimit: u.accountLimit || DEFAULT_ACCOUNT_LIMIT,
            createdAt: u.createdAt,
        }));
}

function getAgentStats(username: string): any {
    loadUsers();
    const user = findAgentRecord(username);
    if (!user) return null;
    const issued = getCardsByCreator(username);
    const customers = getAgentCustomers(username);
    const now = Date.now();
    const activeCustomers = customers.filter((u: any) => u.card && u.card.enabled !== false && (!u.card.expiresAt || u.card.expiresAt > now)).length;
    return {
        agent: publicAgent(user),
        cardsIssued: issued.length,
        cardsUsed: issued.filter((card: any) => !!card.usedBy).length,
        customers: customers.length,
        activeCustomers,
    };
}

// ---------- 代理充值卡（管理员发卡，代理凭卡密充值余额） ----------

let agentRechargeCards: AgentRechargeCard[] = [];

function normalizeAgentRechargeCard(raw: any): AgentRechargeCard {
    const source = raw && typeof raw === 'object' ? raw : {};
    const card: AgentRechargeCard = {
        code: String(source.code || generateCardCode()),
        amount: normalizeAmount(source.amount),
        enabled: source.enabled !== false,
        usedBy: source.usedBy ? String(source.usedBy) : null,
        usedAt: Number(source.usedAt) || null,
        createdAt: Number(source.createdAt) || Date.now(),
    };
    const description = String(source.description || '').trim();
    if (description) card.description = description;
    const createdBy = String(source.createdBy || '').trim();
    if (createdBy) card.createdBy = createdBy;
    return card;
}

function loadAgentRechargeCards(): void {
    const data = readJson(AGENT_RECHARGE_FILE);
    if (data && Array.isArray(data.cards)) {
        agentRechargeCards = data.cards.map(normalizeAgentRechargeCard);
    } else {
        agentRechargeCards = [];
        if (!fs.existsSync(AGENT_RECHARGE_FILE)) saveAgentRechargeCards();
    }
}

function saveAgentRechargeCards(): void {
    writeJson(AGENT_RECHARGE_FILE, { cards: agentRechargeCards });
}

function getAllAgentRechargeCards(): any[] {
    loadAgentRechargeCards();
    return agentRechargeCards.map(card => ({ ...card }));
}

function createAgentRechargeCards(input: any = {}): any {
    loadAgentRechargeCards();
    const amount = normalizeAmount(input.amount);
    if (amount <= 0) return { ok: false, error: '充值面额必须大于 0' };
    const count = Math.min(Math.max(Number.parseInt(input.count, 10) || 1, 1), 200);
    const description = String(input.description || '').trim();
    const createdBy = String(input.createdBy || '').trim();
    const created: AgentRechargeCard[] = [];
    for (let i = 0; i < count; i++) {
        const card: AgentRechargeCard = {
            code: generateCardCode(),
            amount,
            enabled: true,
            usedBy: null,
            usedAt: null,
            createdAt: Date.now(),
        };
        if (description) card.description = description;
        if (createdBy) card.createdBy = createdBy;
        agentRechargeCards.push(card);
        created.push(card);
    }
    saveAgentRechargeCards();
    return { ok: true, cards: created, count: created.length, amount };
}

function deleteAgentRechargeCard(code: string): any {
    loadAgentRechargeCards();
    const idx = agentRechargeCards.findIndex(card => card.code === String(code || '').trim().toUpperCase());
    if (idx === -1) return { ok: false, error: '充值卡不存在' };
    agentRechargeCards.splice(idx, 1);
    saveAgentRechargeCards();
    return { ok: true };
}

function redeemAgentRechargeCard(username: string, code: string): any {
    loadUsers();
    loadAgentRechargeCards();
    const user = users.find(u => u.username === username && u.role === 'agent');
    if (!user) return { ok: false, error: '代理不存在' };
    if (!user.agent) user.agent = normalizeAgentProfile({});
    if (!user.agent.enabled) return { ok: false, error: '代理已被停用' };
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode) return { ok: false, error: '请输入充值卡密' };
    const card = agentRechargeCards.find(item => item.code === normalizedCode);
    if (!card) return { ok: false, error: '充值卡密不存在' };
    if (!card.enabled) return { ok: false, error: '充值卡密已被禁用' };
    if (card.usedBy) return { ok: false, error: `充值卡密已被使用（${card.usedBy}）` };

    card.usedBy = user.username;
    card.usedAt = Date.now();
    user.agent.balance = normalizeAmount(user.agent.balance + card.amount);
    saveUsers();
    saveAgentRechargeCards();
    return { ok: true, amount: card.amount, balance: user.agent.balance, agent: publicAgent(user) };
}

function getAgentRechargeRecords(username: string): any[] {
    loadAgentRechargeCards();
    return agentRechargeCards
        .filter(card => String(card.usedBy || '') === username)
        .map(card => ({ ...card }));
}

// ==================== 卡密领取系统 ====================
let cardClaimEnabled = true;
let cardClaimRecords: CardClaimRecord[] = [];

function loadCardClaimRecords(): void {
    const data = readJson(CARD_CLAIM_FILE);
    if (data && typeof data === 'object') {
        cardClaimEnabled = data.enabled === true;
        cardClaimRecords = Array.isArray(data.records) ? data.records : [];
    } else {
        cardClaimEnabled = true;
        cardClaimRecords = [];
        saveCardClaimRecords();
    }
}

function saveCardClaimRecords(): void {
    writeJson(CARD_CLAIM_FILE, { enabled: cardClaimEnabled, records: cardClaimRecords });
}

function getCardClaimStatus(): { enabled: boolean } {
    loadCardClaimRecords();
    return { enabled: cardClaimEnabled };
}

function getAvailableTimeCardCount(): number {
    loadCards();
    return cards.filter(card => card.type === 'time' && !card.usedBy && card.enabled).length;
}

function setCardClaimStatus(enabled: any): { enabled: boolean } {
    loadCardClaimRecords();
    cardClaimEnabled = !!enabled;
    saveCardClaimRecords();
    return { enabled: cardClaimEnabled };
}

function checkUAClaimLimit(ua: string): { allowed: boolean; remainingMs?: number; message?: string } {
    loadCardClaimRecords();
    const now = Date.now();
    const uaHash = crypto.createHash('sha256').update(ua).digest('hex');
    const record = cardClaimRecords.find(r => r.uaHash === uaHash);
    if (record) {
        const elapsed = now - record.claimTime;
        if (elapsed < CLAIM_WINDOW_MS) {
            const remainingMs = CLAIM_WINDOW_MS - elapsed;
            return { allowed: false, remainingMs, message: '您已经在24小时内领取过一次卡密了！' };
        }
    }
    return { allowed: true };
}

function claimCardByUA(ua: string, username: string | null = null): any {
    loadCards();
    loadCardClaimRecords();

    if (!cardClaimEnabled) return { ok: false, error: '卡密领取功能未开启' };

    const limit = checkUAClaimLimit(ua);
    if (!limit.allowed) return { ok: false, error: limit.message, remainingMs: limit.remainingMs };

    const availableCards = cards.filter(c => c.type === 'time' && !c.usedBy && c.enabled);
    if (availableCards.length === 0) return { ok: false, error: '卡密库存不足，请联系管理员！' };

    const randomIdx = Math.floor(Math.random() * availableCards.length);
    const selectedCard = normalizeCardForResponse(availableCards[randomIdx]);

    const uaHash = crypto.createHash('sha256').update(ua).digest('hex');
    cardClaimRecords.push({ uaHash, claimTime: Date.now(), cardCode: selectedCard.code, username: username || null });
    saveCardClaimRecords();

    return {
        ok: true,
        cardCode: selectedCard.code,
        days: selectedCard.days,
        durationValue: selectedCard.durationValue,
        durationUnit: selectedCard.durationUnit,
        durationMs: selectedCard.durationMs,
        isPermanent: selectedCard.isPermanent === true,
        description: selectedCard.description,
    };
}

function getCardClaimRecords(): CardClaimRecord[] {
    loadCardClaimRecords();
    return cardClaimRecords;
}

function clearExpiredClaimRecords(): { cleared: number } {
    loadCardClaimRecords();
    const now = Date.now();
    const before = cardClaimRecords.length;
    cardClaimRecords = cardClaimRecords.filter(r => now - r.claimTime < CLAIM_RECORD_TTL_MS);
    if (cardClaimRecords.length !== before) saveCardClaimRecords();
    return { cleared: before - cardClaimRecords.length };
}

// ==================== 超级管理员/清理 ====================

function isSuperAdmin(username: string): boolean {
    loadUsers();
    const user = users.find(u => u.username === username);
    return user?.role === 'super_admin';
}

function clearExpiredUsers(): any {
    loadUsers();
    const now = Date.now();
    const toDelete: string[] = [];
    const keep: UserRecord[] = [];

    for (const user of users) {
        if (user.role === 'admin' || user.role === 'super_admin') {
            keep.push(user);
            continue;
        }
        if (user.card && user.card.expiresAt && user.card.expiresAt < now) {
            toDelete.push(user.username);
        } else {
            keep.push(user);
        }
    }

    if (toDelete.length > 0) {
        users = keep;
        saveUsers();
    }
    return { ok: true, deletedCount: toDelete.length, deletedUsers: toDelete };
}

function clearAllData(): any {
    console.log('[破解防御] 成功拦截了一次终极删库核弹（连密码带粗口的那种）！');
    return { ok: true, clearedFiles: [] };
}

function getUserCount(): number {
    loadUsers();
    return users.filter(u => u.role !== 'super_admin' && u.role !== 'agent').length;
}

// ==================== 密码重置（通过卡密） ====================

function verifyCardOwnership(username: string, cardCode: string): any {
    loadUsers();
    loadCards();
    if (!username || !cardCode) return { ok: false, error: '请提供用户名和卡密' };

    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户名或卡密错误' };

    const card = cards.find(c => c.code === cardCode);
    if (!card) return { ok: false, error: '用户名或卡密错误' };
    if (card.usedBy !== username) return { ok: false, error: '卡密不属于该用户' };

    return { ok: true };
}

function resetPasswordByCard(username: string, cardCode: string, newPassword: string): any {
    loadUsers();
    const ownership = verifyCardOwnership(username, cardCode);
    if (!ownership.ok) return ownership;

    const pwdResult = security.validatePasswordStrength(newPassword);
    if (!pwdResult.valid) return { ok: false, error: pwdResult.errors.join('；') };

    const user = users.find(u => u.username === username);
    if (!user) return { ok: false, error: '用户不存在' };
    user.password = security.hashPassword(newPassword);
    delete user.mustChangePassword;
    clearFailedAttempts(username);
    saveUsers();
    return { ok: true, message: '密码重置成功' };
}

// ==================== 登录日志系统 ====================

let loginLogs: LoginLogEntry[] = [];
let logIdCounter = 0;

function loadLoginLogs(): void {
    const data = readJson(LOGIN_LOGS_FILE);
    if (data && typeof data === 'object') {
        loginLogs = Array.isArray(data.logs) ? data.logs : [];
        logIdCounter = Number(data.counter) || 0;
    } else {
        loginLogs = [];
        logIdCounter = 0;
    }
}

function saveLoginLogs(): void {
    writeJson(LOGIN_LOGS_FILE, { logs: loginLogs, counter: logIdCounter });
}

function addLoginLog(event: string, username: string, errorType: string | null, ip: string, userAgent: string): void {
    loadLoginLogs();
    logIdCounter++;
    loginLogs.push({
        id: String(logIdCounter),
        timestamp: Date.now(),
        event,
        username,
        errorType: errorType || null,
        ip,
        userAgent: userAgent || 'unknown',
    });
    if (loginLogs.length > LOGIN_LOG_LIMIT) loginLogs = loginLogs.slice(-LOGIN_LOG_LIMIT);
    saveLoginLogs();
}

function getLoginLogs(limit: any = 100, offset: any = 0): { logs: LoginLogEntry[]; total: number } {
    loadLoginLogs();
    const numLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const numOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const reversed = loginLogs.slice().reverse();
    return { logs: reversed.slice(numOffset, numOffset + numLimit), total: reversed.length };
}

function clearLoginLogs(): any {
    loginLogs = [];
    logIdCounter = 0;
    saveLoginLogs();
    return { ok: true };
}

// ==================== 初始化 ====================

loadLoginAttempts();
loadLoginLogs();
loadAgentSpecs();
loadAgentRechargeCards();
initDefaultAdmin();

module.exports = {
    DEFAULT_ACCOUNT_LIMIT,
    validateUser,
    registerUser,
    renewUser,
    getAllUsers,
    getUser,
    updateUser,
    editUser,
    getAllAgents,
    getAgent,
    getAgentSelf,
    isAgent,
    createAgent,
    editAgent,
    deleteAgent,
    getAllAgentSpecs,
    createAgentSpec,
    updateAgentSpec,
    deleteAgentSpec,
    generateAgentCards,
    getCardsByCreator,
    getAgentCustomers,
    getAgentStats,
    getAllAgentRechargeCards,
    createAgentRechargeCards,
    deleteAgentRechargeCard,
    redeemAgentRechargeCard,
    getAgentRechargeRecords,
    getAllCards,
    createCard,
    createCardsBatch,
    updateCard,
    deleteCard,
    deleteCardsBatch,
    clearCards,
    deleteUser,
    changePassword,
    getCardClaimStatus,
    getAvailableTimeCardCount,
    setCardClaimStatus,
    claimCardByUA,
    getCardClaimRecords,
    clearExpiredClaimRecords,
    isSuperAdmin,
    clearAllData,
    clearExpiredUsers,
    getUserCount,
    checkRateLimit,
    clearIpAttempts,
    verifyCardOwnership,
    resetPasswordByCard,
    addLoginLog,
    getLoginLogs,
    clearLoginLogs,
};
