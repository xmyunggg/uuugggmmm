import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 「一键复制全部卡密」必须一行一个卡密，并且要覆盖 http 部署下的 execCommand 回退路径。

function setup(t, { clipboard = true } = {}) {
  const copied = []
  const toasts = []
  const warnings = []
  const execCalls = []
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  // node 22 的 navigator 是只读访问器，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: clipboard ? { clipboard: { writeText: async (text) => { copied.push(text) } } } : {},
  })

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement: () => {
        const el = {
          value: '',
          style: {},
          select() {
            execCalls.push(el.value)
          },
        }
        return el
      },
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
  })

  t.after(() => {
    if (previousNavigator)
      Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else
      delete globalThis.navigator
    if (previousDocument)
      Object.defineProperty(globalThis, 'document', previousDocument)
    else
      delete globalThis.document
  })

  const source = readFileSync(new URL('../src/composables/useAdminCards.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })

  const mocks = {
    '@/api': { __esModule: true, default: { get: async () => ({ data: { ok: true, data: [] } }) } },
    '@/stores/toast': {
      __esModule: true,
      useToastStore: () => ({
        success: message => toasts.push(message),
        error: message => toasts.push(message),
        warning: message => warnings.push(message),
      }),
    },
    '@/stores/user': {
      __esModule: true,
      formatCardValue: () => '',
      useUserStore: () => ({ getAllCards: async () => ({ ok: true, data: [] }) }),
    },
  }

  const module = { exports: {} }
  // 与仓库其它 tests/*.test.mjs 一样，用 new Function 注入 require 桩
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(
    id => (id in mocks ? mocks[id] : require(id)),
    module,
    module.exports,
  )

  const cards = module.exports.useAdminCards({ showAlert: () => {} })
  return { cards, copied, toasts, warnings, execCalls }
}

const card = (code, extra = {}) => ({ code, description: code, type: 'time', enabled: true, usedBy: null, usedAt: null, createdAt: 0, durationValue: 1, durationUnit: 'day', ...extra })

test('一键复制全部卡密：一行一个卡密', async (t) => {
  const { cards, copied, toasts } = setup(t)
  cards.cards.value = [card('CODE-A'), card('CODE-B'), card('CODE-C')]

  await cards.copyAllCards()

  assert.equal(copied.length, 1)
  assert.equal(copied[0], 'CODE-A\nCODE-B\nCODE-C')
  assert.equal(copied[0].split('\n').length, 3)
  assert.equal(copied[0].endsWith('\n'), false)
  assert.match(toasts[0], /已复制 3 个卡密/)
})

test('有筛选时只复制筛选结果，并在提示里说明', async (t) => {
  const { cards, copied, toasts } = setup(t)
  cards.cards.value = [card('CODE-A'), card('CODE-B', { type: 'quota', value: 3 })]
  cards.cardTypeFilter.value = 'quota'

  await cards.copyAllCards()

  assert.equal(copied[0], 'CODE-B')
  assert.match(toasts[0], /已复制 1 个卡密（当前筛选结果）/)
})

test('关键词筛选同样生效', async (t) => {
  const { cards, copied } = setup(t)
  cards.cards.value = [card('AAA-1'), card('BBB-2'), card('AAA-3')]
  cards.searchQuery.value = 'aaa'

  await cards.copyAllCards()

  assert.equal(copied[0], 'AAA-1\nAAA-3')
})

test('没有卡密时不写剪贴板，只提示', async (t) => {
  const { cards, copied, warnings } = setup(t)
  cards.cards.value = []

  await cards.copyAllCards()

  assert.equal(copied.length, 0)
  assert.match(warnings[0], /没有可复制的卡密/)
})

test('没有 Clipboard API 时回退到 execCommand（http 部署场景）', async (t) => {
  const { cards, execCalls, toasts } = setup(t, { clipboard: false })
  cards.cards.value = [card('CODE-A'), card('CODE-B')]

  await cards.copyAllCards()

  assert.equal(execCalls.length, 1)
  assert.equal(execCalls[0], 'CODE-A\nCODE-B')
  assert.match(toasts[0], /已复制 2 个卡密/)
})

test('单个复制与复制选中行为不变', async (t) => {
  const { cards, copied, toasts } = setup(t)

  await cards.copyCode('CODE-X')
  assert.equal(copied[0], 'CODE-X')

  cards.selectedCards.value.add('CODE-A')
  cards.selectedCards.value.add('CODE-B')
  await cards.copySelectedCards()
  assert.equal(copied[1], 'CODE-A\nCODE-B')
  assert.match(toasts[1], /已复制 2 个卡密/)
})
