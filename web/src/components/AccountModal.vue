<script setup lang="ts">
import type { CaptureFlowState } from '@/utils/capture-login'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NRadio, NRadioGroup } from 'naive-ui/es/radio'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import {
  CAPTURE_POLL_ERROR_INTERVAL_MS,
  CAPTURE_POLL_INTERVAL_MS,
  CAPTURE_SUCCESS_STORAGE_KEY,
  captureAddressLabel,
  captureCurrentStep as captureCurrentStepText,
  captureDeviceSteps as captureDeviceStepsFor,
  captureHelpSteps as captureHelpStepsFor,
  captureNextStep as captureNextStepText,
  isCaptureFlowGone,
  isCaptureRequestCancelled,
  isDuplicateCaptureAccountError,
  normalizeCaptureSnapshot,
} from '@/utils/capture-login'
import { runWxLoginStatusPoll } from '@/utils/wx-login-poll'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<'code' | 'wx_qr' | 'qq_qr' | 'capture'>('code')
const loginSettingsLoaded = ref(false)
const loginSettings = ref({
  wechatQrLogin: true,
  qqQrLogin: false,
  napCatEndpoint: '',
  napCatSignature: '',
})
let loginSettingsRequestVersion = 0
const wxTaskId = ref('')
const wxStatus = ref('')
const wxError = ref('')
const wxLoading = ref(false)
const wxQrUrl = ref('')
let wxPollTimer: ReturnType<typeof setTimeout> | undefined
let wxQrObjectUrl = ''
let wxFlowVersion = 0
let wxPollController: AbortController | undefined
let wxPollInFlight: Promise<void> | undefined
let wxPollKey = ''
let wxPendingCode = ''
const qqTaskId = ref('')
const qqStatus = ref('')
const qqError = ref('')
const qqLoading = ref(false)
const qqQrUrl = ref('')
let qqPollTimer: ReturnType<typeof setTimeout> | undefined
let qqFlowVersion = 0
let qqPollController: AbortController | undefined
let qqPollInFlight: Promise<void> | undefined
let qqPollKey = ''
let qqPendingCode = ''
let qrNameSubmitTimer: ReturnType<typeof setTimeout> | undefined

const wechatQrLoginEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.wechatQrLogin)
const qqQrLoginEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.qqQrLogin)

// ---------------- 抓包登录 ----------------

const captureEnabled = ref(false)
const captureLoading = ref(false)
const captureCompleting = ref(false)
const captureError = ref('')
const captureCopiedField = ref<'host' | 'port' | ''>('')
const captureAccountName = ref('')
const capturePlatform = ref<'qq' | 'wx'>('qq')
const showCaptureHelp = ref(false)
const captureHelpMode = ref<'first' | 'daily'>('first')
const captureHelpDevice = ref<'ios' | 'android'>('ios')
const captureFlow = ref<CaptureFlowState | null>(null)
let capturePollTimer: ReturnType<typeof setTimeout> | undefined
let capturePollController: AbortController | undefined
let capturePollInFlight: Promise<void> | undefined
let capturePollKey = ''
let captureFlowVersion = 0

const captureHelpSteps = computed(() => captureHelpStepsFor(captureHelpMode.value))
const captureDeviceSteps = computed(() => captureDeviceStepsFor(captureHelpDevice.value))
const captureCurrentStep = computed(() => captureCurrentStepText(captureFlow.value))
const captureNextStep = computed(() => captureNextStepText(captureFlow.value, !!props.editData))

// 表单数据
const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

// 添加账号
async function addAccount(data: any, isRelogin = false) {
  const name = String(data?.name || '').trim()
  if (!isRelogin && !name) {
    errorMessage.value = '请输入账号备注'
    return false
  }

  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', { ...data, name })
    if (res.data.ok) {
      emit('saved')
      close()
      return true
    }
    else {
      errorMessage.value = `保存失败: ${getApiErrorMessage(res.data, '请求失败')}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${getApiErrorMessage(e, '请求失败')}`
  }
  finally {
    loading.value = false
  }

  return false
}

function clearQrNameSubmitTimer() {
  if (qrNameSubmitTimer) {
    clearTimeout(qrNameSubmitTimer)
    qrNameSubmitTimer = undefined
  }
}

async function addQrAccount(platform: 'wx' | 'qq', code: string, nickname: string) {
  const name = form.name.trim() || nickname
  if (platform === 'wx')
    wxPendingCode = code
  else
    qqPendingCode = code

  if (!name) {
    if (platform === 'wx') {
      wxStatus.value = '登录授权已完成，等待填写账号备注'
      wxError.value = '未获取到微信昵称，请填写账号备注'
    }
    else {
      qqStatus.value = '登录授权已完成，等待填写账号备注'
      qqError.value = '未获取到 QQ 昵称，请填写账号备注'
    }
    return
  }

  form.name = name
  await submitPendingQrAccount(platform)
}

async function submitPendingQrAccount(platform: 'wx' | 'qq') {
  const name = form.name.trim() || props.editData?.name || ''
  const code = platform === 'wx' ? wxPendingCode : qqPendingCode
  if (!name || !code || !props.show || activeLoginTab.value !== `${platform}_qr`)
    return

  if (platform === 'wx') {
    wxPendingCode = ''
    wxError.value = ''
    wxStatus.value = props.editData ? '正在重新登录...' : '正在添加账号...'
  }
  else {
    qqPendingCode = ''
    qqError.value = ''
    qqStatus.value = props.editData ? '正在重新登录...' : '正在添加账号...'
  }

  const payload: any = { name, code, platform, loginType: 'manual' }
  const saved = await addAccount(payload, !!props.editData)
  if (!saved && props.show && activeLoginTab.value === `${platform}_qr`) {
    if (platform === 'wx')
      wxPendingCode = code
    else
      qqPendingCode = code
  }
}

async function loadLoginSettings() {
  const requestVersion = ++loginSettingsRequestVersion
  loginSettingsLoaded.value = false
  try {
    const response = await api.get('/api/settings/login-config', { skipErrorToast: true } as any)
    if (requestVersion !== loginSettingsRequestVersion)
      return
    const data = response.data?.data
    loginSettings.value = {
      wechatQrLogin: typeof data?.wechatQrLogin === 'boolean' ? data.wechatQrLogin : true,
      qqQrLogin: typeof data?.qqQrLogin === 'boolean' ? data.qqQrLogin : false,
      napCatEndpoint: typeof data?.napCatEndpoint === 'string' ? data.napCatEndpoint : '',
      napCatSignature: typeof data?.napCatSignature === 'string' ? data.napCatSignature : '',
    }
  }
  catch {
    if (requestVersion !== loginSettingsRequestVersion)
      return
    // Keep the existing login entries available when an older server has no endpoint yet.
    loginSettings.value = {
      wechatQrLogin: true,
      qqQrLogin: false,
      napCatEndpoint: '',
      napCatSignature: '',
    }
  }
  finally {
    if (requestVersion === loginSettingsRequestVersion) {
      loginSettingsLoaded.value = true
      // 默认打开扫码登录：优先 QQ，其次微信，最后 Code
      if (loginSettings.value.qqQrLogin)
        activeLoginTab.value = 'qq_qr'
      else if (loginSettings.value.wechatQrLogin)
        activeLoginTab.value = 'wx_qr'
      else
        activeLoginTab.value = 'code'
    }
  }
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!props.editData && !form.name.trim()) {
    errorMessage.value = '请输入账号备注'
    return
  }
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }
  form.name = form.name.trim()

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  const payload: any = {
    name: form.name,
    code,
    platform: props.editData ? (props.editData.platform || 'qq') : form.platform,
    loginType: 'manual',
  }

  await addAccount(payload, !!props.editData)
}

function stopWxPolling() {
  if (wxPollTimer) {
    clearTimeout(wxPollTimer)
    wxPollTimer = undefined
  }
  wxPollController?.abort()
  wxPollController = undefined
}

function resetWxLogin() {
  const oldTaskId = wxTaskId.value
  wxFlowVersion += 1
  stopWxPolling()
  if (oldTaskId) {
    void api.delete(`/api/wx-login/tasks/${oldTaskId}`, { skipErrorToast: true } as any).catch(() => undefined)
  }
  if (wxQrObjectUrl) {
    URL.revokeObjectURL(wxQrObjectUrl)
    wxQrObjectUrl = ''
  }
  wxTaskId.value = ''
  wxStatus.value = ''
  wxError.value = ''
  wxQrUrl.value = ''
  wxLoading.value = false
  wxPendingCode = ''
  clearQrNameSubmitTimer()
}

function isWxFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === wxFlowVersion && taskId === wxTaskId.value
}

async function getWxCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const codeResult = await api.post(`/api/wx-login/tasks/${taskId}/code`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const code = String(codeResult.data?.data?.code || '').trim()
  const nickname = String(codeResult.data?.data?.nickname || '').trim()
  if (!code)
    throw new Error('未获取到登录 Code')

  await addQrAccount('wx', code, nickname)
}

async function confirmWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  wxStatus.value = '正在建立登录会话...'
  await api.post(`/api/wx-login/tasks/${taskId}/confirm`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  await getWxCodeAndAdd(taskId, flowVersion)
}

async function pollWxLoginRequest(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const controller = new AbortController()
  wxPollController = controller
  try {
    const response = await runWxLoginStatusPoll(() => api.get(`/api/wx-login/tasks/${taskId}/status`, {
      timeout: 40000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any))
    if (!isWxFlowActive(taskId, flowVersion))
      return
    const status = response.data?.data?.status
    if (status === 'waiting') {
      wxStatus.value = '等待微信扫码'
    }
    else if (status === 'scanned') {
      wxStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'authorized') {
      stopWxPolling()
      await confirmWxLogin(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      wxError.value = '二维码已失效，请重新获取'
      return
    }
    wxPollTimer = setTimeout(() => void pollWxLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isWxFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    wxError.value = getApiErrorMessage(error, '登录状态检查失败')
  }
  finally {
    if (wxPollController === controller)
      wxPollController = undefined
  }
}

async function pollWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const previous = wxPollInFlight
  const previousKey = wxPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isWxFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }

  const current = pollWxLoginRequest(taskId, flowVersion)
  wxPollInFlight = current
  wxPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (wxPollInFlight === current) {
      wxPollInFlight = undefined
      wxPollKey = ''
    }
  }
}

async function startWxLogin() {
  if (!wechatQrLoginEnabled.value) {
    activeLoginTab.value = 'code'
    return
  }
  resetWxLogin()
  const flowVersion = wxFlowVersion
  wxLoading.value = true
  try {
    const response = await api.post('/api/wx-login/tasks', { app_id: 'wx5306c5978fdb76e4' })
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (flowVersion !== wxFlowVersion) {
      void api.delete(`/api/wx-login/tasks/${taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    wxTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, { responseType: 'blob' })
    if (!isWxFlowActive(taskId, flowVersion))
      return
    wxQrObjectUrl = URL.createObjectURL(qrResponse.data)
    wxQrUrl.value = wxQrObjectUrl
    wxStatus.value = '等待微信扫码'
    void pollWxLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion !== wxFlowVersion)
      return
    wxError.value = getApiErrorMessage(error, '二维码获取失败')
  }
  finally {
    if (flowVersion === wxFlowVersion)
      wxLoading.value = false
  }
}

function stopQqPolling() {
  if (qqPollTimer) {
    clearTimeout(qqPollTimer)
    qqPollTimer = undefined
  }
  qqPollController?.abort()
  qqPollController = undefined
}

function resetQqLogin() {
  const taskId = qqTaskId.value
  qqFlowVersion += 1
  stopQqPolling()
  if (taskId)
    void cancelQqLoginTask(taskId)
  qqTaskId.value = ''
  qqStatus.value = ''
  qqError.value = ''
  qqQrUrl.value = ''
  qqLoading.value = false
  qqPendingCode = ''
  clearQrNameSubmitTimer()
}

function isQqFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === qqFlowVersion && taskId === qqTaskId.value
}

function ensureQqApiOk(response: any, fallback: string) {
  const payload = response?.data
  if (payload?.ok === false)
    throw new Error(getApiErrorMessage(payload, fallback))
  return payload
}

async function getQqCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return
  qqLoading.value = true
  qqStatus.value = '正在获取小程序授权 Code...'
  try {
    const response = await api.post(`/api/qq-login/tasks/${taskId}/code`, undefined, { timeout: 120000 } as any)
    if (!isQqFlowActive(taskId, flowVersion))
      return
    const payload = ensureQqApiOk(response, '获取小程序授权 Code 失败')
    const code = String(payload?.data?.code || '').trim()
    const nickname = String(payload?.data?.nickname || '').trim()
    if (!code)
      throw new Error('未获取到登录 Code')
    await addQrAccount('qq', code, nickname)
  }
  catch (error: any) {
    if (isQqFlowActive(taskId, flowVersion))
      qqError.value = getApiErrorMessage(error, '获取小程序授权 Code 失败')
  }
  finally {
    if (isQqFlowActive(taskId, flowVersion))
      qqLoading.value = false
  }
}

async function cancelQqLoginTask(taskId: string) {
  if (!taskId)
    return
  try {
    const response = await api.post(`/api/qq-login/tasks/${taskId}/cancel`, undefined, {
      timeout: 120000,
      skipErrorToast: true,
    } as any)
    ensureQqApiOk(response, 'QQ 登录任务取消失败')
  }
  catch {}
}

async function pollQqLoginRequest(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return

  const controller = new AbortController()
  qqPollController = controller
  try {
    const response = await api.post(`/api/qq-login/tasks/${taskId}/status`, undefined, {
      timeout: 120000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any)
    if (!isQqFlowActive(taskId, flowVersion))
      return

    const payload = ensureQqApiOk(response, 'QQ 登录状态检查失败')
    const task = payload?.data
    if (!task)
      throw new Error('QQ 登录状态返回无效')
    const status = String(task?.status || '').trim()
    const qrImage = String(task?.qr_image || '').trim()
    if (qrImage)
      qqQrUrl.value = qrImage

    if (status === 'waiting_scan') {
      qqStatus.value = '等待 QQ 扫码'
    }
    else if (status === 'scanned') {
      qqStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'confirmed') {
      stopQqPolling()
      await getQqCodeAndAdd(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      qqError.value = '二维码已失效，请重新获取'
      return
    }
    if (!status) {
      qqError.value = 'QQ 登录状态异常，请重新获取二维码'
      return
    }
    qqPollTimer = setTimeout(() => void pollQqLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isQqFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    qqError.value = getApiErrorMessage(error, 'QQ 登录状态检查失败')
  }
  finally {
    if (qqPollController === controller)
      qqPollController = undefined
  }
}

async function pollQqLogin(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return

  const previous = qqPollInFlight
  const previousKey = qqPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isQqFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }

  const current = pollQqLoginRequest(taskId, flowVersion)
  qqPollInFlight = current
  qqPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (qqPollInFlight === current) {
      qqPollInFlight = undefined
      qqPollKey = ''
    }
  }
}

async function startQqLogin() {
  if (!qqQrLoginEnabled.value) {
    activeLoginTab.value = 'code'
    return
  }
  resetQqLogin()
  const flowVersion = qqFlowVersion
  qqLoading.value = true
  try {
    const response = await api.post('/api/qq-login/tasks')
    const payload = ensureQqApiOk(response, 'QQ 登录二维码获取失败')
    const task = payload?.data
    const taskId = String(task?.task_id || '')
    const qrImage = String(task?.qr_image || '')
    if (!taskId || !qrImage)
      throw new Error('未创建 QQ 登录任务')
    if (flowVersion !== qqFlowVersion)
      return
    qqTaskId.value = taskId
    qqQrUrl.value = qrImage
    qqStatus.value = '等待 QQ 扫码'
    void pollQqLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion === qqFlowVersion)
      qqError.value = getApiErrorMessage(error, 'QQ 登录二维码获取失败')
  }
  finally {
    if (flowVersion === qqFlowVersion)
      qqLoading.value = false
  }
}

function close() {
  resetWxLogin()
  resetQqLogin()
  void cancelCaptureSession()
  showCaptureHelp.value = false
  emit('close')
}

function stopCapturePolling() {
  if (capturePollTimer) {
    clearTimeout(capturePollTimer)
    capturePollTimer = undefined
  }
  capturePollController?.abort()
  capturePollController = undefined
}

function isCaptureFlowActive(flowId: string, flowVersion: number) {
  return flowVersion === captureFlowVersion && flowId === captureFlow.value?.id
}

async function loadCaptureConfig() {
  try {
    const response = await api.get('/api/capture/config', { skipErrorToast: true } as any)
    captureEnabled.value = response.data?.ok === true && response.data?.data?.enabled === true
  }
  catch {
    captureEnabled.value = false
  }
  if (!captureEnabled.value && activeLoginTab.value === 'capture')
    activeLoginTab.value = 'code'
}

async function cancelCaptureSession(deleteRemote = true) {
  const flowId = captureFlow.value?.id
  captureFlowVersion += 1
  stopCapturePolling()
  captureFlow.value = null
  captureCopiedField.value = ''
  if (flowId && deleteRemote)
    await api.delete(`/api/capture/sessions/${flowId}`, { skipErrorToast: true } as any).catch(() => undefined)
}

function resetCaptureError() {
  captureError.value = ''
  captureCopiedField.value = ''
}

async function startCaptureSession() {
  captureLoading.value = true
  captureError.value = ''
  await cancelCaptureSession()
  const flowVersion = captureFlowVersion
  try {
    const response = await api.post('/api/capture/sessions', {
      platform: capturePlatform.value,
      accountId: props.editData?.id || '',
    }, { timeout: 35000 })
    const flow = response.data?.data
    if (response.data?.ok !== true || !flow?.id)
      throw new Error(getApiErrorMessage(response.data, '启动抓取失败'))
    if (flowVersion !== captureFlowVersion)
      return
    const snapshot = normalizeCaptureSnapshot(flow)
    if (!snapshot)
      throw new Error('抓取任务返回无效')
    captureFlow.value = snapshot
    void pollCaptureStatus(snapshot.id, flowVersion)
  }
  catch (error: any) {
    if (flowVersion === captureFlowVersion)
      captureError.value = getApiErrorMessage(error, '启动抓取失败')
  }
  finally {
    captureLoading.value = false
  }
}

async function completeCaptureAccount() {
  const flow = captureFlow.value
  if (!flow || captureCompleting.value)
    return false
  captureCompleting.value = true
  captureError.value = ''
  try {
    const response = await api.post(`/api/capture/sessions/${flow.id}/complete`, {
      name: captureAccountName.value.trim(),
    }, { timeout: 35000 })
    if (response.data?.ok !== true)
      throw new Error(getApiErrorMessage(response.data, props.editData ? '更新账号失败' : '添加账号失败'))
    localStorage.setItem(CAPTURE_SUCCESS_STORAGE_KEY, '1')
    captureFlowVersion += 1
    stopCapturePolling()
    captureFlow.value = null
    emit('saved')
    close()
    return true
  }
  catch (error: any) {
    // 手机仍停留在已添加的账号上时服务端会拒绝，停止任务避免反复报错
    if (isDuplicateCaptureAccountError(error)) {
      captureFlowVersion += 1
      stopCapturePolling()
      captureFlow.value = null
    }
    captureError.value = getApiErrorMessage(error, props.editData ? '更新账号失败' : '添加账号失败')
    return false
  }
  finally {
    captureCompleting.value = false
  }
}

async function pollCaptureStatusRequest(flowId: string, flowVersion: number) {
  if (!isCaptureFlowActive(flowId, flowVersion))
    return

  const controller = new AbortController()
  capturePollController = controller
  try {
    const response = await api.get(`/api/capture/sessions/${flowId}`, {
      timeout: 20000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any)
    if (!isCaptureFlowActive(flowId, flowVersion))
      return
    const snapshot = normalizeCaptureSnapshot(response.data?.data)
    if (!snapshot)
      throw new Error('抓取状态返回无效')
    captureFlow.value = snapshot
    captureError.value = snapshot.proxy.error || ''
    if (snapshot.codeCaptured) {
      await completeCaptureAccount()
      return
    }
    capturePollTimer = setTimeout(() => void pollCaptureStatus(flowId, flowVersion), CAPTURE_POLL_INTERVAL_MS)
  }
  catch (error: any) {
    if (!isCaptureFlowActive(flowId, flowVersion) || isCaptureRequestCancelled(error))
      return
    // 任务已在服务端失效（过期/被清理）时不再轮询
    if (isCaptureFlowGone(error)) {
      captureFlowVersion += 1
      stopCapturePolling()
      captureFlow.value = null
      captureError.value = getApiErrorMessage(error, '抓取任务不存在或已过期')
      return
    }
    captureError.value = getApiErrorMessage(error, '查询抓取状态失败')
    capturePollTimer = setTimeout(() => void pollCaptureStatus(flowId, flowVersion), CAPTURE_POLL_ERROR_INTERVAL_MS)
  }
  finally {
    if (capturePollController === controller)
      capturePollController = undefined
  }
}

async function pollCaptureStatus(flowId: string, flowVersion: number) {
  if (!isCaptureFlowActive(flowId, flowVersion))
    return

  const previous = capturePollInFlight
  const previousKey = capturePollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isCaptureFlowActive(flowId, flowVersion))
      return
    if (previousKey === `${flowId}:${flowVersion}`)
      return
  }

  const current = pollCaptureStatusRequest(flowId, flowVersion)
  capturePollInFlight = current
  capturePollKey = `${flowId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (capturePollInFlight === current) {
      capturePollInFlight = undefined
      capturePollKey = ''
    }
  }
}

function openCaptureHelp() {
  captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
  showCaptureHelp.value = true
}

async function copyCaptureValue(field: 'host' | 'port') {
  const host = captureFlow.value?.publicInfo.host || ''
  const port = captureFlow.value?.publicInfo.mitmPort || 0
  if (!host || !port)
    return
  const value = field === 'host' ? host : String(port)
  try {
    let copied = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value)
        copied = true
      }
      catch {}
    }
    if (!copied) {
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      copied = document.execCommand('copy')
      textarea.remove()
    }
    if (!copied)
      throw new Error('copy failed')
    captureCopiedField.value = field
    setTimeout(() => {
      if (captureCopiedField.value === field)
        captureCopiedField.value = ''
    }, 1800)
  }
  catch {
    captureError.value = '复制失败，请手动填写代理地址和端口'
  }
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    activeLoginTab.value = 'code'
    resetWxLogin()
    resetCaptureError()
    captureAccountName.value = props.editData?.name || ''
    capturePlatform.value = props.editData?.platform === 'wx' ? 'wx' : 'qq'
    captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
    void cancelCaptureSession()
    void loadCaptureConfig()
    void loadLoginSettings()
    if (props.editData) {
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
    }
    else {
      form.name = ''
      form.code = ''
      form.platform = 'qq'
    }
  }
  else {
    void cancelCaptureSession()
    showCaptureHelp.value = false
  }
})

watch(activeLoginTab, (tab) => {
  if (tab === 'capture' && !captureEnabled.value) {
    activeLoginTab.value = 'code'
    return
  }
  if (tab === 'wx_qr' && wechatQrLoginEnabled.value && !wxTaskId.value)
    void startWxLogin()
  else if (tab === 'wx_qr' && !wechatQrLoginEnabled.value)
    activeLoginTab.value = 'code'
  else if (tab === 'qq_qr' && qqQrLoginEnabled.value && !qqTaskId.value)
    void startQqLogin()
  else if (tab === 'qq_qr' && !qqQrLoginEnabled.value)
    activeLoginTab.value = 'code'
  if (tab !== 'wx_qr')
    resetWxLogin()
  if (tab !== 'qq_qr')
    resetQqLogin()
  if (tab !== 'capture')
    void cancelCaptureSession()
})

watch(() => form.name, (name) => {
  clearQrNameSubmitTimer()
  if (!name.trim())
    return
  const platform = activeLoginTab.value === 'wx_qr'
    ? 'wx'
    : activeLoginTab.value === 'qq_qr' ? 'qq' : undefined
  if (!platform || !(platform === 'wx' ? wxPendingCode : qqPendingCode))
    return
  qrNameSubmitTimer = setTimeout(() => void submitPendingQrAccount(platform), 800)
})

onBeforeUnmount(() => {
  resetWxLogin()
  resetQqLogin()
  void cancelCaptureSession()
})
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading && !wxLoading && !qqLoading && !captureCompleting"
    :close-on-esc="!loading && !wxLoading && !qqLoading && !captureCompleting"
    @update:show="value => !value && close()"
  >
    <NCard
      class="account-modal-card"
      :title="editData ? '编辑账号' : '添加账号'"
      :bordered="false"
      :closable="!loading && !wxLoading && !qqLoading && !captureCompleting"
      @close="close"
    >
      <div class="account-modal-content overflow-y-auto">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #b91c1c">
          {{ errorMessage }}
        </div>

        <NTabs v-if="loginSettingsLoaded || captureEnabled" v-model:value="activeLoginTab" class="mb-4" type="line">
          <NTab v-if="qqQrLoginEnabled" name="qq_qr">
            QQ扫码登录
          </NTab>
          <NTab v-if="wechatQrLoginEnabled" name="wx_qr">
            微信扫码登录
          </NTab>
          <NTab name="code">
            输入 Code 登录
          </NTab>
          <NTab v-if="captureEnabled" name="capture">
            抓包登录
          </NTab>
        </NTabs>

        <div v-if="activeLoginTab === 'code'" class="space-y-4">
          <BaseInput
            v-if="!editData"
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
            class="farm-input"
          />

          <NRadioGroup v-if="!editData" v-model:value="form.platform" name="account-platform">
            <div class="flex gap-5">
              <NRadio value="qq">
                QQ 小程序
              </NRadio>
              <NRadio value="wx">
                微信小程序
              </NRadio>
            </div>
          </NRadioGroup>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'wx_qr'" class="space-y-4" role="tabpanel" aria-label="微信扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            placeholder="留空时使用微信昵称"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="wxQrUrl" class="bg-white p-2">
              <img :src="wxQrUrl" alt="微信登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ wxLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxStatus }}
            </p>
            <p v-if="wxError" class="text-sm text-red-500">
              {{ wxError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="startWxLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'qq_qr'" class="space-y-4" role="tabpanel" aria-label="QQ扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            placeholder="留空时使用 QQ 昵称"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="qqQrUrl" class="bg-white p-2">
              <img :src="qqQrUrl" alt="QQ登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ qqLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ qqStatus }}
            </p>
            <p v-if="qqError" class="text-sm text-red-500">
              {{ qqError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" :loading="qqLoading" @click="startQqLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'capture'" class="space-y-4" role="tabpanel" aria-label="抓包登录">
          <BaseInput
            v-model="captureAccountName"
            label="账号备注（可留空）"
            placeholder="留空则使用默认账号名"
            :disabled="!!captureFlow"
            class="farm-input"
          />

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" :style="{ color: 'var(--theme-text)' }">平台</label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="capturePlatform === 'qq' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="capturePlatform === 'qq' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="capturePlatform = 'qq'"
              >
                QQ 小程序
              </button>
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="capturePlatform === 'wx' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="capturePlatform === 'wx' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="capturePlatform = 'wx'"
              >
                微信小程序
              </button>
            </div>
          </div>

          <button
            v-if="!captureFlow"
            type="button"
            class="h-11 w-full flex items-center justify-between border border-[var(--theme-border)] rounded-lg px-3 text-left text-sm"
            :style="{ color: 'var(--theme-text)' }"
            @click="openCaptureHelp"
          >
            <span class="flex items-center gap-2">
              <span class="i-carbon-help" :style="{ color: 'var(--theme-primary)' }" />
              使用说明
            </span>
            <span class="i-carbon-chevron-right opacity-60" />
          </button>

          <div v-if="captureError" class="rounded-lg p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #b91c1c">
            {{ captureError }}
          </div>

          <div v-if="!captureFlow" class="flex flex-col items-center gap-3 py-4">
            <div class="h-16 w-16 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <span class="i-carbon-data-connected text-3xl" :style="{ color: 'var(--theme-primary)' }" />
            </div>
            <BaseButton variant="primary" :loading="captureLoading" @click="startCaptureSession">
              开始抓取
            </BaseButton>
          </div>

          <template v-else>
            <div class="rounded-lg px-3 py-3 text-sm" style="background-color: color-mix(in srgb, var(--theme-primary) 10%, transparent); color: var(--theme-text);">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-xs opacity-60">
                    当前步骤
                  </div>
                  <div class="mt-1 break-words font-semibold">
                    {{ captureCurrentStep }}
                  </div>
                  <div class="mt-1 break-words text-xs opacity-70">
                    下一步：{{ captureNextStep }}
                  </div>
                </div>
                <button
                  type="button"
                  class="h-8 w-8 flex flex-none items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
                  title="使用说明"
                  @click="openCaptureHelp"
                >
                  <span class="i-carbon-help text-lg" />
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="min-w-0 flex items-center justify-between gap-1 border border-[var(--theme-border)] rounded-lg px-3 py-3">
                <div class="min-w-0">
                  <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                    代理服务器
                  </div>
                  <div class="mt-1 break-all font-semibold" :style="{ color: 'var(--theme-text)' }">
                    {{ captureFlow.publicInfo.host || '-' }}
                  </div>
                </div>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :title="captureCopiedField === 'host' ? '已复制' : '复制代理服务器'"
                  class="flex-none !px-2"
                  @click="copyCaptureValue('host')"
                >
                  <span :class="captureCopiedField === 'host' ? 'i-carbon-checkmark text-green-600' : 'i-carbon-copy'" />
                </BaseButton>
              </div>
              <div class="min-w-0 flex items-center justify-between gap-1 border border-[var(--theme-border)] rounded-lg px-3 py-3">
                <div class="min-w-0">
                  <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                    代理端口
                  </div>
                  <div class="mt-1 font-semibold" :style="{ color: 'var(--theme-text)' }">
                    {{ captureFlow.publicInfo.mitmPort || '-' }}
                  </div>
                </div>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :title="captureCopiedField === 'port' ? '已复制' : '复制代理端口'"
                  class="flex-none !px-2"
                  @click="copyCaptureValue('port')"
                >
                  <span :class="captureCopiedField === 'port' ? 'i-carbon-checkmark text-green-600' : 'i-carbon-copy'" />
                </BaseButton>
              </div>
            </div>

            <div v-if="captureFlow.publicInfo.addresses?.length > 1" class="border border-[var(--theme-border)] rounded-lg p-3 text-sm">
              <div class="mb-2 text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                全部可用地址（按当前网络环境选择，代理端口相同）
              </div>
              <div class="space-y-1.5">
                <div
                  v-for="item in captureFlow.publicInfo.addresses"
                  :key="item.address"
                  class="flex items-center justify-between gap-2"
                >
                  <span class="min-w-0 break-all text-xs font-mono" :style="{ color: 'var(--theme-text)' }">
                    {{ item.address }}:{{ captureFlow.publicInfo.mitmPort }}
                  </span>
                  <span
                    class="flex-none rounded px-1.5 py-0.5 text-[10px] font-medium"
                    :style="{
                      color: item.kind === 'tailscale' ? '#0ea5e9' : item.kind === 'lan' ? '#10b981' : 'var(--theme-text)',
                      background: 'color-mix(in srgb, currentColor 10%, transparent)',
                    }"
                  >
                    {{ captureAddressLabel(item.kind) }}
                  </span>
                </div>
              </div>
            </div>

            <div class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800">
              <div class="flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">Code</span>
                <span :class="captureFlow.codeCaptured ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
                  {{ captureFlow.codeCaptured ? '已获取' : '等待中' }}
                </span>
              </div>
              <div v-if="captureFlow.platform === 'qq'" class="mt-2 flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">好友 GID</span>
                <span :style="{ color: 'var(--theme-primary)' }">{{ captureFlow.friendCount }} 个</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">剩余时间</span>
                <span :style="{ color: 'var(--theme-text)' }">{{ captureFlow.publicInfo.remainingSec }} 秒</span>
              </div>
            </div>

            <div class="flex flex-wrap justify-end gap-2 border-t border-[var(--theme-border)] pt-3">
              <BaseButton
                variant="secondary"
                size="sm"
                :href="captureFlow.publicInfo.certificateUrl"
              >
                <span class="i-carbon-certificate" />
                打开证书
              </BaseButton>
              <BaseButton variant="outline" size="sm" @click="cancelCaptureSession()">
                取消抓取
              </BaseButton>
              <BaseButton
                v-if="captureFlow.codeCaptured"
                variant="primary"
                size="sm"
                :loading="captureCompleting"
                @click="completeCaptureAccount"
              >
                {{ editData ? '立即更新' : '立即添加' }}
              </BaseButton>
            </div>
          </template>
        </div>
      </div>
    </NCard>
  </NModal>

  <NModal
    :show="showCaptureHelp"
    :mask-closable="true"
    @update:show="value => !value && (showCaptureHelp = false)"
  >
    <NCard
      class="capture-help-card"
      title="抓包登录使用说明"
      :bordered="false"
      closable
      @close="showCaptureHelp = false"
    >
      <div class="max-h-[70vh] overflow-y-auto">
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            class="h-9 rounded-lg px-3 text-sm transition-colors"
            :class="captureHelpMode === 'first' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
            :style="captureHelpMode === 'first' ? { background: 'var(--theme-gradient)' } : {}"
            @click="captureHelpMode = 'first'"
          >
            首次使用
          </button>
          <button
            type="button"
            class="h-9 rounded-lg px-3 text-sm transition-colors"
            :class="captureHelpMode === 'daily' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
            :style="captureHelpMode === 'daily' ? { background: 'var(--theme-gradient)' } : {}"
            @click="captureHelpMode = 'daily'"
          >
            已装证书
          </button>
        </div>

        <div class="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
          <div v-for="(step, index) in captureHelpSteps" :key="step" class="flex items-start gap-3 py-3 first:pt-0">
            <span class="h-6 w-6 flex flex-none items-center justify-center rounded-full text-xs text-white font-semibold" :style="{ background: 'var(--theme-primary)' }">
              {{ index + 1 }}
            </span>
            <span class="min-w-0 break-words text-sm leading-6" :style="{ color: 'var(--theme-text)' }">
              {{ step }}
            </span>
          </div>
        </div>

        <template v-if="captureHelpMode === 'first'">
          <div class="mt-3 border-t border-[var(--theme-border)] pt-4">
            <div class="mb-3 text-sm font-semibold" :style="{ color: 'var(--theme-text)' }">
              证书安装帮助
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="captureHelpDevice === 'ios' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="captureHelpDevice === 'ios' ? { background: 'var(--theme-gradient)' } : {}"
                @click="captureHelpDevice = 'ios'"
              >
                iPhone / iPad
              </button>
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="captureHelpDevice === 'android' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="captureHelpDevice === 'android' ? { background: 'var(--theme-gradient)' } : {}"
                @click="captureHelpDevice = 'android'"
              >
                Android
              </button>
            </div>
            <div class="mt-3 space-y-2">
              <div v-for="(step, index) in captureDeviceSteps" :key="step" class="flex items-start gap-2 text-xs leading-5" :style="{ color: 'var(--theme-text)' }">
                <span class="flex-none opacity-60">{{ index + 1 }}.</span>
                <span class="break-words">{{ step }}</span>
              </div>
            </div>
          </div>
        </template>

        <div class="mt-4 rounded-lg px-3 py-3 text-xs leading-5" style="background: rgba(245, 158, 11, 0.12); color: #b45309">
          <div>每次任务的代理端口可能变化，请以当前页面显示为准。</div>
          <div class="mt-1">
            服务端会自动释放代理，但账号完成后仍需在手机上手动关闭 Wi-Fi 代理。
          </div>
          <div v-if="capturePlatform === 'wx'" class="mt-1">
            微信抓取成功后无法继续进入农场属于正常现象。
          </div>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
/* 弹窗被 naive 传送到 body，脱离 .ref-ui 作用域，取不到 ref-theme.css 里的 --theme-* 变量：
   边框会消失，选中的平台按钮变成「白字 + 透明底」完全看不见。这里补齐同款取值。 */
.account-modal-card,
.capture-help-card {
  --theme-border: rgba(59, 92, 57, 0.18);
  --theme-gradient: linear-gradient(135deg, #60a5fa, #2563eb);
}

.account-modal-card {
  width: min(448px, calc(100vw - 32px));
}

.account-modal-content {
  max-height: calc(90vh - 100px);
}

.capture-help-card {
  width: min(448px, calc(100vw - 32px));
}

/* naive 的占位符默认 #c2c2c2，白底上对比度只有 1.78，几乎看不清 */
.account-modal-card :deep(.n-input__placeholder),
.account-modal-card :deep(.n-input__placeholder span) {
  color: #6b7280;
}
</style>
