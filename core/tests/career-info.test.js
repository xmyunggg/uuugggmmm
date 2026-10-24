const assert = require('node:assert/strict');
const test = require('node:test');

const { mapHarvestItems } = require('../dist/services/career');

test('生涯收获明细同时兼容 camelCase 与 snake_case 字段', () => {
    const items = mapHarvestItems([
        { fruitId: 20061, harvestCount: 1200 },
        { fruit_id: 20062, harvest_count: 7 },
    ]);

    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.fruitId), [20061, 20062]);
    assert.deepEqual(items.map(item => item.seedId), [20061, 20062]);
    assert.deepEqual(items.map(item => item.harvestCount), [1200, 7]);
});

test('生涯收获明细数值一律归一为 number，未知果实回退占位名', () => {
    const items = mapHarvestItems([
        { fruitId: '20061', harvestCount: '1200' },
        { fruitId: 999999, harvestCount: null },
        {},
    ]);

    assert.equal(items[0].harvestCount, 1200);
    assert.equal(items[1].harvestCount, 0);
    assert.equal(items[1].name, '果实999999');
    assert.ok(items[1].image.endsWith('/999999.png'));
    assert.equal(items[2].fruitId, 0);
    assert.equal(items[2].harvestCount, 0);
});

test('生涯收获明细保留配置里的作物名与图片路径', () => {
    const [first] = mapHarvestItems([{ fruitId: 20061, harvestCount: 1 }]);

    assert.ok(first.name && first.name !== '果实20061', '应命中物品/植物配置里的名称');
    assert.equal(first.image, '/game-config/seed_images_named/seed_images/20061.png');
});

test('非数组入参不抛错，返回空明细', () => {
    assert.deepEqual(mapHarvestItems(null), []);
    assert.deepEqual(mapHarvestItems(undefined), []);
});
