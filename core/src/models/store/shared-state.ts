import type { AccountConfig, Announcement, AntiResaleConfig, AutomationConfig, BagSeedFallbackStrategy, CapitalModeConfig, CaptureConfig, FertilizerLandType, GlobalConfig, IntervalConfig, LoginSettings, OfflineReminder, PlantingStrategy, QuietHoursConfig, SuperAdminAnnouncement, SupportConfig } from '../../types/config';
export {};

const { DEFAULT_TIME_ZONE, normalizeTimeZone, resolveClientVersion, normalizeSystemConfig } = require('../../config/config');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFile } = require('../../services/json-db');

const STORE_FILE: string = getDataFile('store.json');
const ACCOUNTS_FILE: string = getDataFile('accounts.json');
const KNOWN_FRIEND_GIDS_DIR: string = getDataFile('known_friend_gids');

const ALLOWED_PLANTING_STRATEGIES: PlantingStrategy[] = ['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit', 'bag_priority'];
const ALLOWED_BAG_SEED_FALLBACK_STRATEGIES: BagSeedFallbackStrategy[] = ALLOWED_PLANTING_STRATEGIES.filter((s): s is BagSeedFallbackStrategy => s !== 'bag_priority');
const PUSHOO_CHANNELS: Set<string> = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher', 'meow',
]);

const DEFAULT_FERTILIZER_LAND_TYPES: FertilizerLandType[] = ['purple-gold', 'gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_SET: Set<string> = new Set(DEFAULT_FERTILIZER_LAND_TYPES);
const INTERVAL_MAX_SEC: number = 86400;
const DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC: number = 300;
const DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC: number = 60;
let systemConfigMigrated: boolean = false;
let accountFallbackConfig: AccountConfig;

const DEFAULT_OFFLINE_REMINDER: OfflineReminder = {
    channel: 'webhook',
    endpoint: '',
    token: '',
    secret: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
};

const DEFAULT_LOGIN_SETTINGS: LoginSettings = {
    wechatQrLogin: true,
    qqQrLogin: false,
    napCatEndpoint: '',
    napCatSignature: '',
};

const DEFAULT_ANTI_RESALE_CONFIG: AntiResaleConfig = {
    enabled: true,
    title: '重要声明',
    author: '',
    qq: '',
    content: '',
    userThreshold: 999999999,
    intervalSeconds: 2,
    countdownSeconds: 10,
    accountLimitEnabled: false,
    accountLimitThreshold: 999999999,
};

const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
    enabled: false,
    embedded: true,
    apiBase: 'http://127.0.0.1:8450',
    apiToken: '',
    autoImportQqGids: true,
};

const DEFAULT_SUPPORT_CONFIG: SupportConfig = {
    enabled: false,
    title: '联系客服',
    fabTitle: '联系客服',
    subtitle: '点击即可复制联系方式',
    qrcodeHint: '扫码添加微信客服',
    qqTitle: '客服 QQ',
    wechatTitle: '客服微信',
    groupTitle: 'QQ 群号',
    qq: '',
    wechat: '',
    qrcodeUrl: '',
    group: '',
    groupLink: '',
};

const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
    automation: {
        farm: true,
        farm_push: true,
        land_upgrade: true,
        friend: true,
        friend_auto_accept: true,
        friend_help_exp_limit: true,
        friend_steal: true,
        friend_help: true,
        friend_bad: true,
        friend_golden_bug: false,
        friend_help_protect_dog_ignore_exp_limit: true,
        task: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        sell: true,
        fertilizer: 'smart',
        fertilizer_multi_season: true,
        fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES],
        fertilizer_smart_seconds: 300,
        skip_own_weed_bug: true,
        show_manual_fertilizer: true,
        milk_tea_cashier: false,
        milk_tea_wages: false,
        milk_tea_upgrade: false,
        milk_tea_craft: false,
        milk_tea_boost: false,
        milk_tea_hire: false,
        milk_tea_hire_duration: 1,
        milk_tea_hire_talent: 0,
        milk_tea_seed_buy: false,
        milk_tea_interact: false,
        milk_tea_share_daily: false,
        milk_tea_share_rewards: false,
        milk_tea_fund_rewards: false,
    },
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    intervals: {
        farm: 2,
        farmMin: 20,
        farmMax: 25,
        friendMin: 20,
        friendMax: 25,
        helpMin: 20,
        helpMax: 25,
        stealMin: 20,
        stealMax: 25,
    },
    friendQuietHours: {
        enabled: false,
        start: '01:00',
        end: '07:30',
        continueFarm: true,
    },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    friendBlacklist: [],
    plantBlacklist: [
        20002,
        20003,
        20059,
        20065,
        20064,
        20060,
        20061,
    ],
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
    autoCodeRefreshEnabled: false,
    autoCodeRefreshIntervalMinutes: 60,
    capitalMode: { enabled: false, dogId: 0, leadSeconds: 10 },
};

const ALLOWED_AUTOMATION_KEYS: Set<string> = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

// ============ Normalization Helpers ============

function normalizeKnownFriendGids(input: unknown, fallback: number[] = []): number[] {
    const source: unknown[] = Array.isArray(input) ? input : fallback;
    const normalized: number[] = [];
    for (const item of source) {
        const value = Number.parseInt(item as string, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function normalizeKnownFriendGidSyncCooldownSec(input: unknown, fallback: number = DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(30, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeFriendsListCacheTtlSec(input: unknown, fallback: number = DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(10, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeAutoAcceptFriendMinLevel(input: unknown, fallback: number = 0): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(200, base));
}

/** 资本模式配置；缺省字段沿用 fallback（首次即默认值） */
function normalizeCapitalMode(input: unknown, fallback: unknown = DEFAULT_ACCOUNT_CONFIG.capitalMode): CapitalModeConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const base: CapitalModeConfig = (fallback && typeof fallback === 'object')
        ? fallback as CapitalModeConfig
        : DEFAULT_ACCOUNT_CONFIG.capitalMode;
    const enabled = src.enabled !== undefined && src.enabled !== null ? src.enabled === true : base.enabled === true;
    // 兼容上游旧的字段名（selectedDogId / secondsBeforeMature）
    const dogIdInput = src.dogId ?? src.selectedDogId;
    const leadInput = src.leadSeconds ?? src.secondsBeforeMature;
    const rawDogId = dogIdInput !== undefined && dogIdInput !== null
        ? Number.parseInt(String(dogIdInput), 10)
        : Number(base.dogId);
    const dogId = Number.isFinite(rawDogId) && rawDogId > 0 ? rawDogId : 0;
    const rawLead = leadInput !== undefined && leadInput !== null
        ? Number.parseInt(String(leadInput), 10)
        : Number(base.leadSeconds);
    // 解析不出来时退回 10 秒（与上游 `|| 10` 的语义一致），而不是沿用可能已经越界的旧值
    const leadSeconds = Math.max(5, Math.min(300, Number.isFinite(rawLead) ? rawLead : 10));
    return { enabled, dogId, leadSeconds };
}

function normalizeAnnouncement(input: unknown): Announcement {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    return {
        content: String(src.content || '').trim(),
        showOnce: src.showOnce !== false,
        updatedAt: Number(src.updatedAt) || 0,
    };
}

function normalizeSuperAdminAnnouncement(input: unknown): SuperAdminAnnouncement {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    return {
        content: String(src.content || '').trim(),
        password: String(src.password || '').trim(),
        updatedAt: Number(src.updatedAt) || 0,
    };
}

/** 防倒卖配置；prev 为当前已保存配置，缺省字段沿用 prev（首次则用默认值） */
function normalizeAntiResaleConfig(input: unknown, prev: AntiResaleConfig | null = null): AntiResaleConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const base: AntiResaleConfig = prev || DEFAULT_ANTI_RESALE_CONFIG;
    const toInt = (value: unknown, fallback: number, min: number): number => {
        const parsed = Number.parseInt(String(value), 10);
        return Math.max(min, parsed || fallback);
    };
    return {
        enabled: src.enabled !== undefined ? src.enabled !== false : base.enabled,
        title: String(src.title !== undefined ? src.title : base.title).trim(),
        author: String(src.author !== undefined ? src.author : base.author).trim(),
        qq: String(src.qq !== undefined ? src.qq : base.qq).trim(),
        content: String(src.content !== undefined ? src.content : base.content).trim(),
        userThreshold: toInt(src.userThreshold !== undefined ? src.userThreshold : base.userThreshold, DEFAULT_ANTI_RESALE_CONFIG.userThreshold, 1),
        intervalSeconds: toInt(src.intervalSeconds !== undefined ? src.intervalSeconds : base.intervalSeconds, DEFAULT_ANTI_RESALE_CONFIG.intervalSeconds, 1),
        countdownSeconds: toInt(src.countdownSeconds !== undefined ? src.countdownSeconds : base.countdownSeconds, DEFAULT_ANTI_RESALE_CONFIG.countdownSeconds, 5),
        accountLimitEnabled: src.accountLimitEnabled !== undefined ? src.accountLimitEnabled !== false : base.accountLimitEnabled,
        accountLimitThreshold: toInt(src.accountLimitThreshold !== undefined ? src.accountLimitThreshold : base.accountLimitThreshold, DEFAULT_ANTI_RESALE_CONFIG.accountLimitThreshold, 1),
    };
}
/** 抓包服务配置：字符串字段做 trim，布尔字段按默认值兜底 */
function normalizeCaptureConfig(input: unknown, prev: CaptureConfig | null = null): CaptureConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const base: CaptureConfig = prev || DEFAULT_CAPTURE_CONFIG;
    return {
        enabled: src.enabled !== undefined ? src.enabled === true : base.enabled,
        embedded: src.embedded !== undefined ? src.embedded !== false : base.embedded,
        apiBase: String(src.apiBase !== undefined && src.apiBase !== null && src.apiBase !== '' ? src.apiBase : base.apiBase).trim(),
        apiToken: String(src.apiToken !== undefined && src.apiToken !== null && src.apiToken !== '' ? src.apiToken : base.apiToken).trim(),
        autoImportQqGids: src.autoImportQqGids !== undefined ? src.autoImportQqGids !== false : base.autoImportQqGids,
    };
}

/** 联系客服配置：字符串字段做 trim，布尔字段按默认值兜底 */
function normalizeSupportConfig(input: unknown, prev: SupportConfig | null = null): SupportConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const base: SupportConfig = prev || DEFAULT_SUPPORT_CONFIG;
    const pick = (key: keyof SupportConfig): string =>
        String(src[key] ?? base[key]).trim();
    // 标题类字段留空时回退到默认文案，避免用户端出现空白标签
    const pickTitle = (key: Exclude<keyof SupportConfig, 'enabled'>): string =>
        pick(key) || DEFAULT_SUPPORT_CONFIG[key];
    return {
        enabled: src.enabled !== undefined ? src.enabled === true : base.enabled,
        title: pickTitle('title'),
        fabTitle: pickTitle('fabTitle'),
        subtitle: pickTitle('subtitle'),
        qrcodeHint: pickTitle('qrcodeHint'),
        qqTitle: pickTitle('qqTitle'),
        wechatTitle: pickTitle('wechatTitle'),
        groupTitle: pickTitle('groupTitle'),
        qq: pick('qq'),
        wechat: pick('wechat'),
        qrcodeUrl: pick('qrcodeUrl'),
        group: pick('group'),
        groupLink: pick('groupLink'),
    };
}

function normalizeAutoAcceptHarvestStealHarvest(input: unknown, fallback: number = 8): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(9999, base));
}

function normalizeAutoAcceptHarvestStealSteal(input: unknown, fallback: number = 1): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(1, Math.min(9999, base));
}

function normalizeBagSeedPriority(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    const normalized: number[] = [];
    for (const item of input) {
        const value = Number.parseInt(item as string, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

/**
 * seedId -> 允许的土地类型。缺 key、空数组、全类型三者等价于不限制，统一省略该 key。
 */
function normalizeBagSeedLandTypes(input: unknown): Record<string, FertilizerLandType[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const normalized: Record<string, FertilizerLandType[]> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        const seedId = Number.parseInt(key, 10);
        if (!Number.isFinite(seedId) || seedId <= 0) continue;
        if (!Array.isArray(value)) continue;
        const types: FertilizerLandType[] = [];
        for (const item of value) {
            const type = String(item || '').trim().toLowerCase();
            if (!FERTILIZER_LAND_TYPE_SET.has(type)) continue;
            if (types.includes(type as FertilizerLandType)) continue;
            types.push(type as FertilizerLandType);
        }
        if (types.length === 0 || types.length === DEFAULT_FERTILIZER_LAND_TYPES.length) continue;
        normalized[String(seedId)] = types;
    }
    return normalized;
}

function normalizeBagSeedFallbackStrategy(input: unknown, fallback: BagSeedFallbackStrategy = 'level'): BagSeedFallbackStrategy {
    const strategy = String(input || '').trim();
    if (ALLOWED_BAG_SEED_FALLBACK_STRATEGIES.includes(strategy as BagSeedFallbackStrategy)) return strategy as BagSeedFallbackStrategy;
    return fallback;
}

function normalizeFertilizerLandTypes(input: unknown, fallback: FertilizerLandType[] = DEFAULT_FERTILIZER_LAND_TYPES): FertilizerLandType[] {
    const source: unknown[] = Array.isArray(input) ? input : fallback;
    const normalized: FertilizerLandType[] = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(value)) continue;
        if (normalized.includes(value as FertilizerLandType)) continue;
        normalized.push(value as FertilizerLandType);
    }
    return normalized;
}

function normalizeTimeString(v: unknown, fallback: string): string {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return fallback;
    const hh = Math.max(0, Math.min(23, Number.parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, Number.parseInt(m[2], 10)));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normalizeIntervals(intervals: Partial<IntervalConfig> | undefined): IntervalConfig {
    const src = (intervals && typeof intervals === 'object') ? intervals : {} as Partial<IntervalConfig>;
    const toSec = (v: unknown, d: number): number => Math.max(1, Number.parseInt(v as string, 10) || d);
    const farm = toSec(src.farm, 2);

    let farmMin = toSec(src.farmMin, farm);
    let farmMax = toSec(src.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    let helpMin = toSec(src.helpMin, 10);
    let helpMax = toSec(src.helpMax, 10);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];

    let stealMin = toSec(src.stealMin, 10);
    let stealMax = toSec(src.stealMax, 10);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];

    // 新配置使用统一好友任务间隔；旧账号自动取帮助/偷菜两组间隔中较快的一组。
    let friendMin = toSec(src.friendMin, Math.min(helpMin, stealMin));
    let friendMax = toSec(src.friendMax, Math.min(helpMax, stealMax));
    if (friendMin > friendMax) [friendMin, friendMax] = [friendMax, friendMin];

    return {
        ...src,
        farm,
        farmMin,
        farmMax,
        friendMin,
        friendMax,
        helpMin,
        helpMax,
        stealMin,
        stealMax,
    } as IntervalConfig;
}

function cloneAccountConfig(base: Partial<AccountConfig> = DEFAULT_ACCOUNT_CONFIG): AccountConfig {
    const srcAutomation = (base && base.automation && typeof base.automation === 'object')
        ? base.automation
        : {} as Partial<AutomationConfig>;
    const automation: AutomationConfig = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation) as Array<keyof AutomationConfig>) {
        if (key === 'fertilizer_land_types') {
            automation[key] = normalizeFertilizerLandTypes(srcAutomation[key], DEFAULT_FERTILIZER_LAND_TYPES);
            continue;
        }
        if (key === 'milk_tea_hire_duration') {
            const duration = Number((srcAutomation as any)[key]);
            automation[key] = [1, 2, 3].includes(duration) ? duration : DEFAULT_ACCOUNT_CONFIG.automation.milk_tea_hire_duration;
            continue;
        }
        if (key === 'milk_tea_hire_talent') {
            const talent = Number((srcAutomation as any)[key]);
            automation[key] = [0, 9001, 9002, 9003, 9004].includes(talent) ? talent : DEFAULT_ACCOUNT_CONFIG.automation.milk_tea_hire_talent;
            continue;
        }
        if (srcAutomation[key] !== undefined) (automation as any)[key] = (srcAutomation as any)[key];
    }

    const rawBlacklist: number[] = Array.isArray(base.friendBlacklist) ? base.friendBlacklist : [];

    const knownFriendGids = normalizeKnownFriendGids(base.knownFriendGids);
    const knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(base.knownFriendGidSyncCooldownSec);
    const friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(base.friendsListCacheTtlSec);

    const rawPlantBlacklist: number[] = Array.isArray(base.plantBlacklist) ? base.plantBlacklist : [];

    return {
        ...DEFAULT_ACCOUNT_CONFIG,
        ...base,
        automation,
        intervals: { ...(base.intervals || DEFAULT_ACCOUNT_CONFIG.intervals) },
        friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours, ...(base.friendQuietHours || {}) },
        knownFriendGids,
        knownFriendGidSyncCooldownSec,
        friendsListCacheTtlSec,
        friendBlacklist: rawBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(base.plantingStrategy || '') as PlantingStrategy)
            ? String(base.plantingStrategy) as PlantingStrategy
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, Number.parseInt(String(base.preferredSeedId), 10) || 0),
        plantBlacklist: rawPlantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealDelaySeconds: Math.max(0, Math.min(300, Number(base.stealDelaySeconds) || 0)),
        plantOrderRandom: !!(base.plantOrderRandom),
        plantDelaySeconds: Math.max(0, Math.min(60, Number(base.plantDelaySeconds) || 0)),
        goldenBugKeepCount: Math.max(0, Math.min(10000, Number(base.goldenBugKeepCount) || 0)),
        goldenBugRoundLimit: Math.max(1, Math.min(100, Number(base.goldenBugRoundLimit) || 24)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(base.fertilizerBuyCheckIntervalMinutes) || 30)),
        bagSeedPriority: normalizeBagSeedPriority(base.bagSeedPriority),
        bagSeedMultiLandReservationEnabled: base.bagSeedMultiLandReservationEnabled !== undefined
            ? !!base.bagSeedMultiLandReservationEnabled
            : DEFAULT_ACCOUNT_CONFIG.bagSeedMultiLandReservationEnabled,
        bagSeedLandTypes: normalizeBagSeedLandTypes(base.bagSeedLandTypes),
        bagSeedFallbackStrategy: normalizeBagSeedFallbackStrategy(base.bagSeedFallbackStrategy),
        autoAcceptFriendMinLevel: normalizeAutoAcceptFriendMinLevel(base.autoAcceptFriendMinLevel, DEFAULT_ACCOUNT_CONFIG.autoAcceptFriendMinLevel),
        autoAcceptRequireOwnLevel: !!base.autoAcceptRequireOwnLevel,
        autoAcceptHarvestStealEnabled: base.autoAcceptHarvestStealEnabled !== undefined
            ? !!base.autoAcceptHarvestStealEnabled
            : DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealEnabled,
        autoAcceptHarvestStealHarvest: normalizeAutoAcceptHarvestStealHarvest(base.autoAcceptHarvestStealHarvest, DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealHarvest),
        autoAcceptHarvestStealSteal: normalizeAutoAcceptHarvestStealSteal(base.autoAcceptHarvestStealSteal, DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealSteal),
        autoCodeRefreshEnabled: base.autoCodeRefreshEnabled !== undefined
            ? !!base.autoCodeRefreshEnabled
            : DEFAULT_ACCOUNT_CONFIG.autoCodeRefreshEnabled,
        autoCodeRefreshIntervalMinutes: Math.max(1, Math.min(1440, Number(base.autoCodeRefreshIntervalMinutes) || DEFAULT_ACCOUNT_CONFIG.autoCodeRefreshIntervalMinutes)),
        capitalMode: normalizeCapitalMode(base.capitalMode, DEFAULT_ACCOUNT_CONFIG.capitalMode),
    };
}

function normalizeAccountConfig(input: unknown, fallback: AccountConfig = accountFallbackConfig): AccountConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const cfg = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);

    if (src.automation && typeof src.automation === 'object') {
        for (const [k, v] of Object.entries(src.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(k)) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
                (cfg.automation as any)[k] = allowed.includes(v as string) ? v : cfg.automation[k as keyof AutomationConfig];
            } else if (k === 'fertilizer_land_types') {
                cfg.automation.fertilizer_land_types = normalizeFertilizerLandTypes(v, cfg.automation.fertilizer_land_types);
            } else if (k === 'fertilizer_smart_seconds') {
                cfg.automation.fertilizer_smart_seconds = Math.max(30, Math.min(3600, Number(v) || 300));
            } else if (k === 'milk_tea_hire_duration') {
                const duration = Number(v);
                cfg.automation.milk_tea_hire_duration = [1, 2, 3].includes(duration) ? duration : cfg.automation.milk_tea_hire_duration;
            } else if (k === 'milk_tea_hire_talent') {
                const talent = Number(v);
                cfg.automation.milk_tea_hire_talent = [0, 9001, 9002, 9003, 9004].includes(talent) ? talent : cfg.automation.milk_tea_hire_talent;
            } else {
                (cfg.automation as any)[k] = !!v;
            }
        }
    }

    if (src.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(src.plantingStrategy)) {
        cfg.plantingStrategy = src.plantingStrategy;
    }

    if (src.preferredSeedId !== undefined && src.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(src.preferredSeedId, 10) || 0);
    }

    if (src.intervals && typeof src.intervals === 'object') {
        for (const [type, sec] of Object.entries(src.intervals)) {
            if (cfg.intervals[type] === undefined) continue;
            cfg.intervals[type] = Math.max(1, Number.parseInt(sec as string, 10) || cfg.intervals[type] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    if (src.friendQuietHours && typeof src.friendQuietHours === 'object') {
        const old: Partial<QuietHoursConfig> = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: src.friendQuietHours.enabled !== undefined ? !!src.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(src.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(src.friendQuietHours.end, old.end || '07:00'),
            continueFarm: src.friendQuietHours.continueFarm !== undefined
                ? !!src.friendQuietHours.continueFarm
                : (old.continueFarm !== undefined ? !!old.continueFarm : true),
        };
    }

    if (Array.isArray(src.friendBlacklist)) {
        cfg.friendBlacklist = src.friendBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (src.knownFriendGids !== undefined) {
        cfg.knownFriendGids = normalizeKnownFriendGids(src.knownFriendGids, cfg.knownFriendGids);
    }

    if (src.knownFriendGidSyncCooldownSec !== undefined) {
        cfg.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            src.knownFriendGidSyncCooldownSec,
            cfg.knownFriendGidSyncCooldownSec,
        );
    }

    if (src.friendsListCacheTtlSec !== undefined) {
        cfg.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            src.friendsListCacheTtlSec,
            cfg.friendsListCacheTtlSec,
        );
    }

    if (Array.isArray(src.plantBlacklist)) {
        cfg.plantBlacklist = src.plantBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (src.stealDelaySeconds !== undefined && src.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(300, Number.parseInt(src.stealDelaySeconds, 10) || 0));
    }

    if (src.plantOrderRandom !== undefined && src.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!src.plantOrderRandom;
    }

    if (src.plantDelaySeconds !== undefined && src.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(src.plantDelaySeconds) || 0));
    }

    if (src.goldenBugKeepCount !== undefined && src.goldenBugKeepCount !== null) {
        cfg.goldenBugKeepCount = Math.max(0, Math.min(10000, Number(src.goldenBugKeepCount) || 0));
    }

    if (src.goldenBugRoundLimit !== undefined && src.goldenBugRoundLimit !== null) {
        cfg.goldenBugRoundLimit = Math.max(1, Math.min(100, Number(src.goldenBugRoundLimit) || 24));
    }

    if (src.fertilizerBuyOrganicCount !== undefined && src.fertilizerBuyOrganicCount !== null) {
        cfg.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyOrganicCount) || 0));
    }

    if (src.fertilizerBuyOrganicThresholdHours !== undefined && src.fertilizerBuyOrganicThresholdHours !== null) {
        cfg.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyOrganicThresholdHours) || 0));
    }

    if (src.fertilizerBuyNormalCount !== undefined && src.fertilizerBuyNormalCount !== null) {
        cfg.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyNormalCount) || 0));
    }

    if (src.fertilizerBuyNormalThresholdHours !== undefined && src.fertilizerBuyNormalThresholdHours !== null) {
        cfg.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyNormalThresholdHours) || 0));
    }

    if (src.fertilizerBuyCheckIntervalMinutes !== undefined && src.fertilizerBuyCheckIntervalMinutes !== null) {
        cfg.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(src.fertilizerBuyCheckIntervalMinutes) || 30));
    }

    if (src.autoCodeRefreshEnabled !== undefined && src.autoCodeRefreshEnabled !== null) {
        cfg.autoCodeRefreshEnabled = !!src.autoCodeRefreshEnabled;
    }

    if (src.autoCodeRefreshIntervalMinutes !== undefined && src.autoCodeRefreshIntervalMinutes !== null) {
        cfg.autoCodeRefreshIntervalMinutes = Math.max(1, Math.min(1440, Number(src.autoCodeRefreshIntervalMinutes) || DEFAULT_ACCOUNT_CONFIG.autoCodeRefreshIntervalMinutes));
    }

    if (src.capitalMode && typeof src.capitalMode === 'object') {
        cfg.capitalMode = normalizeCapitalMode(src.capitalMode, cfg.capitalMode);
    }

    if (src.bagSeedPriority !== undefined && src.bagSeedPriority !== null) {
        cfg.bagSeedPriority = normalizeBagSeedPriority(src.bagSeedPriority);
    }

    if (src.bagSeedMultiLandReservationEnabled !== undefined && src.bagSeedMultiLandReservationEnabled !== null) {
        cfg.bagSeedMultiLandReservationEnabled = !!src.bagSeedMultiLandReservationEnabled;
    }

    if (src.bagSeedLandTypes !== undefined && src.bagSeedLandTypes !== null) {
        cfg.bagSeedLandTypes = normalizeBagSeedLandTypes(src.bagSeedLandTypes);
    }

    if (src.bagSeedFallbackStrategy !== undefined && src.bagSeedFallbackStrategy !== null) {
        cfg.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(src.bagSeedFallbackStrategy, cfg.bagSeedFallbackStrategy);
    }

    if (src.autoAcceptFriendMinLevel !== undefined && src.autoAcceptFriendMinLevel !== null) {
        cfg.autoAcceptFriendMinLevel = normalizeAutoAcceptFriendMinLevel(src.autoAcceptFriendMinLevel, cfg.autoAcceptFriendMinLevel);
    }

    if (src.autoAcceptRequireOwnLevel !== undefined && src.autoAcceptRequireOwnLevel !== null) {
        cfg.autoAcceptRequireOwnLevel = !!src.autoAcceptRequireOwnLevel;
    }

    if (src.autoAcceptHarvestStealEnabled !== undefined && src.autoAcceptHarvestStealEnabled !== null) {
        cfg.autoAcceptHarvestStealEnabled = !!src.autoAcceptHarvestStealEnabled;
    }

    if (src.autoAcceptHarvestStealHarvest !== undefined && src.autoAcceptHarvestStealHarvest !== null) {
        cfg.autoAcceptHarvestStealHarvest = normalizeAutoAcceptHarvestStealHarvest(src.autoAcceptHarvestStealHarvest, cfg.autoAcceptHarvestStealHarvest);
    }

    if (src.autoAcceptHarvestStealSteal !== undefined && src.autoAcceptHarvestStealSteal !== null) {
        cfg.autoAcceptHarvestStealSteal = normalizeAutoAcceptHarvestStealSteal(src.autoAcceptHarvestStealSteal, cfg.autoAcceptHarvestStealSteal);
    }

    // 账号级「运行环境」覆盖：缺省/显式 null 表示沿用后台配置的全局默认
    if (src.systemConfig && typeof src.systemConfig === 'object') {
        cfg.systemConfig = normalizeSystemConfig(src.systemConfig, cfg.systemConfig || null);
    } else {
        cfg.systemConfig = null;
    }

    return cfg;
}

// ============ Global Config (mutable shared state) ============

accountFallbackConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation, fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES] },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
};

const globalConfig: GlobalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    ui: {
        theme: 'light',
    },
    loginSettings: { ...DEFAULT_LOGIN_SETTINGS },
    offlineReminder: { ...DEFAULT_OFFLINE_REMINDER },
    systemConfig: null,
    userSystemConfigs: {},
    userOfflineReminders: {},
    announcement: { content: '', showOnce: true, updatedAt: 0 },
    announcementReadRecords: {},
    superAdminAnnouncement: { content: '', password: '', updatedAt: 0 },
    antiResaleConfig: null,
    captureConfig: null,
    supportConfig: null,
};

function resolveAccountId(accountId: unknown): string {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String((process as any).env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function loadGlobalConfig(): void {
    ensureDataDir();
    try {
        const data: any = readJsonFile(STORE_FILE, () => ({}));
        if (data && typeof data === 'object') {
            accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            const cfgMap = (data.accountConfigs && typeof data.accountConfigs === 'object')
                ? data.accountConfigs
                : {};
            globalConfig.accountConfigs = {};
            for (const [id, cfg] of Object.entries(cfgMap)) {
                const sid = String(id || '').trim();
                if (!sid) continue;
                globalConfig.accountConfigs[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            for (const [id, cfg] of Object.entries(globalConfig.accountConfigs)) {
                globalConfig.accountConfigs[id] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            globalConfig.ui = { ...globalConfig.ui, ...(data.ui || {}) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = theme === 'light' ? 'light' : 'dark';

            // offlineReminder / userOfflineReminders normalization done in global-config
            if (data.offlineReminder && typeof data.offlineReminder === 'object') {
                globalConfig.offlineReminder = data.offlineReminder;
            }

            const userOfflineReminders = (data.userOfflineReminders && typeof data.userOfflineReminders === 'object')
                ? data.userOfflineReminders
                : {};
            globalConfig.userOfflineReminders = {};
            for (const [username, cfg] of Object.entries(userOfflineReminders)) {
                const key = String(username || '').trim();
                if (!key) continue;
                globalConfig.userOfflineReminders[key] = cfg as OfflineReminder;
            }

            const userSystemConfigs = (data.userSystemConfigs && typeof data.userSystemConfigs === 'object')
                ? data.userSystemConfigs
                : {};
            globalConfig.userSystemConfigs = {};
            for (const [username, cfg] of Object.entries(userSystemConfigs)) {
                const key = String(username || '').trim();
                if (!key) continue;
                globalConfig.userSystemConfigs[key] = normalizeSystemConfig(cfg, null);
            }

            globalConfig.announcement = normalizeAnnouncement(data.announcement);
            const readRecords = (data.announcementReadRecords && typeof data.announcementReadRecords === 'object')
                ? data.announcementReadRecords
                : {};
            globalConfig.announcementReadRecords = {};
            for (const [username, ts] of Object.entries(readRecords)) {
                const key = String(username || '').trim();
                if (!key) continue;
                globalConfig.announcementReadRecords[key] = Number(ts) || 0;
            }
            globalConfig.superAdminAnnouncement = normalizeSuperAdminAnnouncement(data.superAdminAnnouncement);
            globalConfig.antiResaleConfig = (data.antiResaleConfig && typeof data.antiResaleConfig === 'object')
                ? normalizeAntiResaleConfig(data.antiResaleConfig)
                : null;
            globalConfig.captureConfig = (data.captureConfig && typeof data.captureConfig === 'object')
                ? normalizeCaptureConfig(data.captureConfig)
                : null;
            globalConfig.supportConfig = (data.supportConfig && typeof data.supportConfig === 'object')
                ? normalizeSupportConfig(data.supportConfig)
                : null;

            if (data.loginSettings && typeof data.loginSettings === 'object') {
                globalConfig.loginSettings = {
                    wechatQrLogin: typeof data.loginSettings.wechatQrLogin === 'boolean'
                        ? data.loginSettings.wechatQrLogin
                        : DEFAULT_LOGIN_SETTINGS.wechatQrLogin,
                    qqQrLogin: typeof data.loginSettings.qqQrLogin === 'boolean'
                        ? data.loginSettings.qqQrLogin
                        : DEFAULT_LOGIN_SETTINGS.qqQrLogin,
                    napCatEndpoint: typeof data.loginSettings.napCatEndpoint === 'string'
                        ? data.loginSettings.napCatEndpoint.trim()
                        : DEFAULT_LOGIN_SETTINGS.napCatEndpoint,
                    napCatSignature: typeof data.loginSettings.napCatSignature === 'string'
                        ? data.loginSettings.napCatSignature.trim()
                        : DEFAULT_LOGIN_SETTINGS.napCatSignature,
                };
            }

            if (data.systemConfig && typeof data.systemConfig === 'object') {
                const srcDevice = (data.systemConfig.deviceInfo && typeof data.systemConfig.deviceInfo === 'object')
                    ? data.systemConfig.deviceInfo : {};
                const deviceOs = String(srcDevice.os || data.systemConfig.os || 'Windows').trim();
                const savedTopVersion = String(data.systemConfig.clientVersion || '').trim();
                const savedDeviceVersion = String(srcDevice.clientVersion || '').trim();
                const savedVersion = savedDeviceVersion || savedTopVersion;
                const savedVersionUpdatedAt = Number(data.systemConfig.clientVersionUpdatedAt);
                const {
                    clientVersion: deviceClientVersion,
                    clientVersionUpdatedAt: deviceClientVersionUpdatedAt,
                } = resolveClientVersion(savedVersion, savedVersionUpdatedAt);
                const normalizedSystemConfig = {
                    serverUrl: String(data.systemConfig.serverUrl || '').trim(),
                    clientVersion: deviceClientVersion,
                    clientVersionUpdatedAt: deviceClientVersionUpdatedAt,
                    platform: String(data.systemConfig.platform || 'qq').trim(),
                    os: deviceOs,
                    timeZone: normalizeTimeZone(data.systemConfig.timeZone || DEFAULT_TIME_ZONE),
                    deviceInfo: {
                        os: deviceOs,
                        clientVersion: deviceClientVersion,
                        sysSoftware: String(srcDevice.sysSoftware || 'Windows').trim(),
                        network: String(srcDevice.network || 'wifi').trim(),
                        memory: String(srcDevice.memory || '16384').trim(),
                        deviceId: String(srcDevice.deviceId || 'DESKTOP-PC<WPC>').trim(),
                        userAgent: String(srcDevice.userAgent || '').trim(),
                    },
                };
                systemConfigMigrated = savedTopVersion !== deviceClientVersion
                    || savedDeviceVersion !== deviceClientVersion
                    || Number(data.systemConfig.clientVersionUpdatedAt) !== deviceClientVersionUpdatedAt
                    || data.systemConfig.timeZone !== normalizedSystemConfig.timeZone;
                globalConfig.systemConfig = normalizedSystemConfig;
            }
        }
    } catch (e: any) {
        console.error('加载配置失败:', e.message);
    }
}

module.exports = {
    // File paths
    STORE_FILE,
    ACCOUNTS_FILE,
    KNOWN_FRIEND_GIDS_DIR,
    // Constants
    ALLOWED_PLANTING_STRATEGIES,
    ALLOWED_BAG_SEED_FALLBACK_STRATEGIES,
    PUSHOO_CHANNELS,
    DEFAULT_FERTILIZER_LAND_TYPES,
    FERTILIZER_LAND_TYPE_SET,
    INTERVAL_MAX_SEC,
    DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    DEFAULT_OFFLINE_REMINDER,
    DEFAULT_LOGIN_SETTINGS,
    DEFAULT_ANTI_RESALE_CONFIG,
    DEFAULT_CAPTURE_CONFIG,
    DEFAULT_SUPPORT_CONFIG,
    DEFAULT_ACCOUNT_CONFIG,
    ALLOWED_AUTOMATION_KEYS,
    // Mutable shared state (by reference)
    globalConfig,
    get accountFallbackConfig() { return accountFallbackConfig; },
    set accountFallbackConfig(v: AccountConfig) { accountFallbackConfig = v; },
    get systemConfigMigrated() { return systemConfigMigrated; },
    set systemConfigMigrated(v: boolean) { systemConfigMigrated = !!v; },
    // Helpers
    normalizeKnownFriendGids,
    normalizeKnownFriendGidSyncCooldownSec,
    normalizeFriendsListCacheTtlSec,
    normalizeBagSeedPriority,
    normalizeBagSeedLandTypes,
    normalizeBagSeedFallbackStrategy,
    normalizeFertilizerLandTypes,
    normalizeTimeString,
    normalizeIntervals,
    normalizeAutoAcceptFriendMinLevel,
    normalizeAutoAcceptHarvestStealHarvest,
    normalizeAutoAcceptHarvestStealSteal,
    normalizeAnnouncement,
    normalizeSuperAdminAnnouncement,
    normalizeAntiResaleConfig,
    normalizeCaptureConfig,
    normalizeSupportConfig,
    normalizeCapitalMode,
    normalizeAccountConfig,
    cloneAccountConfig,
    resolveAccountId,
    loadGlobalConfig,
};
