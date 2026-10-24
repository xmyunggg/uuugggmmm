// 抓包登录的纯逻辑：会话快照归一、步骤/帮助文案与错误判定。
// 后端 /api/capture/* 由 core/src/controllers/admin/capture-routes.ts 提供，
// 这里集中处理返回结构，避免组件里散落字段名。

export const CAPTURE_SUCCESS_STORAGE_KEY = 'capture_login_succeeded'
export const CAPTURE_POLL_INTERVAL_MS = 1500
export const CAPTURE_POLL_ERROR_INTERVAL_MS = 3000

export interface CaptureAddress {
  address: string
  kind: string
}

export interface CaptureFlowState {
  id: string
  platform: 'qq' | 'wx'
  codeCaptured: boolean
  accountGid: string
  friendCount: number
  captureStatus: string
  proxy: {
    running: boolean
    status: string
    error: string
  }
  publicInfo: {
    host: string
    addresses: CaptureAddress[]
    mitmPort: number
    remainingSec: number
    certificateUrl: string
  }
}

/** 把 /api/capture/sessions/:id 的返回归一为前端状态；结构无效时返回 null */
export function normalizeCaptureSnapshot(payload: any): CaptureFlowState | null {
  if (!payload || typeof payload !== 'object' || !payload.id)
    return null

  const publicInfo = payload.publicInfo && typeof payload.publicInfo === 'object' ? payload.publicInfo : {}
  const proxy = payload.proxy && typeof payload.proxy === 'object' ? payload.proxy : {}
  const addresses: CaptureAddress[] = Array.isArray(publicInfo.addresses)
    ? publicInfo.addresses
        .filter((item: any) => item && item.address)
        .map((item: any) => ({ address: String(item.address), kind: String(item.kind || '') }))
    : []

  return {
    id: String(payload.id),
    platform: payload.platform === 'wx' ? 'wx' : 'qq',
    codeCaptured: payload.codeCaptured === true,
    accountGid: String(payload.accountGid || ''),
    friendCount: Number(payload.friendCount) || 0,
    captureStatus: String(payload.captureStatus || ''),
    proxy: {
      running: proxy.running === true,
      status: String(proxy.status || ''),
      error: String(proxy.error || ''),
    },
    publicInfo: {
      host: String(publicInfo.host || ''),
      addresses,
      mitmPort: Number(publicInfo.mitmPort) || 0,
      remainingSec: Number(publicInfo.remainingSec) || 0,
      certificateUrl: String(publicInfo.certificateUrl || ''),
    },
  }
}

/** 任务已在服务端失效（过期/被清理）→ 前端应停止轮询 */
export function isCaptureFlowGone(error: any): boolean {
  return error?.response?.status === 404
}

/** 手机仍停留在已添加的账号上，服务端拒绝重复添加 */
export function isDuplicateCaptureAccountError(error: any): boolean {
  return error?.response?.data?.code === 'DUPLICATE_CAPTURE_ACCOUNT'
}

export function isCaptureRequestCancelled(error: any): boolean {
  return error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED'
}

export function captureHelpSteps(mode: 'first' | 'daily'): string[] {
  return mode === 'first'
    ? [
        '点击开始抓取，获取本次代理地址和端口',
        '打开 CA 证书，并在手机系统中安装和信任',
        '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
        '将手机 Wi-Fi 代理设置为页面显示的地址和端口',
        '彻底关闭后重新打开对应的 QQ 或微信农场',
        'Code 获取后账号会立即添加；QQ 好友 GID 将在后台继续同步',
        'QQ 农场保持打开，完整好友列表同步后会立即释放代理，最迟约 15 秒',
      ]
    : [
        '点击开始抓取，确认本次代理地址和端口',
        '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
        '将手机 Wi-Fi 代理更新为本次显示的地址和端口',
        '重新打开对应农场，并保持页面打开',
        '账号添加后，QQ 农场继续保持打开，最迟约 15 秒完成后台同步',
        '后台同步结束后，将手机 Wi-Fi 代理改回关闭',
      ]
}

export function captureDeviceSteps(device: 'ios' | 'android'): string[] {
  return device === 'ios'
    ? [
        '在 Safari 中点击“打开证书”并允许下载描述文件',
        '进入“设置 → 通用 → VPN 与设备管理”安装描述文件',
        '进入“设置 → 通用 → 关于本机 → 证书信任设置”启用完全信任',
      ]
    : [
        '点击“打开证书”下载 CA 文件',
        '进入系统安全设置中的“安装证书”或“凭据存储”',
        '选择 CA 证书并确认安装；不同品牌的菜单名称可能不同',
      ]
}

export function captureCurrentStep(flow: CaptureFlowState | null): string {
  if (!flow)
    return '开始新的抓取任务'
  if (!flow.codeCaptured)
    return `设置 Wi-Fi 代理并打开${flow.platform === 'qq' ? ' QQ' : '微信'}农场`
  return '已获取 Code，正在立即完成账号操作'
}

export function captureNextStep(flow: CaptureFlowState | null, isEdit: boolean): string {
  const action = isEdit ? '更新' : '添加'
  if (!flow)
    return '开始后按本次显示的代理信息设置手机 Wi-Fi'
  if (!flow.codeCaptured)
    return '重新打开小程序，并保持农场页面打开'
  if (flow.platform === 'qq')
    return `即将自动${action}账号，好友 GID 将在后台同步`
  return `即将自动${action}账号`
}

export function captureAddressLabel(kind: string): string {
  if (kind === 'tailscale')
    return 'Tailscale'
  if (kind === 'lan')
    return '局域网'
  return '其他'
}
