import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia, setActivePinia } = require('pinia')
const ts = require('typescript')

// 跑真实的 pet store；只替换外部 I/O（api）与浏览器侧依赖
function harness(t, api) {
  const pinia = createPinia()
  setActivePinia(pinia)
  t.after(() => disposePinia(pinia))
  const imports = {
    '@/api': { __esModule: true, default: api, getApiErrorMessage: value => value?.error || value?.message || '请求失败' },
  }
  const source = readFileSync(new URL('../src/stores/pet.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => imports[id] || require(id), module, module.exports)
  return module.exports.usePetStore(pinia)
}

test('资本模式默认关闭，读取后写入 store', async (t) => {
  const store = harness(t, {
    get: async () => ({ data: { ok: true, data: { enabled: true, dogId: 601, leadSeconds: 30 } } }),
  })
  assert.deepEqual({ ...store.capitalMode }, { enabled: false, dogId: 0, leadSeconds: 10 })
  const ok = await store.fetchCapitalMode('a')
  assert.equal(ok, true)
  assert.deepEqual({ ...store.capitalMode }, { enabled: true, dogId: 601, leadSeconds: 30 })
})

test('切账号后旧账号的资本模式回包不会覆盖新账号', async (t) => {
  const requests = []
  const store = harness(t, { get: () => new Promise(resolve => requests.push(resolve)) })
  const stale = store.fetchCapitalMode('a')
  // 切账号（面板会先 clear 再重新拉取）
  store.clear()
  const fresh = store.fetchCapitalMode('b')
  requests[1]({ data: { ok: true, data: { enabled: false, dogId: 0, leadSeconds: 10 } } })
  await fresh
  requests[0]({ data: { ok: true, data: { enabled: true, dogId: 601, leadSeconds: 30 } } })
  await stale
  assert.deepEqual({ ...store.capitalMode }, { enabled: false, dogId: 0, leadSeconds: 10 })
})

test('保存资本模式会提交完整配置，并以服务端返回值回填', async (t) => {
  const calls = []
  const store = harness(t, {
    get: async () => ({ data: { ok: true, data: { enabled: false, dogId: 0, leadSeconds: 10 } } }),
    post: async (url, body, options) => {
      calls.push({ url, body, options })
      return { data: { ok: true, data: { capitalMode: { ...body, leadSeconds: 300 } } } }
    },
  })
  const saved = await store.saveCapitalMode('a', { enabled: true, dogId: 602, leadSeconds: 999 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/dog/capital-mode')
  assert.deepEqual(calls[0].body, { enabled: true, dogId: 602, leadSeconds: 999 })
  assert.equal(calls[0].options.headers['x-account-id'], 'a')
  assert.deepEqual(saved, { enabled: true, dogId: 602, leadSeconds: 300 })
  assert.deepEqual({ ...store.capitalMode }, { enabled: true, dogId: 602, leadSeconds: 300 })
})

test('保存失败时保留原来的配置并给出错误文案', async (t) => {
  const store = harness(t, {
    get: async () => ({ data: { ok: true, data: { enabled: false, dogId: 0, leadSeconds: 10 } } }),
    post: async () => ({ data: { ok: false, error: 'leadSeconds 超出范围' } }),
  })
  await store.fetchCapitalMode('a')
  const saved = await store.saveCapitalMode('a', { enabled: true, dogId: 601, leadSeconds: 9999 })
  assert.equal(saved, null)
  assert.equal(store.error, 'leadSeconds 超出范围')
  assert.deepEqual({ ...store.capitalMode }, { enabled: false, dogId: 0, leadSeconds: 10 })
})

test('clear 会把资本模式恢复默认值', async (t) => {
  const store = harness(t, {
    get: async () => ({ data: { ok: true, data: { enabled: true, dogId: 601, leadSeconds: 45 } } }),
  })
  await store.fetchCapitalMode('a')
  assert.equal(store.capitalMode.enabled, true)
  store.clear()
  assert.deepEqual({ ...store.capitalMode }, { enabled: false, dogId: 0, leadSeconds: 10 })
  assert.equal(store.capitalModeLoading, false)
  assert.equal(store.capitalModeSaving, false)
})
