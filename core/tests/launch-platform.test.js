const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizePlatform, resolveLaunchPlatform } = require('../dist/utils/launch-platform');

test('账号自带渠道优先于运行环境默认平台', () => {
    // 微信账号 + 默认 qq 运行环境：必须仍按 wx 连接，否则网关 400 missing openid parameter
    assert.equal(resolveLaunchPlatform('wx', 'qq'), 'wx');
    assert.equal(resolveLaunchPlatform('qq', 'wx'), 'qq');
    // 两边一致时不受影响
    assert.equal(resolveLaunchPlatform('qq', 'qq'), 'qq');
    assert.equal(resolveLaunchPlatform('wx', 'wx'), 'wx');
});

test('账号未声明渠道时回落到运行环境默认平台', () => {
    for (const empty of [undefined, null, '', '   ']) {
        assert.equal(resolveLaunchPlatform(empty, 'wx'), 'wx');
        assert.equal(resolveLaunchPlatform(empty, 'qq'), 'qq');
    }
    // 运行环境也没给 → 默认 qq
    assert.equal(resolveLaunchPlatform('', ''), 'qq');
    assert.equal(resolveLaunchPlatform(undefined, undefined), 'qq');
});

test('大小写与空白归一化', () => {
    assert.equal(resolveLaunchPlatform(' WX ', 'qq'), 'wx');
    assert.equal(resolveLaunchPlatform('', ' WX '), 'wx');
    assert.equal(normalizePlatform('QQ'), 'qq');
    assert.equal(normalizePlatform(null), '');
    assert.equal(normalizePlatform(undefined), '');
});
