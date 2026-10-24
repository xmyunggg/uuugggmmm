<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import AdminNoticeAnnouncementPanel from '@/components/admin/AdminNoticeAnnouncementPanel.vue'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'
import BaseSelect from '@/components/ref-ui/BaseSelect.vue'
import BaseSwitch from '@/components/ref-ui/BaseSwitch.vue'
import ConfirmModal from '@/components/ref-ui/ConfirmModal.vue'
import { useToastStore } from '@/stores/toast'

interface DeviceInfo {
  os: string
  clientVersion: string
  sysSoftware: string
  network: string
  memory: string
  deviceId: string
  userAgent: string
}

interface SystemConfig {
  serverUrl: string
  clientVersion: string
  platform: string
  os: string
  timeZone: string
  deviceInfo: DeviceInfo
}

interface DevicePreset {
  id: string
  name: string
  description?: string
  deviceInfo?: Partial<DeviceInfo>
}

interface SelectOption {
  label: string
  value: string
}

interface LoginSettings {
  wechatQrLogin: boolean
  qqQrLogin: boolean
  napCatEndpoint: string
  napCatSignature: string
}

interface OfflineReminder {
  channel: string
  endpoint: string
  token: string
  secret: string
  title: string
  msg: string
  offlineDeleteSec: number
}

const toast = useToastStore()

const loading = ref(false)
const saving = ref(false)
const showResetConfirm = ref(false)
const devicePresets = ref<DevicePreset[]>([])
const selectedPresetId = ref('')

const defaultDeviceInfo: DeviceInfo = {
  os: 'Windows',
  clientVersion: '',
  sysSoftware: 'Windows 10',
  network: 'wifi',
  memory: '16384',
  deviceId: 'DESKTOP-PC<WPC>',
  userAgent: '',
}

function createDefaultConfig(): SystemConfig {
  return {
    serverUrl: '',
    clientVersion: '',
    platform: 'qq',
    os: 'Windows',
    timeZone: 'Asia/Shanghai',
    deviceInfo: { ...defaultDeviceInfo },
  }
}

const localSystemConfig = ref<SystemConfig>(createDefaultConfig())
const defaultSystemConfig = ref<SystemConfig>(createDefaultConfig())

const timeZoneOptions = ref<SelectOption[]>([
  { label: '北京时间 / 上海（UTC+8）', value: 'Asia/Shanghai' },
])
const platformOptions: SelectOption[] = [
  { label: 'QQ', value: 'qq' },
  { label: '微信', value: 'wx' },
]
const osOptions: SelectOption[] = [
  { label: 'Windows', value: 'Windows' },
  { label: 'iOS', value: 'iOS' },
  { label: 'Android', value: 'Android' },
]

function normalizeSystemConfig(source: Partial<SystemConfig> | null | undefined, fallback: SystemConfig): SystemConfig {
  return {
    serverUrl: source?.serverUrl || '',
    clientVersion: source?.clientVersion || '',
    platform: source?.platform || 'qq',
    os: source?.os || 'Windows',
    timeZone: source?.timeZone || fallback.timeZone || 'Asia/Shanghai',
    deviceInfo: source?.deviceInfo
      ? { ...fallback.deviceInfo, ...source.deviceInfo }
      : { ...fallback.deviceInfo },
  }
}

// ==================== 登录设置 ====================
const localLoginSettings = ref<LoginSettings>({
  wechatQrLogin: true,
  qqQrLogin: false,
  napCatEndpoint: '',
  napCatSignature: '',
})
const loginSettingsSaving = ref(false)

function normalizeLoginSettings(source: Partial<LoginSettings> | null | undefined): LoginSettings {
  return {
    wechatQrLogin: typeof source?.wechatQrLogin === 'boolean' ? source.wechatQrLogin : true,
    qqQrLogin: typeof source?.qqQrLogin === 'boolean' ? source.qqQrLogin : false,
    napCatEndpoint: typeof source?.napCatEndpoint === 'string' ? source.napCatEndpoint.trim() : '',
    napCatSignature: typeof source?.napCatSignature === 'string' ? source.napCatSignature.trim() : '',
  }
}

async function handleSaveLoginSettings() {
  if (localLoginSettings.value.qqQrLogin
    && (!localLoginSettings.value.napCatEndpoint.trim() || !localLoginSettings.value.napCatSignature.trim())) {
    toast.error('开启 QQ 扫码登录前，请配置 NapCat 接口地址和接口签名')
    return
  }

  loginSettingsSaving.value = true
  try {
    const { data } = await api.post('/api/settings/login-config', localLoginSettings.value)
    if (data?.ok) {
      localLoginSettings.value = normalizeLoginSettings(data.data)
      toast.success('登录设置已保存')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    loginSettingsSaving.value = false
  }
}

async function loadDevicePresets() {
  try {
    const { data } = await api.get('/api/settings/device-presets')
    if (data?.ok && Array.isArray(data.data))
      devicePresets.value = data.data
  }
  catch (error) {
    console.error('加载设备预设失败:', error)
  }
}

async function loadSystemConfig() {
  loading.value = true
  try {
    const { data } = await api.get('/api/settings/system-config/global')
    if (data?.ok) {
      if (Array.isArray(data.data.timeZones) && data.data.timeZones.length) {
        timeZoneOptions.value = data.data.timeZones.map((option: SelectOption) => ({
          label: String(option.label || option.value || ''),
          value: String(option.value || 'Asia/Shanghai'),
        }))
      }
      defaultSystemConfig.value = normalizeSystemConfig(data.data.default, defaultSystemConfig.value)
      localSystemConfig.value = normalizeSystemConfig(data.data.saved || data.data.default, defaultSystemConfig.value)
      localLoginSettings.value = normalizeLoginSettings(data.data.loginSettings)
    }
  }
  catch (error) {
    toast.error(`加载系统配置失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    loading.value = false
  }
}

function applyDevicePreset(presetId: string) {
  const preset = devicePresets.value.find(item => item.id === presetId)
  if (!preset)
    return
  const deviceInfo: DeviceInfo = { ...defaultDeviceInfo, ...(preset.deviceInfo || {}) }
  localSystemConfig.value = {
    ...localSystemConfig.value,
    os: deviceInfo.os || 'Windows',
    clientVersion: deviceInfo.clientVersion || '',
    deviceInfo,
  }
  selectedPresetId.value = presetId
}

function handleReset() {
  showResetConfirm.value = true
}

async function confirmReset() {
  saving.value = true
  try {
    const { data } = await api.post('/api/settings/system-config/global/reset')
    if (data?.ok) {
      localSystemConfig.value = normalizeSystemConfig(data.data.saved, defaultSystemConfig.value)
      selectedPresetId.value = ''
      toast.success('系统配置已重置为默认值')
    }
    else {
      toast.error(getApiErrorMessage(data, '重置失败'))
    }
  }
  catch (error) {
    toast.error(`重置失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    saving.value = false
    showResetConfirm.value = false
  }
}

async function handleSave() {
  saving.value = true
  try {
    localSystemConfig.value.clientVersion = localSystemConfig.value.deviceInfo.clientVersion
    localSystemConfig.value.os = localSystemConfig.value.deviceInfo.os
    const { data } = await api.post('/api/settings/system-config/global', localSystemConfig.value)
    if (data?.ok) {
      toast.success('系统配置已保存并立即生效')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    saving.value = false
  }
}

// ==================== 下线提醒（全局默认） ====================
const channelOptions: SelectOption[] = [
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
  { label: 'MeoW', value: 'meow' },
]

function createDefaultOfflineReminder(): OfflineReminder {
  return {
    channel: 'webhook',
    endpoint: '',
    token: '',
    secret: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
  }
}

const localOfflineReminder = ref<OfflineReminder>(createDefaultOfflineReminder())
const offlineReminderSaving = ref(false)
const offlineReminderTesting = ref(false)
const showOfflineResetConfirm = ref(false)

function normalizeOfflineReminder(source: Partial<OfflineReminder> | null | undefined): OfflineReminder {
  const defaults = createDefaultOfflineReminder()
  const sec = Number(source?.offlineDeleteSec)
  return {
    channel: source?.channel ? String(source.channel) : defaults.channel,
    endpoint: String(source?.endpoint ?? defaults.endpoint),
    token: String(source?.token ?? defaults.token),
    secret: String(source?.secret ?? defaults.secret),
    title: String(source?.title ?? defaults.title),
    msg: String(source?.msg ?? defaults.msg),
    offlineDeleteSec: Number.isFinite(sec) && sec >= 0 ? Math.floor(sec) : defaults.offlineDeleteSec,
  }
}

/** 各渠道 Token 的填写格式提示；placeholder 与 hint 都从这里取 */
const CHANNEL_TOKEN_HINTS: Record<string, { placeholder: string, hint: string }> = {
  webhook: { placeholder: '接收端 token（可选）', hint: '' },
  qmsg: {
    placeholder: 'Qmsg key',
    hint: '填 qmsg.zendee.cn 登录后看到的 key，消息发给绑定该 key 的 QQ；群发和指定 QQ 暂不支持。',
  },
  serverchan: {
    placeholder: 'SCT… 或 sctp… 开头',
    hint: '填 Server 酱的 SendKey，sctp 开头的多账号 key 会自动走 push.ft07.com。',
  },
  pushplus: { placeholder: 'pushplus token', hint: '填 pushplus.plus 扫码登录后显示的 token。' },
  pushplushxtrip: { placeholder: 'hxtrip token', hint: '填 pushplus.hxtrip.com 的 token。' },
  wecom: {
    placeholder: 'corpid#corpsecret#agentid',
    hint: '三段用 # 连接：企业 ID # 应用密钥 # 应用 AgentId，可选第四段填接收成员（默认 @all）。',
  },
  bark: {
    placeholder: '设备 key 或 https://自定义域名/key',
    hint: '用官方服务器只填设备 key；自建服务器把完整地址填进来（bark 的 url 附加参数暂不支持）。',
  },
  gocqhttp: {
    placeholder: 'http://127.0.0.1:5700/send_private_msg?user_id=QQ',
    hint: '填完整的 go-cqhttp API 地址，目标 QQ 和 access_token 写在 URL 查询参数里。',
  },
  onebot: {
    placeholder: 'http://127.0.0.1:3000/send_group_msg?group_id=123',
    hint: '填完整 OneBot 11 API 地址：路径含 group 走群发、含 private 走私聊，access_token 写 ?access_token=xxx。',
  },
  atri: {
    placeholder: 'user_id',
    hint: '依赖第三方中转 pushoo.tianli0.top，该服务目前返回 502，已不可用，建议改用其他渠道。',
  },
  pushdeer: { placeholder: 'pushkey', hint: '填 PushDeer 的 pushkey。' },
  igot: { placeholder: 'key', hint: '填 iGot 的推送 key（推送地址为 push.hellyw.com/{key}）；该域名在本机实测 40 秒超时，可能是服务不可用或网络受限。' },
  telegram: {
    placeholder: 'botToken#chatId',
    hint: '两段用 # 连接：机器人 token # 你的 chat id（例如 123456:AAxxxx#123456789）；需要服务器能直连 api.telegram.org，国内网络通常不可达。',
  },
  feishu: {
    placeholder: 'hook key 或完整 Webhook 地址',
    hint: '填自定义机器人 hook 地址的后半段 key，或直接粘贴完整 Webhook 地址。',
  },
  ifttt: {
    placeholder: 'key#eventName',
    hint: '两段用 # 连接：IFTTT Webhook key # 事件名（value1/2/3 暂不支持自定义）。',
  },
  wecombot: { placeholder: '群机器人 Webhook key', hint: '填企业微信群机器人 Webhook 地址里的 key。' },
  discord: {
    placeholder: '完整 Webhook URL 或 id#token',
    hint: '建议直接粘贴完整 Discord Webhook URL（用户名和头像暂不支持自定义）。',
  },
  wxpusher: {
    placeholder: 'WxPusher 应用 Token（AT_ 开头）',
    hint: 'WxPusher 需要两项：应用 Token（后台「应用管理」里的 AT_ 开头字符串）和接收者。接收者发给自己填 UID_xxx（在「我的 → 我的 UID」复制），群发填 Topic 的数字 ID；多个接收者用逗号分隔。',
  },
  meow: { placeholder: 'MeoW 注册昵称', hint: '填 MeoW 注册昵称，可用「接口地址」指定自建服务。' },
}

const offlineChannel = computed(() => String(localOfflineReminder.value.channel || '').trim().toLowerCase())
const isDingTalkChannel = computed(() => offlineChannel.value === 'dingtalk')
const isWxPusherChannel = computed(() => offlineChannel.value === 'wxpusher')
const offlineChannelUsesEndpoint = computed(() => offlineChannel.value === 'webhook' || isDingTalkChannel.value || isWxPusherChannel.value)
const offlineTokenLabel = computed(() => {
  if (offlineChannel.value === 'meow')
    return '昵称'
  return isWxPusherChannel.value ? '应用 Token' : 'Token'
})
const offlineChannelTokenHint = computed(() => CHANNEL_TOKEN_HINTS[offlineChannel.value] || null)
const offlineTokenPlaceholder = computed(() => offlineChannelTokenHint.value?.placeholder || '推送 Token')
const offlineChannelHint = computed(() => offlineChannelTokenHint.value?.hint || '')
const offlineEndpointLabel = computed(() => {
  if (isDingTalkChannel.value)
    return 'Webhook 地址'
  return isWxPusherChannel.value ? '接收者' : '接口地址'
})
const offlineEndpointPlaceholder = computed(() => {
  if (isDingTalkChannel.value)
    return '从钉钉群机器人设置页复制完整 Webhook'
  return isWxPusherChannel.value ? 'UID_xxx，多个用逗号分隔；群发填 TopicID' : 'https://...'
})

async function loadOfflineReminder() {
  try {
    const { data } = await api.get('/api/settings/offline-reminder/global')
    if (data?.ok) {
      localOfflineReminder.value = normalizeOfflineReminder(data.data.saved)
    }
  }
  catch (error) {
    toast.error(`加载下线提醒配置失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
}

async function handleSaveOfflineReminder() {
  offlineReminderSaving.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/global', localOfflineReminder.value)
    if (data?.ok) {
      localOfflineReminder.value = normalizeOfflineReminder(data.data?.saved)
      toast.success('下线提醒全局默认已保存')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    offlineReminderSaving.value = false
  }
}

async function handleTestOfflineReminder() {
  offlineReminderTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOfflineReminder.value)
    if (data?.ok) {
      toast.success('测试消息发送成功')
    }
    else {
      toast.error(getApiErrorMessage(data, '测试失败'))
    }
  }
  catch (error) {
    toast.error(`测试失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    offlineReminderTesting.value = false
  }
}

async function confirmOfflineReset() {
  offlineReminderSaving.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/global/reset')
    if (data?.ok) {
      localOfflineReminder.value = normalizeOfflineReminder(data.data?.saved)
      toast.success('已恢复为默认的下线提醒配置')
    }
    else {
      toast.error(getApiErrorMessage(data, '重置失败'))
    }
  }
  catch (error) {
    toast.error(`重置失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    offlineReminderSaving.value = false
    showOfflineResetConfirm.value = false
  }
}

// ==================== 抓包登录服务 ====================
interface CaptureConfig {
  enabled: boolean
  embedded: boolean
  running: boolean
  apiBase: string
  apiToken: string
  tokenConfigured: boolean
  autoImportQqGids: boolean
}

function createDefaultCaptureConfig(): CaptureConfig {
  return {
    enabled: false,
    embedded: true,
    running: false,
    apiBase: 'http://127.0.0.1:8450',
    apiToken: '',
    tokenConfigured: false,
    autoImportQqGids: true,
  }
}

const localCaptureConfig = ref<CaptureConfig>(createDefaultCaptureConfig())
const captureConfigSaving = ref(false)
const captureConfigTesting = ref(false)

function normalizeCaptureConfig(source: Partial<CaptureConfig> | null | undefined): CaptureConfig {
  const defaults = createDefaultCaptureConfig()
  return {
    enabled: source?.enabled === true,
    embedded: source?.embedded !== false,
    running: source?.running === true,
    apiBase: String(source?.apiBase || defaults.apiBase),
    // 服务端不会下发已保存的 Token，留空表示保持原值
    apiToken: '',
    tokenConfigured: source?.tokenConfigured === true,
    autoImportQqGids: source?.autoImportQqGids !== false,
  }
}

async function loadCaptureConfig() {
  try {
    const { data } = await api.get('/api/admin/capture-config', { skipErrorToast: true } as any)
    if (data?.ok)
      localCaptureConfig.value = normalizeCaptureConfig(data.data)
  }
  catch (error) {
    console.error('加载抓包服务配置失败:', error)
  }
}

async function handleTestCaptureConfig() {
  captureConfigTesting.value = true
  try {
    const { data } = await api.post('/api/admin/capture-config/test', localCaptureConfig.value, { timeout: 20000 })
    if (data?.ok) {
      const port = data.data?.proxyPort ? `（代理端口 ${data.data.proxyPort}）` : ''
      toast.success(`抓包服务连接正常${port}`)
    }
    else {
      toast.error(getApiErrorMessage(data, '连接测试失败'))
    }
  }
  catch (error) {
    toast.error(`连接测试失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    captureConfigTesting.value = false
  }
}

async function handleSaveCaptureConfig() {
  captureConfigSaving.value = true
  try {
    const { data } = await api.post('/api/admin/capture-config', {
      ...localCaptureConfig.value,
      confirmed: true,
    })
    if (data?.ok) {
      localCaptureConfig.value = normalizeCaptureConfig(data.data)
      toast.success('抓包服务配置已保存')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    captureConfigSaving.value = false
  }
}

onMounted(() => {
  loadSystemConfig()
  loadDevicePresets()
  loadOfflineReminder()
  loadCaptureConfig()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
        系统配置
      </h3>
      <div class="flex items-center gap-2">
        <BaseButton variant="secondary" size="sm" :loading="saving" @click="handleReset">
          重置
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="saving" @click="handleSave">
          保存
        </BaseButton>
      </div>
    </div>

    <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-600 backdrop-blur-md dark:text-gray-300">
      服务器连接、时区与客户端设备参数。保存后立即生效，礼包、任务、安静时段与日志均以所设时区为准。
      <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">
        此处为全局默认：未单独设置运行环境的用户（及其名下游戏账号）会沿用这里的配置；用户在「设置 → 系统设置 → 运行环境」中保存过只对本人生效。
      </span>
    </div>

    <div v-if="loading" class="py-8 text-center text-gray-500">
      <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
    </div>

    <div v-else class="space-y-3">
      <div v-if="devicePresets.length" class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-3 backdrop-blur-md">
        <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">设备预设</label>
        <div class="flex flex-wrap gap-2">
          <BaseButton
            v-for="preset in devicePresets"
            :key="preset.id"
            size="sm"
            :variant="selectedPresetId === preset.id ? 'primary' : 'secondary'"
            @click="applyDevicePreset(preset.id)"
          >
            {{ preset.name }}
          </BaseButton>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BaseInput
          v-model="localSystemConfig.serverUrl"
          label="服务器地址"
          type="text"
          placeholder="wss://..."
        />
        <BaseSelect
          v-model="localSystemConfig.timeZone"
          label="系统时区"
          :options="timeZoneOptions"
        />
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-3 backdrop-blur-md">
          <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">平台</label>
          <div class="flex flex-wrap gap-2">
            <BaseButton
              v-for="option in platformOptions"
              :key="option.value"
              size="sm"
              :variant="localSystemConfig.platform === option.value ? 'primary' : 'secondary'"
              @click="localSystemConfig.platform = option.value"
            >
              {{ option.label }}
            </BaseButton>
          </div>
        </div>
        <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-3 backdrop-blur-md">
          <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">系统</label>
          <div class="flex flex-wrap gap-2">
            <BaseButton
              v-for="option in osOptions"
              :key="option.value"
              size="sm"
              :variant="localSystemConfig.deviceInfo.os === option.value ? 'primary' : 'secondary'"
              @click="() => { localSystemConfig.deviceInfo.os = option.value; localSystemConfig.os = option.value }"
            >
              {{ option.label }}
            </BaseButton>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BaseInput
          v-model="localSystemConfig.deviceInfo.clientVersion"
          label="客户端版本"
          type="text"
          :placeholder="defaultSystemConfig.deviceInfo.clientVersion || '从服务器加载中...'"
        />
        <BaseInput
          v-model="localSystemConfig.deviceInfo.sysSoftware"
          label="系统版本"
          type="text"
          placeholder="Windows 10"
        />
        <BaseInput
          v-model="localSystemConfig.deviceInfo.deviceId"
          label="设备标识"
          type="text"
          placeholder="DESKTOP-PC<WPC>"
        />
        <BaseInput
          v-model="localSystemConfig.deviceInfo.memory"
          label="内存 (MB)"
          type="text"
          placeholder="16384"
        />
        <BaseInput
          v-model="localSystemConfig.deviceInfo.network"
          label="网络"
          type="text"
          placeholder="wifi"
        />
        <BaseInput
          v-model="localSystemConfig.deviceInfo.userAgent"
          label="User-Agent"
          type="text"
          placeholder="Mozilla/5.0 ..."
        />
      </div>
    </div>

    <!-- 登录设置 -->
    <section class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
      <div class="mb-4 flex items-start gap-3">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-900/25 dark:text-violet-400">
          <span class="i-carbon-login text-xl" />
        </div>
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            登录设置
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            控制添加账号时可用的扫码登录方式
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3">
          <BaseSwitch v-model="localLoginSettings.wechatQrLogin" label="微信扫码登录" />
        </div>
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3">
          <BaseSwitch v-model="localLoginSettings.qqQrLogin" label="QQ扫码登录" />
        </div>
      </div>

      <div
        v-if="localLoginSettings.qqQrLogin"
        class="grid grid-cols-1 mt-4 gap-3 border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-4 sm:grid-cols-2"
      >
        <BaseInput
          v-model="localLoginSettings.napCatEndpoint"
          label="NapCat接口地址"
          type="text"
          placeholder="http://127.0.0.1:6099"
        />
        <BaseInput
          v-model="localLoginSettings.napCatSignature"
          label="NapCat接口签名"
          type="password"
          placeholder="请输入 NapCat 接口签名"
        />
      </div>

      <div class="mt-3 flex justify-end border-t border-[var(--theme-border)] pt-3">
        <BaseButton
          variant="primary"
          size="sm"
          :loading="loginSettingsSaving"
          @click="handleSaveLoginSettings"
        >
          保存登录设置
        </BaseButton>
      </div>
    </section>

    <!-- 下线提醒（全局默认） -->
    <section class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
      <div class="mb-4 flex items-start gap-3">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400">
          <span class="i-carbon-notification text-xl" />
        </div>
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            下线提醒
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            配置账号离线后的通知与清理
          </p>
        </div>
      </div>

      <div class="mb-3 border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] px-3 py-2 text-xs text-gray-600 leading-relaxed dark:text-gray-300">
        此处为全局默认：未单独设置下线提醒的用户（及其名下游戏账号）会沿用这里的配置；用户在「设置 → 系统设置 → 下线提醒」中保存过只对本人生效。
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BaseSelect
          v-model="localOfflineReminder.channel"
          label="推送渠道"
          :options="channelOptions"
        />

        <BaseInput
          v-if="offlineChannelUsesEndpoint"
          v-model="localOfflineReminder.endpoint"
          :label="offlineEndpointLabel"
          type="text"
          :placeholder="offlineEndpointPlaceholder"
        />

        <BaseInput
          v-if="!isDingTalkChannel"
          v-model="localOfflineReminder.token"
          :label="offlineTokenLabel"
          type="text"
          :placeholder="offlineTokenPlaceholder"
        />

        <p
          v-if="offlineChannelHint"
          class="text-xs text-gray-500 leading-relaxed sm:col-span-2 dark:text-gray-400"
        >
          {{ offlineChannelHint }}
        </p>

        <template v-else>
          <BaseInput
            v-model="localOfflineReminder.secret"
            label="加签密钥（可选）"
            type="password"
            placeholder="仅在机器人开启加签时填写 SEC..."
          />
          <p class="text-xs text-gray-500 leading-relaxed sm:col-span-2 dark:text-gray-400">
            从群机器人的设置页复制完整 Webhook；只有开启“加签”时才需要填写加签密钥。
          </p>
        </template>

        <BaseInput
          v-model="localOfflineReminder.title"
          label="标题"
          type="text"
          placeholder="提醒标题"
        />
        <BaseInput
          v-model.number="localOfflineReminder.offlineDeleteSec"
          label="离线删除账号 (秒)"
          type="number"
          min="0"
          placeholder="0 表示不删除"
        />
        <BaseInput
          v-model="localOfflineReminder.msg"
          label="内容"
          type="text"
          placeholder="提醒内容"
          class="sm:col-span-2"
        />
      </div>

      <div class="mt-3 flex justify-end gap-2 border-t border-[var(--theme-border)] pt-3">
        <BaseButton
          variant="secondary"
          size="sm"
          :loading="offlineReminderSaving"
          :disabled="offlineReminderTesting"
          @click="showOfflineResetConfirm = true"
        >
          恢复默认
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :loading="offlineReminderTesting"
          :disabled="offlineReminderSaving"
          @click="handleTestOfflineReminder"
        >
          测试通知
        </BaseButton>
        <BaseButton
          variant="primary"
          size="sm"
          :loading="offlineReminderSaving"
          :disabled="offlineReminderTesting"
          @click="handleSaveOfflineReminder"
        >
          保存下线提醒
        </BaseButton>
      </div>
    </section>

    <!-- 抓包登录服务 -->
    <section class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
      <div class="mb-4 flex items-start gap-3">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
          <span class="i-carbon-data-connected text-xl" />
        </div>
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            抓包登录服务
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            开放后用户可在「添加账号」中通过手机代理抓包直接获取 Code
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 mb-3 gap-3 sm:grid-cols-3">
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            添加账号入口
          </div>
          <div class="mt-1 font-semibold">
            {{ localCaptureConfig.enabled && localCaptureConfig.running !== false ? '已开放' : '已关闭' }}
          </div>
        </div>
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            运行模式
          </div>
          <div class="mt-1 font-semibold">
            {{ localCaptureConfig.embedded ? '嵌入模式' : (localCaptureConfig.apiToken || localCaptureConfig.tokenConfigured ? '独立服务（已配置）' : '独立服务（未配置）') }}
          </div>
        </div>
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            QQ 好友 GID
          </div>
          <div class="mt-1 font-semibold">
            {{ localCaptureConfig.autoImportQqGids ? '自动导入' : '不导入' }}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3 sm:col-span-2">
          <BaseSwitch
            v-model="localCaptureConfig.enabled"
            label="允许使用抓包登录添加账号"
          />
          <div v-if="localCaptureConfig.embedded" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            默认关闭且不运行；开启后才会启动嵌入服务，手机 Wi-Fi 代理端口固定为 18000
          </div>
        </div>

        <template v-if="!localCaptureConfig.embedded">
          <BaseInput
            v-model="localCaptureConfig.apiBase"
            label="抓包服务地址"
            type="text"
            placeholder="http://127.0.0.1:8450"
            class="sm:col-span-2"
          />
          <BaseInput
            v-model="localCaptureConfig.apiToken"
            label="API Token"
            type="password"
            :placeholder="localCaptureConfig.tokenConfigured ? '已配置，留空保持不变' : '请输入抓包服务 API Token'"
            class="sm:col-span-2"
          />
        </template>

        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3 sm:col-span-2">
          <BaseSwitch
            v-model="localCaptureConfig.autoImportQqGids"
            label="QQ 抓取完成后自动导入好友 GID"
          />
        </div>
      </div>

      <div class="mt-3 flex flex-wrap justify-end gap-2 border-t border-[var(--theme-border)] pt-3">
        <BaseButton
          variant="secondary"
          size="sm"
          :loading="captureConfigTesting"
          :disabled="captureConfigSaving || (localCaptureConfig.embedded && localCaptureConfig.running === false)"
          @click="handleTestCaptureConfig"
        >
          测试连接
        </BaseButton>
        <BaseButton
          variant="primary"
          size="sm"
          :loading="captureConfigSaving"
          :disabled="captureConfigTesting"
          @click="handleSaveCaptureConfig"
        >
          保存抓包服务
        </BaseButton>
      </div>
    </section>

    <!-- 公告与声明 -->
    <AdminNoticeAnnouncementPanel />

    <ConfirmModal
      :show="showResetConfirm"
      title="重置系统配置"
      message="确定要将运行环境配置重置为默认值吗？"
      type="danger"
      confirm-text="重置"
      :loading="saving"
      @confirm="confirmReset"
      @cancel="showResetConfirm = false"
      @close="showResetConfirm = false"
    />

    <ConfirmModal
      :show="showOfflineResetConfirm"
      title="恢复默认下线提醒"
      message="确定要将全局默认的下线提醒配置恢复为默认值吗？（已单独设置的用户不受影响）"
      type="danger"
      confirm-text="恢复默认"
      :loading="offlineReminderSaving"
      @confirm="confirmOfflineReset"
      @cancel="showOfflineResetConfirm = false"
      @close="showOfflineResetConfirm = false"
    />
  </div>
</template>
