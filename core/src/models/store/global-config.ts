import type { AccountConfig, Announcement, AntiResaleConfig, CaptureConfig, LoginSettings, OfflineReminder, SupportConfig, SystemConfig, UIConfig } from '../../types/config';
export {};

const { readTextFile, writeJsonFileAtomic } = require('../../services/json-db');
const { DEFAULT_CLIENT_VERSION, DEFAULT_TIME_ZONE, normalizeTimeZone, normalizeSystemConfig, resolveClientVersionUpdatedAt } = require('../../config/config');

const sharedState = require('./shared-state');

const {
    STORE_FILE,
    PUSHOO_CHANNELS,
    DEFAULT_OFFLINE_REMINDER,
    DEFAULT_LOGIN_SETTINGS,
    DEFAULT_ANTI_RESALE_CONFIG,
    DEFAULT_CAPTURE_CONFIG,
    DEFAULT_SUPPORT_CONFIG,
    normalizeCaptureConfig,
    normalizeSupportConfig,
    globalConfig,
    normalizeAccountConfig,
    normalizeAnnouncement,
    normalizeSuperAdminAnnouncement,
    normalizeAntiResaleConfig,
    cloneAccountConfig,
    DEFAULT_ACCOUNT_CONFIG,
} = sharedState;

function normalizeOfflineReminder(input: unknown): OfflineReminder {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const secret = (src.secret !== undefined && src.secret !== null)
        ? String(src.secret).trim()
        : DEFAULT_OFFLINE_REMINDER.secret;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        endpoint,
        token,
        secret,
        title,
        msg,
        offlineDeleteSec,
    };
}

function sanitizeGlobalConfigBeforeSave(): void {
    sharedState.accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(sharedState.accountFallbackConfig);

    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap: Record<string, AccountConfig> = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        nextMap[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
    }
    globalConfig.accountConfigs = nextMap;

    const userMap = (globalConfig.userSystemConfigs && typeof globalConfig.userSystemConfigs === 'object')
        ? globalConfig.userSystemConfigs
        : {};
    const nextUserMap: Record<string, SystemConfig> = {};
    for (const [username, cfg] of Object.entries(userMap)) {
        const key = String(username || '').trim();
        if (!key) continue;
        nextUserMap[key] = normalizeSystemConfig(cfg, null);
    }
    globalConfig.userSystemConfigs = nextUserMap;

    const userReminderMap = (globalConfig.userOfflineReminders && typeof globalConfig.userOfflineReminders === 'object')
        ? globalConfig.userOfflineReminders
        : {};
    const nextUserReminderMap: Record<string, OfflineReminder> = {};
    for (const [username, cfg] of Object.entries(userReminderMap)) {
        const key = String(username || '').trim();
        if (!key) continue;
        nextUserReminderMap[key] = normalizeOfflineReminder(cfg);
    }
    globalConfig.userOfflineReminders = nextUserReminderMap;

    globalConfig.announcement = normalizeAnnouncement(globalConfig.announcement);
    globalConfig.superAdminAnnouncement = normalizeSuperAdminAnnouncement(globalConfig.superAdminAnnouncement);
    if (globalConfig.antiResaleConfig) {
        globalConfig.antiResaleConfig = normalizeAntiResaleConfig(globalConfig.antiResaleConfig);
    }
    if (globalConfig.captureConfig) {
        globalConfig.captureConfig = normalizeCaptureConfig(globalConfig.captureConfig);
    }
    if (globalConfig.supportConfig) {
        globalConfig.supportConfig = normalizeSupportConfig(globalConfig.supportConfig);
    }
}

function saveGlobalConfig(): void {
    const { ensureDataDir } = require('../../config/runtime-paths');
    ensureDataDir();
    try {
        const oldJson: string = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);

        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (e: any) {
        console.error('保存配置失败:', e.message);
    }
}

function getUI(): UIConfig {
    return { ...globalConfig.ui };
}

function setUITheme(theme: unknown): UIConfig {
    const t = String(theme || '').toLowerCase();
    const next: UIConfig['theme'] = (t === 'light') ? 'light' : 'dark';
    // Import here to avoid circular - use direct globalConfig mutation
    if (globalConfig.ui) {
        globalConfig.ui.theme = next;
    }
    saveGlobalConfig();
    return getUI();
}

function getOfflineReminder(): OfflineReminder {
    return normalizeOfflineReminder(globalConfig.offlineReminder);
}

function normalizeLoginSettings(input: unknown): LoginSettings {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    return {
        wechatQrLogin: typeof src.wechatQrLogin === 'boolean' ? src.wechatQrLogin : DEFAULT_LOGIN_SETTINGS.wechatQrLogin,
        qqQrLogin: typeof src.qqQrLogin === 'boolean' ? src.qqQrLogin : DEFAULT_LOGIN_SETTINGS.qqQrLogin,
        napCatEndpoint: typeof src.napCatEndpoint === 'string' ? src.napCatEndpoint.trim() : DEFAULT_LOGIN_SETTINGS.napCatEndpoint,
        napCatSignature: typeof src.napCatSignature === 'string' ? src.napCatSignature.trim() : DEFAULT_LOGIN_SETTINGS.napCatSignature,
    };
}

function getLoginSettings(): LoginSettings {
    return normalizeLoginSettings(globalConfig.loginSettings);
}

function setLoginSettings(cfg: Partial<LoginSettings> | undefined): LoginSettings {
    const next = normalizeLoginSettings({ ...getLoginSettings(), ...(cfg || {}) });
    if (next.qqQrLogin && (!next.napCatEndpoint || !next.napCatSignature)) {
        throw new Error('开启 QQ 扫码登录前，请配置 NapCat 接口地址和接口签名');
    }
    globalConfig.loginSettings = next;
    saveGlobalConfig();
    return getLoginSettings();
}

function setOfflineReminder(cfg: Partial<OfflineReminder> | undefined): OfflineReminder {
    const current = normalizeOfflineReminder(globalConfig.offlineReminder);
    globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getOfflineReminder();
}

/** 重置后台全局默认的下线提醒 */
function resetOfflineReminder(): OfflineReminder {
    globalConfig.offlineReminder = normalizeOfflineReminder({ ...DEFAULT_OFFLINE_REMINDER });
    saveGlobalConfig();
    return getOfflineReminder();
}

// ==================== 公告 ====================

function getAnnouncement(): Announcement {
    return normalizeAnnouncement(globalConfig.announcement);
}

function setAnnouncement(content: unknown, showOnce: unknown = true): Announcement {
    globalConfig.announcement = {
        content: String(content || '').trim(),
        showOnce: showOnce !== false,
        updatedAt: Date.now(),
    };
    saveGlobalConfig();
    return getAnnouncement();
}

function getAnnouncementReadRecord(username: unknown): number {
    const key = resolveUsername(username);
    if (!key) return 0;
    return Number((globalConfig.announcementReadRecords || {})[key]) || 0;
}

function markAnnouncementRead(username: unknown): void {
    const key = resolveUsername(username);
    if (!key) return;
    if (!globalConfig.announcementReadRecords || typeof globalConfig.announcementReadRecords !== 'object') {
        globalConfig.announcementReadRecords = {};
    }
    globalConfig.announcementReadRecords[key] = Date.now();
    saveGlobalConfig();
}

/** 公告是否需要对该用户弹出（showOnce 时读过的版本不再弹） */
function shouldShowAnnouncement(username: unknown): boolean {
    const key = resolveUsername(username);
    if (!key) return false;
    const announcement = getAnnouncement();
    if (!announcement.content) return false;
    if (!announcement.showOnce) return true;
    return getAnnouncementReadRecord(key) < announcement.updatedAt;
}

// ==================== 超级管理员公告 ====================

function getSuperAdminAnnouncement(): Announcement & { hasPassword: boolean } {
    const cfg = normalizeSuperAdminAnnouncement(globalConfig.superAdminAnnouncement);
    return { content: cfg.content, showOnce: true, updatedAt: cfg.updatedAt, hasPassword: !!cfg.password };
}

function getSuperAdminAnnouncementPassword(): string {
    return normalizeSuperAdminAnnouncement(globalConfig.superAdminAnnouncement).password;
}

function setSuperAdminAnnouncement(content: unknown, password: unknown): Announcement & { hasPassword: boolean } {
    const prev = normalizeSuperAdminAnnouncement(globalConfig.superAdminAnnouncement);
    const nextPassword = String(password || '').trim();
    globalConfig.superAdminAnnouncement = {
        content: String(content || '').trim(),
        // 留空表示保持原密码不变
        password: nextPassword || prev.password,
        updatedAt: Date.now(),
    };
    saveGlobalConfig();
    return getSuperAdminAnnouncement();
}

function verifySuperAdminAnnouncementPassword(password: unknown): boolean {
    const stored = getSuperAdminAnnouncementPassword();
    if (!stored) return false;
    return String(password || '').trim() === stored;
}

// ==================== 防倒卖配置 ====================

function getAntiResaleConfig(): AntiResaleConfig {
    if (!globalConfig.antiResaleConfig) return { ...DEFAULT_ANTI_RESALE_CONFIG };
    return normalizeAntiResaleConfig(globalConfig.antiResaleConfig);
}

function setAntiResaleConfig(input: unknown): AntiResaleConfig {
    const prev = globalConfig.antiResaleConfig ? normalizeAntiResaleConfig(globalConfig.antiResaleConfig) : null;
    globalConfig.antiResaleConfig = normalizeAntiResaleConfig(input, prev);
    saveGlobalConfig();
    return getAntiResaleConfig();
}

// ==================== Code/GID 抓取服务配置 ====================

function getCaptureConfig(): CaptureConfig {
    if (!globalConfig.captureConfig) return { ...DEFAULT_CAPTURE_CONFIG };
    return normalizeCaptureConfig(globalConfig.captureConfig);
}

function setCaptureConfig(input: unknown): CaptureConfig {
    const prev = globalConfig.captureConfig ? normalizeCaptureConfig(globalConfig.captureConfig) : null;
    globalConfig.captureConfig = normalizeCaptureConfig(input, prev);
    saveGlobalConfig();
    return getCaptureConfig();
}

// ==================== 联系客服配置 ====================

function getSupportConfig(): SupportConfig {
    if (!globalConfig.supportConfig) return { ...DEFAULT_SUPPORT_CONFIG };
    return normalizeSupportConfig(globalConfig.supportConfig);
}

function setSupportConfig(input: unknown): SupportConfig {
    const prev = globalConfig.supportConfig ? normalizeSupportConfig(globalConfig.supportConfig) : null;
    globalConfig.supportConfig = normalizeSupportConfig(input, prev);
    saveGlobalConfig();
    return getSupportConfig();
}

function getSystemConfig(): SystemConfig | null {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function setSystemConfig(config: Partial<SystemConfig> | undefined): SystemConfig | null {
    if (!config || typeof config !== 'object') return null;
    const DEFAULT_DEVICE_INFO = {
        os: 'Windows',
        clientVersion: DEFAULT_CLIENT_VERSION,
        sysSoftware: 'Windows',
        network: 'wifi',
        memory: '16384',
        deviceId: 'DESKTOP-PC<WPC>',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
    };
    const srcDevice = (config.deviceInfo && typeof config.deviceInfo === 'object') ? config.deviceInfo : {};
    const topVersion = String(config.clientVersion || '').trim();
    const deviceVersion = String((srcDevice as any).clientVersion || '').trim();
    const requestedVersion = deviceVersion || topVersion;
    const clientVersion = requestedVersion || DEFAULT_DEVICE_INFO.clientVersion;
    const currentVersion = String(globalConfig.systemConfig?.clientVersion || DEFAULT_DEVICE_INFO.clientVersion).trim();
    const currentUpdatedAt = Number(globalConfig.systemConfig?.clientVersionUpdatedAt);
    const clientVersionUpdatedAt = resolveClientVersionUpdatedAt(
        clientVersion,
        currentVersion,
        currentUpdatedAt,
        config.clientVersionUpdatedAt,
    );
    const deviceInfo = {
        os: String((srcDevice as any).os || DEFAULT_DEVICE_INFO.os).trim(),
        clientVersion,
        sysSoftware: String((srcDevice as any).sysSoftware || DEFAULT_DEVICE_INFO.sysSoftware).trim(),
        network: String((srcDevice as any).network || DEFAULT_DEVICE_INFO.network).trim(),
        memory: String((srcDevice as any).memory || DEFAULT_DEVICE_INFO.memory).trim(),
        deviceId: String((srcDevice as any).deviceId || DEFAULT_DEVICE_INFO.deviceId).trim(),
        userAgent: String((srcDevice as any).userAgent || DEFAULT_DEVICE_INFO.userAgent).trim(),
    };
    globalConfig.systemConfig = {
        serverUrl: String(config.serverUrl || '').trim(),
        clientVersion: deviceInfo.clientVersion,
        clientVersionUpdatedAt,
        platform: String(config.platform || 'qq').trim(),
        os: deviceInfo.os,
        timeZone: normalizeTimeZone(config.timeZone || DEFAULT_TIME_ZONE),
        deviceInfo,
    };
    saveGlobalConfig();
    return { ...globalConfig.systemConfig };
}

function resolveUsername(username: unknown): string {
    return (username !== undefined && username !== null) ? String(username).trim() : '';
}

function getUserSystemConfigOverride(username: unknown): SystemConfig | null {
    const key = resolveUsername(username);
    if (!key) return null;
    const cfg = (globalConfig.userSystemConfigs || {})[key];
    if (!cfg) return null;
    return { ...cfg, deviceInfo: { ...cfg.deviceInfo } };
}

function setUserSystemConfigOverride(username: unknown, input: unknown): SystemConfig | null {
    const key = resolveUsername(username);
    if (!key) return null;
    const current = (globalConfig.userSystemConfigs || {})[key] || null;
    const next = normalizeSystemConfig(input, current);
    if (!globalConfig.userSystemConfigs || typeof globalConfig.userSystemConfigs !== 'object') {
        globalConfig.userSystemConfigs = {};
    }
    globalConfig.userSystemConfigs[key] = next;
    saveGlobalConfig();
    return getUserSystemConfigOverride(key);
}

function clearUserSystemConfigOverride(username: unknown): boolean {
    const key = resolveUsername(username);
    if (!key) return false;
    const map = globalConfig.userSystemConfigs || {};
    if (!map[key]) return false;
    delete map[key];
    saveGlobalConfig();
    return true;
}

function getUserOfflineReminderOverride(username: unknown): OfflineReminder | null {
    const key = resolveUsername(username);
    if (!key) return null;
    const cfg = (globalConfig.userOfflineReminders || {})[key];
    if (!cfg) return null;
    return normalizeOfflineReminder(cfg);
}

function setUserOfflineReminderOverride(username: unknown, input: unknown): OfflineReminder | null {
    const key = resolveUsername(username);
    if (!key) return null;
    const current = (globalConfig.userOfflineReminders || {})[key];
    const base = current ? normalizeOfflineReminder(current) : getOfflineReminder();
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const next = normalizeOfflineReminder({ ...base, ...src });
    if (!globalConfig.userOfflineReminders || typeof globalConfig.userOfflineReminders !== 'object') {
        globalConfig.userOfflineReminders = {};
    }
    globalConfig.userOfflineReminders[key] = next;
    saveGlobalConfig();
    return getUserOfflineReminderOverride(key);
}

function clearUserOfflineReminderOverride(username: unknown): boolean {
    const key = resolveUsername(username);
    if (!key) return false;
    const map = globalConfig.userOfflineReminders || {};
    if (!map[key]) return false;
    delete map[key];
    saveGlobalConfig();
    return true;
}

/** 某个游戏账号当前生效的下线提醒：账号归属用户的用户级设置优先，其次后台全局默认 */
function getOfflineReminderForAccount(accountId: unknown): OfflineReminder {
    try {
        const { getAccountOwnerUsername } = require('./accounts');
        const owner = resolveUsername(getAccountOwnerUsername(accountId));
        if (owner) {
            const override = getUserOfflineReminderOverride(owner);
            if (override) return override;
        }
    } catch (e: any) {
        console.error('解析账号归属用户的下线提醒配置失败:', e.message);
    }
    return getOfflineReminder();
}

/**
 * 一次性迁移：旧版按游戏账号保存的运行环境 → 归属用户的用户级运行环境。
 * 同一个用户有多个账号时，只保留第一个作为该用户的运行环境。
 */
function migrateLegacyAccountSystemConfig(): void {
    try {
        const { getAccounts } = require('./accounts');
        const accounts = getAccounts()?.accounts || [];
        let touched = false;
        for (const account of accounts) {
            const id = String(account?.id || '').trim();
            if (!id) continue;
            const cfg = globalConfig.accountConfigs[id];
            if (!cfg || !cfg.systemConfig) continue;
            const username = resolveUsername(account?.username);
            if (username && !(globalConfig.userSystemConfigs || {})[username]) {
                globalConfig.userSystemConfigs[username] = normalizeSystemConfig(cfg.systemConfig, null);
            }
            cfg.systemConfig = null;
            touched = true;
        }
        if (touched) saveGlobalConfig();
    } catch (e: any) {
        console.error('迁移账号级运行环境配置失败:', e.message);
    }
}

// Initialize on load
const { loadGlobalConfig } = sharedState;
loadGlobalConfig();
migrateLegacyAccountSystemConfig();
// Apply offlineReminder normalization after load
globalConfig.offlineReminder = normalizeOfflineReminder(globalConfig.offlineReminder);
const loadedUserOfflineReminders = (globalConfig.userOfflineReminders && typeof globalConfig.userOfflineReminders === 'object')
    ? globalConfig.userOfflineReminders
    : {};
for (const [username, cfg] of Object.entries(loadedUserOfflineReminders)) {
    const key = String(username || '').trim();
    if (!key) continue;
    loadedUserOfflineReminders[key] = normalizeOfflineReminder(cfg);
}
globalConfig.userOfflineReminders = loadedUserOfflineReminders;
globalConfig.loginSettings = normalizeLoginSettings(globalConfig.loginSettings);
if (sharedState.systemConfigMigrated) {
    saveGlobalConfig();
    sharedState.systemConfigMigrated = false;
}

module.exports = {
    saveGlobalConfig,
    getUI,
    setUITheme,
    getLoginSettings,
    setLoginSettings,
    getOfflineReminder,
    setOfflineReminder,
    resetOfflineReminder,
    getSystemConfig,
    setSystemConfig,
    getUserSystemConfigOverride,
    setUserSystemConfigOverride,
    clearUserSystemConfigOverride,
    getUserOfflineReminderOverride,
    setUserOfflineReminderOverride,
    clearUserOfflineReminderOverride,
    getOfflineReminderForAccount,
    // 公告
    getAnnouncement,
    setAnnouncement,
    getAnnouncementReadRecord,
    markAnnouncementRead,
    shouldShowAnnouncement,
    getSuperAdminAnnouncement,
    getSuperAdminAnnouncementPassword,
    setSuperAdminAnnouncement,
    verifySuperAdminAnnouncementPassword,
    // 防倒卖
    getAntiResaleConfig,
    setAntiResaleConfig,
    DEFAULT_ANTI_RESALE_CONFIG,
    // 抓包服务
    getCaptureConfig,
    setCaptureConfig,
    DEFAULT_CAPTURE_CONFIG,
    // 联系客服
    getSupportConfig,
    setSupportConfig,
    DEFAULT_SUPPORT_CONFIG,
};
