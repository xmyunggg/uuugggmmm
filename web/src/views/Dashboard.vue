<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import api, { getApiErrorMessage } from '@/api'
import CareerModal from '@/components/CareerModal.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useIllustratedStore } from '@/stores/illustrated'
import { usePetStore } from '@/stores/pet'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const illustratedStore = useIllustratedStore()
const petStore = usePetStore()
const toastStore = useToastStore()
const router = useRouter()

const { status, diamondBalance, logs: statusLogs, realtimeConnected } = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { data: illustratedData } = storeToRefs(illustratedStore)

const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const clearingLogs = ref(false)
const localUptime = ref(0)

// ==================== 个人生涯 ====================
const showCareerModal = ref(false)
const careerLoading = ref(false)
const careerError = ref('')
const careerProfile = ref<Record<string, any> | null>(null)

const accountAvatar = computed(() => {
  const liveAvatar = String(status.value?.status?.avatarUrl || '').trim()
  return String(currentAccount.value?.avatar || liveAvatar || '').trim()
})

async function loadCareer() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId)
    return
  careerLoading.value = true
  careerError.value = ''
  try {
    const { data } = await api.get('/api/career', {
      headers: { 'x-account-id': accountId },
      skipErrorToast: true,
    } as any)
    if (!data?.ok)
      throw new Error(data?.error || '生涯记录读取失败')
    careerProfile.value = data.data || null
  }
  catch (e: any) {
    careerProfile.value = null
    careerError.value = getApiErrorMessage(e, '生涯记录读取失败')
  }
  finally {
    careerLoading.value = false
  }
}

function openCareer() {
  if (!currentAccountId.value)
    return
  showCareerModal.value = true
  loadCareer()
}

// ==================== 账号与运行状态 ====================
const displayName = computed(() => {
  const account = currentAccount.value
  const gameName = status.value?.status?.name
  if (gameName)
    return account?.name ? `${gameName} (${account.name})` : gameName
  if (account?.name && account?.nick)
    return `${account.nick} (${account.name})`
  return account?.name || account?.nick || '未登录'
})

const online = computed(() => !!status.value?.connection?.connected)
const running = computed(() => online.value && !!currentAccount.value?.running)
const statusBadge = computed(() => {
  if (running.value)
    return '农场运行中'
  if (online.value)
    return '账号已连接'
  return '账号离线'
})

watch(
  () => status.value?.sessionElapsedSeconds ?? status.value?.uptime,
  (value) => {
    if (value !== undefined && value !== null)
      localUptime.value = Math.max(0, Number(value) || 0)
  },
  { immediate: true },
)

useIntervalFn(() => {
  if (online.value)
    localUptime.value++
}, 1000)

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (d > 0)
    return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

// ==================== 下次巡查 ====================
const nextFarmCheck = ref('账号未登录')
const nextFriendCheck = ref('账号未登录')
let localNextFarmRemainSec = 0
let localNextFriendRemainSec = 0
let farmQuiet = false
let friendQuiet = false
let hasNextCheckData = false

function updateCountdowns() {
  if (!online.value) {
    nextFarmCheck.value = '账号未登录'
    nextFriendCheck.value = '账号未登录'
    return
  }

  if (!running.value) {
    nextFarmCheck.value = '未运行'
    nextFriendCheck.value = '未运行'
    return
  }

  if (!hasNextCheckData) {
    nextFarmCheck.value = '--:--:--'
    nextFriendCheck.value = '--:--:--'
    return
  }

  if (farmQuiet) {
    nextFarmCheck.value = '静默中'
  }
  else if (localNextFarmRemainSec > 0) {
    localNextFarmRemainSec--
    nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
  }
  else {
    nextFarmCheck.value = '巡查中...'
  }

  if (friendQuiet) {
    nextFriendCheck.value = '静默中'
  }
  else if (localNextFriendRemainSec > 0) {
    localNextFriendRemainSec--
    nextFriendCheck.value = formatDuration(localNextFriendRemainSec)
  }
  else {
    nextFriendCheck.value = '巡查中...'
  }
}

watch(() => status.value?.nextChecks, (nextChecks) => {
  if (nextChecks) {
    hasNextCheckData = true
    localNextFarmRemainSec = Number(nextChecks.farmRemainSec) || 0
    localNextFriendRemainSec = Number(
      nextChecks.friendRemainSec
      ?? nextChecks.helpRemainSec
      ?? nextChecks.stealRemainSec,
    ) || 0
    farmQuiet = !!nextChecks.farmQuiet
    friendQuiet = !!(nextChecks.friendQuiet ?? nextChecks.helpQuiet ?? nextChecks.stealQuiet)
  }
  else {
    hasNextCheckData = false
  }
  updateCountdowns()
}, { immediate: true })

function resetNextChecks() {
  hasNextCheckData = false
  localNextFarmRemainSec = 0
  localNextFriendRemainSec = 0
  farmQuiet = false
  friendQuiet = false
  updateCountdowns()
}

useIntervalFn(updateCountdowns, 1000)

// ==================== 经验与资产 ====================
function getExpPercent(progress: any) {
  if (!progress || !progress.needed)
    return 0
  return Math.min(100, Math.max(0, (Number(progress.current) / Number(progress.needed)) * 100))
}

const expRate = computed(() => {
  const gain = Number(status.value?.sessionExpGained || 0)
  const uptime = Number(status.value?.sessionElapsedSeconds ?? status.value?.uptime ?? 0)
  const hours = uptime / 3600
  const rate = hours > 0 ? Math.floor(gain / hours) : 0
  return `${Math.max(0, rate).toLocaleString('zh-CN')}/小时`
})

const upgradeText = computed(() => {
  const forecast = status.value?.levelForecast
  if (!forecast)
    return '等待升级预测'
  if (forecast.source === 'ready')
    return '收获后可升级'
  const estimatedAt = Number(forecast.estimatedAt)
  if (!Number.isFinite(estimatedAt) || estimatedAt <= 0)
    return forecast?.plotCount ? '本轮收获不足升级' : '等待升级预测'
  const generatedAt = Number(forecast.generatedAt) || Date.now()
  const minutes = Math.max(1, Math.ceil((estimatedAt - generatedAt) / 60000))
  const duration = minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`
  return forecast.source === 'planted' ? `约 ${duration}后收获可升级` : `约 ${duration}后升级`
})

const TRAILING_ZERO_RE = /\.00$/
const SINGLE_TRAILING_ZERO_RE = /(\.\d)0$/

function trimDecimal(value: number) {
  return value.toFixed(2).replace(TRAILING_ZERO_RE, '').replace(SINGLE_TRAILING_ZERO_RE, '$1')
}

function formatCompactAmount(value: unknown) {
  const amount = Number(value)
  if (!Number.isFinite(amount))
    return '0'
  const n = Math.max(0, Math.trunc(amount))
  if (n >= 1e8)
    return `${trimDecimal(n / 1e8)}亿`
  if (n >= 1e4)
    return `${trimDecimal(n / 1e4)}万`
  return n.toLocaleString('zh-CN')
}

const assets = computed(() => [
  {
    key: 'gold',
    label: '金币',
    icon: 'i-carbon-currency-dollar',
    value: formatCompactAmount(status.value?.status?.gold),
  },
  {
    key: 'coupon',
    label: '点券',
    icon: 'i-carbon-ticket',
    value: formatCompactAmount(status.value?.status?.coupon),
  },
  {
    key: 'diamond',
    label: '钻石',
    icon: 'i-carbon-gem',
    value: formatCompactAmount(diamondBalance.value),
  },
  {
    key: 'goldBean',
    label: '金豆',
    icon: 'i-carbon-sprout',
    value: formatCompactAmount(status.value?.status?.goldBean),
  },
])

// ==================== 今日统计 ====================
const OP_META: Record<string, { label: string, icon: string }> = {
  harvest: { label: '收获', icon: 'i-carbon-wheat' },
  farming: { label: '一键务农', icon: 'i-carbon-agriculture-analytics' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry' },
  plant: { label: '种植', icon: 'i-carbon-sprout' },
  steal: { label: '偷菜', icon: 'i-carbon-run' },
  helpFarming: { label: '帮务农', icon: 'i-carbon-collaborate' },
  weed: { label: '放草', icon: 'i-carbon-cut' },
  bug: { label: '放虫', icon: 'i-carbon-pest' },
  tongQiGift: { label: '同气礼包', icon: 'i-carbon-gift' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete' },
  sell: { label: '出售', icon: 'i-carbon-currency-dollar' },
  upgrade: { label: '土地升级', icon: 'i-carbon-arrows-vertical' },
  levelUp: { label: '等级提升', icon: 'i-carbon-trophy' },
}

const operationEntries = computed(() => {
  const operations = status.value?.operations || {}
  return Object.keys(operations)
    .map((key) => {
      const meta = OP_META[key]
      return {
        key,
        label: meta?.label || key,
        icon: meta?.icon || 'i-carbon-chart-column',
        value: Number(operations[key]) || 0,
      }
    })
})

function formatGain(value: unknown) {
  const gain = Number(value || 0)
  if (gain === 0)
    return '0'
  return `${gain > 0 ? '+' : ''}${gain.toLocaleString('zh-CN')}`
}

function gainClass(value: unknown) {
  const gain = Number(value || 0)
  if (gain > 0)
    return 'gain--positive'
  if (gain < 0)
    return 'gain--negative'
  return 'gain--neutral'
}

// ==================== 功能入口 ====================
const cropIllustratedLevel = computed(() => Number(illustratedData.value?.crop?.level || 0))
const petLevel = computed(() => Number(petStore.activeDog?.level || 0))
const illustratedCollection = computed(() => {
  const items = illustratedData.value?.crop?.items
  if (!Array.isArray(items) || !items.length)
    return '收集进度'
  const unlocked = items.filter((item: any) => item.unlocked).length
  return `已收集 ${unlocked}/${items.length}`
})

const features = computed(() => [
  { key: 'illustrated', label: '作物图鉴', hint: `Lv.${cropIllustratedLevel.value}`, icon: 'i-carbon-sprout' },
  { key: 'pet', label: '宠物', hint: `Lv.${petLevel.value}`, icon: 'i-carbon-dog-walker' },
  { key: 'collection', label: '图鉴', hint: illustratedCollection.value, icon: 'i-carbon-book' },
  { key: 'mall', label: '商城', hint: '道具 · 装扮', icon: 'i-carbon-shopping-cart' },
  { key: 'activity', label: '活动', hint: '精彩活动', icon: 'i-carbon-events' },
  { key: 'analytics', label: '分析', hint: '数据统计', icon: 'i-carbon-chart-line' },
])

function openFeature(key: string) {
  if (key === 'illustrated' || key === 'collection')
    router.push({ path: '/personal', query: { tab: 'illustrated' } })
  else if (key === 'pet')
    router.push({ path: '/personal', query: { tab: 'pet' } })
  else if (key === 'mall')
    router.push('/game-mall')
  else if (key === 'activity')
    router.push('/activity')
  else if (key === 'analytics')
    router.push('/analytics')
}

function openAsset(key: string) {
  if (key === 'gold')
    router.push('/analytics')
  else
    router.push('/game-mall')
}

// ==================== 运行日志 ====================
const allLogs = computed(() => {
  return [...(statusLogs.value || [])]
    .slice(-200)
    .sort((a: any, b: any) => a.ts - b.ts)
})

const filter = reactive({
  module: '',
  event: '',
  keyword: '',
  isWarn: '',
})

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keyword.trim() || filter.isWarn),
)

const modules = [
  { label: '所有模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '好友', value: 'friend' },
  { label: '仓库', value: 'warehouse' },
  { label: '任务', value: 'task' },
  { label: '活动', value: 'activity' },
  { label: '商城', value: 'mall' },
  { label: '商店', value: 'shop' },
  { label: '宠物', value: 'dog' },
  { label: '系统', value: 'system' },
]

const events = [
  { label: '所有事件', value: '' },
  { label: '农场循环', value: '农场循环' },
  { label: '收获作物', value: '收获作物' },
  { label: '种植种子', value: '种植种子' },
  { label: '铲除植物', value: '铲除植物' },
  { label: '施肥', value: '施肥' },
  { label: '手动施肥', value: '手动施肥' },
  { label: '一键施肥', value: '一键施肥' },
  { label: '多季节施肥', value: '多季节施肥' },
  { label: '施肥后收获作物', value: '施肥后收获作物' },
  { label: '购买种子', value: '购买种子' },
  { label: '购买种子跳过', value: '购买种子跳过' },
  { label: '选择种子', value: '选择种子' },
  { label: '购买化肥', value: '购买化肥' },
  { label: '购买化肥计时器', value: '购买化肥计时器' },
  { label: '解锁土地', value: '解锁土地' },
  { label: '升级土地', value: '升级土地' },
  { label: '土地推送通知', value: '土地推送通知' },
  { label: '农场社交事件通知', value: '农场社交事件通知' },
  { label: '收获后状态分类', value: '收获后状态分类' },
  { label: '收获后状态补拉', value: '收获后状态补拉' },
  { label: '好友巡查循环', value: '好友巡查循环' },
  { label: '开始好友巡查', value: '开始好友巡查' },
  { label: '好友巡查失败', value: '好友巡查失败' },
  { label: '好友巡查跳过', value: '好友巡查跳过' },
  { label: '好友扫描', value: '好友扫描' },
  { label: '进入农场', value: '进入农场' },
  { label: '照顾好友', value: '照顾好友' },
  { label: '获取好友列表', value: '获取好友列表' },
  { label: '好友宠物同步', value: '好友宠物同步' },
  { label: '偷菜后出售', value: '偷菜后出售' },
  { label: '投放黄金虫', value: '投放黄金虫' },
  { label: '放虫放草次数上限', value: '放虫放草次数上限' },
  { label: '放虫放草次数用完', value: '放虫放草次数用完' },
  { label: '放虫放草失败', value: '放虫放草失败' },
  { label: '成熟唤醒', value: '成熟唤醒' },
  { label: '加黑名单', value: '加黑名单' },
  { label: '删除好友', value: '删除好友' },
  { label: '访客补充好友GID', value: '访客补充好友GID' },
  { label: '互动记录', value: 'interact_records' },
  { label: '收获后出售', value: '收获后出售' },
  { label: '每日任务', value: '每日任务' },
  { label: '启动序列', value: '启动序列' },
  { label: '好友统一任务', value: '好友统一任务' },
  { label: '网关退避', value: '网关退避' },
  { label: '扫描任务', value: '扫描任务' },
  { label: '领取任务', value: '领取任务' },
  { label: '扫描活跃奖励', value: '扫描活跃奖励' },
  { label: '领取活跃奖励', value: '领取活跃奖励' },
  { label: '图鉴奖励', value: '图鉴奖励' },
  { label: '邮箱领取', value: 'email_rewards' },
  { label: '免费礼包', value: 'mall_free_gifts' },
  { label: '月卡礼包', value: 'month_card_gift' },
  { label: '会员礼包', value: 'vip_daily_gift' },
  { label: '分享奖励', value: 'daily_share' },
  { label: '购买化肥检查', value: 'check_fertilizer' },
  { label: '有机化肥检查', value: 'check_fertilizer_organic' },
  { label: '普通化肥检查', value: 'check_fertilizer_normal' },
  { label: '化肥自动购买', value: 'fertilizer_auto_buy' },
  { label: '神秘商人自动购买', value: '神秘商人自动购买' },
  { label: '奶茶热销中自动任务', value: '奶茶热销中自动任务' },
  { label: '激活宠物', value: '激活宠物' },
  { label: '上场宠物', value: '上场宠物' },
  { label: '收回宠物', value: '收回宠物' },
  { label: '使用狗粮', value: '使用狗粮' },
  { label: '资本模式派出', value: '资本模式派出' },
  { label: '资本模式召回', value: '资本模式召回' },
]

const logLevels = [
  { label: '所有等级', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
]

async function onLogFilterChange() {
  await reloadLogs()
}

async function onLogSearchTrigger() {
  await reloadLogs()
}

async function resetLogFilters() {
  filter.module = ''
  filter.event = ''
  filter.keyword = ''
  filter.isWarn = ''
  await reloadLogs()
}

watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
})

const MODULE_LABELS: Record<string, string> = {
  farm: '农场',
  friend: '好友',
  warehouse: '仓库',
  task: '任务',
  activity: '活动',
  mall: '商城',
  shop: '商店',
  dog: '宠物',
  pet: '宠物',
  system: '系统',
}

function getLogModuleLabel(log: any) {
  const module = String(log?.meta?.module || '').toLowerCase()
  if (MODULE_LABELS[module])
    return MODULE_LABELS[module]
  const tag = String(log?.tag || '').trim()
  if (!tag || tag === '错误' || tag === '警告')
    return '系统'
  return tag
}

function logTagClass(log: any) {
  const label = getLogModuleLabel(log)
  if (label === '好友')
    return 'log-tag--friend'
  if (label === '农场')
    return 'log-tag--farm'
  if (label === '活动')
    return 'log-tag--activity'
  if (label === '仓库')
    return 'log-tag--warehouse'
  if (label === '任务')
    return 'log-tag--task'
  if (label === '商城')
    return 'log-tag--mall'
  if (label === '商店')
    return 'log-tag--shop'
  if (label === '宠物')
    return 'log-tag--pet'
  return 'log-tag--system'
}

const latestModuleLabel = computed(() => {
  const latest = allLogs.value.at(-1)
  return latest ? getLogModuleLabel(latest) : '系统'
})

function formatLogTime(timeStr: string) {
  if (!timeStr)
    return ''
  const parts = String(timeStr).split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el)
    return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 50
}

let logScrollFrame: number | undefined

function scheduleLogScroll(force = false) {
  nextTick(() => {
    if (!logContainer.value || (!force && !autoScroll.value) || logScrollFrame !== undefined)
      return
    logScrollFrame = window.requestAnimationFrame(() => {
      if (logContainer.value)
        logContainer.value.scrollTop = logContainer.value.scrollHeight
      logScrollFrame = undefined
    })
  })
}

function scrollToBottom() {
  autoScroll.value = true
  scheduleLogScroll(true)
}

watch(allLogs, () => scheduleLogScroll())

async function clearLogs() {
  if (!currentAccountId.value)
    return
  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await refresh(true)
      scrollToBottom()
    }
    else {
      toastStore.error(`清空失败: ${getApiErrorMessage(data, '未知错误')}`)
    }
  }
  catch (e: any) {
    toastStore.error(`清空失败: ${getApiErrorMessage(e, '请求失败')}`)
  }
  finally {
    clearingLogs.value = false
  }
}

// ==================== 数据刷新 ====================
async function refreshDiamond() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || !currentAccount.value?.running || !online.value)
    return
  await statusStore.fetchDiamond(accountId)
}

async function loadFeatureSummaries() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || !currentAccount.value?.running || !online.value)
    return
  await Promise.allSettled([
    illustratedStore.fetch(accountId),
    petStore.fetchPetInfo(accountId),
  ])
}

function logQueryOptions() {
  return {
    limit: 100,
    module: filter.module || undefined,
    event: filter.event || undefined,
    keyword: filter.keyword.trim() || undefined,
    isWarn: filter.isWarn === 'warn' ? true : filter.isWarn === 'info' ? false : undefined,
  }
}

async function reloadLogs() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId)
    return
  await statusStore.fetchLogs(accountId, logQueryOptions())
  scrollToBottom()
}

async function refresh(forceReloadLogs = false) {
  const accountId = String(currentAccountId.value || '')
  if (!accountId)
    return
  if (!realtimeConnected.value || forceReloadLogs || !status.value?.status)
    await statusStore.fetchStatus(accountId)
  if (forceReloadLogs || hasActiveLogFilter.value || !realtimeConnected.value || !statusLogs.value.length)
    await statusStore.fetchLogs(accountId, logQueryOptions())
}

watch(currentAccountId, async () => {
  diamondBalance.value = 0
  illustratedStore.reset()
  petStore.clear()
  localUptime.value = 0
  resetNextChecks()
  await refresh()
  await refreshDiamond()
  await loadFeatureSummaries()
  scrollToBottom()
})

watch(online, async (value) => {
  if (value) {
    await refreshDiamond()
    await loadFeatureSummaries()
  }
})

onMounted(async () => {
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  await refresh()
  await refreshDiamond()
  await loadFeatureSummaries()
  scrollToBottom()
})

onBeforeUnmount(() => {
  if (logScrollFrame !== undefined)
    window.cancelAnimationFrame(logScrollFrame)
})

useIntervalFn(refresh, 10000)
</script>

<template>
  <div class="farm-dashboard">
    <div class="farm-shell">
      <!-- 账号信息 -->
      <section class="farm-glass profile-card">
        <div class="profile-row">
          <button class="avatar-button" type="button" title="查看个人生涯" @click="openCareer">
            <img v-if="accountAvatar" :src="accountAvatar" :alt="displayName" class="avatar-image">
            <span v-else class="avatar-fallback i-fas-user-circle" />
          </button>
          <div class="profile-main">
            <div class="profile-title">
              <h1 :title="displayName">
                {{ displayName }}
              </h1>
              <span class="level-chip">Lv.{{ status?.status?.level || 0 }}</span>
            </div>
            <div class="exp-row">
              <div class="exp-track">
                <div class="exp-fill" :style="{ width: `${getExpPercent(status?.levelProgress)}%` }" />
              </div>
              <span class="exp-numbers">
                {{ status?.levelProgress?.current || 0 }} / {{ status?.levelProgress?.needed || 0 }}
              </span>
            </div>
          </div>
        </div>
        <div class="profile-foot">
          <span class="profile-metric">
            <i class="i-carbon-flash" />
            EXP 效率：{{ expRate }}
          </span>
          <span class="upgrade-text" :class="{ 'upgrade-text--muted': !online }">
            <i class="i-carbon-arrow-up" />
            {{ online ? upgradeText : '账号离线' }}
          </span>
        </div>
      </section>

      <!-- 资产 -->
      <div class="asset-grid">
        <button
          v-for="asset in assets"
          :key="asset.key"
          type="button"
          class="asset-card"
          :class="`asset-card--${asset.key}`"
          @click="openAsset(asset.key)"
        >
          <span class="asset-head">
            <span class="asset-icon"><i :class="asset.icon" /></span>
            <span class="asset-label">{{ asset.label }}</span>
            <i class="asset-arrow i-carbon-chevron-right" />
          </span>
          <span class="asset-value">{{ asset.value }}</span>
        </button>
      </div>

      <!-- 运行状态 -->
      <button type="button" class="farm-glass run-card" @click="router.push('/personal')">
        <span class="run-left">
          <span class="run-badges">
            <span class="run-online">
              <span class="run-dot" :class="{ 'run-dot--off': !online }" />
              {{ online ? '在线' : '离线' }}
            </span>
            <span class="run-badge">{{ statusBadge }}</span>
          </span>
          <span class="run-time-row">
            <span class="run-clock"><i class="i-carbon-time" /></span>
            <strong class="run-time">{{ formatDuration(localUptime) }}</strong>
          </span>
          <span class="run-caption">已运行</span>
        </span>
        <span class="run-art">
          <span class="run-enter"><i class="i-carbon-chevron-right" /></span>
        </span>
      </button>

      <!-- 功能宫格 -->
      <div class="feature-grid">
        <button
          v-for="feature in features"
          :key="feature.key"
          type="button"
          class="farm-glass feature-card"
          @click="openFeature(feature.key)"
        >
          <span class="feature-icon" :class="`feature-icon--${feature.key}`">
            <i :class="feature.icon" />
          </span>
          <span class="feature-copy">
            <strong>{{ feature.label }}</strong>
            <small>{{ feature.hint }}</small>
          </span>
          <i class="feature-arrow i-carbon-chevron-right" />
        </button>
      </div>

      <!-- 下次巡查 / 今日统计 -->
      <div class="insight-grid">
        <section class="farm-glass insight-card">
          <div class="insight-head">
            <span class="insight-icon insight-icon--time"><i class="i-carbon-time" /></span>
            <div class="insight-heading">
              <h2>下次巡查倒计时</h2>
              <p>自动巡查节奏</p>
            </div>
          </div>
          <div class="check-list">
            <div class="check-row">
              <span class="check-icon check-icon--farm"><i class="i-carbon-sprout" /></span>
              <span class="check-label">农场</span>
              <span class="check-value" :class="{ 'check-value--muted': !running || nextFarmCheck === '--:--:--' }">{{ nextFarmCheck }}</span>
            </div>
            <div class="check-row">
              <span class="check-icon check-icon--friend"><i class="i-carbon-user-multiple" /></span>
              <span class="check-label">好友任务</span>
              <span class="check-value" :class="{ 'check-value--muted': !running || nextFriendCheck === '--:--:--' }">{{ nextFriendCheck }}</span>
            </div>
          </div>
        </section>

        <section class="farm-glass insight-card">
          <div class="insight-head">
            <span class="insight-icon insight-icon--stats"><i class="i-carbon-chart-column" /></span>
            <div class="insight-heading">
              <h2>今日统计</h2>
              <p>{{ online ? `本次会话 · 在线 ${formatDuration(localUptime)}` : '等待账号连接' }}</p>
            </div>
          </div>

          <div v-if="!online" class="insight-empty">
            账号未登录
          </div>
          <template v-else>
            <div v-if="operationEntries.length" class="operation-grid">
              <div v-for="operation in operationEntries" :key="operation.key" class="operation-chip">
                <i :class="operation.icon" class="operation-icon" />
                <span class="operation-label">{{ operation.label }}</span>
                <strong class="operation-value">{{ operation.value }}</strong>
              </div>
            </div>
            <div v-else class="insight-empty">
              暂无统计数据
            </div>

            <div class="session-gains">
              <p class="gain-title">
                本次会话收益
              </p>
              <div class="gain-item">
                <span>经验</span>
                <strong :class="gainClass(status?.sessionExpGained)">{{ formatGain(status?.sessionExpGained) }}</strong>
              </div>
              <div class="gain-item">
                <span>金币</span>
                <strong :class="gainClass(status?.sessionGoldGained)">{{ formatGain(status?.sessionGoldGained) }}</strong>
              </div>
              <div class="gain-item">
                <span>点券</span>
                <strong :class="gainClass(status?.sessionCouponGained)">{{ formatGain(status?.sessionCouponGained) }}</strong>
              </div>
            </div>
          </template>
        </section>
      </div>

      <!-- 运行日志 -->
      <section class="farm-glass log-card">
        <div class="log-head">
          <div class="log-title">
            <div class="log-title-main">
              <h2>运行日志</h2>
              <p v-if="hasActiveLogFilter">
                筛选结果 {{ allLogs.length }} 条 · 实时推送已暂停
              </p>
              <p v-else>
                共 {{ allLogs.length }} 条 · 最新{{ latestModuleLabel }}
              </p>
            </div>
          </div>
          <div class="log-filters">
            <div class="log-filter-control">
              <BaseSelect v-model="filter.module" :options="modules" @change="onLogFilterChange" />
            </div>
            <div class="log-filter-control">
              <BaseSelect v-model="filter.event" :options="events" filterable @change="onLogFilterChange" />
            </div>
            <div class="log-filter-control">
              <BaseSelect v-model="filter.isWarn" :options="logLevels" @change="onLogFilterChange" />
            </div>
            <div class="log-filter-control log-filter-control--keyword">
              <BaseInput
                v-model="filter.keyword"
                placeholder="关键词"
                clearable
                @keyup.enter="onLogSearchTrigger"
                @clear="onLogSearchTrigger"
              />
            </div>
            <button class="log-search" type="button" title="搜索日志" @click="onLogSearchTrigger">
              <i class="i-carbon-search" />
            </button>
            <button v-if="hasActiveLogFilter" class="log-reset" type="button" title="重置筛选" @click="resetLogFilters">
              <i class="i-carbon-reset" />
            </button>
            <button class="log-clear" type="button" :disabled="clearingLogs" title="清空日志" @click="clearLogs">
              <i class="i-carbon-trash-can" />
            </button>
          </div>
        </div>
        <div class="log-body">
          <div ref="logContainer" class="log-list" @scroll="onLogScroll">
            <div v-if="!allLogs.length" class="log-empty">
              {{ hasActiveLogFilter ? '没有匹配的日志' : '暂无日志' }}
            </div>
            <div v-for="(log, logIndex) in allLogs" :key="`${log.ts}-${logIndex}`" class="log-line" :title="log.msg">
              <span class="log-time">{{ formatLogTime(log.time) }}</span>
              <span class="log-tag" :class="logTagClass(log)">{{ getLogModuleLabel(log) }}</span>
              <span class="log-msg">{{ log.msg }}</span>
            </div>
          </div>
          <button v-if="!autoScroll" class="log-latest" type="button" @click="scrollToBottom">
            最新 <i class="i-carbon-arrow-down" />
          </button>
        </div>
      </section>
    </div>

    <CareerModal
      :show="showCareerModal"
      :account="currentAccount"
      :profile="careerProfile"
      :loading="careerLoading"
      :error="careerError"
      @close="showCareerModal = false"
      @refresh="loadCareer"
    />
  </div>
</template>

<style scoped>
.farm-dashboard {
  position: relative;
  min-height: calc(100dvh - 150px);
  padding: 18px;
  overflow: hidden;
  border-radius: 30px;
  background-color: #86b96c;
  background-image:
    linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(21, 62, 40, 0.18) 100%),
    url('https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=anime%20style%20idyllic%20farm%20landscape%2C%20bright%20blue%20sky%20with%20soft%20pink%20clouds%2C%20distant%20purple%20mountains%2C%20green%20rolling%20fields%2C%20colorful%20wildflowers%2C%20wooden%20fence%2C%20warm%20sunlight%2C%20pastel%20colors%2C%20highly%20detailed%20scenic%20illustration%2C%20no%20text&image_size=landscape_16_9'),
    linear-gradient(180deg, #9ed3f5 0%, #cfe8b4 46%, #74a85b 100%);
  background-position: center, center, center;
  background-size: cover, cover, cover;
  background-repeat: no-repeat;
  box-shadow:
    0 24px 60px rgba(27, 61, 39, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
}

.farm-dashboard::after {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 70% at 12% 0%, rgba(255, 255, 255, 0.34), transparent 60%),
    radial-gradient(90% 60% at 100% 100%, rgba(255, 214, 128, 0.22), transparent 65%);
  content: '';
  pointer-events: none;
}

.farm-shell {
  position: relative;
  z-index: 1;
  display: flex;
  width: min(100%, 1060px);
  flex-direction: column;
  gap: 14px;
  margin: 0 auto;
}

.farm-glass {
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 22px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0.42) 100%);
  box-shadow:
    0 12px 30px rgba(25, 58, 36, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.75);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
}

/* 账号卡 */
.profile-card {
  padding: 18px 20px 14px;
  color: #20382a;
}

.profile-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.avatar-button {
  display: flex;
  width: 58px;
  height: 58px;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
  border: 2px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  box-shadow: 0 4px 12px rgba(38, 72, 48, 0.2);
  cursor: pointer;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.avatar-button:hover {
  box-shadow: 0 6px 16px rgba(38, 72, 48, 0.28);
  transform: translateY(-1px);
}

.avatar-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-fallback {
  color: #6b8f77;
  font-size: 34px;
}

.profile-main {
  min-width: 0;
  flex: 1;
}

.profile-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.profile-title h1 {
  overflow: hidden;
  margin: 0;
  color: #1d3527;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.2px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6);
}

.level-chip {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #a8e063, #62c655);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(69, 154, 53, 0.35);
}

.exp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 11px;
}

.exp-track {
  height: 12px;
  flex: 1;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.55);
  box-shadow: inset 0 1px 3px rgba(57, 94, 65, 0.18);
}

.exp-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #8ee06a 0%, #4dc24c 100%);
  box-shadow: 0 0 10px rgba(88, 196, 75, 0.55);
  transition: width 0.5s ease;
}

.exp-numbers {
  flex: none;
  color: #3b5a46;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.profile-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  font-size: 12px;
}

.profile-metric {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #476b55;
}

.profile-metric .i-carbon-flash {
  color: #4f9ee8;
  font-size: 14px;
}

.upgrade-text {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: #27a34a;
  font-weight: 600;
}

.upgrade-text--muted {
  color: #7d8f84;
}

/* 资产卡 */
.asset-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.asset-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  padding: 11px 12px 12px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 18px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.asset-card:hover {
  box-shadow: 0 10px 22px rgba(28, 62, 38, 0.18);
  transform: translateY(-2px);
}

.asset-card--gold {
  background: linear-gradient(135deg, rgba(255, 246, 214, 0.9), rgba(255, 227, 160, 0.66));
}

.asset-card--coupon {
  background: linear-gradient(135deg, rgba(224, 249, 235, 0.9), rgba(188, 235, 213, 0.64));
}

.asset-card--diamond {
  background: linear-gradient(135deg, rgba(226, 243, 255, 0.9), rgba(190, 223, 250, 0.64));
}

.asset-card--goldBean {
  background: linear-gradient(135deg, rgba(255, 239, 220, 0.9), rgba(255, 216, 178, 0.66));
}

.asset-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #4c5d51;
  font-size: 12px;
}

.asset-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.72);
  font-size: 13px;
}

.asset-card--gold .asset-icon {
  color: #d69b1a;
}

.asset-card--coupon .asset-icon {
  color: #2f9d64;
}

.asset-card--diamond .asset-icon {
  color: #3386c9;
}

.asset-card--goldBean .asset-icon {
  color: #d9812c;
}

.asset-label {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-arrow {
  margin-left: auto;
  color: rgba(79, 107, 88, 0.55);
  font-size: 14px;
}

.asset-value {
  overflow: hidden;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 0.3px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-card--gold .asset-value {
  color: #b97808;
}

.asset-card--coupon .asset-value {
  color: #1f8a55;
}

.asset-card--diamond .asset-value {
  color: #2472b5;
}

.asset-card--goldBean .asset-value {
  color: #c96c1c;
}

/* 运行状态 */
.run-card {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 148px;
  align-items: stretch;
  overflow: hidden;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: 22px;
  color: #20382a;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

.run-left {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  padding: 16px 20px;
}

.run-badges {
  display: flex;
  align-items: center;
  gap: 8px;
}

.run-online {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #2f7d4c;
  font-size: 12px;
  font-weight: 600;
}

.run-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #35c05a;
  box-shadow: 0 0 0 3px rgba(53, 192, 90, 0.2);
}

.run-dot--off {
  background: #cbd5cb;
  box-shadow: 0 0 0 3px rgba(148, 163, 148, 0.18);
}

.run-badge {
  padding: 3px 9px;
  border: 1px solid rgba(58, 129, 71, 0.25);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.55);
  color: #3c6b49;
  font-size: 11px;
  font-weight: 600;
}

.run-time-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.run-clock {
  display: inline-flex;
  width: 34px;
  height: 34px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, #8ee06a, #4dc24c);
  color: #fff;
  font-size: 18px;
  box-shadow: 0 5px 14px rgba(72, 166, 71, 0.35);
}

.run-time {
  color: #1c3526;
  font-size: clamp(28px, 4.4vw, 38px);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.65);
}

.run-caption {
  margin-top: 4px;
  margin-left: 44px;
  color: #5a7a64;
  font-size: 12px;
}

.run-art {
  position: relative;
  width: 46%;
  flex: none;
  background-image:
    linear-gradient(90deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0) 36%),
    url('https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=cute%20cartoon%20farmhouse%20on%20a%20green%20hill%2C%20red%20roof%2C%20fruit%20trees%2C%20colorful%20flowers%2C%20blue%20sky%2C%20warm%20sunlight%2C%20soft%20studio%20ghibli%20style%20landscape%20illustration%2C%20no%20text&image_size=landscape_4_3');
  background-position: center, center;
  background-size: cover, cover;
  background-repeat: no-repeat;
}

.run-enter {
  position: absolute;
  top: 50%;
  right: 14px;
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.82);
  color: #4b6b56;
  font-size: 18px;
  box-shadow: 0 4px 12px rgba(36, 68, 44, 0.2);
  transform: translateY(-50%);
}

/* 功能宫格 */
.feature-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.feature-card {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 12px 12px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 18px;
  color: #20382a;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease,
    background-color 0.15s ease;
}

.feature-card:hover {
  background-color: rgba(255, 255, 255, 0.16);
  box-shadow: 0 10px 24px rgba(27, 60, 37, 0.18);
  transform: translateY(-2px);
}

.feature-icon {
  display: inline-flex;
  width: 42px;
  height: 42px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.7);
  font-size: 22px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
}

.feature-icon--illustrated {
  color: #4fa53a;
}

.feature-icon--pet {
  color: #d9922f;
}

.feature-icon--collection {
  color: #4b8fd8;
}

.feature-icon--mall {
  color: #d0813a;
}

.feature-icon--activity {
  color: #d96a9a;
}

.feature-icon--analytics {
  color: #3b9a8c;
}

.feature-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.feature-copy strong {
  overflow: hidden;
  color: #233c2c;
  font-size: 14px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feature-copy small {
  overflow: hidden;
  color: #5c7864;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feature-arrow {
  flex: none;
  color: rgba(79, 107, 88, 0.55);
  font-size: 16px;
}

/* 巡查倒计时 / 今日统计 */
.insight-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.insight-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 16px 18px;
  color: #20382a;
}

.insight-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.insight-icon {
  display: inline-flex;
  width: 38px;
  height: 38px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.72);
  font-size: 20px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
}

.insight-icon--time {
  color: #2563eb;
}

.insight-icon--stats {
  color: #d9821f;
}

.insight-heading {
  min-width: 0;
}

.insight-heading h2 {
  margin: 0;
  color: #1f3b2b;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3px;
}

.insight-heading p {
  margin: 3px 0 0;
  overflow: hidden;
  color: #5c7864;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.36);
}

.check-icon {
  display: inline-flex;
  width: 24px;
  height: 24px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.66);
  font-size: 14px;
}

.check-icon--farm {
  color: #3f9e4d;
}

.check-icon--friend {
  color: #3a8fc4;
}

.check-label {
  color: #3c5a47;
  font-size: 13px;
}

.check-value {
  margin-left: auto;
  color: #2f4b38;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.check-value--muted {
  color: #708878;
  font-size: 13px;
  font-weight: 600;
}

.insight-empty {
  padding: 18px 0;
  color: rgba(58, 86, 66, 0.65);
  font-size: 13px;
  text-align: center;
}

.operation-grid {
  display: grid;
  max-height: 146px;
  gap: 6px;
  overflow-y: auto;
  padding-right: 3px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  scrollbar-color: rgba(93, 128, 99, 0.45) transparent;
  scrollbar-width: thin;
}

.operation-chip {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.34);
  font-size: 11px;
}

.operation-icon {
  flex: none;
  color: #5b8462;
  font-size: 13px;
}

.operation-label {
  overflow: hidden;
  color: #5d7466;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.operation-value {
  margin-left: auto;
  color: #2f4b38;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.session-gains {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(59, 92, 57, 0.12);
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.gain-title {
  margin: 0;
  color: #6b8272;
  font-size: 10px;
  grid-column: 1 / -1;
  letter-spacing: 0.4px;
}

.gain-item {
  padding: 6px 4px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.3);
  text-align: center;
}

.gain-item span {
  display: block;
  color: #6b8272;
  font-size: 10px;
}

.gain-item strong {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.gain--positive {
  color: #2f9e4d;
}

.gain--negative {
  color: #d24b44;
}

.gain--neutral {
  color: #5d7466;
}

/* 日志 */
.log-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  color: #20382a;
}

.log-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.log-title {
  min-width: 0;
}

.log-title-main h2 {
  margin: 0;
  color: #1f3b2b;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 1px;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6);
}

.log-title-main p {
  margin: 5px 0 0;
  color: #54705e;
  font-size: 11px;
}

.log-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.log-filter-control {
  width: 118px;
  flex: none;
}

.log-filter-control--keyword {
  width: 150px;
}

.log-filter-control :deep(.n-select),
.log-filter-control :deep(.n-input) {
  width: 100%;
}

.log-filter-control :deep(.n-base-selection) {
  border-radius: 10px;
}

.log-search,
.log-reset,
.log-clear {
  display: inline-flex;
  width: 34px;
  height: 34px;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 10px;
  cursor: pointer;
  font-size: 16px;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease;
}

.log-search {
  border: 1px solid rgba(255, 255, 255, 0.7);
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  color: #fff;
  box-shadow: 0 5px 14px rgba(37, 99, 235, 0.3);
}

.log-search:hover {
  box-shadow: 0 7px 18px rgba(37, 99, 235, 0.4);
}

.log-reset,
.log-clear {
  border: 1px solid rgba(90, 120, 96, 0.2);
  background: rgba(255, 255, 255, 0.4);
  color: #6b8a74;
}

.log-reset:hover,
.log-clear:hover {
  background: rgba(255, 255, 255, 0.72);
  color: #2563eb;
}

.log-clear:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.log-body {
  display: flex;
  min-height: 0;
  align-items: center;
  gap: 12px;
}

.log-list {
  display: flex;
  min-width: 0;
  max-height: 214px;
  min-height: 120px;
  flex: 1;
  flex-direction: column;
  gap: 5px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-color: rgba(93, 128, 99, 0.45) transparent;
  scrollbar-width: thin;
}

.log-list::-webkit-scrollbar {
  width: 5px;
}

.log-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(93, 128, 99, 0.45);
}

.log-empty {
  padding: 26px 0;
  color: rgba(58, 86, 66, 0.65);
  font-size: 13px;
  text-align: center;
}

.log-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.34);
  font-size: 12px;
  line-height: 1.4;
}

.log-time {
  flex: none;
  color: #647c6b;
  font-variant-numeric: tabular-nums;
}

.log-tag {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.log-tag--friend {
  background: rgba(232, 221, 252, 0.9);
  color: #7c4dbe;
}

.log-tag--farm {
  background: rgba(214, 243, 217, 0.9);
  color: #2f8547;
}

.log-tag--activity {
  background: rgba(255, 231, 208, 0.9);
  color: #c06a1f;
}

.log-tag--warehouse {
  background: rgba(255, 243, 205, 0.9);
  color: #a67a12;
}

.log-tag--task {
  background: rgba(216, 235, 253, 0.9);
  color: #2f70ad;
}

.log-tag--mall {
  background: rgba(255, 235, 220, 0.9);
  color: #b4632a;
}

.log-tag--shop {
  background: rgba(212, 242, 240, 0.9);
  color: #247a73;
}

.log-tag--pet {
  background: rgba(255, 226, 236, 0.9);
  color: #b04773;
}

.log-tag--system {
  background: rgba(226, 232, 228, 0.9);
  color: #5d7163;
}

.log-msg {
  min-width: 0;
  overflow: hidden;
  color: #2f4b38;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-latest {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(96, 165, 250, 0.95), rgba(37, 99, 235, 0.95));
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.35);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.log-latest:hover {
  box-shadow: 0 8px 20px rgba(37, 99, 235, 0.45);
  transform: translateY(-1px);
}

@media (max-width: 860px) {
  .farm-dashboard {
    min-height: calc(100dvh - 132px);
    padding: 13px;
    border-radius: 24px;
  }

  .farm-shell {
    gap: 11px;
  }

  .profile-card {
    padding: 14px 15px 12px;
  }

  .profile-title h1 {
    font-size: 17px;
  }

  .avatar-button {
    width: 50px;
    height: 50px;
  }

  .asset-value {
    font-size: 19px;
  }

  .run-art {
    width: 42%;
  }

  .run-left {
    padding: 14px 16px;
  }

  .run-time {
    font-size: 28px;
  }

  .feature-card {
    padding: 10px;
  }

  .feature-icon {
    width: 38px;
    height: 38px;
    font-size: 20px;
  }

  .log-card {
    padding: 14px;
  }

  .log-filter-control {
    width: 108px;
  }

  .log-filter-control--keyword {
    width: 132px;
  }

  .log-title-main h2 {
    font-size: 18px;
  }
}

@media (max-width: 640px) {
  .asset-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .feature-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .insight-grid {
    grid-template-columns: 1fr;
  }

  .run-card {
    min-height: 136px;
  }

  .run-art {
    width: 38%;
  }

  .run-time {
    font-size: 24px;
    letter-spacing: 1px;
  }

  .run-clock {
    width: 30px;
    height: 30px;
    font-size: 16px;
  }

  .run-caption {
    margin-left: 40px;
  }

  .log-card {
    gap: 10px;
  }

  .log-head {
    align-items: stretch;
    flex-direction: column;
  }

  .log-filters {
    width: 100%;
  }

  .log-filter-control {
    width: auto;
    flex: 1 1 100px;
  }

  .log-filter-control--keyword {
    flex: 1 1 140px;
  }

  .log-title-main p {
    margin-top: 3px;
  }

  .log-body {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
  }

  .log-list {
    max-height: 190px;
    min-height: 110px;
  }

  .log-latest {
    align-self: flex-end;
    padding: 7px 13px;
  }
}

@media (max-width: 400px) {
  .farm-dashboard {
    padding: 10px;
    border-radius: 20px;
  }

  .farm-glass {
    border-radius: 18px;
  }

  .profile-foot {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .run-art {
    width: 34%;
  }

  .feature-copy small {
    font-size: 10px;
  }
}

/* 移动端让插画背景延伸到固定底栏下方，内容仍保留安全间距 */
@media (max-width: 1023px) {
  .farm-dashboard {
    min-height: calc(100dvh - 86px);
    margin-bottom: calc(-132px - env(safe-area-inset-bottom));
    padding-bottom: calc(132px + env(safe-area-inset-bottom));
  }
}
</style>
