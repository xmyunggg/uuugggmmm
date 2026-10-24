import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 「状态」列现在同时显示 使用状态(未使用/已使用) 与 启用状态(已启用/已禁用)，
// 这里把筛选项与这两个维度钉住，避免改筛选语义时列表显示跟着漂掉。

function setup(t) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { createElement: () => ({ value: '', style: {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => true },
  })

  t.after(() => {
    if (previousNavigator)
      Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else
      delete globalThis.navigator
    delete globalThis.document
  })

  const source = readFileSync(new URL('../src/composables/useAdminCards.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })

  const mocks = {
    '@/api': { __esModule: true, default: { get: async () => ({ data: { ok: true, data: [] } }) } },
    '@/stores/toast': { __esModule: true, useToastStore: () => ({ success() {}, error() {}, warning() {} }) },
    '@/stores/user': { __esModule: true, formatCardValue: () => '', useUserStore: () => ({ getAllCards: async () => ({ ok: true, data: [] }) }) },
  }

  const module = { exports: {} }
  // 与仓库其它 tests/*.test.mjs 一样，用 new Function 注入 require 桩
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(
    id => (id in mocks ? mocks[id] : require(id)),
    module,
    module.exports,
  )

  return module.exports.useAdminCards({ showAlert: () => {} })
}

const card = (code, extra = {}) => ({ code, description: code, type: 'time', enabled: true, usedBy: null, usedAt: null, createdAt: 0, durationValue: 1, durationUnit: 'day', ...extra })

function fixture() {
  return [
    card('UNUSED-ENABLED'),
    card('UNUSED-DISABLED', { enabled: false }),
    card('USED-ENABLED', { usedBy: 'admin', usedAt: 1758900000000 }),
    card('USED-DISABLED', { usedBy: 'admin', usedAt: 1758900000000, enabled: false }),
  ]
}

const codes = cards => cards.map(c => c.code)

test('状态筛选：未使用 = 没有使用者', (t) => {
  const { cards, filterStatus, filteredCards } = setup(t)
  cards.value = fixture()

  filterStatus.value = 'unused'
  assert.deepEqual(codes(filteredCards.value), ['UNUSED-ENABLED', 'UNUSED-DISABLED'])
})

test('状态筛选：已使用 = 有使用者（与状态列的「已使用」徽章同口径）', (t) => {
  const { cards, filterStatus, filteredCards } = setup(t)
  cards.value = fixture()

  filterStatus.value = 'used'
  assert.deepEqual(codes(filteredCards.value), ['USED-ENABLED', 'USED-DISABLED'])
})

test('状态筛选：已启用/已禁用只看 enabled（与状态列的启用徽章同口径）', (t) => {
  const { cards, filterStatus, filteredCards } = setup(t)
  cards.value = fixture()

  filterStatus.value = 'enabled'
  assert.deepEqual(codes(filteredCards.value), ['UNUSED-ENABLED', 'USED-ENABLED'])

  filterStatus.value = 'disabled'
  assert.deepEqual(codes(filteredCards.value), ['UNUSED-DISABLED', 'USED-DISABLED'])
})

test('状态筛选：使用状态与启用状态是两个独立维度', (t) => {
  const { cards, filterStatus, filteredCards, cardTypeFilter, searchQuery } = setup(t)
  cards.value = fixture()
  cardTypeFilter.value = 'all'
  searchQuery.value = ''

  filterStatus.value = 'used'
  assert.equal(filteredCards.value.length, 2)
  assert.ok(filteredCards.value.some(c => c.enabled) && filteredCards.value.some(c => !c.enabled))

  filterStatus.value = 'all'
  assert.equal(filteredCards.value.length, 4)
})

test('状态筛选：五个选项都有对应文案，且与页面下拉选项一致', (t) => {
  const { filterStatus, currentCardStatusLabel } = setup(t)

  const expected = { all: '全部状态', unused: '未使用', used: '已使用', enabled: '已启用', disabled: '已禁用' }
  for (const [value, label] of Object.entries(expected)) {
    filterStatus.value = value
    assert.equal(currentCardStatusLabel.value, label)
  }

  // 下拉选项写在 AdminCardPanel.vue 的 statusFilterOptions 里，两边文案不能漂
  const panel = readFileSync(new URL('../src/components/admin/AdminCardPanel.vue', import.meta.url), 'utf8')
  const block = panel.slice(panel.indexOf('const statusFilterOptions'), panel.indexOf('const statusFilterOptions') + 400)
  const labels = [...block.matchAll(/label: '([^']+)'/g)].map(m => m[1])
  const values = [...block.matchAll(/value: '([^']+)'/g)].map(m => m[1])
  assert.deepEqual(labels, Object.values(expected))
  assert.deepEqual(values, Object.keys(expected))
})

test('状态列：使用状态与启用状态徽章都由 usedBy / enabled 直接决定', (t) => {
  const { cards } = setup(t)
  cards.value = fixture()

  const panel = readFileSync(new URL('../src/components/admin/AdminCardPanel.vue', import.meta.url), 'utf8')
  // 两个徽章各自绑到一个可见文案上，缺一个就会出现「状态显示不全」
  assert.match(panel, /data-card-usage="card\.usedBy \? 'used' : 'unused'"/)
  assert.match(panel, /data-card-enabled="card\.enabled \? 'true' : 'false'"/)
  assert.match(panel, /\{\{ card\.usedBy \? '已使用' : '未使用' \}\}/)
  assert.match(panel, /\{\{ card\.enabled \? '已启用' : '已禁用' \}\}/)

  const used = cards.value.filter(c => c.usedBy).map(c => (c.usedBy ? '已使用' : '未使用'))
  assert.deepEqual(used, ['已使用', '已使用'])
})
