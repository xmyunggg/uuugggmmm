import config from '../activity-data/milk-tea-20261015.json';
import { normalizeMilkTeaWork } from './milk-tea-work';

export {};

const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const { getServerTimeSec, toNum } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const warehouse = require('./warehouse');
const { getDiamondBalance } = require('./pay');
const { util } = require('protobufjs');
const GROUP = '2026110100';
const MILK = '2026110101';
const SHOP = '2026110102';
const FUND = '2026110103';
const SHARE = '2026110104';
const SERVICE = 'gamepb.activitypb.ActivityService';
const operations: Record<string, [number, string, string]> = {
    create: [53, 'milk_tea_create_shop', MILK], rename: [54, 'milk_tea_rename_shop', MILK],
    shop: [55, 'milk_tea_get_shop', MILK], hireList: [56, 'milk_tea_get_hire_list', MILK],
    hire: [57, 'milk_tea_hire', MILK], workshop: [58, 'milk_tea_get_workshop', MILK],
    claim: [59, 'milk_tea_claim_cashier', MILK], boost: [60, 'milk_tea_boost', MILK],
    upgrade: [61, 'milk_tea_upgrade', MILK], craft: [62, 'milk_tea_craft', MILK],
    work: [63, 'milk_tea_get_work_page', MILK], wages: [64, 'milk_tea_claim_wages', MILK],
    interact: [65, 'milk_tea_interact', MILK], rank: [66, 'milk_tea_get_rank', MILK],
    logs: [67, 'milk_tea_get_sales_log', MILK], hireSetting: [68, 'milk_tea_set_hire_disable', MILK],
    shareRewards: [71, 'share_reward_claim_milestones', SHARE], shareDaily: [74, 'share_reward_claim_daily', SHARE],
    exchange: [1, 'shop_buy', SHOP], unlock: [75, 'growth_fund_unlock', FUND],
    fundClaim: [76, 'growth_fund_claim', FUND],
};
const readActions = new Set(['shop', 'hireList', 'workshop', 'work', 'rank', 'logs']);
// 这些动作不要求店铺已开业（分享/成长基金与店铺经营相互独立）。
const shopFreeActions = new Set(['create', 'shareDaily', 'shareRewards', 'fundClaim']);
// 结算期仍可执行的领取类动作。
const settlingActions = new Set(['claim', 'wages', 'exchange', 'shareDaily', 'shareRewards', 'fundClaim']);
let tail: Promise<any> = Promise.resolve();

function fail(message: string): never { throw new Error(message); }
function integer(value: any, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) fail('数量或编号无效');
    return number;
}
function item(value: any) {
    const id = toNum(value?.id);
    return { id, count: toNum(value?.count), name: getItemById(id)?.name || `物品 #${id}`, image: getItemImageById(id) };
}
function items(values: any[]) { return (values || []).map(item); }
function cupMap(values: any) {
    return Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [
        /^\d+$/.test(key) ? key : util.longFromHash(key, false).toString(), toNum(value),
    ]));
}
function plain(type: any, value: any) { return type.toObject(value, { longs: String, bytes: String }); }
function ruleLines(head: any): string[] {
    try { return JSON.parse(Buffer.from(head.extra).toString()).tips.txt.filter((line: any) => typeof line === 'string').map((line: string) => line.replace(/<br\s*(?:\/\s*)?>/gi, '\n').replace(/<[^>]+>/g, '')); }
    catch { return []; }
}
async function group() {
    const reply = await sendMsgAsync(SERVICE, 'GetGroup', types.GetGroupRequest.encode({ group_id: GROUP }).finish());
    const result = types.MilkTeaGetGroupReply.decode(reply.body).group;
    if (String(result?.head?.activity_id) !== GROUP) fail('活动目录回包不匹配');
    return result.children || [];
}
async function rpc(action: string, params: any = {}) {
    const [cmd, field, id] = operations[action];
    const request = { activity_id: id, operate_type: cmd, [field]: params };
    const reply = await sendMsgAsync(SERVICE, 'Operate', types.MilkTeaOperateRequest.encode(request).finish());
    const decoded = types.MilkTeaOperateReply.decode(reply.body);
    if (String(decoded.activity_id) !== id || toNum(decoded.operate_type) !== cmd || !decoded[field]) {
        fail('操作回包不完整，请刷新确认结果，勿重复提交');
    }
    return decoded[field];
}
async function inventory(diamonds = false) {
    const bag = warehouse.getBagItems(await warehouse.getBag());
    const balances: Record<string, number> = {};
    for (const entry of bag) balances[String(entry.id)] = (balances[String(entry.id)] || 0) + toNum(entry.count);
    if (diamonds) balances['1004'] = await getDiamondBalance();
    return { bag, balances };
}
function checkCost(costs: any[], expected: any, balances: any, count = 1) {
    const signature = (list: any[]) => (list || []).map(v => `${toNum(v.id)}:${toNum(v.count)}`).sort().join('|');
    if (!Array.isArray(expected) || signature(costs) !== signature(expected)) fail('费用已变化，请刷新后重新确认');
    for (const cost of costs) {
        if (toNum(cost.count) < 0 || !Number.isSafeInteger(toNum(cost.count) * count)) fail('费用无效');
        if ((balances[String(cost.id)] || 0) < toNum(cost.count) * count) fail('货币或道具数量不足');
    }
}
function recipeConfig(id: any) { return config.MilkTeaRecipeConfig.find(v => v.recipe_id === toNum(id)); }
function normalizeRecipes(reply: any) {
    return (reply.recipes || []).map((v: any) => {
        const row = recipeConfig(v.recipe_id);
        return { ...plain(types.MilkTeaOperateReply, { milk_tea_get_workshop: { recipes: [v] } }).milk_tea_get_workshop.recipes[0],
            image: `/activity-assets/milk-tea/recipe-${v.recipe_id}.png`, description: row?.drink_desc || '',
            fruitId: Number(row?.fruit_item_id.split(':')[0] || 0),
        };
    });
}
function normalizeShop(value: any) {
    const result = plain(types.MilkTeaOperateReply, { milk_tea_get_shop: { shop: value } }).milk_tea_get_shop.shop;
    for (const key of ['drink_cups', 'pending_cups_by_recipe', 'pending_cups_by_source', 'boost_coin_price']) result[key] = cupMap(value[key]);
    result.pending_rewards = items(value.pending_rewards);
    result.boost_preview_rewards = items(value.boost_preview_rewards);
    return result;
}
function normalizeGoods(entry: any, settling: boolean) {
    const limit = toNum(entry.purchase_limit);
    const bought = toNum(entry.purchased_count);
    const conditions = (entry.cond_hints || []).map((v: any) => ({ type: v.cond_type, satisfied: !!v.satisfied, current: toNum(v.current), target: toNum(v.target) }));
    // The official shop uses a positive purchase_limit as the finite cap.
    const remaining = limit > 0 ? Math.max(0, limit - bought) : null;
    return { id: String(entry.id), name: entry.name, description: entry.desc, rewards: items(entry.item), costs: items(entry.cost),
        remaining, conditions, category: entry.category_tag,
        available: remaining !== 0 && conditions.every((v: any) => v.satisfied) && !(settling && entry.category_tag === 'seed'),
    };
}
function normalizeShare(entry: any) {
    const summary = entry?.summary;
    if (!summary) fail('快乐值活动进度未返回');
    const daily = summary.daily || {};
    return {
        itemId: toNum(summary.score_item_id), current: toNum(summary.current_score),
        dailyReward: toNum(summary.daily_reward), firstShareReward: toNum(summary.first_share_reward),
        daily: { claimed: !!daily.daily_reward_claimed, firstShareAwarded: !!daily.first_share_awarded,
            claimedCount: toNum(daily.claimed_count), claimLimit: toNum(daily.claim_limit) },
        milestones: (summary.milestones || []).map((tier: any) => ({ id: toNum(tier.tier_id), threshold: toNum(tier.threshold),
            state: toNum(tier.state), rewards: items(tier.rewards) })),
    };
}
/** 自动雇佣候选：优先符合天赋的好友，其次任意空闲好友，最后兜底实习员工（9004 只选机器人）。 */
function selectHireCandidate(hire: any, input: any) {
    const now = getServerTimeSec();
    const talent = toNum(input.talentId);
    const idle = (entry: any) => !!entry?.friend?.gid && toNum(entry.state) === 0
        && toNum(entry.state_until_at) <= now && toNum(entry.rehire_available_at) <= now;
    const friends = (hire.friends || []).filter((entry: any) => !entry.is_robot && idle(entry));
    const robots = (hire.robots || []).filter(idle);
    if (talent === 9004) return robots[0];
    return friends.find((entry: any) => !talent || toNum(entry.talent_id) === talent) || friends[0] || robots[0];
}
/**
 * 自动互动候选顺序：3 招牌试饮（收益+20%/2h，另送高级奶茶）→ 2 花式摇杯（收益+10%/3h）→ 1 宣传推广（本班奖金 20%）。
 * 4 划水摸鱼 / 5 申请涨薪 有工资减半风险，默认不自动选，只能在活动中心手动发起。
 */
const AUTO_INTERACTION_ORDER = [3, 2, 1];
function selectInteractionType(state: any) {
    for (const kind of AUTO_INTERACTION_ORDER) {
        if (state.interactions.find((v: any) => v.interaction_id === kind)?.ready) return kind;
    }
    return undefined;
}
async function getMilkTeaActivity(page = 'shop', input: any = {}) {
    if (!['shop', 'settings', 'upgrade', 'workshop', 'hireList', 'exchange', 'fund', 'share', 'work', 'rank', 'logs'].includes(page)) fail('未知的活动页面');
    const entries = await group();
    const entry = entries.find((v: any) => String(v.head?.activity_id) === MILK);
    if (!entry?.milk_tea?.summary) fail('奶茶活动进度未返回');
    const now = getServerTimeSec();
    const head = entry.head;
    const active = now >= toNum(head.begin_time) && now < toNum(head.end_time);
    const settling = toNum(head.settle_start_time) > 0 && now >= toNum(head.settle_start_time);
    const summary = plain(types.MilkTeaGetGroupReply, { group: { children: [entry] } }).group.children[0].milk_tea.summary;
    const result: any = { id: MILK, title: head.name, serverTime: now, startTime: toNum(head.begin_time), endTime: toNum(head.end_time),
        settleStartTime: toNum(head.settle_start_time), active, settling, summary, rules: ruleLines(head), page,
        recommendedNames: config.MilkTeaActivityConfig[0].recommend_names.split(';'), levels: config.MilkTeaStoreLevelConfig.map(level => ({
            ...level, rewards: String(level.rewards || '').split(';').filter(Boolean).map(text => { const [id, count] = text.split(':').map(Number); return item({ id, count }); }),
            recipes: level.recipe_ids_string.split(';').map(id => recipeConfig(id)?.recipe_name).filter(Boolean),
        })),
    };
    const inv = await inventory(page === 'fund' || page === 'exchange');
    result.balances = inv.balances;
    if (page === 'exchange') {
        const shop = entries.find((v: any) => String(v.head?.activity_id) === SHOP)?.shop;
        if (!shop) fail('兑换商店未返回');
        result.goods = (shop.goods || []).map((v: any) => normalizeGoods(v, settling));
    } else if (page === 'fund') {
        const fund = entries.find((v: any) => String(v.head?.activity_id) === FUND)?.growth_fund;
        if (!fund) fail('成长基金未返回');
        result.fund = { unlocked: !!fund.unlocked, costs: items(fund.unlock_cost), tiers: (fund.tiers || []).map((tier: any) => ({
            id: toNum(tier.tier_id), state: toNum(tier.state), rewards: items(tier.reward),
            conditions: (tier.conditions || []).map((v: any) => ({ type: v.type, current: toNum(v.current_value), target: toNum(v.target_value), reached: !!v.reached })),
        })) };
    } else if (page === 'share') {
        if (active) {
            const share = entries.find((v: any) => String(v.head?.activity_id) === SHARE)?.share_reward;
            result.share = normalizeShare(share);
        }
    } else if (active && toNum(summary.shop_open_at) > 0) {
        if (['shop', 'upgrade', 'workshop', 'hireList'].includes(page)) result.shop = normalizeShop((await rpc('shop')).shop);
        if (page === 'shop' || page === 'workshop') {
            result.recipes = normalizeRecipes(await rpc('workshop'));
            const bonus = config.MilkTeaStoreLevelConfig.find(v => v.level === toNum(result.shop.level))?.advanced_price_percent || 0;
            for (const recipe of result.recipes) {
                const basePrice = Number(recipeConfig(recipe.recipe_id)?.base_price.split(':')[1] || 0);
                recipe.boostTokenPrice = Math.floor(basePrice * (10000 + (recipe.is_advanced ? bonus : 0)) / 10000);
            }
        }
        if (page === 'workshop') {
            result.fruits = inv.bag.filter((v: any) => result.recipes.some((r: any) => r.unlocked && r.fruitId === toNum(v.id)))
                .map((v: any) => ({ ...item(v), uid: String(v.uid), locked: warehouse.isItemLocked(v), mutations: (v.mutant_types || []).map(toNum) }));
        }
        if (page === 'hireList') {
            const duration = integer(input.durationId ?? 1, 1, 3);
            const value = await rpc('hireList', { duration_id: duration });
            result.hire = plain(types.MilkTeaOperateReply, { milk_tea_get_hire_list: value }).milk_tea_get_hire_list;
            result.durations = config.MilkTeaHireDurationConfig;
        }
        if (page === 'work') {
            const value = await rpc('work');
            result.work = plain(types.MilkTeaOperateReply, { milk_tea_get_work_page: value }).milk_tea_get_work_page;
            delete result.work.hire_subscribe_qq_jump_url;
            delete result.work.hire_subscribe_template_id;
            Object.assign(result, normalizeMilkTeaWork(result.work));
        }
        if (page === 'rank' || page === 'logs') {
            const today = Math.floor((now + 8 * 3600) / 86400) * 86400 - 8 * 3600;
            const day = Number(input.day) || today;
            const params = page === 'rank' ? { page: integer(input.pageNumber ?? 1, 1, 100) } : { day: integer(day, 1, today) };
            const value = await rpc(page, params);
            const field = operations[page][1];
            result[page] = plain(types.MilkTeaOperateReply, { [field]: value })[field];
            if (page === 'logs') {
                result.logs.cups_by_recipe = cupMap(value.cups_by_recipe);
                result.logs.cups_by_source = cupMap(value.cups_by_source);
                result.logs.items = items(value.items);
            }
        }
    }
    return result;
}

async function perform(action: string, input: any) {
    if (!Object.hasOwn(operations, action) || readActions.has(action)) fail('未知的活动操作');
    const auto = input?.auto === true;
    const page = ['exchange'].includes(action) ? 'exchange' : ['unlock', 'fundClaim'].includes(action) ? 'fund' : ['shareDaily', 'shareRewards'].includes(action) ? 'share'
        : ['hire'].includes(action) ? 'hireList' : action === 'craft' ? 'workshop' : ['wages', 'interact'].includes(action) ? 'work' : ['rename', 'hireSetting'].includes(action) ? 'settings' : action === 'upgrade' ? 'upgrade' : 'shop';
    const state = await getMilkTeaActivity(page, input);
    if (!state.active) fail('活动尚未开放或已经结束');
    if (!shopFreeActions.has(action) && !toNum(state.summary.shop_open_at)) fail('请先开业');
    if (state.settling && !settlingActions.has(action)) fail('结算期不可进行此操作');
    let params: any = {};
    if (action === 'create' || action === 'rename') {
        const name = String(input.name || '').trim();
        const rule = config.MilkTeaActivityConfig[0];
        if ([...name].length < rule.name_min_length || [...name].length > rule.name_max_length) fail(`店名需为${rule.name_min_length}—${rule.name_max_length}个字`);
        if (action === 'create' && toNum(state.summary.shop_open_at) > 0) fail('店铺已经开业');
        if (action === 'rename' && toNum(state.summary.rename_cd_until_at) > getServerTimeSec()) fail('尚未到修改店名时间');
        params = { shop_name: name };
    } else if (action === 'boost') {
        const count = auto ? 1 : integer(input.count, 1, 9999);
        if (state.shop.is_settling) fail('结算期不可加速');
        if (auto) {
            if ((state.balances[String(toNum(state.shop.sales_item_id))] || 0) <= 0) fail('暂无可用的宣传喇叭');
        } else {
            checkCost([{ id: toNum(state.shop.sales_item_id), count: 1 }], input.expectedCosts, state.balances, count);
        }
        params = { count };
    } else if (action === 'claim') {
        if (!state.shop.pending_rewards.some((v: any) => v.count > 0)) fail('暂无可领取收益');
    } else if (action === 'upgrade') {
        if (!auto && toNum(state.summary.level) !== integer(input.expectedLevel)) fail('店铺等级已变化，请刷新后重新确认');
        if (!state.summary.can_upgrade) fail('尚未达到店铺升级条件');
    } else if (action === 'craft') {
        if (auto) {
            const eligible = new Set(state.recipes.filter((v: any) => v.unlocked && v.is_advanced).map((v: any) => v.fruitId));
            const uids = [...new Set((state.fruits || []).filter((v: any) => eligible.has(toNum(v.id)) && toNum(v.count) > 0 && !v.locked).map((v: any) => String(v.uid)))];
            if (!uids.length) return { activity: state, result: null, skipped: true, reason: '没有可加工的已解锁活动果实' };
            params = { fruit_uids: uids };
        } else {
            if (!Array.isArray(input.fruits) || !input.fruits.length || input.fruits.length > 200) fail('请选择制作材料');
            const ids = new Set<string>();
            for (const selected of input.fruits) {
                const uid = String(selected.uid);
                if (ids.has(uid)) fail('制作材料重复');
                ids.add(uid);
                const fruit = state.fruits.find((v: any) => v.uid === uid);
                if (!fruit || fruit.locked || fruit.count !== integer(selected.count)) fail('果实数量或锁定状态已变化，请重新选择');
            }
            params = { fruit_uids: [...ids] };
        }
    } else if (action === 'hire') {
        const level = config.MilkTeaStoreLevelConfig.find(v => v.level === toNum(state.shop.level));
        // 位置由服务端自动挑选第一个空闲槽位；员工在自动模式下由候选策略挑选，手动模式沿用前端指定
        const index = Array.from({ length: level?.employee_slot_count || 0 }, (_, slot) => slot)
            .find(slot => !(state.shop.slots || []).some((v: any) => toNum(v.slot_index) === slot && toNum(v.end_at) > getServerTimeSec()));
        if (index === undefined) fail('员工位置已满');
        let target: string;
        if (auto) {
            const candidate = selectHireCandidate(state.hire, input);
            if (!candidate) return { activity: state, result: null, skipped: true, reason: '没有符合条件的空闲员工' };
            target = String(candidate.friend.gid);
        } else {
            target = String(input.targetGid);
            const candidate = [...(state.hire.friends || []), ...(state.hire.robots || [])].find(v => String(v.friend?.gid) === target);
            if (!candidate || toNum(candidate.state) !== 0 || toNum(candidate.rehire_available_at) > getServerTimeSec()) fail('该员工当前不可雇佣');
        }
        if (state.settleStartTime - getServerTimeSec() < toNum(state.hire.min_remain_biz_sec)) fail('剩余营业时间不足');
        if (auto) {
            if ((state.balances['1041'] || 0) < toNum(state.hire.wage_total)) fail('奶茶券不足，暂无法雇佣员工');
        } else {
            checkCost([{ id: 1041, count: toNum(state.hire.wage_total) }], input.expectedCosts, state.balances);
        }
        params = { hires: [{ slot_index: index, duration_id: toNum(state.hire.duration_id), target_gid: target }] };
    } else if (action === 'exchange') {
        const goods = state.goods.find((v: any) => v.id === String(input.goodsId));
        const count = auto ? integer(input.count ?? 1, 1, 9999) : integer(input.count, 1, 9999);
        if (!goods?.available || (goods.remaining !== null && count > goods.remaining)) fail('商品条件或限购数量不满足');
        if (auto) {
            for (const cost of goods.costs) {
                if ((state.balances[String(cost.id)] || 0) < cost.count * count) fail('货币或道具数量不足');
            }
        } else {
            checkCost(goods.costs, input.expectedCosts, state.balances, count);
        }
        params = { goods_id: goods.id, count };
    } else if (action === 'unlock') {
        if (state.fund.unlocked) fail('成长基金已解锁');
        checkCost(state.fund.costs, input.expectedCosts, state.balances);
    } else if (action === 'fundClaim') {
        if (!state.fund.unlocked || !state.fund.tiers.some((v: any) => v.state === 2)) fail('暂无可领取的成长基金奖励');
    } else if (action === 'shareDaily') {
        if (state.share?.daily?.claimed) fail('今日已领取');
    } else if (action === 'shareRewards') {
        if (!(state.share?.milestones || []).some((v: any) => v.state === 2)) fail('暂无可领取档位');
    } else if (action === 'wages') {
        if (!(state.work.slips || []).some((v: any) => toNum(v.wage_status) === 1)) fail('暂无可领取工资');
    } else if (action === 'interact') {
        const shift = state.work.my_shift;
        if (!shift || state.work.interact_done || toNum(shift.end_at) <= getServerTimeSec() || toNum(shift.interact_count) >= toNum(shift.interact_limit)) fail('当前班次不可互动');
        const kind = auto ? selectInteractionType(state) : integer(input.interactionType, 1, 5);
        if (kind === undefined || kind === null) return { activity: state, result: null, skipped: true, reason: '没有可用的工作事项' };
        if (!auto && String(input.expectedShiftId || '') !== String(shift.shift_id)) fail('班次已变化，请刷新后重新选择');
        if (!state.interactions.find((value: any) => value.interaction_id === kind)?.ready) fail('工作事项数据不完整，请刷新后重试');
        params = { target_gid: String(shift.employer.gid), interaction_type: kind };
    } else if (action === 'hireSetting') {
        if (typeof input.disabled !== 'boolean') fail('雇佣设置无效');
        params = { hire_disabled: input.disabled };
    }
    const reply = await rpc(action, params);
    const field = operations[action][1];
    const result = plain(types.MilkTeaOperateReply, { [field]: reply })[field];
    if (action === 'craft') {
        result.crafted_cups = cupMap(reply.crafted_cups);
        result.drink_cups = cupMap(reply.drink_cups);
    }
    if (action === 'hire' && !reply.results?.some((v: any) => v.success)) fail(reply.results?.[0]?.error_msg || '雇佣未成功，请刷新确认');
    const rewards = items(reply.awards || reply.items || reply.rewards || reply.opening_gift || reply.items_gained);
    if (action === 'boost') rewards.push(...items([{ id: 1041, count: reply.token_gain }, { id: 1001, count: reply.coin_gain }]).filter(v => v.count > 0));
    try { return { activity: await getMilkTeaActivity(page, input), result, rewards }; }
    catch { return { activity: null, result, rewards, refreshRequired: true }; }
}

function operateMilkTeaActivity(action: string, input: any = {}) {
    const result = tail.then(() => perform(action, input));
    tail = result.catch(() => {});
    return result;
}

module.exports = { getMilkTeaActivity, operateMilkTeaActivity };
