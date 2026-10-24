import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { useToastStore } from '@/stores/toast'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')

const api = axios.create({
  baseURL: '/',
  timeout: 10000,
})

export function normalizeApiErrorMessage(raw: unknown): string {
  const text = String(raw || '').trim()
  if (!text)
    return ''

  const codeMatch = text.match(/\bcode=\d+\b\s*(.*)$/)
  const codeIndex = codeMatch?.index ?? -1
  if (codeMatch?.[1] && codeIndex >= 0 && text.slice(0, codeIndex).includes('.'))
    return codeMatch[1].trim()
  return text
}

export function getApiErrorMessage(error: unknown, fallback = '请求失败'): string {
  const candidate = error as any
  const data = candidate?.response?.data
    || (candidate && typeof candidate === 'object' ? candidate : null)
  const raw = data?.errorMessage
    || data?.error
    || data?.message
    || candidate?.message
    || (typeof error === 'string' ? error : '')
  return normalizeApiErrorMessage(raw) || fallback
}

api.interceptors.request.use((config) => {
  const token = tokenRef.value
  if (token) {
    config.headers['x-admin-token'] = token
  }
  const accountId = accountIdRef.value
  if (accountId && !config.headers.has('x-account-id')) {
    config.headers.set('x-account-id', accountId)
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

api.interceptors.response.use((response) => {
  const responseData = response?.data
  const skipToast = (response?.config as any)?.skipErrorToast
  if (responseData && typeof responseData === 'object' && responseData.ok === false) {
    const message = getApiErrorMessage(responseData, '')
    if (message) {
      responseData.error = message
      if (!skipToast)
        useToastStore().error(message)
    }
  }
  return response
}, (error) => {
  // Aborting an in-flight request is expected when a modal closes or a QR flow restarts.
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED')
    return Promise.reject(error)

  const toast = useToastStore()
  const normalizedMessage = getApiErrorMessage(error, '')
  if (normalizedMessage) {
    error.message = normalizedMessage
    if (error.response?.data && typeof error.response.data === 'object')
      error.response.data.error = normalizedMessage
  }

  // 支持 skipErrorToast 配置，让调用方自行处理错误
  const skipToast = error.config?.skipErrorToast

  if (error.response) {
    const status = error.response.status
    const backendError = getApiErrorMessage(error, '')
    // 卡密到期/被封禁时后端返回 403，和 401 一样需要清掉本地登录态回登录页
    const cardBlocked = status === 403
      && (backendError.includes('账号已过期') || backendError.includes('账号已被封禁'))
    if (status === 401 || cardBlocked) {
      // Avoid redirect loop or multiple redirects
      if (!window.location.pathname.includes('/login')) {
        tokenRef.value = ''
        window.location.href = '/login'
        toast.warning(cardBlocked ? backendError : '登录已过期，请重新登录')
      }
    }
    else if (status === 403 && error.response.data?.errorType === 'password_change_required') {
      // 默认密码未改：后端拒绝业务接口，直接把用户送到改密页
      if (!window.location.pathname.includes('/force-password-change'))
        window.location.href = '/force-password-change'
    }
    else if (status >= 500) {
      // 后端运行态可预期错误：不弹全局500，交给页面状态处理
      if (backendError === '账号未运行' || backendError === 'API Timeout') {
        return Promise.reject(error)
      }
      if (!skipToast) {
        toast.error(backendError || '请求失败，请稍后重试')
      }
    }
    else {
      if (!skipToast) {
        toast.error(getApiErrorMessage(error, `请求失败，请联系管理员！`))
      }
    }
  }
  else if (error.request) {
    if (!skipToast) {
      toast.error('网络错误，无法连接到服务器')
    }
  }
  else {
    if (!skipToast) {
      toast.error(`错误: ${getApiErrorMessage(error, '请求失败')}`)
    }
  }

  return Promise.reject(error)
})

export default api
