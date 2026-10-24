export {};

interface ReloginReminderOptions {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
}

interface OfflineReminderPayload {
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
}

function createReloginReminderService(options: ReloginReminderOptions) {
    const { store, sendPushooMessage, log } = options;

    /** 取某个账号生效的下线提醒：账号归属用户的用户级设置优先，其次后台全局默认 */
    function resolveReminderConfig(accountId?: string): any {
        const id = String(accountId || '').trim();
        if (id && typeof store.getOfflineReminderForAccount === 'function') {
            const perAccount = store.getOfflineReminderForAccount(id);
            if (perAccount) return perAccount;
        }
        return store.getOfflineReminder ? store.getOfflineReminder() : null;
    }

    function getOfflineAutoDeleteMs(accountId?: string): number {
        const cfg = resolveReminderConfig(accountId);
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }

    function resolvePushChannel(accountId?: string): { ok: true; channel: string; endpoint: string; token: string; secret: string } | { ok: false; reason: string } {
        const cfg = resolveReminderConfig(accountId);
        if (!cfg) return { ok: false, reason: '未找到下线提醒配置' };

        const channel = String(cfg.channel || '').trim().toLowerCase();
        const endpoint = String(cfg.endpoint || '').trim();
        const token = String(cfg.token || '').trim();
        const secret = String(cfg.secret || '').trim();
        if (!channel) return { ok: false, reason: '下线提醒配置不完整' };
        if (channel === 'webhook' && !endpoint) return { ok: false, reason: 'Webhook 渠道未设置接口地址' };
        if (channel === 'dingtalk' && !endpoint && !token) return { ok: false, reason: '钉钉渠道未设置 Webhook 地址' };
        // WxPusher 需要应用 Token，接收者取「接收者」字段；兼容 pushoo 的 appToken#topicIds 旧写法
        if (channel === 'wxpusher' && token && !endpoint && !token.includes('#')) {
            return { ok: false, reason: 'WxPusher 渠道未设置接收者（UID 或 TopicID）' };
        }
        if (channel !== 'webhook' && channel !== 'dingtalk' && !token) return { ok: false, reason: '下线提醒渠道未设置 Token' };
        return { ok: true, channel, endpoint, token, secret };
    }

    async function sendConfiguredPush(payload: { title?: string; content?: string; accountId?: string; accountName?: string; logLabel?: string } = {}): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const baseTitle = String(payload.title || '').trim();
        const content = String(payload.content || '').trim();
        const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            const channelCfg = resolvePushChannel(accountId);
            if (channelCfg.ok === false) {
                log('错误', channelCfg.reason);
                return;
            }
            if (!title || !content) {
                log('错误', '推送标题或内容为空');
                return;
            }
            const result = await sendPushooMessage({
                channel: channelCfg.channel,
                endpoint: channelCfg.endpoint,
                token: channelCfg.token,
                secret: channelCfg.secret,
                title,
                content,
            });
            if (result?.ok) {
                log('系统', `${logLabel}发送成功: ${accountName || accountId || title}`);
            } else {
                log('错误', `${logLabel}发送失败: ${result?.msg || 'unknown'}`);
            }
        } catch (e: any) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');
            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });

            const cfg = resolveReminderConfig(accountId);
            if (!cfg) {
                log('错误', '未找到下线提醒配置');
                return;
            }

            const baseTitle = String(cfg.title || '').trim();
            const content = String(cfg.msg || '').trim();
            if (!baseTitle || !content) {
                log('错误', '下线提醒配置不完整');
                return;
            }

            await sendConfiguredPush({ title: baseTitle, content, accountId, accountName, logLabel: '下线提醒' });
        } catch (e: any) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush };
}

module.exports = { createReloginReminderService };
