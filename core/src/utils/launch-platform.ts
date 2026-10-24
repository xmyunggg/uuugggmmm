/**
 * 连接 platform 的取值规则。
 *
 * 账号的 platform（accounts.json）是事实：QQ 与微信的登录 code 只会属于一个渠道，
 * 用错渠道连网关会被拒（表现为 400 missing openid parameter）。
 * 「运行环境 → 平台」只是全站默认值，仅当账号未声明渠道时兜底，
 * 不能让默认值反过来覆盖账号自己的渠道。
 */

export function normalizePlatform(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

/**
 * @param accountPlatform 账号自带渠道（优先）
 * @param systemPlatform 运行环境默认平台（兜底）
 */
export function resolveLaunchPlatform(accountPlatform: unknown, systemPlatform: unknown): string {
    const own = normalizePlatform(accountPlatform);
    if (own) return own;
    return normalizePlatform(systemPlatform) || 'qq';
}
