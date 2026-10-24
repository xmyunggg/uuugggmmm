<script setup lang="ts">
import type { AgentSpec } from '@/stores/user'
import { computed, onMounted, ref } from 'vue'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'
import BaseSelect from '@/components/ref-ui/BaseSelect.vue'
import { formatAgentPrice } from '@/composables/useAdminAgents'
import { useToastStore } from '@/stores/toast'
import { formatTimeDuration, useUserStore } from '@/stores/user'

interface AgentCard {
  code: string
  description?: string
  type: 'time' | 'quota'
  enabled: boolean
  usedBy: string | null
  usedAt: number | null
  createdAt: number
  value?: number
  durationValue?: number
  durationUnit?: 'hour' | 'day'
  durationMs?: number | null
  isPermanent?: boolean
}

interface AgentCustomer {
  username: string
  role: string
  accountLimit: number
  createdAt: number
  card: { expiresAt: number | null, enabled: boolean } | null
}

const userStore = useUserStore()
const toast = useToastStore()

const loading = ref(false)
const generating = ref(false)
const activeTab = ref<'cards' | 'customers'>('cards')
const specId = ref('')
const count = ref(1)
const description = ref('')
const generatedCodes = ref<string[]>([])
const cards = ref<AgentCard[]>([])
const cardsLoading = ref(false)
const customers = ref<AgentCustomer[]>([])
const customersLoading = ref(false)
const rechargeCode = ref('')
const recharging = ref(false)
const rechargeRecords = ref<{ code: string, amount: number, usedAt: number | null }[]>([])

const agent = computed(() => userStore.agentInfo)
const specs = computed<AgentSpec[]>(() => agent.value?.specs || [])
const specOptions = computed(() => specs.value.map(spec => ({ label: `${spec.name}（${describeSpec(spec)} · ${formatAgentPrice(spec.price)}）`, value: spec.id })))
const selectedSpec = computed(() => specs.value.find(spec => spec.id === specId.value) || null)
const balance = computed(() => Number(agent.value?.balance) || 0)
const unitPrice = computed(() => Math.max(0, Number(selectedSpec.value?.price) || 0))
const estimatedCost = computed(() => unitPrice.value * Math.max(1, Math.floor(Number(count.value) || 1)))
const balanceEnough = computed(() => estimatedCost.value <= 0 || balance.value >= estimatedCost.value)

const stats = computed(() => ({
  issued: cards.value.length,
  used: cards.value.filter(card => !!card.usedBy).length,
  customers: customers.value.length,
  activeCustomers: customers.value.filter(customer => isCardActive(customer.card)).length,
}))

function describeSpec(spec: AgentSpec) {
  if (spec.type === 'quota')
    return `额度 +${spec.value ?? 0}`
  const duration = spec.isPermanent ? '永久' : `${spec.durationValue ?? 0}${spec.durationUnit === 'hour' ? '小时' : '天'}`
  const limit = Number(spec.accountLimit)
  return Number.isFinite(limit) && limit > 0 ? `${duration} · 额度${limit}` : duration
}

function quotaText(value: number | undefined) {
  if (value === undefined || value < 0)
    return '不限'
  return `${value} 张`
}

function formatDate(timestamp: number | null | undefined) {
  if (!timestamp)
    return '-'
  return new Date(timestamp).toLocaleString('zh-CN')
}

function isExpired(expiresAt: number | null | undefined) {
  return !!expiresAt && Date.now() > expiresAt
}

function isCardActive(card: AgentCustomer['card']) {
  if (!card)
    return false
  return card.enabled !== false && !isExpired(card.expiresAt)
}

async function copyText(text: string, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  }
  catch {
    toast.error('复制失败，请手动复制')
  }
}

function copyAllGenerated() {
  if (generatedCodes.value.length === 0)
    return
  copyText(generatedCodes.value.join('\n'), `已复制 ${generatedCodes.value.length} 个卡密`)
}

async function loadCards() {
  cardsLoading.value = true
  try {
    const res = await userStore.fetchMyAgentCards()
    cards.value = res.ok ? res.data : []
  }
  catch {
    cards.value = []
  }
  finally {
    cardsLoading.value = false
  }
}

async function loadCustomers() {
  customersLoading.value = true
  try {
    const res = await userStore.fetchMyAgentCustomers()
    customers.value = res.ok ? res.data : []
  }
  catch {
    customers.value = []
  }
  finally {
    customersLoading.value = false
  }
}

async function loadRechargeRecords() {
  try {
    const res = await userStore.fetchAgentRechargeRecords()
    rechargeRecords.value = res.ok ? res.data : []
  }
  catch {
    rechargeRecords.value = []
  }
}

async function refreshAll() {
  loading.value = true
  try {
    await Promise.all([
      userStore.fetchAgentMe(),
      loadCards(),
      loadCustomers(),
      loadRechargeRecords(),
    ])
    if (!specId.value && specs.value.length > 0)
      specId.value = specs.value[0]?.id || ''
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e.message || '加载代理信息失败')
  }
  finally {
    loading.value = false
  }
}

async function handleRecharge() {
  const code = rechargeCode.value.trim()
  if (!code) {
    toast.warning('请输入充值卡密')
    return
  }
  recharging.value = true
  try {
    const res = await userStore.redeemAgentRechargeCard(code)
    if (res.ok) {
      toast.success(`充值成功，本次 +${res.data.amount}，当前余额 ${res.data.balance}`)
      rechargeCode.value = ''
      await loadRechargeRecords()
    }
    else {
      toast.error(res.error || '充值失败')
    }
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e.message || '充值失败')
  }
  finally {
    recharging.value = false
  }
}

async function handleGenerate() {
  if (!specId.value) {
    toast.warning('请选择发卡规格')
    return
  }
  const num = Math.max(1, Math.min(100, Math.floor(Number(count.value) || 1)))
  if (unitPrice.value > 0 && balance.value < unitPrice.value * num) {
    toast.warning('余额不足，请先充值')
    return
  }
  generating.value = true
  try {
    const res = await userStore.generateAgentCards(specId.value, num, description.value.trim() || undefined)
    if (res.ok) {
      generatedCodes.value = (res.data.cards || []).map((card: any) => card.code)
      const cost = Number(res.data.cost) || 0
      toast.success(cost > 0 ? `已生成 ${generatedCodes.value.length} 个卡密，扣除余额 ${cost}` : `已生成 ${generatedCodes.value.length} 个卡密`)
      description.value = ''
      count.value = 1
      await loadCards()
    }
    else {
      toast.error(res.error || '发卡失败')
    }
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e.message || '发卡失败')
  }
  finally {
    generating.value = false
  }
}

function cardValueText(card: AgentCard) {
  if (card.type === 'quota')
    return `+${card.value ?? 0} 额度`
  return formatTimeDuration(card)
}

onMounted(refreshAll)
</script>

<template>
  <div class="ref-ui agent-center">
    <section class="mx-auto max-w-5xl py-8 space-y-6">
      <div class="glass-card rounded-3xl p-6 sm:p-8">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="i-carbon-user-multiple text-2xl text-emerald-500" />
            <div>
              <h1 class="text-2xl font-bold">
                代理中心
              </h1>
              <p class="text-sm text-gray-500 dark:text-gray-400">
                {{ agent?.username || userStore.username }} · {{ agent?.note || '未填写备注' }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span
              class="inline-flex rounded-full px-3 py-1 text-xs font-semibold"
              :class="agent?.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'"
            >
              {{ agent?.enabled ? '正常' : '已停用' }}
            </span>
            <BaseButton variant="secondary" size="sm" :loading="loading" @click="refreshAll">
              刷新
            </BaseButton>
          </div>
        </div>

        <div class="grid grid-cols-2 mt-6 gap-3 sm:grid-cols-3">
          <div class="rounded-2xl bg-emerald-50 px-4 py-3 dark:bg-emerald-900/20">
            <div class="text-xs text-emerald-700 dark:text-emerald-300">
              账户余额
            </div>
            <div class="mt-1 text-emerald-700 font-semibold dark:text-emerald-200">
              {{ balance }}
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              剩余总额度
            </div>
            <div class="mt-1 text-gray-900 font-semibold dark:text-gray-100">
              {{ quotaText(agent?.remainingTotal) }}
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              今日剩余
            </div>
            <div class="mt-1 text-gray-900 font-semibold dark:text-gray-100">
              {{ quotaText(agent?.remainingDaily) }}
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              累计发卡
            </div>
            <div class="mt-1 text-gray-900 font-semibold dark:text-gray-100">
              {{ stats.issued }} 张
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              客户数
            </div>
            <div class="mt-1 text-gray-900 font-semibold dark:text-gray-100">
              {{ stats.customers }} 人（活跃 {{ stats.activeCustomers }}）
            </div>
          </div>
          <div class="rounded-2xl bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              已使用卡密
            </div>
            <div class="mt-1 text-gray-900 font-semibold dark:text-gray-100">
              {{ stats.used }} 张
            </div>
          </div>
        </div>
      </div>

      <!-- 充值 -->
      <div class="glass-card rounded-3xl p-6 sm:p-8">
        <div class="mb-4 flex items-center gap-3">
          <div class="i-carbon-wallet text-2xl text-emerald-500" />
          <div>
            <h2 class="text-lg font-bold">
              余额充值
            </h2>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              输入管理员发放的充值卡密，充值金额立即计入账户余额。
            </p>
          </div>
        </div>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div class="w-full sm:max-w-sm">
            <BaseInput v-model="rechargeCode" label="充值卡密" placeholder="输入充值卡密" />
          </div>
          <BaseButton variant="primary" :loading="recharging" @click="handleRecharge">
            立即充值
          </BaseButton>
        </div>
        <div v-if="rechargeRecords.length > 0" class="mt-4">
          <div class="mb-2 text-xs text-gray-500 dark:text-gray-400">
            充值记录
          </div>
          <div class="max-h-40 overflow-y-auto space-y-1">
            <div
              v-for="record in rechargeRecords"
              :key="record.code"
              class="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5 text-xs dark:bg-gray-900/40"
            >
              <span class="text-gray-700 font-mono dark:text-gray-300">{{ record.code }}</span>
              <span class="text-gray-500 dark:text-gray-400">+{{ record.amount }} · {{ formatDate(record.usedAt) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 发卡 -->
      <div class="glass-card rounded-3xl p-6 sm:p-8">
        <div class="mb-4 flex items-center gap-3">
          <div class="i-carbon-ticket text-2xl text-emerald-500" />
          <div>
            <h2 class="text-lg font-bold">
              生成卡密
            </h2>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              按管理员预置的规格发卡，生成的卡密可直接发给客户注册或续费。
            </p>
          </div>
        </div>

        <div v-if="specs.length === 0" class="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          当前没有可用规格，请联系管理员配置发卡规格。
        </div>

        <div v-else class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-3">
            <BaseSelect v-model="specId" label="发卡规格" :options="specOptions" placeholder="请选择规格" />
            <BaseInput v-model.number="count" type="number" min="1" max="100" label="数量（最多100）" />
            <BaseInput v-model="description" label="备注" placeholder="选填，默认使用规格名" />
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <BaseButton variant="primary" :loading="generating" :disabled="!selectedSpec || !balanceEnough" @click="handleGenerate">
              生成卡密
            </BaseButton>
            <span v-if="selectedSpec" class="text-sm text-gray-500 dark:text-gray-400">
              规格：{{ describeSpec(selectedSpec) }}
            </span>
            <span v-if="selectedSpec" class="text-sm" :class="balanceEnough ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'">
              需扣余额 {{ estimatedCost }}（当前余额 {{ balance }}）{{ balanceEnough ? '' : '，余额不足' }}
            </span>
          </div>

          <div v-if="generatedCodes.length > 0" class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4">
            <div class="mb-2 flex items-center justify-between">
              <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
                本次生成 {{ generatedCodes.length }} 个卡密
              </div>
              <div class="flex gap-2">
                <BaseButton variant="secondary" size="sm" @click="copyAllGenerated">
                  复制全部
                </BaseButton>
                <BaseButton variant="ghost" size="sm" @click="generatedCodes = []">
                  清空
                </BaseButton>
              </div>
            </div>
            <div class="max-h-56 overflow-y-auto space-y-1">
              <div
                v-for="code in generatedCodes"
                :key="code"
                class="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900/40"
              >
                <span class="text-xs text-gray-800 font-mono dark:text-gray-200">{{ code }}</span>
                <button class="text-xs text-emerald-600 dark:text-emerald-400 hover:underline" @click="copyText(code)">
                  复制
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 卡密 / 客户 -->
      <div class="glass-card rounded-3xl p-6 sm:p-8">
        <div class="mb-4 flex items-center gap-2">
          <button
            class="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            :class="activeTab === 'cards' ? 'text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'"
            :style="activeTab === 'cards' ? { backgroundColor: 'var(--theme-primary)' } : {}"
            @click="activeTab = 'cards'"
          >
            我的卡密
          </button>
          <button
            class="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            :class="activeTab === 'customers' ? 'text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'"
            :style="activeTab === 'customers' ? { backgroundColor: 'var(--theme-primary)' } : {}"
            @click="activeTab = 'customers'"
          >
            我的客户
          </button>
        </div>

        <template v-if="activeTab === 'cards'">
          <div v-if="cardsLoading" class="py-8 text-center text-gray-500">
            加载中...
          </div>
          <div v-else class="overflow-x-auto border border-[var(--theme-border)] rounded-2xl">
            <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead class="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    卡密
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    内容
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    状态
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    使用者
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    创建时间
                  </th>
                  <th class="px-3 py-2 text-right text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="card in cards" :key="card.code">
                  <td class="whitespace-nowrap px-3 py-2 text-xs text-gray-800 font-mono dark:text-gray-200">
                    {{ card.code }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                    {{ cardValueText(card) }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2">
                    <span
                      class="inline-flex rounded-full px-2 text-xs font-semibold leading-5"
                      :class="card.usedBy ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200' : (card.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200')"
                    >
                      {{ card.usedBy ? '已使用' : (card.enabled ? '未使用' : '已禁用') }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                    {{ card.usedBy || '-' }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                    {{ formatDate(card.createdAt) }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-right">
                    <button class="text-xs text-emerald-600 dark:text-emerald-400 hover:underline" @click="copyText(card.code)">
                      复制
                    </button>
                  </td>
                </tr>
                <tr v-if="cards.length === 0">
                  <td colspan="6" class="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                    还没有发过卡
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else>
          <div v-if="customersLoading" class="py-8 text-center text-gray-500">
            加载中...
          </div>
          <div v-else class="overflow-x-auto border border-[var(--theme-border)] rounded-2xl">
            <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead class="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    用户名
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    额度
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    时长
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    到期时间
                  </th>
                  <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                    状态
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="customer in customers" :key="customer.username">
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 font-medium dark:text-white">
                    {{ customer.username }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                    {{ customer.accountLimit }} 个
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                    {{ customer.card ? formatTimeDuration(customer.card) : '无' }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                    {{ formatDate(customer.card?.expiresAt) }}
                  </td>
                  <td class="whitespace-nowrap px-3 py-2">
                    <span
                      v-if="customer.card"
                      class="inline-flex rounded-full px-2 text-xs font-semibold leading-5"
                      :class="isCardActive(customer.card) ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'"
                    >
                      {{ isCardActive(customer.card) ? '正常' : (customer.card.enabled === false ? '封禁' : '已过期') }}
                    </span>
                    <span v-else class="text-gray-500">-</span>
                  </td>
                </tr>
                <tr v-if="customers.length === 0">
                  <td colspan="5" class="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                    还没有归属到你的客户
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
