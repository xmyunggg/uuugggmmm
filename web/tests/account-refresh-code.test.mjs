import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia, setActivePinia } = require('pinia')
const ts = require('typescript')

const ACCOUNT_SOURCE = readFileSync(new URL('../src/stores/account.ts', import.meta.url), 'utf8')

// Run the real account store; only the HTTP client is replaced so we can assert the request shape.
function harness(t, api) {
  const pinia = createPinia()
  setActivePinia(pinia)
  t.after(() => disposePinia(pinia))
  const imports = { '@/api': { __esModule: true, default: api } }
  const { outputText } = ts.transpileModule(ACCOUNT_SOURCE, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => imports[id] || require(id), module, module.exports)
  return module.exports.useAccountStore(pinia)
}

function recordingApi(reply) {
  const calls = []
  return {
    calls,
    get: async (url) => {
      calls.push({ method: 'get', url })
      return { data: [] }
    },
    post: async (url, body, config) => {
      calls.push({ method: 'post', url, body, config })
      return { data: reply }
    },
    delete: async (url) => {
      calls.push({ method: 'delete', url })
      return { data: {} }
    },
  }
}

test('单账号刷新只请求该账号的接口，不会触发批量刷新', async (t) => {
  const reply = { ok: true, data: { total: 1, success: 1, failed: 0, skipped: 0, results: [{ accountId: '7', name: '微信号', ok: true }] } }
  const api = recordingApi(reply)
  const store = harness(t, api)

  const result = await store.refreshWxCode('7')

  const refreshCalls = api.calls.filter(c => c.method === 'post' && String(c.url).includes('refresh-wx-code'))
  assert.equal(refreshCalls.length, 1)
  assert.equal(refreshCalls[0].url, '/api/accounts/7/refresh-wx-code')
  assert.ok(!api.calls.some(c => String(c.url).includes('refresh-wx-codes')), '不应调用批量接口')
  assert.deepEqual(result, reply)
})

test('单账号刷新会带上长超时并刷新账号列表', async (t) => {
  const api = recordingApi({ ok: true, data: { total: 1, success: 1, failed: 0, skipped: 0, results: [] } })
  const store = harness(t, api)

  await store.refreshWxCode('9')

  const call = api.calls.find(c => String(c.url).includes('refresh-wx-code'))
  assert.equal(call.config.timeout, 120000)
  assert.ok(api.calls.some(c => String(c.url).includes('/api/accounts') && c.method === 'get'), '换 Code 后应重新拉账号列表')
})

test('账号 id 会被原样编码进路径，避免拼接出错误地址', async (t) => {
  const api = recordingApi({ ok: false, error: '刷新失败', data: { total: 1, success: 0, failed: 1, skipped: 0, results: [{ accountId: 'wx-abc', name: 'n', ok: false, error: '刷新失败' }] } })
  const store = harness(t, api)

  const result = await store.refreshWxCode('wx-abc')

  const call = api.calls.find(c => String(c.url).includes('refresh-wx-code'))
  assert.equal(call.url, '/api/accounts/wx-abc/refresh-wx-code')
  assert.equal(result.ok, false)
  assert.equal(result.data.results[0].error, '刷新失败')
})

test('store 同时导出单账号与批量刷新，两者互不影响', () => {
  assert.match(ACCOUNT_SOURCE, /async function refreshWxCode\(id: string\)/)
  assert.match(ACCOUNT_SOURCE, /async function refreshWxCodes\(\)/)
  assert.match(ACCOUNT_SOURCE, /refreshWxCodes,\n\s+refreshWxCode,/)
})
