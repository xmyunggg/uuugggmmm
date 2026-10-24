import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 卡密到期/封禁时后端返回 403，前端必须和 401 一样清掉登录态回登录页，
// 否则用户会停在一个「看起来还登录着但所有请求都失败」的面板里。
function loadApiModule() {
  const source = readFileSync(new URL('../src/api/index.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })

  const handlers = {}
  const tokenRef = { value: 'admin-token' }
  const toasts = []
  const axiosInstance = {
    interceptors: {
      request: { use: (onFulfilled) => { handlers.request = onFulfilled } },
      response: { use: (_onFulfilled, onRejected) => { handlers.response = onRejected } },
    },
  }
  const fakeAxios = {
    create: () => axiosInstance,
    isCancel: () => false,
  }
  const fakeRequire = (id) => {
    if (id === 'axios')
      return { __esModule: true, default: fakeAxios }
    if (id === '@vueuse/core')
      return { __esModule: true, useStorage: () => tokenRef }
    if (id === '@/stores/toast') {
      return {
        __esModule: true,
        useToastStore: () => ({
          error: message => toasts.push({ level: 'error', message }),
          warning: message => toasts.push({ level: 'warning', message }),
        }),
      }
    }
    return require(id)
  }

  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(fakeRequire, module, module.exports)
  return { api: module.exports.default, handlers, tokenRef, toasts }
}

async function triggerError(handlers, { status, message }) {
  const error = { response: { status, data: { error: message } }, config: {}, message }
  try {
    await handlers.response(error)
  }
  catch {
    // 拦截器最后一定会 reject，这里只关心副作用
  }
  return error
}

function withWindow(pathname) {
  const location = { pathname, href: '' }
  globalThis.window = { location }
  return location
}

test('403 账号已过期：清 token 并跳登录页，提示后端文案', async () => {
  const { handlers, tokenRef, toasts } = loadApiModule()
  const location = withWindow('/dashboard')
  await triggerError(handlers, { status: 403, message: '账号已过期，请续费后重新登录' })

  assert.equal(tokenRef.value, '')
  assert.equal(location.href, '/login')
  assert.deepEqual(toasts, [{ level: 'warning', message: '账号已过期，请续费后重新登录' }])
})

test('403 账号已被封禁：同样退出登录', async () => {
  const { handlers, tokenRef, toasts } = loadApiModule()
  const location = withWindow('/accounts')
  await triggerError(handlers, { status: 403, message: '账号已被封禁，请联系管理员' })

  assert.equal(tokenRef.value, '')
  assert.equal(location.href, '/login')
  assert.deepEqual(toasts, [{ level: 'warning', message: '账号已被封禁，请联系管理员' }])
})

test('403 权限类错误：保持原有 toast 行为，不强制跳转', async () => {
  const { handlers, tokenRef, toasts } = loadApiModule()
  const location = withWindow('/dashboard')
  await triggerError(handlers, { status: 403, message: '需要管理员权限' })

  assert.equal(tokenRef.value, 'admin-token')
  assert.equal(location.href, '')
  assert.deepEqual(toasts, [{ level: 'error', message: '需要管理员权限' }])
})

test('401 仍然跳登录页（回归）', async () => {
  const { handlers, tokenRef, toasts } = loadApiModule()
  const location = withWindow('/dashboard')
  await triggerError(handlers, { status: 401, message: 'Unauthorized' })

  assert.equal(tokenRef.value, '')
  assert.equal(location.href, '/login')
  assert.deepEqual(toasts, [{ level: 'warning', message: '登录已过期，请重新登录' }])
})

test('已停留在登录页时不重复跳转，也不重复弹提示（登录页自己内联展示错误）', async () => {
  const { handlers, toasts } = loadApiModule()
  const location = withWindow('/login')
  await triggerError(handlers, { status: 403, message: '账号已过期，请续费后重新登录' })

  // Login.vue 会拿到 error.response.data 并内联展示，这里再弹一次就是重复反馈
  assert.equal(location.href, '')
  assert.deepEqual(toasts, [])
})
