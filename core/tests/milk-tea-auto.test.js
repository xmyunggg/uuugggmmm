const assert = require('node:assert/strict');
const test = require('node:test');

const {
    AUTOMATION_KEYS,
    DEFAULT_HIRE_DURATION,
    DEFAULT_MIN_RUN_INTERVAL_MS,
    HIRE_DURATIONS,
    HIRE_TALENTS,
    clampDuration,
    clampTalent,
    createMilkTeaAutomation,
} = require('../dist/services/milk-tea-auto');

const NOW = 1792032000; // 秒级服务器时间

function shopState(overrides = {}) {
    return {
        active: overrides.active === undefined ? true : overrides.active,
        settling: overrides.settling === undefined ? false : overrides.settling,
        serverTime: NOW,
        summary: { shop_open_at: NOW - 600, level: 1, can_upgrade: false, has_unclaimed_wage: false, ...(overrides.summary || {}) },
        shop: { level: 1, is_settling: false, sales_item_id: 1042, pending_rewards: [], slots: [], ...(overrides.shop || {}) },
        recipes: overrides.recipes || [],
        balances: overrides.balances || { 1042: 3 },
        levels: overrides.levels || [{ level: 1, employee_slot_count: 2 }],
    };
}

function shareState(overrides = {}) {
    return {
        active: true,
        share: { daily: { claimed: false }, milestones: [], ...(overrides.share || {}) },
    };
}

function fundState(overrides = {}) {
    return { active: true, fund: { unlocked: true, tiers: [], ...(overrides.fund || {}) } };
}

function workState(overrides = {}) {
    const now = overrides.serverTime === undefined ? NOW : overrides.serverTime;
    return {
        active: true,
        settling: false,
        serverTime: now,
        work: {
            interact_done: false,
            my_shift: { shift_id: '7', employer: { gid: '101' }, begin_at: now - 60, end_at: now + 3600, interact_count: 0, interact_limit: 1 },
            ...(overrides.work || {}),
        },
        interactions: overrides.interactions || [
            { interaction_id: 1, ready: true },
            { interaction_id: 2, ready: true },
            { interaction_id: 3, ready: true },
            { interaction_id: 4, ready: true },
            { interaction_id: 5, ready: true },
        ],
    };
}

function exchangeState(overrides = {}) {
    return {
        active: true,
        settling: false,
        goods: [],
        balances: {},
        ...overrides,
    };
}

function createHarness(spec = {}) {
    const calls = { getActivity: [], operate: [], logs: [], warns: [] };
    let clockMs = NOW * 1000;
    const enabled = new Set(spec.enabled || []);
    const pages = spec.pages || {};
    const operateError = spec.operateError || {};
    const skipped = spec.skipped || new Set();

    const automation = createMilkTeaAutomation({
        isEnabled: (key) => enabled.has(key),
        getHireDuration: () => (spec.hireDuration === undefined ? DEFAULT_HIRE_DURATION : spec.hireDuration),
        getHireTalent: () => (spec.hireTalent === undefined ? 0 : spec.hireTalent),
        getActivity: async (page, input) => {
            calls.getActivity.push(page);
            const resolver = pages[page];
            if (typeof resolver === 'function') return resolver(input);
            if (resolver !== undefined) return resolver;
            if (page === 'shop') return shopState();
            if (page === 'share') return shareState();
            if (page === 'fund') return fundState();
            if (page === 'work') return workState();
            if (page === 'exchange') return exchangeState();
            return null;
        },
        operate: async (action, input) => {
            calls.operate.push({ action, input });
            if (operateError[action]) throw operateError[action];
            if (skipped.has(action)) return { skipped: true, reason: 'skip' };
            return { ok: true };
        },
        log: (tag, message, extra) => calls.logs.push({ tag, message, extra }),
        logWarn: (tag, message, extra) => calls.warns.push({ tag, message, extra }),
        now: () => clockMs,
        minRunIntervalMs: spec.minRunIntervalMs,
    });

    return {
        automation,
        calls,
        advance(ms) { clockMs += ms; },
        actions() { return calls.operate.map((entry) => entry.action); },
    };
}

const ALL_KEYS = Object.values(AUTOMATION_KEYS);

test('all enabled: runs shop actions then share/fund in client order', async () => {
    const h = createHarness({
        enabled: ALL_KEYS,
        pages: {
            shop: shopState({
                summary: { can_upgrade: true, has_unclaimed_wage: true },
                shop: { pending_rewards: [{ id: 1041, count: 12 }], slots: [] },
                recipes: [{ recipe_id: 2, unlocked: true, is_advanced: true, fruitId: 40525 }],
                balances: { 1042: 3, 40525: 4 },
            }),
            share: shareState({ share: { daily: { claimed: false }, milestones: [{ id: 1, state: 2 }] } }),
            fund: fundState({ fund: { unlocked: true, tiers: [{ id: 1, state: 2 }] } }),
            exchange: exchangeState({
                goods: [{ id: '301', category: 'seed', available: true, remaining: 5, costs: [{ id: 1001, count: 10000 }] }],
                balances: { 1001: 100000 },
            }),
        },
    });

    const result = await h.automation();
    assert.deepEqual(h.actions(), ['claim', 'wages', 'upgrade', 'craft', 'boost', 'hire', 'interact', 'exchange', 'shareDaily', 'shareRewards', 'fundClaim']);
    assert.deepEqual(result.actions, ['cashier', 'wages', 'upgrade', 'craft', 'boost', 'hire', 'interact', 'seedBuy', 'shareDaily', 'shareRewards', 'fundRewards']);
    // 所有写操作都带 auto 标记，禁止绕过 service 的确认校验。
    assert.ok(h.calls.operate.every((entry) => entry.input.auto === true));
});

test('inactive activity short-circuits without writes', async () => {
    const h = createHarness({ enabled: ALL_KEYS, pages: { shop: shopState({ active: false }) } });
    const result = await h.automation();
    assert.equal(result.skipped, '活动未开放');
    assert.equal(h.calls.operate.length, 0);
});

test('settling only keeps claim-class actions', async () => {
    const h = createHarness({
        enabled: ALL_KEYS,
        pages: {
            shop: shopState({
                settling: true,
                summary: { can_upgrade: true, has_unclaimed_wage: true },
                shop: { pending_rewards: [{ id: 1041, count: 3 }] },
                recipes: [{ recipe_id: 2, unlocked: true, is_advanced: true, fruitId: 40525 }],
                balances: { 1042: 3, 40525: 4 },
            }),
            share: shareState({ share: { daily: { claimed: false }, milestones: [{ state: 2 }] } }),
            fund: fundState({ fund: { unlocked: true, tiers: [{ state: 2 }] } }),
        },
    });
    await h.automation();
    assert.deepEqual(h.actions(), ['claim', 'wages', 'shareDaily', 'shareRewards', 'fundClaim']);
});

test('closed shop still claims share/fund rewards but skips business actions', async () => {
    const h = createHarness({
        enabled: ALL_KEYS,
        pages: {
            shop: shopState({ summary: { shop_open_at: 0, can_upgrade: true, has_unclaimed_wage: true } }),
            share: shareState({ share: { daily: { claimed: false }, milestones: [{ state: 2 }] } }),
            fund: fundState({ fund: { unlocked: true, tiers: [{ state: 2 }] } }),
        },
    });
    await h.automation();
    assert.deepEqual(h.actions(), ['shareDaily', 'shareRewards', 'fundClaim']);
});

test('minimum interval throttles repeated runs unless forced', async () => {
    const h = createHarness({
        enabled: ['milk_tea_cashier'],
        pages: { shop: shopState({ shop: { pending_rewards: [{ id: 1041, count: 1 }] } }) },
    });
    await h.automation();
    assert.equal(h.calls.operate.length, 1);
    h.advance(1000);
    assert.equal(await h.automation(), null);
    assert.equal(h.calls.operate.length, 1);
    h.advance(DEFAULT_MIN_RUN_INTERVAL_MS);
    await h.automation();
    assert.equal(h.calls.operate.length, 2);
    // force 忽略最小间隔
    await h.automation({ force: true });
    assert.equal(h.calls.operate.length, 3);
});

test('skipped action is not counted and logs no success', async () => {
    const h = createHarness({
        enabled: ['milk_tea_hire'],
        pages: {
            shop: shopState({ shop: { slots: [] } }),
        },
        skipped: new Set(['hire']),
    });
    const result = await h.automation();
    assert.deepEqual(result.actions, []);
    assert.equal(h.calls.logs.length, 0);
    assert.equal(h.calls.operate.length, 1);
});

test('a failing action is logged and does not abort the rest', async () => {
    const failure = new Error('boom');
    const h = createHarness({
        enabled: ['milk_tea_cashier', 'milk_tea_share_daily'],
        pages: {
            shop: shopState({ shop: { pending_rewards: [{ id: 1041, count: 1 }] } }),
            share: shareState({ share: { daily: { claimed: false } } }),
        },
        operateError: { claim: failure },
    });
    const result = await h.automation();
    assert.deepEqual(result.actions, ['shareDaily']);
    assert.equal(h.calls.warns.length, 1);
    assert.match(h.calls.warns[0].message, /领取收益失败/);
});

test('inactive business error stays silent', async () => {
    const failure = new Error('MILK_TEA_UNAVAILABLE');
    failure.code = 'MILK_TEA_UNAVAILABLE';
    const h = createHarness({
        enabled: ['milk_tea_cashier'],
        pages: { shop: shopState({ shop: { pending_rewards: [{ id: 1041, count: 1 }] } }) },
        operateError: { claim: failure },
    });
    await h.automation();
    assert.equal(h.calls.warns.length, 0);
});

test('craft is skipped when no eligible advanced fruit is owned', async () => {
    const h = createHarness({
        enabled: ['milk_tea_craft'],
        pages: {
            shop: shopState({
                recipes: [{ recipe_id: 2, unlocked: true, is_advanced: true, fruitId: 40525 }],
                balances: {},
            }),
        },
    });
    await h.automation();
    assert.equal(h.calls.operate.length, 0);
});

test('hire picks the first free slot and forwards clamped duration/talent', async () => {
    const h = createHarness({
        enabled: ['milk_tea_hire'],
        hireDuration: 99,
        hireTalent: 1234,
        pages: {
            shop: shopState({
                shop: { level: 1, slots: [{ slot_index: 0, end_at: NOW + 1000 }] },
                levels: [{ level: 1, employee_slot_count: 2 }],
            }),
        },
    });
    await h.automation();
    assert.equal(h.calls.operate.length, 1);
    assert.equal(h.calls.operate[0].action, 'hire');
    assert.equal(h.calls.operate[0].input.slotIndex, 1);
    assert.equal(h.calls.operate[0].input.durationId, DEFAULT_HIRE_DURATION);
    assert.equal(h.calls.operate[0].input.talentId, 0);
});

test('interact runs only while a shift is open and never spends its own once consumed', async () => {
    const live = createHarness({ enabled: ['milk_tea_interact'], pages: { shop: shopState(), work: workState() } });
    await live.automation();
    assert.equal(live.calls.operate.length, 1);
    assert.equal(live.calls.operate[0].action, 'interact');
    assert.equal(live.calls.operate[0].input.auto, true);

    // 已互动 / 无班次 / 班次过期 / 次数用尽：都不应该发写请求。
    const variants = {
        done: workState({ work: { interact_done: true } }),
        noShift: workState({ work: { my_shift: null } }),
        expired: workState({ work: { my_shift: { shift_id: '7', employer: { gid: '101' }, begin_at: NOW - 7200, end_at: NOW - 60, interact_count: 0, interact_limit: 1 } } }),
        exhausted: workState({ work: { my_shift: { shift_id: '7', employer: { gid: '101' }, begin_at: NOW - 60, end_at: NOW + 3600, interact_count: 1, interact_limit: 1 } } }),
    };
    for (const [label, page] of Object.entries(variants)) {
        const h = createHarness({ enabled: ['milk_tea_interact'], pages: { shop: shopState(), work: page } });
        await h.automation();
        assert.equal(h.calls.operate.length, 0, `${label} 不应发起互动`);
    }
});

test('seed purchase skips paid or unaffordable goods and stays off during settlement', async () => {
    const h = createHarness({
        enabled: ['milk_tea_seed_buy'],
        pages: {
            shop: shopState(),
            exchange: exchangeState({
                goods: [
                    { id: '301', category: 'seed', available: true, remaining: 5, costs: [{ id: 1001, count: 999999 }] },
                    { id: '302', category: 'seed', available: true, remaining: 0, costs: [{ id: 1001, count: 1 }] },
                    { id: '303', category: 'seed', available: true, remaining: 5, costs: [{ id: 1001, count: 10 }] },
                ],
                balances: { 1001: 100 },
            }),
        },
    });
    await h.automation();
    assert.equal(h.calls.operate.length, 1);
    assert.equal(h.calls.operate[0].input.goodsId, '303');
    assert.equal(h.calls.operate[0].input.count, 1);

    const settling = createHarness({
        enabled: ['milk_tea_seed_buy'],
        pages: {
            shop: shopState({ settling: true }),
            exchange: exchangeState({
                settling: true,
                goods: [{ id: '303', category: 'seed', available: true, remaining: 5, costs: [{ id: 1001, count: 10 }] }],
                balances: { 1001: 100 },
            }),
        },
    });
    await settling.automation();
    assert.equal(settling.calls.operate.length, 0);
});

test('clamp helpers reject out-of-range values', () => {
    assert.equal(clampDuration('2'), 2);
    assert.equal(clampDuration('9'), DEFAULT_HIRE_DURATION);
    assert.equal(clampDuration(undefined), DEFAULT_HIRE_DURATION);
    assert.equal(clampTalent(9002), 9002);
    assert.equal(clampTalent('5'), 0);
    assert.deepEqual(HIRE_DURATIONS, [1, 2, 3]);
    assert.deepEqual(HIRE_TALENTS, [0, 9001, 9002, 9003, 9004]);
});
