export {};
/**
 * 推送接口封装（基于 pushoo）
 */

const crypto = require('node:crypto');
const axios = require('axios').default;
const pushoo = require('pushoo').default;

const DINGTALK_WEBHOOK_PREFIX = 'https://oapi.dingtalk.com/robot/send?access_token=';
const MEOW_DEFAULT_BASE_URL = 'https://api.chuckfang.com';
const WXPUSHER_SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message';
/** WxPusher contentType：1 纯文本，2 HTML，3 Markdown */
const WXPUSHER_CONTENT_TYPE_TEXT = 1;

function assertRequiredText(name: string, value: any): string {
    const text: string = String(value || '').trim();
    if (!text) {
        throw new Error(`${name} 不能为空`);
    }
    return text;
}

function createDingTalkSign(secretInput: any, timestampInput: any): string {
    const secret = assertRequiredText('钉钉加签密钥', secretInput);
    const timestamp = Math.trunc(Number(timestampInput));
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('钉钉加签时间戳无效');
    }
    return crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`, 'utf8')
        .digest('base64');
}

function buildDingTalkWebhook(endpointInput: any, tokenInput: any, secretInput: any = '', timestampInput: any = Date.now()): string {
    const endpoint = String(endpointInput || '').trim();
    const token = String(tokenInput || '').trim();
    const credential = assertRequiredText('钉钉 Webhook 地址', endpoint || token);
    const rawUrl = /^https?:\/\//i.test(credential)
        ? credential
        : `${DINGTALK_WEBHOOK_PREFIX}${encodeURIComponent(credential)}`;

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('钉钉 Webhook 地址格式无效');
    }
    const isOfficialWebhook = url.protocol === 'https:'
        && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
        && url.pathname === '/robot/send'
        && !!url.searchParams.get('access_token');
    if (!isOfficialWebhook) {
        throw new Error('钉钉 Webhook 地址格式无效');
    }

    const secret = String(secretInput || '').trim();
    if (secret) {
        const timestamp = Math.trunc(Number(timestampInput));
        const sign = createDingTalkSign(secret, timestamp);
        url.searchParams.set('timestamp', String(timestamp));
        url.searchParams.set('sign', sign);
    }
    return url.toString();
}

async function sendDingTalkMessage(payload: any): Promise<any> {
    const url = buildDingTalkWebhook(payload.endpoint, payload.token, payload.secret);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const response = await axios.post(url, {
        msgtype: 'text',
        text: {
            content: `${title}\n${content}`,
        },
    });
    return response.data;
}

/**
 * 发送 MeoW 推送（鸿蒙 MeoW 消息推送 API）
 * @param payload
 * @param payload.token 必填 用户昵称（作为路径参数）
 * @param payload.endpoint 可选 自定义接口地址（默认 https://api.chuckfang.com）
 * @param payload.title 必填 推送标题
 * @param payload.content 必填 推送内容
 * @returns MeoW 推送结果
 */
async function sendMeowMessage(payload: any): Promise<any> {
    const nickname = assertRequiredText('MeoW 昵称', payload.token);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const baseUrl = String(payload.endpoint || MEOW_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('MeoW 接口地址格式无效');
    }
    const url = `${baseUrl}/${encodeURIComponent(nickname)}`;
    const response = await axios.post(url, {
        title,
        msg: content,
    });
    const data: any = (response && response.data && typeof response.data === 'object') ? response.data : {};
    const status: number = Number(data.status);
    if (Number.isFinite(status) && status !== 200) {
        // MeoW 业务状态码非 200 视为失败，转为 error 结构便于统一结果判断
        return {
            status,
            error: {
                message: String(data.msg || data.message || 'MeoW 推送失败'),
            },
        };
    }
    return data;
}

/**
 * 解析 WxPusher 的「应用 Token + 接收者」配置
 * @param tokenInput 应用 Token（AT_ 开头）；兼容 pushoo 旧写法 `appToken#topicIds`
 * @param receiverInput 接收者，支持 UID_xxx（单发）和数字 TopicID（群发），可用逗号、空格或分号分隔多个
 * @returns 拆分后的 appToken、uids、topicIds
 */
function parseWxPusherTarget(tokenInput: any, receiverInput: any): { appToken: string; uids: string[]; topicIds: number[] } {
    const rawToken = assertRequiredText('WxPusher 应用 Token', tokenInput);
    const [appTokenPart, topicPartFromToken = ''] = rawToken.split('#');
    const appToken = assertRequiredText('WxPusher 应用 Token', appTokenPart);
    if (/^UID_/i.test(appToken)) {
        throw new Error('WxPusher 的 Token 应填应用 Token（AT_ 开头），UID_ 开头的接收者请填到「接收者」');
    }

    const receiverText = String(receiverInput || '').trim() || topicPartFromToken.trim();
    const uids: string[] = [];
    const topicIds: number[] = [];
    for (const piece of receiverText.split(/[\s,，;；]+/)) {
        const value = piece.trim();
        if (!value) continue;
        if (/^UID_/i.test(value)) {
            if (!uids.includes(value)) uids.push(value);
            continue;
        }
        if (/^\d+$/.test(value)) {
            const topicId = Number(value);
            if (!topicIds.includes(topicId)) topicIds.push(topicId);
            continue;
        }
        throw new Error(`WxPusher 接收者格式无效: ${value}（应为 UID_xxx 或数字 TopicID）`);
    }

    if (uids.length === 0 && topicIds.length === 0) {
        throw new Error('WxPusher 渠道未设置接收者（UID 或 TopicID）');
    }
    return { appToken, uids, topicIds };
}

/**
 * 发送 WxPusher 推送（标准推送 API：UID 单发或 TopicID 群发）
 * @param payload
 * @param payload.token 必填 WxPusher 应用 Token（AT_ 开头）
 * @param payload.endpoint 必填 接收者，UID_xxx 或数字 TopicID，可用逗号分隔多个
 * @param payload.title 必填 推送标题（作为消息摘要）
 * @param payload.content 必填 推送内容
 * @returns WxPusher 接口返回
 */
async function sendWxPusherMessage(payload: any): Promise<any> {
    const { appToken, uids, topicIds } = parseWxPusherTarget(payload.token, payload.endpoint);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const response = await axios.post(WXPUSHER_SEND_URL, {
        appToken,
        content,
        summary: title,
        contentType: WXPUSHER_CONTENT_TYPE_TEXT,
        uids,
        topicIds,
    });
    return response.data;
}

/**
 * 归一化各推送渠道的返回结构，判定是否成功。
 *
 * pushoo 各渠道返回形态差异很大：pushplus/bark 用 HTTP 语义的 code 200，
 * 企业微信/钉钉用 errcode 0，OneBot 用 retcode 0，飞书 v1 用 StatusCode 0，
 * igot/gocqhttp 用 success/status，discord/ifttt 直接返回纯文本。
 * 只认 code === 'ok' | '0' 会把 pushplus/bark 的成功判成失败，也会把
 * igot/gocqhttp/企业微信 的失败判成成功。
 * @param result 渠道原始返回
 * @returns 统一结果：ok、code、msg、raw
 */
function normalizePushResult(result: any): { ok: boolean; code: string; msg: string; raw: any } {
    const source: any = (result && typeof result === 'object') ? result : { data: result };
    // pushoo 内部异常返回的是 Error 实例，只保留 message，
    // 避免把 axios 的 config/stack（含服务端路径）透给面板和日志
    const raw: any = source.error && typeof source.error === 'object'
        ? { ...source, error: { message: String(source.error.message || source.error) } }
        : source;
    const status: string = String(raw.status ?? '').trim().toLowerCase();
    const numericCode: any = [raw.code, raw.errcode, raw.StatusCode, raw.retcode]
        .find((value: any) => value !== undefined && value !== null && value !== '');
    const code: string = raw.error ? 'error' : String(numericCode ?? (status || 'ok'));
    const isEmptyObject: boolean = Object.keys(raw).length === 0;
    const isHttpSuccessCode: boolean = code === '0' || /^2\d\d$/.test(code);

    const explicitFailure: boolean = !!raw.error
        || raw.success === false
        || raw.ok === false
        || status === 'failed' || status === 'fail' || status === 'error'
        || (raw.retcode !== undefined && raw.retcode !== null && Number(raw.retcode) !== 0)
        || (raw.StatusCode !== undefined && raw.StatusCode !== null && Number(raw.StatusCode) !== 0)
        || (raw.errcode !== undefined && raw.errcode !== null && Number(raw.errcode) !== 0);

    const explicitSuccess: boolean = raw.success === true
        || raw.ok === true
        || status === 'ok' || status === 'success'
        || raw.retcode === 0
        || raw.StatusCode === 0
        || raw.errcode === 0;

    // 明确的布尔/状态标记优先；只有没有任何标记时才按数值业务码判断（WxPusher 的 1000 + success:true 仍算成功）
    const failed: boolean = explicitFailure
        || (!explicitSuccess && numericCode !== undefined && /^\d+$/.test(code) && !isHttpSuccessCode);

    const succeeded: boolean = explicitSuccess
        || (!explicitFailure && numericCode !== undefined && (isHttpSuccessCode || code === 'ok'));

    // 既无失败标记也无成功标记：非空返回体（discord/ifttt 的纯文本等）在 HTTP 层已确认成功；
    // 空对象说明上游没返回结果（企业微信 corpid/corpsecret 错误时 pushoo 吞掉异常返回 {}）
    const ok: boolean = failed ? false : (succeeded || !isEmptyObject);

    const message: string = String(
        raw.msg || raw.errmsg || raw.message || raw.error?.message || raw.StatusMessage || raw.status
        || (isEmptyObject ? '推送接口未返回结果（请检查 Token 是否正确）' : (ok ? 'ok' : 'push failed')),
    );

    return { ok, code, msg: message, raw };
}

/**
 * 需要复合 Token（多段用 # 连接）的渠道；这里提前校验并给出可读错误，
 * 否则 pushoo 只会抛出 `chatId is required` 这类难以理解的提示。
 */
const COMPOSITE_TOKEN_RULES: Record<string, { parts: number; hint: string }> = {
    telegram: { parts: 2, hint: 'Telegram 需要 botToken#chatId（例如 123456:AAxxxx#123456789）' },
    wecom: { parts: 3, hint: '企业微信需要 corpid#corpsecret#agentid（可选第四段填接收成员，默认 @all）' },
    ifttt: { parts: 2, hint: 'IFTTT 需要 key#eventName（Webhook key 与事件名用 # 连接）' },
};

function assertChannelTokenShape(channel: string, token: string): void {
    const rule = COMPOSITE_TOKEN_RULES[channel];
    if (!rule) return;
    const parts = String(token || '').split('#').map(part => part.trim());
    if (parts.length < rule.parts || parts.slice(0, rule.parts).some(part => !part)) {
        throw new Error(rule.hint);
    }
}

/**
 * 发送推送
 * @param payload
 * @param payload.channel 必填 推送渠道（pushoo 平台名，如 webhook）
 * @param payload.endpoint Webhook 接口地址（webhook、dingtalk 渠道使用）；WxPusher 渠道填接收者（UID_xxx / TopicID）
 * @param payload.token 除 webhook、dingtalk 外的渠道必填；兼容旧版钉钉 access token
 * @param payload.secret 钉钉机器人加签密钥（可选）
 * @param payload.title 必填 推送标题
 * @param payload.content 必填 推送内容
 * @returns 推送结果
 */
async function sendPushooMessage(payload: any = {}): Promise<{ ok: boolean; code: string; msg: string; raw: any }> {
    const channel: string = assertRequiredText('channel', payload.channel).toLowerCase();
    const endpoint: string = String(payload.endpoint || '').trim();
    const rawToken: string = String(payload.token || '').trim();
    const secret: string = String(payload.secret || '').trim();
    const token: string = channel === 'webhook' || channel === 'dingtalk'
        ? rawToken
        : assertRequiredText('token', rawToken);
    const title: string = assertRequiredText('title', payload.title);
    const content: string = assertRequiredText('content', payload.content);
    if (token) assertChannelTokenShape(channel, token);

    const options: any = {};
    if (channel === 'webhook') {
        const url: string = assertRequiredText('endpoint', endpoint);
        options.webhook = { url, method: 'POST' };
    }

    const request: any = { title, content };
    if (token) request.token = token;
    if (channel === 'webhook') request.options = options;

    const result: any = channel === 'dingtalk'
        ? await sendDingTalkMessage({ endpoint, token, secret, title, content })
        : channel === 'meow'
            ? await sendMeowMessage({ endpoint, token, title, content })
            : channel === 'wxpusher'
                ? await sendWxPusherMessage({ endpoint, token, title, content })
                : await pushoo(channel, request);

    return normalizePushResult(result);
}

module.exports = {
    buildDingTalkWebhook,
    createDingTalkSign,
    sendMeowMessage,
    parseWxPusherTarget,
    sendWxPusherMessage,
    normalizePushResult,
    assertChannelTokenShape,
    sendPushooMessage,
};
