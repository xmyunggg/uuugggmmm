const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    assertChannelTokenShape,
    buildDingTalkWebhook,
    createDingTalkSign,
    normalizePushResult,
    parseWxPusherTarget,
    sendPushooMessage,
} = require('../dist/services/push');

test('buildDingTalkWebhook converts a legacy access token to an official webhook', () => {
    const url = new URL(buildDingTalkWebhook('', 'legacy-token'));

    assert.equal(url.origin, 'https://oapi.dingtalk.com');
    assert.equal(url.pathname, '/robot/send');
    assert.equal(url.searchParams.get('access_token'), 'legacy-token');
});

test('buildDingTalkWebhook keeps a complete webhook address', () => {
    const endpoint = 'https://oapi.dingtalk.com/robot/send?access_token=complete-token';

    assert.equal(buildDingTalkWebhook(endpoint, ''), endpoint);
});

test('buildDingTalkWebhook appends the documented timestamp and signature', () => {
    const endpoint = 'https://oapi.dingtalk.com/robot/send?access_token=signed-token';
    const secret = 'SEC-test-secret';
    const timestamp = 1_700_000_000_000;
    const expectedSign = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`, 'utf8')
        .digest('base64');
    const url = new URL(buildDingTalkWebhook(endpoint, '', secret, timestamp));

    assert.equal(createDingTalkSign(secret, timestamp), expectedSign);
    assert.equal(url.searchParams.get('timestamp'), String(timestamp));
    assert.equal(url.searchParams.get('sign'), expectedSign);
});

test('buildDingTalkWebhook rejects non-DingTalk endpoints', () => {
    assert.throws(
        () => buildDingTalkWebhook('https://example.com/robot/send?access_token=test', ''),
        /钉钉 Webhook 地址格式无效/,
    );
});

test('parseWxPusherTarget splits uids and topic ids from the receiver field', () => {
    const target = parseWxPusherTarget('AT_app_token', 'UID_aaa, UID_bbb 123 456');

    assert.equal(target.appToken, 'AT_app_token');
    assert.deepEqual(target.uids, ['UID_aaa', 'UID_bbb']);
    assert.deepEqual(target.topicIds, [123, 456]);
});

test('parseWxPusherTarget still accepts the pushoo appToken#topicIds form', () => {
    const target = parseWxPusherTarget('AT_app_token#123,456', '');

    assert.equal(target.appToken, 'AT_app_token');
    assert.deepEqual(target.uids, []);
    assert.deepEqual(target.topicIds, [123, 456]);
});

test('parseWxPusherTarget prefers the receiver field over the token suffix', () => {
    const target = parseWxPusherTarget('AT_app_token#123', 'UID_aaa');

    assert.deepEqual(target.uids, ['UID_aaa']);
    assert.deepEqual(target.topicIds, []);
});

test('parseWxPusherTarget rejects a receiver UID pasted into the token field', () => {
    assert.throws(
        () => parseWxPusherTarget('UID_Mubcc10NI1crJ8Y7XjXsAlnQ0wwO', ''),
        /Token 应填应用 Token/,
    );
});

test('parseWxPusherTarget requires at least one receiver', () => {
    assert.throws(() => parseWxPusherTarget('AT_app_token', ''), /未设置接收者/);
});

test('parseWxPusherTarget rejects unknown receiver formats', () => {
    assert.throws(() => parseWxPusherTarget('AT_app_token', 'someone@example.com'), /接收者格式无效/);
});

/** 替换 axios.post，捕获 WxPusher 请求体并返回指定响应 */
async function withStubbedAxiosPost(responseBody, run) {
    const axios = require('axios').default;
    const originalPost = axios.post;
    const calls = [];
    axios.post = async (url, body) => {
        calls.push({ url, body });
        return { data: responseBody };
    };
    try {
        const result = await run();
        return { result, calls };
    } finally {
        axios.post = originalPost;
    }
}

test('sendPushooMessage posts a well-formed WxPusher request for uid push', async () => {
    const { result, calls } = await withStubbedAxiosPost(
        { code: 1000, msg: '处理成功', data: [{ uid: 'UID_aaa' }], success: true },
        () => sendPushooMessage({
            channel: 'wxpusher',
            token: 'AT_app_token',
            endpoint: 'UID_aaa',
            title: '账号下线提醒',
            content: '账号下线',
        }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://wxpusher.zjiecode.com/api/send/message');
    assert.deepEqual(calls[0].body, {
        appToken: 'AT_app_token',
        content: '账号下线',
        summary: '账号下线提醒',
        contentType: 1,
        uids: ['UID_aaa'],
        topicIds: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.msg, '处理成功');
});

test('sendPushooMessage reports WxPusher failures from the response body', async () => {
    const { result } = await withStubbedAxiosPost(
        { code: 1001, msg: 'appToken不正确', data: null, success: false },
        () => sendPushooMessage({
            channel: 'wxpusher',
            token: 'AT_bad_token',
            endpoint: 'UID_aaa',
            title: '账号下线提醒',
            content: '账号下线',
        }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, '1001');
    assert.equal(result.msg, 'appToken不正确');
});

test('normalizePushResult accepts each channel documented success shape', () => {
    const cases = [
        ['pushplus/bark 用 HTTP 语义的 code 200', { code: 200, msg: '请求成功', data: 'ok' }],
        ['企业微信/钉钉用 errcode 0', { errcode: 0, errmsg: 'ok' }],
        ['飞书 v1 用 StatusCode 0', { StatusCode: 0, StatusMessage: 'success', data: {} }],
        ['飞书 v2 用 code 0', { code: 0, msg: 'success' }],
        ['OneBot 用 retcode 0', { status: 'ok', retcode: 0, data: { message_id: 1 } }],
        ['igot 用 success true', { success: true, data: {} }],
        ['WxPusher 用 code 1000 + success', { code: 1000, msg: '处理成功', success: true }],
        ['discord/ifttt 返回纯文本', 'Delivered successfully, code 200.'],
        ['discord 204 返回空字符串', ''],
    ];

    for (const [label, payload] of cases) {
        assert.equal(normalizePushResult(payload).ok, true, `${label} 应判成功`);
    }
});

test('normalizePushResult detects each channel documented failure shape', () => {
    const cases = [
        ['pushoo 内部异常', { error: new Error('topicIds is required') }, /topicIds is required/],
        ['pushplus 业务错误码', { code: 903, msg: 'token 错误' }, /token 错误/],
        ['igot 失败', { success: false, message: '推送失败' }, /推送失败/],
        ['gocqhttp 失败', { status: 'failed', retcode: 1, msg: 'QQ 未登录' }, /QQ 未登录/],
        ['OneBot 失败', { status: 'failed', retcode: 1400, message: '群号不存在' }, /群号不存在/],
        ['企业微信 errcode 非 0', { errcode: 40013, errmsg: 'invalid corpid' }, /invalid corpid/],
        ['飞书 v1 非 0 状态', { StatusCode: 9499, StatusMessage: 'Bad Request' }, /Bad Request/],
        ['MeoW 错误结构', { status: 500, error: { message: 'MeoW 推送失败' } }, /MeoW 推送失败/],
    ];

    for (const [label, payload, expected] of cases) {
        const result = normalizePushResult(payload);
        assert.equal(result.ok, false, `${label} 应判失败`);
        assert.match(result.msg, expected, `${label} 应带上错误信息`);
    }
});

test('normalizePushResult treats an empty response body as failure', () => {
    // 企业微信 corpid/corpsecret 错误时，pushoo 会吞掉异常直接返回 {}
    const result = normalizePushResult({});

    assert.equal(result.ok, false);
    assert.match(result.msg, /未返回结果/);
});

test('assertChannelTokenShape enforces composite tokens', () => {
    assert.throws(() => assertChannelTokenShape('telegram', '123456:AAxxxx'), /botToken#chatId/);
    assert.throws(() => assertChannelTokenShape('telegram', '123456:AAxxxx#'), /botToken#chatId/);
    assert.throws(() => assertChannelTokenShape('wecom', 'corpid#corpsecret'), /corpid#corpsecret#agentid/);
    assert.throws(() => assertChannelTokenShape('ifttt', 'webhook-key'), /key#eventName/);

    assert.doesNotThrow(() => assertChannelTokenShape('telegram', '123456:AAxxxx#123456789'));
    assert.doesNotThrow(() => assertChannelTokenShape('wecom', 'corpid#corpsecret#1000002#@all'));
    assert.doesNotThrow(() => assertChannelTokenShape('ifttt', 'webhook-key#farm_offline'));
    // 单段 Token 的渠道不做结构校验
    assert.doesNotThrow(() => assertChannelTokenShape('pushplus', 'anything'));
});
