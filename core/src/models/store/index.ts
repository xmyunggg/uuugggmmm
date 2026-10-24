export {};
const sharedState = require('./shared-state');
const globalConfig = require('./global-config');
const accountConfig = require('./account-config');
const accounts = require('./accounts');

module.exports = {
    // Account config
    getConfigSnapshot: accountConfig.getConfigSnapshot,
    applyConfigSnapshot: accountConfig.applyConfigSnapshot,
    getAutomation: accountConfig.getAutomation,
    setAutomation: accountConfig.setAutomation,
    isAutomationOn: accountConfig.isAutomationOn,
    getPreferredSeed: accountConfig.getPreferredSeed,
    getPlantingStrategy: accountConfig.getPlantingStrategy,
    getBagSeedPriority: accountConfig.getBagSeedPriority,
    getBagSeedMultiLandReservationEnabled: accountConfig.getBagSeedMultiLandReservationEnabled,
    getBagSeedLandTypes: accountConfig.getBagSeedLandTypes,
    getBagSeedFallbackStrategy: accountConfig.getBagSeedFallbackStrategy,
    getIntervals: accountConfig.getIntervals,
    getFriendQuietHours: accountConfig.getFriendQuietHours,
    getKnownFriendGids: accountConfig.getKnownFriendGids,
    setKnownFriendGids: accountConfig.setKnownFriendGids,
    getKnownFriendGidSyncCooldownSec: accountConfig.getKnownFriendGidSyncCooldownSec,
    setKnownFriendGidSyncCooldownSec: accountConfig.setKnownFriendGidSyncCooldownSec,
    getFriendsListCacheTtlSec: accountConfig.getFriendsListCacheTtlSec,
    setFriendsListCacheTtlSec: accountConfig.setFriendsListCacheTtlSec,
    getFriendBlacklist: accountConfig.getFriendBlacklist,
    setFriendBlacklist: accountConfig.setFriendBlacklist,
    addFriendToBlacklist: accountConfig.addFriendToBlacklist,
    getStealDelaySeconds: accountConfig.getStealDelaySeconds,
    getPlantOrderRandom: accountConfig.getPlantOrderRandom,
    getPlantDelaySeconds: accountConfig.getPlantDelaySeconds,
    getGoldenBugKeepCount: accountConfig.getGoldenBugKeepCount,
    getGoldenBugRoundLimit: accountConfig.getGoldenBugRoundLimit,
    getFertilizerBuyOrganicCount: accountConfig.getFertilizerBuyOrganicCount,
    getFertilizerBuyOrganicThresholdHours: accountConfig.getFertilizerBuyOrganicThresholdHours,
    getFertilizerBuyNormalCount: accountConfig.getFertilizerBuyNormalCount,
    getFertilizerBuyNormalThresholdHours: accountConfig.getFertilizerBuyNormalThresholdHours,
    getFertilizerBuyCheckIntervalMinutes: accountConfig.getFertilizerBuyCheckIntervalMinutes,
    getAutoAcceptFriendMinLevel: accountConfig.getAutoAcceptFriendMinLevel,
    getAutoAcceptRequireOwnLevel: accountConfig.getAutoAcceptRequireOwnLevel,
    getAutoAcceptHarvestStealEnabled: accountConfig.getAutoAcceptHarvestStealEnabled,
    getAutoAcceptHarvestStealHarvest: accountConfig.getAutoAcceptHarvestStealHarvest,
    getAutoAcceptHarvestStealSteal: accountConfig.getAutoAcceptHarvestStealSteal,
    getAutoCodeRefreshConfig: accountConfig.getAutoCodeRefreshConfig,
    getCapitalMode: accountConfig.getCapitalMode,
    setCapitalMode: accountConfig.setCapitalMode,
    getPlantBlacklist: accountConfig.getPlantBlacklist,
    setPlantBlacklist: accountConfig.setPlantBlacklist,
    getDefaultAccountConfig: accountConfig.getDefaultAccountConfig,
    getAccountOwnerUsername: accounts.getAccountOwnerUsername,

    // Global config
    getUI: globalConfig.getUI,
    setUITheme: globalConfig.setUITheme,
    getLoginSettings: globalConfig.getLoginSettings,
    setLoginSettings: globalConfig.setLoginSettings,
    getOfflineReminder: globalConfig.getOfflineReminder,
    setOfflineReminder: globalConfig.setOfflineReminder,
    resetOfflineReminder: globalConfig.resetOfflineReminder,
    getUserOfflineReminderOverride: globalConfig.getUserOfflineReminderOverride,
    setUserOfflineReminderOverride: globalConfig.setUserOfflineReminderOverride,
    clearUserOfflineReminderOverride: globalConfig.clearUserOfflineReminderOverride,
    getOfflineReminderForAccount: globalConfig.getOfflineReminderForAccount,

    // Accounts
    getAccounts: accounts.getAccounts,
    addOrUpdateAccount: accounts.addOrUpdateAccount,
    deleteAccount: accounts.deleteAccount,
    stripAccountSecrets: accounts.stripAccountSecrets,
    stripAccountsDataSecrets: accounts.stripAccountsDataSecrets,

    // System config
    getSystemConfig: globalConfig.getSystemConfig,
    setSystemConfig: globalConfig.setSystemConfig,
    getUserSystemConfigOverride: globalConfig.getUserSystemConfigOverride,
    setUserSystemConfigOverride: globalConfig.setUserSystemConfigOverride,
    clearUserSystemConfigOverride: globalConfig.clearUserSystemConfigOverride,

    // 公告
    getAnnouncement: globalConfig.getAnnouncement,
    setAnnouncement: globalConfig.setAnnouncement,
    getAnnouncementReadRecord: globalConfig.getAnnouncementReadRecord,
    markAnnouncementRead: globalConfig.markAnnouncementRead,
    shouldShowAnnouncement: globalConfig.shouldShowAnnouncement,
    getSuperAdminAnnouncement: globalConfig.getSuperAdminAnnouncement,
    getSuperAdminAnnouncementPassword: globalConfig.getSuperAdminAnnouncementPassword,
    setSuperAdminAnnouncement: globalConfig.setSuperAdminAnnouncement,
    verifySuperAdminAnnouncementPassword: globalConfig.verifySuperAdminAnnouncementPassword,

    // 防倒卖
    getAntiResaleConfig: globalConfig.getAntiResaleConfig,
    setAntiResaleConfig: globalConfig.setAntiResaleConfig,
    DEFAULT_ANTI_RESALE_CONFIG: globalConfig.DEFAULT_ANTI_RESALE_CONFIG,

    // Code/GID 抓取服务
    getCaptureConfig: globalConfig.getCaptureConfig,
    setCaptureConfig: globalConfig.setCaptureConfig,
    DEFAULT_CAPTURE_CONFIG: globalConfig.DEFAULT_CAPTURE_CONFIG,

    // 联系客服
    getSupportConfig: globalConfig.getSupportConfig,
    setSupportConfig: globalConfig.setSupportConfig,
    DEFAULT_SUPPORT_CONFIG: globalConfig.DEFAULT_SUPPORT_CONFIG,
};
