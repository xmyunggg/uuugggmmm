const assert = require('node:assert/strict');
const test = require('node:test');
const { handleActivityApiError } = require('../dist/controllers/admin/activity-center/error-handler');

function render(error) {
    let payload = null;
    handleActivityApiError({ json: value => { payload = value; return value; } }, error);
    return payload;
}

test('an unmapped business code keeps the real reason instead of a blanket message', () => {
    // 萌宠页面曾经就是这种情况：PET_DIARY_UNAVAILABLE + 具体原因，被兜底文案吞掉。
    const payload = render(Object.assign(new Error('服务端未返回萌宠养成状态'), { code: 'PET_DIARY_UNAVAILABLE' }));
    assert.deepEqual(payload, { ok: false, error: '服务端未返回萌宠养成状态', errorCode: 'PET_DIARY_UNAVAILABLE' });
});

test('known codes still use the curated wording', () => {
    const payload = render(new Error('gamepb.activitypb.ActivityService.Operate 错误: code=1034014 青梅种子已领取'));
    assert.equal(payload.error, '今日青梅种子已经领取，无需重复领取');
    assert.equal(payload.errorCode, '1034014');
});

test('activity-not-started codes surface the server reason, falling back to curated text', () => {
    const withReason = render(new Error('gamepb.activitypb.ActivityService.Operate 错误: code=1034001 活动未开始'));
    assert.deepEqual(withReason, { ok: false, error: '活动未开始', errorCode: '1034001' });
    const bare = render(Object.assign(new Error('operate failed'), { code: '1034002' }));
    assert.equal(bare.error, '活动尚未开放或已经结束');
    assert.equal(bare.errorCode, '1034002');
});

test('protocol noise without a readable reason stays generic', () => {
    const payload = render(new Error('Error: connect ECONNREFUSED 127.0.0.1:3000'));
    assert.equal(payload.error, '活动操作失败，请刷新页面后重试');
    assert.equal(payload.errorCode, 'ACTIVITY_OPERATION_FAILED');
    const gateway = render(new Error('gatepb.Error code=9999'));
    assert.equal(gateway.error, '活动操作失败，请刷新页面后重试');
    assert.equal(gateway.errorCode, '9999');
});
