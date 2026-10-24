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

// /api/settings 返回的是嵌套结构 autoCodeRefresh，前端必须读它，否则会回落到默认值。
function apiReturning(settingsData) {
  return { get: async () => ({ data: { ok: true, data: settingsData } }) }
}

test('自动刷新 Code 的开关与间隔按接口返回的嵌套结构回填', async (t) => {
  const { store } = harness(t, apiReturning({
    strategy: 'max_exp',
    autoCodeRefresh: { enabled: true, intervalMinutes: 15 },
  }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.autoCodeRefreshEnabled, true)
  assert.equal(store.settings.autoCodeRefreshIntervalMinutes, 15)
})

test('关闭自动刷新后重新加载设置仍保持关闭，不会回落到默认开启', async (t) => {
  const { store } = harness(t, apiReturning({
    strategy: 'max_exp',
    autoCodeRefresh: { enabled: false, intervalMinutes: 30 },
  }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.autoCodeRefreshEnabled, false)
  assert.equal(store.settings.autoCodeRefreshIntervalMinutes, 30)
})

test('接口没有下发该配置时使用默认值（关闭 / 60 分钟）', async (t) => {
  const { store } = harness(t, apiReturning({ strategy: 'max_exp' }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.autoCodeRefreshEnabled, false)
  assert.equal(store.settings.autoCodeRefreshIntervalMinutes, 60)
})

test('仍兼容扁平字段返回', async (t) => {
  const { store } = harness(t, apiReturning({
    strategy: 'max_exp',
    autoCodeRefreshEnabled: true,
    autoCodeRefreshIntervalMinutes: 90,
  }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.autoCodeRefreshEnabled, true)
  assert.equal(store.settings.autoCodeRefreshIntervalMinutes, 90)
})
