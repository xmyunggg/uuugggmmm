import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 直接用真实模块，只有渲染层不参与
function loadCaptureLogin() {
  const source = readFileSync(new URL('../src/utils/capture-login.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

const {
  captureAddressLabel,
  captureCurrentStep,
  captureDeviceSteps,
  captureHelpSteps,
  captureNextStep,
  isCaptureFlowGone,
  isCaptureRequestCancelled,
  isDuplicateCaptureAccountError,
  normalizeCaptureSnapshot,
} = loadCaptureLogin()

// 与 core/src/controllers/admin/capture-routes.ts 的 serializeFlow 保持一致
function backendSnapshot(overrides = {}) {
  return {
    id: 'flow-1',
    platform: 'qq',
    codeCaptured: false,
    accountGid: '',
    friendCount: 0,
    captureStatus: 'waiting',
    proxy: { running: true, status: 'running', error: '' },
    publicInfo: {
      host: '192.168.1.8',
      addresses: [{ address: '192.168.1.8', kind: 'lan' }],
      mitmPort: 18000,
      mitmProxyAutoStopSec: 300,
      remainingSec: 297,
      certificateUrl: '/api/public/capture-certificate/flow-1/token-1',
    },
    completed: false,
    result: null,
    ...overrides,
  }
}

test('按后端 serializeFlow 结构归一抓包会话快照', () => {
  const flow = normalizeCaptureSnapshot(backendSnapshot())
  assert.deepEqual(flow, {
    id: 'flow-1',
    platform: 'qq',
    codeCaptured: false,
    accountGid: '',
    friendCount: 0,
    captureStatus: 'waiting',
    proxy: { running: true, status: 'running', error: '' },
    publicInfo: {
      host: '192.168.1.8',
      addresses: [{ address: '192.168.1.8', kind: 'lan' }],
      mitmPort: 18000,
      remainingSec: 297,
      certificateUrl: '/api/public/capture-certificate/flow-1/token-1',
    },
  })
})

test('已抓到的 Code、好友数量与代理错误照实回填', () => {
  const flow = normalizeCaptureSnapshot(backendSnapshot({
    codeCaptured: true,
    accountGid: '123456',
    friendCount: 42,
    proxy: { running: false, status: 'stopped', error: '代理已释放' },
  }))
  assert.equal(flow.codeCaptured, true)
  assert.equal(flow.accountGid, '123456')
  assert.equal(flow.friendCount, 42)
  assert.equal(flow.proxy.error, '代理已释放')
})

test('缺失或非法字段回落为安全的默认值', () => {
  const flow = normalizeCaptureSnapshot({ id: 99, platform: 'wechat' })
  assert.equal(flow.id, '99')
  assert.equal(flow.platform, 'qq', '非 wx 平台一律按 QQ 处理')
  assert.deepEqual(flow.publicInfo.addresses, [])
  assert.equal(flow.publicInfo.mitmPort, 0)
  assert.equal(flow.publicInfo.remainingSec, 0)
  assert.equal(flow.publicInfo.certificateUrl, '')
  assert.equal(flow.proxy.running, false)

  const partial = normalizeCaptureSnapshot(backendSnapshot({
    publicInfo: {
      host: '10.0.0.9',
      addresses: [{ address: '10.0.0.9', kind: 'tailscale' }, { kind: 'lan' }, null, {}],
      mitmPort: 18001,
      remainingSec: 12,
    },
  }))
  assert.deepEqual(partial.publicInfo.addresses, [{ address: '10.0.0.9', kind: 'tailscale' }])
})

test('结构无效的返回归一为 null', () => {
  assert.equal(normalizeCaptureSnapshot(null), null)
  assert.equal(normalizeCaptureSnapshot(undefined), null)
  assert.equal(normalizeCaptureSnapshot('flow'), null)
  assert.equal(normalizeCaptureSnapshot({ platform: 'qq' }), null)
})

test('区分任务失效、重复账号与主动取消', () => {
  assert.equal(isCaptureFlowGone({ response: { status: 404 } }), true)
  assert.equal(isCaptureFlowGone({ response: { status: 502 } }), false)
  assert.equal(isCaptureFlowGone(new Error('boom')), false)

  assert.equal(isDuplicateCaptureAccountError({ response: { data: { code: 'DUPLICATE_CAPTURE_ACCOUNT' } } }), true)
  assert.equal(isDuplicateCaptureAccountError({ response: { data: { code: 'OTHER' } } }), false)

  assert.equal(isCaptureRequestCancelled({ name: 'CanceledError' }), true)
  assert.equal(isCaptureRequestCancelled({ code: 'ERR_CANCELED' }), true)
  assert.equal(isCaptureRequestCancelled(new Error('boom')), false)
})

test('抓包步骤文案按平台与是否编辑区分', () => {
  assert.equal(captureCurrentStep(null), '开始新的抓取任务')
  assert.equal(captureNextStep(null, false), '开始后按本次显示的代理信息设置手机 Wi-Fi')

  const waitingQq = normalizeCaptureSnapshot(backendSnapshot())
  assert.equal(captureCurrentStep(waitingQq), '设置 Wi-Fi 代理并打开 QQ农场')
  assert.equal(captureNextStep(waitingQq, false), '重新打开小程序，并保持农场页面打开')

  const waitingWx = normalizeCaptureSnapshot(backendSnapshot({ platform: 'wx' }))
  assert.equal(captureCurrentStep(waitingWx), '设置 Wi-Fi 代理并打开微信农场')

  const capturedQq = normalizeCaptureSnapshot(backendSnapshot({ codeCaptured: true }))
  assert.equal(captureCurrentStep(capturedQq), '已获取 Code，正在立即完成账号操作')
  assert.equal(captureNextStep(capturedQq, false), '即将自动添加账号，好友 GID 将在后台同步')
  assert.equal(captureNextStep(capturedQq, true), '即将自动更新账号，好友 GID 将在后台同步')

  const capturedWx = normalizeCaptureSnapshot(backendSnapshot({ codeCaptured: true, platform: 'wx' }))
  assert.equal(captureNextStep(capturedWx, false), '即将自动添加账号')
  assert.equal(captureNextStep(capturedWx, true), '即将自动更新账号')
})

test('使用说明按首次/已装证书与设备类型给出对应步骤', () => {
  const first = captureHelpSteps('first')
  const daily = captureHelpSteps('daily')
  assert.equal(first.length, 7)
  assert.equal(daily.length, 6)
  assert.ok(first[1].includes('安装'))
  assert.ok(daily.every(step => !step.includes('CA 证书，并在手机系统中安装')))

  const ios = captureDeviceSteps('ios')
  const android = captureDeviceSteps('android')
  assert.equal(ios.length, 3)
  assert.equal(android.length, 3)
  assert.ok(ios[0].includes('Safari'))
  assert.ok(android[0].includes('下载 CA 文件'))
})

test('代理地址来源标签', () => {
  assert.equal(captureAddressLabel('tailscale'), 'Tailscale')
  assert.equal(captureAddressLabel('lan'), '局域网')
  assert.equal(captureAddressLabel(''), '其他')
  assert.equal(captureAddressLabel('wifi'), '其他')
})
