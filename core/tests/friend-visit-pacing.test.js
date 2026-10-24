const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_MAX_VISITS_PER_RUN,
    DEFAULT_COOLDOWN_MS,
    selectFriendVisitBatch,
    resetFriendVisitPacing,
} = require('../dist/services/friend/visit-pacing');

const NOW = 1780000000000;

function targets(count, from = 1) {
    const list = [];
    for (let gid = from; gid < from + count; gid += 1) list.push({ gid, name: `f${gid}` });
    return list;
}

function gids(list) {
    return list.map(item => item.gid);
}

test.beforeEach(() => {
    resetFriendVisitPacing();
});

test('空列表和没有 gid 的候选直接返回空', () => {
    assert.deepEqual(selectFriendVisitBatch([], { now: NOW }), []);
    assert.deepEqual(selectFriendVisitBatch(null, { now: NOW }), []);
    assert.deepEqual(selectFriendVisitBatch([{ name: 'no-gid' }, { gid: 0 }], { now: NOW }), []);
});

test('一轮最多访问默认数量，maxVisits 超过上限时回落到 30', () => {
    assert.equal(selectFriendVisitBatch(targets(50), { now: NOW }).length, DEFAULT_MAX_VISITS_PER_RUN);
    resetFriendVisitPacing();
    assert.equal(selectFriendVisitBatch(targets(50), { now: NOW, maxVisits: 3 }).length, 3);
    resetFriendVisitPacing();
    assert.equal(selectFriendVisitBatch(targets(50), { now: NOW, maxVisits: 999 }).length, 30);
});

test('轮转：第一批之后轮到剩下的好友，冷却中的不重复访问', () => {
    const list = targets(20);
    const first = selectFriendVisitBatch(list, { now: NOW });
    assert.deepEqual(gids(first), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // 第二批：前 12 位都在冷却里，只剩后面 8 位可访问（不补满）
    const second = selectFriendVisitBatch(list, { now: NOW });
    assert.deepEqual(gids(second), [13, 14, 15, 16, 17, 18, 19, 20]);
    // 全都访问过之后不空转：按轮转顺序照常挑一批
    const third = selectFriendVisitBatch(list, { now: NOW });
    assert.equal(third.length, DEFAULT_MAX_VISITS_PER_RUN);
});

test('冷却过期后好友重新进入候选', () => {
    const list = targets(3);
    assert.deepEqual(gids(selectFriendVisitBatch(list, { now: NOW })), [1, 2, 3]);
    assert.deepEqual(gids(selectFriendVisitBatch(list, { now: NOW })), [1, 2, 3], '冷却内仍然全都被挑（人少不空转）');
    // 冷却过期后重新从头轮转，顺序不乱
    const later = NOW + DEFAULT_COOLDOWN_MS;
    assert.deepEqual(gids(selectFriendVisitBatch(list, { now: later })), [1, 2, 3]);
});

test('点名好友跳过冷却排在最前面，且不重复占位', () => {
    const list = targets(20);
    selectFriendVisitBatch(list, { now: NOW });
    // 第二批本来只会挑 13-20，点名的 5 和 9 要插到最前面
    const batch = selectFriendVisitBatch(list, { now: NOW, priorityGids: [5, 9], maxVisits: 4 });
    assert.deepEqual(gids(batch), [5, 9, 13, 14]);
    resetFriendVisitPacing();
    const fresh = selectFriendVisitBatch(list, { now: NOW, priorityGids: new Set([20, 3]), maxVisits: 3 });
    assert.deepEqual(gids(fresh), [3, 20, 1]);
});

test('不同账号与用途各自独立记冷却', () => {
    const list = targets(3);
    selectFriendVisitBatch(list, { now: NOW, accountId: 'a', mode: 'friend' });
    // 另一个账号没有被访问过，照常从第一位开始
    assert.deepEqual(gids(selectFriendVisitBatch(list, { now: NOW, accountId: 'b', mode: 'friend' })), [1, 2, 3]);
    // 同一账号另一个用途也互不影响
    assert.deepEqual(gids(selectFriendVisitBatch(list, { now: NOW, accountId: 'a', mode: 'steal' })), [1, 2, 3]);
});

test('冷却显式设为 0 表示不节流：好友全都可访问，只是按轮转顺序挑一批', () => {
    const list = targets(20);
    const first = selectFriendVisitBatch(list, { now: NOW, cooldownMs: 0 });
    assert.deepEqual(gids(first), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const second = selectFriendVisitBatch(list, { now: NOW, cooldownMs: 0 });
    assert.deepEqual(gids(second), [13, 14, 15, 16, 17, 18, 19, 20, 1, 2, 3, 4]);
});

test('resetFriendVisitPacing 清空冷却与轮转位置', () => {
    const list = targets(20);
    selectFriendVisitBatch(list, { now: NOW });
    resetFriendVisitPacing();
    assert.deepEqual(gids(selectFriendVisitBatch(list, { now: NOW })), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
