export {};
export type PlantingStrategy =
  | 'preferred'
  | 'level'
  | 'max_exp'
  | 'max_fert_exp'
  | 'max_profit'
  | 'max_fert_profit'
  | 'bag_priority';

export type BagSeedFallbackStrategy = Exclude<PlantingStrategy, 'bag_priority'>;

export type FertilizerMode = 'both' | 'normal' | 'organic' | 'smart' | 'none';

export type FertilizerLandType = 'purple-gold' | 'gold' | 'black' | 'red' | 'normal';

export interface AutomationConfig {
  farm: boolean;
  farm_push: boolean;
  land_upgrade: boolean;
  friend: boolean;
  friend_auto_accept: boolean;
  friend_help_exp_limit: boolean;
  friend_steal: boolean;
  friend_help: boolean;
  friend_bad: boolean;
  friend_golden_bug: boolean;
  friend_help_protect_dog_ignore_exp_limit: boolean;
  task: boolean;
  fertilizer_gift: boolean;
  fertilizer_buy_organic: boolean;
  fertilizer_buy_normal: boolean;
  mystery_shop_auto_buy: boolean;
  mystery_shop_allow_gold: boolean;
  mystery_shop_allow_coupon: boolean;
  mystery_shop_allow_gold_bean: boolean;
  mystery_shop_allow_diamond: boolean;
  mystery_shop_arrival_notify: boolean;
  mystery_shop_purchase_notify: boolean;
  sell: boolean;
  fertilizer: FertilizerMode;
  fertilizer_multi_season: boolean;
  fertilizer_land_types: FertilizerLandType[];
  fertilizer_smart_seconds: number;
  skip_own_weed_bug: boolean;
  show_manual_fertilizer: boolean;
  // 奶茶热销中活动自动化（收益 / 工资 / 升级 / 制作 / 喇叭 / 雇佣 / 种子 / 快乐值 / 成长基金）
  milk_tea_cashier: boolean;
  milk_tea_wages: boolean;
  milk_tea_upgrade: boolean;
  milk_tea_craft: boolean;
  milk_tea_boost: boolean;
  milk_tea_hire: boolean;
  /** 雇佣时长档位（1=4h / 2=12h / 3=24h）。 */
  milk_tea_hire_duration: number;
  /** 雇佣偏好员工类型（0=不限 / 9001-9004 对应天赋）。 */
  milk_tea_hire_talent: number;
  milk_tea_seed_buy: boolean;
  milk_tea_interact: boolean;
  milk_tea_share_daily: boolean;
  milk_tea_share_rewards: boolean;
  milk_tea_fund_rewards: boolean;
}

export interface IntervalConfig {
  farm: number;
  farmMin: number;
  farmMax: number;
  friendMin: number;
  friendMax: number;
  helpMin: number;
  helpMax: number;
  stealMin: number;
  stealMax: number;
  [key: string]: number;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  continueFarm: boolean;
}

/** 资本模式：按作物成熟时间临时派出守护宠物，收获后自动召回 */
export interface CapitalModeConfig {
  enabled: boolean;
  /** 要自动派出的宠物 ID，0 表示还没选 */
  dogId: number;
  /** 作物成熟前多少秒派出（5-300） */
  leadSeconds: number;
}

export interface AccountConfig {
  automation: AutomationConfig;
  plantingStrategy: PlantingStrategy;
  preferredSeedId: number;
  intervals: IntervalConfig;
  friendQuietHours: QuietHoursConfig;
  knownFriendGids: number[];
  knownFriendGidSyncCooldownSec: number;
  friendsListCacheTtlSec: number;
  friendBlacklist: number[];
  plantBlacklist: number[];
  stealDelaySeconds: number;
  plantOrderRandom: boolean;
  plantDelaySeconds: number;
  /** 自动投放黄金虫时背包里保留自用的数量 */
  goldenBugKeepCount: number;
  /** 单轮最多投放多少只黄金虫（1-100） */
  goldenBugRoundLimit: number;
  fertilizerBuyOrganicCount: number;
  fertilizerBuyOrganicThresholdHours: number;
  fertilizerBuyNormalCount: number;
  fertilizerBuyNormalThresholdHours: number;
  fertilizerBuyCheckIntervalMinutes: number;
  bagSeedPriority: number[];
  /** 是否为明确排在前面的多格背包种子保留尚未连成布局的空地。 */
  bagSeedMultiLandReservationEnabled: boolean;
  /** seedId -> 允许种植的土地类型。缺 key 视为不限制。 */
  bagSeedLandTypes: Record<string, FertilizerLandType[]>;
  bagSeedFallbackStrategy: BagSeedFallbackStrategy;
  autoAcceptFriendMinLevel: number;
  autoAcceptRequireOwnLevel: boolean;
  autoAcceptHarvestStealEnabled: boolean;
  autoAcceptHarvestStealHarvest: number;
  autoAcceptHarvestStealSteal: number;
  /** 微信账号是否用持久化凭证自动刷新登录 Code（重启免扫码 / 掉线自动重登 / 定时刷新） */
  autoCodeRefreshEnabled: boolean;
  /** 自动刷新 Code 的间隔（分钟），同时作为定时重连周期 */
  autoCodeRefreshIntervalMinutes: number;
  /** 资本模式：按作物成熟时间临时派出守护宠物 */
  capitalMode: CapitalModeConfig;
  /**
   * @deprecated 旧版「账号级运行环境」字段，已改为用户级（见 GlobalConfig.userSystemConfigs）。
   * 仅保留用于启动时的一次性迁移，不要在新代码中读写。
   */
  systemConfig?: SystemConfig | null;
}

export interface OfflineReminder {
  channel: string;
  endpoint: string;
  token: string;
  secret: string;
  title: string;
  msg: string;
  offlineDeleteSec: number;
}

export interface UIConfig {
  theme: 'light' | 'dark';
}

export interface LoginSettings {
  wechatQrLogin: boolean;
  qqQrLogin: boolean;
  napCatEndpoint: string;
  napCatSignature: string;
}

export interface DeviceInfo {
  os: string;
  clientVersion: string;
  sysSoftware: string;
  network: string;
  memory: string;
  deviceId: string;
  userAgent: string;
}

export interface SystemConfig {
  serverUrl: string;
  clientVersion: string;
  clientVersionUpdatedAt?: number;
  platform: string;
  os: string;
  timeZone: string;
  deviceInfo: DeviceInfo;
}

/** 全站公告：登录后在面板中弹出的通知 */
export interface Announcement {
  content: string;
  /** true = 每个用户只弹一次（读过后不再弹）；false = 每次登录都弹 */
  showOnce: boolean;
  updatedAt: number;
}

/** 超级管理员公告：登录页/面板中对未登录访客展示，需要密码校验 */
export interface SuperAdminAnnouncement {
  content: string;
  password: string;
  updatedAt: number;
}

/** 防倒卖声明与账号数量限制配置 */
export interface AntiResaleConfig {
  enabled: boolean;
  title: string;
  author: string;
  qq: string;
  content: string;
  /** 注册用户数达到该阈值后展示声明 */
  userThreshold: number;
  /** 两次展示之间的最短间隔（秒） */
  intervalSeconds: number;
  /** 声明弹窗的关闭倒计时（秒） */
  countdownSeconds: number;
  accountLimitEnabled: boolean;
  accountLimitThreshold: number;
}

/** 联系客服配置：后台配置后，用户在面板中以悬浮按钮查看 */
export interface SupportConfig {
  /** 是否向用户展示联系客服入口 */
  enabled: boolean;
  /** 弹窗标题 */
  title: string;
  /** 入口文字：桌面端侧边栏导航项与移动端底部导航项的显示文案 */
  fabTitle: string;
  /** 弹窗副标题 */
  subtitle: string;
  /** 二维码上方的扫码提示文字 */
  qrcodeHint: string;
  /** 客服 QQ 行的标题 */
  qqTitle: string;
  /** 客服微信行的标题 */
  wechatTitle: string;
  /** QQ 群行的标题（群号与加群链接共用） */
  groupTitle: string;
  /** 客服 QQ 号 */
  qq: string;
  /** 客服微信号 */
  wechat: string;
  /** 客服二维码图片地址 */
  qrcodeUrl: string;
  /** QQ 群号 */
  group: string;
  /** 加群链接 */
  groupLink: string;
}

/** Code/GID 抓取服务配置 */
export interface CaptureConfig {
  /** 是否启用「抓包登录」 */
  enabled: boolean;
  /** 是否使用内嵌在本进程的抓包服务（false 表示连接独立抓包服务） */
  embedded: boolean;
  /** 独立抓包服务地址，如 http://127.0.0.1:8450 */
  apiBase: string;
  /** 独立抓包服务 API Token；嵌入模式无需填写 */
  apiToken: string;
  /** 抓包登录后是否自动拉取 QQ 好友 GID */
  autoImportQqGids: boolean;
}

export interface GlobalConfig {
  accountConfigs: Record<string, AccountConfig>;
  defaultAccountConfig: AccountConfig;
  ui: UIConfig;
  loginSettings: LoginSettings;
  /** 后台「系统 → 下线提醒」配置的全局默认；未单独设置的用户沿用此值。 */
  offlineReminder: OfflineReminder;
  /** 后台「系统 → 运行环境」配置的全局默认；未单独设置的用户沿用此值。 */
  systemConfig: SystemConfig | null;
  /** 按登录用户（用户名）单独设置的「运行环境」；缺省表示沿用全局默认。 */
  userSystemConfigs: Record<string, SystemConfig>;
  /** 按登录用户（用户名）单独设置的「下线提醒」；缺省表示沿用全局默认。 */
  userOfflineReminders: Record<string, OfflineReminder>;
  /** 全站公告（登录后弹窗） */
  announcement: Announcement;
  /** 用户名 -> 最近一次阅读公告的时间戳，用于 showOnce 判断 */
  announcementReadRecords: Record<string, number>;
  /** 超级管理员公告 */
  superAdminAnnouncement: SuperAdminAnnouncement;
  /** 防倒卖配置；null 表示尚未配置（使用默认值） */
  antiResaleConfig: AntiResaleConfig | null;
  /** Code/GID 抓取服务配置；null 表示尚未配置（使用默认值） */
  captureConfig: CaptureConfig | null;
  /** 联系客服配置；null 表示尚未配置（使用默认值） */
  supportConfig: SupportConfig | null;
}
