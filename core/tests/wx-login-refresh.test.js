const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WxLoginService } = require('../dist/services/wx-login/service');

function stubFetch(responses) {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const next = responses.shift();
        assert.notEqual(next, undefined, `unexpected request: ${url}`);
        return {
            status: next.status || 200,
            headers: new Headers(next.headers || {}),
            arrayBuffer: async () => Buffer.from(next.body || ''),
        };
    };
    return {
        calls,
        restore: () => { global.fetch = originalFetch; },
    };
}

test('confirm 捕获 refreshtoken 并回传微信长期凭证', async () => {
    const fetchStub = stubFetch([
        { body: '{}' },
        { body: JSON.stringify({ code: 0, ext_info: { list_s: { login_buffer: { value: ['login-buffer'] } } } }) },
        { body: JSON.stringify({ code: 0, nick_name: '昵称' }) },
    ]);
    try {
        const session = {
            cookies: new Map([
                ['openid', 'openid-value'],
                ['accesstoken', 'access-token-value'],
                ['refreshtoken', 'refresh-token-value'],
            ]),
            uuid: 'uuid',
            oauthCode: 'oauth-code',
        };

        const credentials = await new WxLoginService().confirm(session);

        assert.deepEqual(credentials, {
            openid: 'openid-value',
            loginBuffer: 'login-buffer',
            accesstoken: 'access-token-value',
            refreshtoken: 'refresh-token-value',
        });
        assert.equal(session.refreshtoken, 'refresh-token-value');
        assert.equal(session.accesstoken, 'access-token-value');
    }
    finally {
        fetchStub.restore();
    }
});

test('refreshLoginBuffer 用 refreshtoken 续期后换发新 loginBuffer，并滚动返回新凭证', async () => {
    const fetchStub = stubFetch([
        {
            body: JSON.stringify({
                code: 0,
                user_info: { access_token: 'access-token-2', refresh_token: 'refresh-token-2' },
            }),
        },
        { body: JSON.stringify({ code: 0, ext_info: { list_s: { login_buffer: { value: ['login-buffer-2'] } } } }) },
    ]);
    try {
        const result = await new WxLoginService().refreshLoginBuffer({
            openid: 'openid-value',
            refreshtoken: 'refresh-token-value',
            accesstoken: 'access-token-value',
        });

        assert.deepEqual(result, {
            openid: 'openid-value',
            loginBuffer: 'login-buffer-2',
            refreshtoken: 'refresh-token-2',
            accesstoken: 'access-token-2',
        });
        assert.deepEqual(fetchStub.calls.map(call => new URL(call.url).pathname), [
            '/pc_yyb_auth/pcyyb_refresh_token_auth',
            '/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth',
        ]);

        // 续期请求必须是 camelCase 字段，否则服务端解析不到 refreshtoken（code=-109）
        const refreshPayload = JSON.parse(fetchStub.calls[0].init.body);
        assert.deepEqual(refreshPayload, {
            userInfo: {
                openId: 'openid-value',
                refreshToken: 'refresh-token-value',
                accessToken: 'access-token-value',
                loginType: 'WX',
            },
        });
        const refreshHeaders = fetchStub.calls[0].init.headers;
        const timestamp = refreshHeaders.get('Ual-Access-Timestamp');
        const nonce = refreshHeaders.get('Ual-Access-Nonce');
        const signature = crypto.createHash('md5')
            .update(`${fetchStub.calls[0].init.body}${timestamp}wgrdg373hy26ww2${nonce}`)
            .digest('hex');
        assert.equal(refreshHeaders.get('Ual-Access-Signature'), signature);

        // 换 loginBuffer 时用新凭证做 Cookie
        const loginBufferCookie = fetchStub.calls[1].init.headers.get('Cookie');
        assert.match(String(loginBufferCookie), /openid=openid-value/);
        assert.match(String(loginBufferCookie), /accesstoken=access-token-2/);
        assert.match(String(loginBufferCookie), /refreshtoken=refresh-token-2/);
    }
    finally {
        fetchStub.restore();
    }
});

test('续期成功但换 loginBuffer 失败时，错误对象仍携带滚动后的新凭证', async () => {
    const fetchStub = stubFetch([
        {
            body: JSON.stringify({
                code: 0,
                user_info: { access_token: 'access-token-2', refresh_token: 'refresh-token-2' },
            }),
        },
        { body: JSON.stringify({ code: -1, msg: 'ManualAuth rejected' }) },
    ]);
    try {
        await assert.rejects(
            () => new WxLoginService().refreshLoginBuffer({
                openid: 'openid-value',
                refreshtoken: 'refresh-token-value',
                accesstoken: 'access-token-value',
            }),
            (error) => {
                assert.match(error.message, /login buffer refresh failed/);
                assert.equal(error.refreshtoken, 'refresh-token-2');
                assert.equal(error.accesstoken, 'access-token-2');
                return true;
            },
        );
    }
    finally {
        fetchStub.restore();
    }
});

test('缺少 refreshtoken 时续期直接报错，提示重新扫码', async () => {
    await assert.rejects(
        () => new WxLoginService().refreshLoginBuffer({ openid: 'openid-value' }),
        /缺少刷新凭证/,
    );
});
