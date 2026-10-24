import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia, setActivePinia } = require('pinia')
const ts = require('typescript')

// Run the real setting store with Vue/Pinia; only the HTTP client is replaced.
function harness(t, api) {
  const pinia = createPinia()
  setActivePinia(pinia)
  t.after(() => disposePinia(pinia))
  const imports = {
    '@/api': { __esModule: true, default: api, getApiErrorMessage: value => value?.error || value?.message || '请求失败' },
  }
  const source = readFileSync(new URL('../src/stores/setting.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => imports[id] || require(id), module, module.exports)
  return { store: module.exports.useSettingStore(pinia) }
}

function apiReturning(settingsData) {
  return { get: async () => ({ data: { ok: true, data: settingsData } }) }
}

test('黄金虫配置默认保留 0 只、单轮 24 只，开关默认关闭', async (t) => {
  const { store } = harness(t, apiReturning({ strategy: 'max_exp' }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.goldenBugKeepCount, 0)
  assert.equal(store.settings.goldenBugRoundLimit, 24)
  assert.notEqual(store.settings.automation.friend_golden_bug, true)
})

test('接口下发的黄金虫配置会被回填', async (t) => {
  const { store } = harness(t, apiReturning({
    strategy: 'max_exp',
    goldenBugKeepCount: 5,
    goldenBugRoundLimit: 40,
    automation: { friend_golden_bug: true },
  }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.goldenBugKeepCount, 5)
  assert.equal(store.settings.goldenBugRoundLimit, 40)
  assert.equal(store.settings.automation.friend_golden_bug, true)
})

test('保存设置时把黄金虫开关与数量一起提交，并在响应确认后回写', async (t) => {
  let captured = null
  const api = {
    get: async () => ({ data: { ok: true, data: { strategy: 'max_exp' } } }),
    post: async (_url, payload) => {
      captured = payload
      return { data: { ok: true, data: { ...payload, saved: true } } }
    },
  }
  const { store } = harness(t, api)
  const result = await store.saveSettings('1', {
    automation: { friend_golden_bug: true },
    goldenBugKeepCount: 3,
    goldenBugRoundLimit: 30,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(captured.automation, { friend_golden_bug: true })
  assert.equal(captured.goldenBugKeepCount, 3)
  assert.equal(captured.goldenBugRoundLimit, 30)
  assert.equal(store.settings.goldenBugKeepCount, 3)
  assert.equal(store.settings.goldenBugRoundLimit, 30)
  assert.equal(store.settings.automation.friend_golden_bug, true)
})
