import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia, setActivePinia } = require('pinia')
const ts = require('typescript')

const MILK_TEA_BOOLEAN_KEYS = [
  'milk_tea_cashier',
  'milk_tea_wages',
  'milk_tea_upgrade',
  'milk_tea_craft',
  'milk_tea_boost',
  'milk_tea_hire',
  'milk_tea_seed_buy',
  'milk_tea_interact',
  'milk_tea_share_daily',
  'milk_tea_share_rewards',
  'milk_tea_fund_rewards',
]

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

test('接口下发的奶茶开关与雇佣参数会被回填', async (t) => {
  const { store } = harness(t, apiReturning({
    strategy: 'max_exp',
    automation: { milk_tea_cashier: true, milk_tea_hire: true, milk_tea_hire_duration: 3, milk_tea_hire_talent: 9002 },
  }))
  assert.equal(await store.fetchSettings('1'), true)
  assert.equal(store.settings.automation.milk_tea_cashier, true)
  assert.equal(store.settings.automation.milk_tea_hire, true)
  assert.equal(store.settings.automation.milk_tea_hire_duration, 3)
  assert.equal(store.settings.automation.milk_tea_hire_talent, 9002)
  assert.notEqual(store.settings.automation.milk_tea_craft, true)
})

test('保存设置时把奶茶开关与雇佣参数一起提交', async (t) => {
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
    automation: { milk_tea_craft: true, milk_tea_hire_duration: 2, milk_tea_hire_talent: 9001 },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(captured.automation, { milk_tea_craft: true, milk_tea_hire_duration: 2, milk_tea_hire_talent: 9001 })
  assert.equal(store.settings.automation.milk_tea_craft, true)
})

test('设置页本地状态带上了奶茶字段，保存时才不会丢', () => {
  const source = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  const spreads = source.split('...milkTeaAutomationDefaults').length - 1
  assert.ok(spreads >= 3, `奶茶默认值应在三处本地默认值里都展开，实际 ${spreads} 处`)
  for (const key of MILK_TEA_BOOLEAN_KEYS)
    assert.ok(source.includes(`${key}: false`), `奶茶默认值应包含 ${key}`)
  assert.ok(source.includes('milk_tea_hire_duration: 1'), '雇佣时长应有本地默认值')
  assert.ok(source.includes('milk_tea_hire_talent: 0'), '员工类型应有本地默认值')
})

test('自动控制表单渲染全部奶茶开关与雇佣参数', () => {
  const source = readFileSync(new URL('../src/components/settings/AutomationSettingsForm.vue', import.meta.url), 'utf8')
  for (const key of MILK_TEA_BOOLEAN_KEYS)
    assert.match(source, new RegExp(`settings\\.automation\\.${key}`), `表单应绑定 ${key}`)
  assert.match(source, /settings\.automation\.milk_tea_hire_duration/)
  assert.match(source, /settings\.automation\.milk_tea_hire_talent/)
  assert.match(source, /奶茶热销中/)
  assert.match(source, /雇佣时长/)
  assert.match(source, /员工类型偏好/)
})
