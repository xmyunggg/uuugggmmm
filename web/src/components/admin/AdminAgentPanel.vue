<script setup lang="ts">
import type { AdminAgent } from '@/composables/useAdminAgents'
import { computed, onMounted, ref } from 'vue'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'
import BaseSelect from '@/components/ref-ui/BaseSelect.vue'
import ConfirmModal from '@/components/ref-ui/ConfirmModal.vue'
import { formatAgentPrice, formatAgentSpec, useAdminAgents } from '@/composables/useAdminAgents'
import { useToastStore } from '@/stores/toast'
import { formatTimeDuration } from '@/stores/user'

const {
  specs,
  loading,
  searchQuery,
  filteredAgents,
  agents,
  enabledCount,
  totalIssued,
  showAgentModal,
  agentForm,
  editingAgent,
  savingAgent,
  showSaveConfirm,
  showToggleConfirm,
  pendingToggle,
  toggleLoading,
  showDeleteConfirm,
  pendingDelete,
  deleteLoading,
  showCardsModal,
  cardsLoading,
  agentCards,
  cardsAgent,
  showCustomersModal,
  customersLoading,
  agentCustomers,
  customersAgent,
  showSpecModal,
  specForm,
  editingSpec,
  savingSpec,
  showSpecDeleteConfirm,
  pendingDeleteSpec,
  deletingSpec,
  rechargeCards,
  rechargeLoading,
  showRechargeModal,
  rechargeForm,
  savingRecharge,
  rechargeGenerated,
  showRechargeDeleteConfirm,
  pendingDeleteRecharge,
  deletingRecharge,
  fetchAgents,
  fetchSpecs,
  fetchRechargeCards,
  openCreateAgent,
  openEditAgent,
  requestSaveAgent,
  confirmSaveAgent,
  requestToggleAgent,
  confirmToggleAgent,
  requestDeleteAgent,
  confirmDeleteAgent,
  openAgentCards,
  openAgentCustomers,
  openSpecModal,
  openEditSpec,
  requestSaveSpec,
  toggleSpec,
  requestDeleteSpec,
  confirmDeleteSpec,
  openRechargeModal,
  saveRechargeCards,
  requestDeleteRechargeCard,
  confirmDeleteRechargeCard,
} = useAdminAgents()

const showSpecSection = ref(true)
const showRechargeSection = ref(false)

const toast = useToastStore()

const totalBalance = computed(() => agents.value.reduce((sum, agent) => sum + (Number(agent.balance) || 0), 0))
const unusedRechargeCount = computed(() => rechargeCards.value.filter(card => !card.usedBy).length)
const specTypeOptions = [
  { label: '时间卡', value: 'time' },
  { label: '额度卡', value: 'quota' },
]
const durationUnitOptions = [
  { label: '天', value: 'day' },
  { label: '小时', value: 'hour' },
]

onMounted(() => {
  fetchAgents()
  fetchSpecs()
  fetchRechargeCards()
})

function quotaText(value: number) {
  return value < 0 ? '不限' : `${value} 张`
}

function specNames(agent: AdminAgent) {
  if (!Array.isArray(agent.specIds) || agent.specIds.length === 0)
    return '全部规格'
  return agent.specIds.map(id => specs.value.find(spec => spec.id === id)?.name || id).join('、')
}

function formatDate(timestamp: number | null | undefined) {
  if (!timestamp)
    return '-'
  return new Date(timestamp).toLocaleString('zh-CN')
}

function formatMoney(value: number | undefined) {
  const num = Number(value)
  if (!Number.isFinite(num))
    return '0'
  return num.toFixed(2).replace(/\.00$/, '')
}

function closeAgentModal() {
  if (savingAgent.value)
    return
  showAgentModal.value = false
  editingAgent.value = null
}

function closeCardsModal() {
  showCardsModal.value = false
  cardsAgent.value = null
}

function closeCustomersModal() {
  showCustomersModal.value = false
  customersAgent.value = null
}

function cardIsExpired(expiresAt: number | null | undefined) {
  return !!expiresAt && Date.now() > expiresAt
}

async function copyRechargeCode(code: string) {
  try {
    await navigator.clipboard.writeText(code)
    toast.success('已复制充值卡密')
  }
  catch {
    toast.error('复制失败，请手动复制')
  }
}

async function copyRechargeList() {
  if (rechargeGenerated.value.length === 0)
    return
  try {
    await navigator.clipboard.writeText(rechargeGenerated.value.join('\n'))
    toast.success(`已复制 ${rechargeGenerated.value.length} 张充值卡密`)
  }
  catch {
    toast.error('复制失败，请手动复制')
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
        代理管理
      </h3>
      <div class="flex items-center gap-2">
        <BaseButton variant="secondary" size="sm" @click="openRechargeModal">
          生成充值卡
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="openSpecModal">
          新建规格
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="fetchAgents">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" @click="openCreateAgent">
          新建代理
        </BaseButton>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 backdrop-blur-md dark:text-gray-200">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          代理总数
        </div>
        <div class="mt-1 font-semibold">
          {{ agents.length }} 个
        </div>
      </div>
      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 backdrop-blur-md dark:text-gray-200">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          启用中
        </div>
        <div class="mt-1 font-semibold">
          {{ enabledCount }} 个
        </div>
      </div>
      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 backdrop-blur-md dark:text-gray-200">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          累计发卡
        </div>
        <div class="mt-1 font-semibold">
          {{ totalIssued }} 张
        </div>
      </div>
      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-700 backdrop-blur-md dark:text-gray-200">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          代理余额合计
        </div>
        <div class="mt-1 font-semibold">
          {{ formatMoney(totalBalance) }}
        </div>
      </div>
    </div>

    <!-- 发卡规格 -->
    <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] backdrop-blur-md">
      <button
        class="w-full flex items-center justify-between px-4 py-3 text-left"
        @click="showSpecSection = !showSpecSection"
      >
        <span class="text-sm text-gray-900 font-semibold dark:text-gray-100">
          发卡规格（代理只能按这些规格发卡）
        </span>
        <div class="i-carbon-chevron-down text-gray-400 transition-transform" :class="{ 'rotate-180': showSpecSection }" />
      </button>
      <div v-if="showSpecSection" class="overflow-hidden border-t border-[var(--theme-border)]">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50/60 dark:bg-gray-700/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                名称
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                类型
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                内容
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                单价
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                状态
              </th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                操作
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="spec in specs" :key="spec.id">
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 font-medium dark:text-white">
                {{ spec.name }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm">
                <span class="inline-flex rounded-full px-2 text-xs font-semibold leading-5" :class="spec.type === 'quota' ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'">
                  {{ spec.type === 'quota' ? '额度卡' : '时间卡' }}
                </span>
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                {{ formatAgentSpec(spec) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm" :class="Number(spec.price) > 0 ? 'text-gray-900 dark:text-white' : 'text-gray-400'">
                {{ formatAgentPrice(spec.price) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2">
                <span class="inline-flex rounded-full px-2 text-xs font-semibold leading-5" :class="spec.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">
                  {{ spec.enabled ? '启用' : '停用' }}
                </span>
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-right text-sm font-medium">
                <button class="mr-3 text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300" @click="openEditSpec(spec)">
                  编辑
                </button>
                <button class="mr-3 text-yellow-600 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-300" @click="toggleSpec(spec)">
                  {{ spec.enabled ? '停用' : '启用' }}
                </button>
                <button class="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300" @click="requestDeleteSpec(spec)">
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="specs.length === 0">
              <td colspan="6" class="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                暂无规格，请先新建规格
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 代理充值卡 -->
    <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] backdrop-blur-md">
      <button
        class="w-full flex items-center justify-between px-4 py-3 text-left"
        @click="showRechargeSection = !showRechargeSection"
      >
        <span class="text-sm text-gray-900 font-semibold dark:text-gray-100">
          代理充值卡（代理凭卡密充值余额，剩余未使用 {{ unusedRechargeCount }} 张）
        </span>
        <div class="i-carbon-chevron-down text-gray-400 transition-transform" :class="{ 'rotate-180': showRechargeSection }" />
      </button>
      <div v-if="showRechargeSection" class="overflow-hidden border-t border-[var(--theme-border)]">
        <div class="flex items-center justify-between px-4 py-3">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            面额由管理员自定义，代理在「代理中心」输入卡密即可充值。
          </div>
          <div class="flex gap-2">
            <BaseButton variant="secondary" size="sm" @click="fetchRechargeCards">
              刷新
            </BaseButton>
            <BaseButton variant="primary" size="sm" @click="openRechargeModal">
              生成充值卡
            </BaseButton>
          </div>
        </div>
        <div v-if="rechargeLoading" class="py-6 text-center text-gray-500">
          加载中...
        </div>
        <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50/60 dark:bg-gray-700/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                卡密
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                面额
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                状态
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                使用代理
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
            <tr v-for="card in rechargeCards" :key="card.code">
              <td class="whitespace-nowrap px-3 py-2 text-xs text-gray-900 font-mono dark:text-white">
                {{ card.code }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 font-medium dark:text-white">
                {{ formatMoney(card.amount) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2">
                <span class="inline-flex rounded-full px-2 text-xs font-semibold leading-5" :class="card.usedBy ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200' : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'">
                  {{ card.usedBy ? '已使用' : '未使用' }}
                </span>
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                {{ card.usedBy || '-' }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {{ formatDate(card.createdAt) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-right text-sm font-medium">
                <button
                  v-if="!card.usedBy"
                  class="mr-3 text-emerald-600 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-300"
                  @click="copyRechargeCode(card.code)"
                >
                  复制
                </button>
                <button class="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300" @click="requestDeleteRechargeCard(card)">
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="rechargeCards.length === 0">
              <td colspan="6" class="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                暂无充值卡，点击「生成充值卡」创建
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div class="w-full sm:max-w-sm">
        <BaseInput
          v-model="searchQuery"
          label="搜索代理"
          type="search"
          placeholder="输入代理用户名"
          clearable
        />
      </div>
      <div class="text-xs text-gray-500 dark:text-gray-400">
        {{ searchQuery.trim() ? `找到 ${filteredAgents.length} 个代理` : `共 ${agents.length} 个代理` }}
      </div>
    </div>

    <div v-if="loading" class="py-8 text-center text-gray-500">
      <div i-svg-spinners-90-ring-with-bg class="mb-2 inline-block text-2xl" />
      <div>加载中...</div>
    </div>

    <div v-else class="overflow-hidden border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] shadow backdrop-blur-md">
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                代理
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                状态
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                剩余额度
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                累计发卡
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                余额
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                可用规格
              </th>
              <th class="px-3 py-2 text-left text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                创建时间
              </th>
              <th class="px-3 py-2 text-right text-xs text-gray-500 font-medium uppercase dark:text-gray-300">
                操作
              </th>
            </tr>
          </thead>
          <tbody class="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
            <tr v-for="agent in filteredAgents" :key="agent.username">
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 font-medium dark:text-white">
                <div>{{ agent.username }}</div>
                <div v-if="agent.note" class="text-xs text-gray-500 dark:text-gray-400">
                  {{ agent.note }}
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2">
                <span class="inline-flex rounded-full px-2 text-xs font-semibold leading-5" :class="agent.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'">
                  {{ agent.enabled ? '正常' : '已停用' }}
                </span>
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                <div>总：{{ quotaText(agent.remainingTotal) }}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">
                  日：{{ quotaText(agent.remainingDaily) }}
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                {{ agent.usedTotal }} 张
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm font-medium" :class="Number(agent.balance) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'">
                {{ formatMoney(agent.balance) }}
              </td>
              <td class="max-w-[220px] truncate px-3 py-2 text-sm text-gray-900 dark:text-white" :title="specNames(agent)">
                {{ specNames(agent) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {{ formatDate(agent.createdAt) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-right text-sm font-medium">
                <button class="mr-3 text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300" @click="openEditAgent(agent)">
                  编辑
                </button>
                <button class="mr-3 text-purple-600 dark:text-purple-400 hover:text-purple-900 dark:hover:text-purple-300" @click="openAgentCards(agent)">
                  卡密
                </button>
                <button class="mr-3 text-emerald-600 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-300" @click="openAgentCustomers(agent)">
                  客户
                </button>
                <button class="mr-3 text-yellow-600 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-300" @click="requestToggleAgent(agent)">
                  {{ agent.enabled ? '停用' : '启用' }}
                </button>
                <button class="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300" @click="requestDeleteAgent(agent)">
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="filteredAgents.length === 0">
              <td colspan="8" class="px-3 py-8 text-center text-gray-500 dark:text-gray-400">
                <div class="i-carbon-user-multiple mx-auto mb-2 text-3xl text-gray-300" />
                <div class="text-sm">
                  {{ searchQuery.trim() ? '没有找到匹配的代理' : '暂无代理' }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建/编辑代理 -->
    <div
      v-if="showAgentModal"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 p-3 sm:items-center sm:p-4"
      @click.self="closeAgentModal"
    >
      <div class="my-auto max-h-[calc(100dvh-1.5rem)] max-w-lg w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] dark:bg-gray-800 sm:p-5" @click.stop>
        <h2 class="mb-4 text-lg text-gray-900 font-bold dark:text-white">
          {{ editingAgent ? `编辑代理：${editingAgent.username}` : '新建代理' }}
        </h2>

        <div class="space-y-4">
          <BaseInput
            v-model="agentForm.username"
            label="代理用户名"
            placeholder="字母、数字、下划线，3-32 位"
          />
          <BaseInput
            v-model="agentForm.password"
            type="password"
            label="登录密码"
            :placeholder="editingAgent ? '留空则不修改' : '至少 6 位'"
          />
          <BaseInput
            v-model="agentForm.note"
            label="备注"
            placeholder="选填，用于标记渠道"
          />

          <div class="grid gap-3 md:grid-cols-2">
            <div class="border border-gray-200 rounded-xl p-4 space-y-2 dark:border-gray-700">
              <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
                总发卡额度
              </div>
              <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input v-model="agentForm.unlimitedTotal" type="checkbox" class="border-gray-300 rounded">
                不限量
              </label>
              <BaseInput
                v-if="!agentForm.unlimitedTotal"
                v-model.number="agentForm.quotaTotal"
                type="number"
                min="0"
                placeholder="可发卡总数"
              />
            </div>
            <div class="border border-gray-200 rounded-xl p-4 space-y-2 dark:border-gray-700">
              <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
                每日发卡额度
              </div>
              <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input v-model="agentForm.unlimitedDaily" type="checkbox" class="border-gray-300 rounded">
                不限量
              </label>
              <BaseInput
                v-if="!agentForm.unlimitedDaily"
                v-model.number="agentForm.quotaDaily"
                type="number"
                min="0"
                placeholder="每日可发卡数"
              />
            </div>
          </div>

          <div class="border border-gray-200 rounded-xl p-4 space-y-2 dark:border-gray-700">
            <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
              代理余额
            </div>
            <BaseInput
              v-model.number="agentForm.balance"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
            />
            <p class="text-xs text-gray-500 dark:text-gray-400">
              代理发卡按规格单价从余额扣费；日常充值建议发放「充值卡」，此处可直接调整余额。
            </p>
          </div>

          <div class="border border-gray-200 rounded-xl p-4 dark:border-gray-700">
            <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
              可使用规格
            </div>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              不勾选任何规格表示可使用全部规格。
            </p>
            <div class="grid mt-3 gap-2 sm:grid-cols-2">
              <label
                v-for="spec in specs"
                :key="spec.id"
                class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
              >
                <input v-model="agentForm.specIds" type="checkbox" :value="spec.id" class="border-gray-300 rounded">
                <span>{{ spec.name }}</span>
                <span class="text-xs text-gray-400">({{ formatAgentSpec(spec) }} · {{ formatAgentPrice(spec.price) }})</span>
              </label>
              <div v-if="specs.length === 0" class="text-xs text-gray-400">
                暂无规格
              </div>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input v-model="agentForm.enabled" type="checkbox" class="border-gray-300 rounded">
            启用该代理（停用后代理无法登录）
          </label>
        </div>

        <div class="mt-5 flex justify-end space-x-3">
          <BaseButton variant="secondary" size="sm" :disabled="savingAgent" @click="closeAgentModal">
            取消
          </BaseButton>
          <BaseButton variant="primary" size="sm" :disabled="savingAgent" @click="requestSaveAgent">
            下一步
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 新建/编辑规格 -->
    <div
      v-if="showSpecModal"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 p-3 sm:items-center sm:p-4"
      @click.self="!savingSpec && (showSpecModal = false)"
    >
      <div class="my-auto max-h-[calc(100dvh-1.5rem)] max-w-md w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] dark:bg-gray-800 sm:p-5" @click.stop>
        <h2 class="mb-4 text-lg text-gray-900 font-bold dark:text-white">
          {{ editingSpec ? `编辑发卡规格：${editingSpec.name}` : '新建发卡规格' }}
        </h2>

        <div class="space-y-4">
          <BaseInput v-model="specForm.name" label="规格名称" placeholder="例如：7天体验卡" />
          <BaseSelect
            v-model="specForm.type"
            label="卡密类型"
            :options="specTypeOptions"
          />

          <template v-if="specForm.type === 'time'">
            <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input v-model="specForm.isPermanent" type="checkbox" class="border-gray-300 rounded">
              永久有效
            </label>
            <div v-if="!specForm.isPermanent" class="grid grid-cols-2 gap-3">
              <BaseInput v-model.number="specForm.durationValue" type="number" min="1" label="时长" />
              <BaseSelect v-model="specForm.durationUnit" label="单位" :options="durationUnitOptions" />
            </div>
            <BaseInput
              v-model.number="specForm.accountLimit"
              type="number"
              min="0"
              label="账号额度（0 表示使用默认）"
            />
          </template>

          <template v-else>
            <BaseInput
              v-model.number="specForm.value"
              type="number"
              min="1"
              label="增加的账号额度"
            />
          </template>

          <BaseInput
            v-model.number="specForm.price"
            type="number"
            min="0"
            step="0.01"
            label="单价（元/张，0 表示免费）"
            placeholder="代理每生成 1 张卡扣取的余额"
          />
        </div>

        <div class="mt-5 flex justify-end space-x-3">
          <BaseButton variant="secondary" size="sm" :disabled="savingSpec" @click="showSpecModal = false">
            取消
          </BaseButton>
          <BaseButton variant="primary" size="sm" :loading="savingSpec" @click="requestSaveSpec">
            {{ editingSpec ? '保存' : '创建' }}
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 生成充值卡 -->
    <div
      v-if="showRechargeModal"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 p-3 sm:items-center sm:p-4"
      @click.self="!savingRecharge && (showRechargeModal = false)"
    >
      <div class="my-auto max-h-[calc(100dvh-1.5rem)] max-w-md w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] dark:bg-gray-800 sm:p-5" @click.stop>
        <h2 class="mb-4 text-lg text-gray-900 font-bold dark:text-white">
          生成代理充值卡
        </h2>

        <div class="space-y-4">
          <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
            充值卡面额由你自定义，代理在「代理中心」输入卡密后余额即增加对应金额。
          </div>
          <div class="grid grid-cols-2 gap-3">
            <BaseInput v-model.number="rechargeForm.amount" type="number" min="0" step="0.01" label="单张面额（元）" />
            <BaseInput v-model.number="rechargeForm.count" type="number" min="1" max="200" label="数量（最多200）" />
          </div>
          <BaseInput v-model="rechargeForm.description" label="备注" placeholder="选填" />

          <div v-if="rechargeGenerated.length > 0" class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-3">
            <div class="mb-2 flex items-center justify-between">
              <div class="text-sm text-gray-900 font-semibold dark:text-gray-100">
                本次生成 {{ rechargeGenerated.length }} 张
              </div>
              <BaseButton variant="secondary" size="sm" @click="copyRechargeList">
                复制全部
              </BaseButton>
            </div>
            <div class="max-h-40 overflow-y-auto space-y-1">
              <div
                v-for="code in rechargeGenerated"
                :key="code"
                class="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900/40"
              >
                <span class="text-xs text-gray-800 font-mono dark:text-gray-200">{{ code }}</span>
                <button class="text-xs text-emerald-600 dark:text-emerald-400 hover:underline" @click="copyRechargeCode(code)">
                  复制
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="mt-5 flex justify-end space-x-3">
          <BaseButton variant="secondary" size="sm" :disabled="savingRecharge" @click="showRechargeModal = false">
            关闭
          </BaseButton>
          <BaseButton variant="primary" size="sm" :loading="savingRecharge" @click="saveRechargeCards">
            生成
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 代理卡密 -->
    <div
      v-if="showCardsModal"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 p-3 sm:items-center sm:p-4"
      @click.self="closeCardsModal"
    >
      <div class="my-auto max-h-[calc(100dvh-1.5rem)] max-w-3xl w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] dark:bg-gray-800 sm:p-5" @click.stop>
        <h2 class="mb-4 text-lg text-gray-900 font-bold dark:text-white">
          卡密记录：{{ cardsAgent?.username }}
        </h2>
        <div v-if="cardsLoading" class="py-6 text-center text-gray-500">
          加载中...
        </div>
        <div v-else class="overflow-x-auto border border-gray-200 rounded-lg dark:border-gray-700">
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
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="card in agentCards" :key="card.code">
                <td class="whitespace-nowrap px-3 py-2 text-xs text-gray-900 font-mono dark:text-white">
                  {{ card.code }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                  {{ card.type === 'quota' ? `+${card.value ?? 0}额度` : formatTimeDuration(card) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm">
                  <span class="inline-flex rounded-full px-2 text-xs font-semibold leading-5" :class="card.usedBy ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200' : (card.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200')">
                    {{ card.usedBy ? '已使用' : (card.enabled ? '未使用' : '已禁用') }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                  {{ card.usedBy || '-' }}
                </td>
              </tr>
              <tr v-if="agentCards.length === 0">
                <td colspan="4" class="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  该代理还没有发过卡
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mt-5 flex justify-end">
          <BaseButton variant="secondary" size="sm" @click="closeCardsModal">
            关闭
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 代理客户 -->
    <div
      v-if="showCustomersModal"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black bg-opacity-50 p-3 sm:items-center sm:p-4"
      @click.self="closeCustomersModal"
    >
      <div class="my-auto max-h-[calc(100dvh-1.5rem)] max-w-3xl w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] dark:bg-gray-800 sm:p-5" @click.stop>
        <h2 class="mb-4 text-lg text-gray-900 font-bold dark:text-white">
          客户列表：{{ customersAgent?.username }}
        </h2>
        <div v-if="customersLoading" class="py-6 text-center text-gray-500">
          加载中...
        </div>
        <div v-else class="overflow-x-auto border border-gray-200 rounded-lg dark:border-gray-700">
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
                  状态
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="customer in agentCustomers" :key="customer.username">
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 font-medium dark:text-white">
                  {{ customer.username }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                  {{ customer.accountLimit }} 个
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm text-gray-900 dark:text-white">
                  {{ customer.card ? formatTimeDuration(customer.card) : '无' }}
                </td>
                <td class="whitespace-nowrap px-3 py-2 text-sm">
                  <span v-if="customer.card" class="inline-flex rounded-full px-2 text-xs font-semibold leading-5" :class="customer.card.enabled === false ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' : (cardIsExpired(customer.card.expiresAt) ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200')">
                    {{ customer.card.enabled === false ? '封禁' : (cardIsExpired(customer.card.expiresAt) ? '已过期' : '正常') }}
                  </span>
                  <span v-else class="text-gray-500">-</span>
                </td>
              </tr>
              <tr v-if="agentCustomers.length === 0">
                <td colspan="4" class="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  该代理还没有客户
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mt-5 flex justify-end">
          <BaseButton variant="secondary" size="sm" @click="closeCustomersModal">
            关闭
          </BaseButton>
        </div>
      </div>
    </div>

    <ConfirmModal
      v-model:show="showSaveConfirm"
      :title="editingAgent ? '确认保存修改' : '确认创建代理'"
      :message="editingAgent ? `将更新代理 ${editingAgent.username} 的额度与可用规格。` : `将创建代理 ${agentForm.username}，其可以按指定规格发卡。`"
      :loading="savingAgent"
      @confirm="confirmSaveAgent"
      @cancel="showSaveConfirm = false"
      @close="showSaveConfirm = false"
    />

    <ConfirmModal
      v-model:show="showToggleConfirm"
      :type="pendingToggle?.enabled ? 'danger' : 'primary'"
      :title="pendingToggle?.enabled ? '确认停用代理' : '确认启用代理'"
      :message="pendingToggle?.enabled ? `停用后代理 ${pendingToggle?.username} 将立即被踢下线且无法登录。` : `启用后代理 ${pendingToggle?.username} 可以重新登录发卡。`"
      :loading="toggleLoading"
      @confirm="confirmToggleAgent"
      @cancel="showToggleConfirm = false"
      @close="showToggleConfirm = false"
    />

    <ConfirmModal
      v-model:show="showDeleteConfirm"
      type="danger"
      title="确认删除代理"
      :message="`将删除代理账号 ${pendingDelete?.username}。已发出的卡密与已归属的客户数据会保留。`"
      confirm-text="删除"
      :loading="deleteLoading"
      @confirm="confirmDeleteAgent"
      @cancel="showDeleteConfirm = false"
      @close="showDeleteConfirm = false"
    />

    <ConfirmModal
      v-model:show="showSpecDeleteConfirm"
      type="danger"
      title="确认删除规格"
      :message="`将删除发卡规格「${pendingDeleteSpec?.name}」。删除后代理无法再使用该规格发卡。`"
      confirm-text="删除"
      :loading="deletingSpec"
      @confirm="confirmDeleteSpec"
      @cancel="showSpecDeleteConfirm = false"
      @close="showSpecDeleteConfirm = false"
    />

    <ConfirmModal
      v-model:show="showRechargeDeleteConfirm"
      type="danger"
      title="确认删除充值卡"
      :message="`将删除充值卡「${pendingDeleteRecharge?.code}」（面额 ${formatMoney(pendingDeleteRecharge?.amount)}）。已使用的充值卡删除不影响代理已充值的余额。`"
      confirm-text="删除"
      :loading="deletingRecharge"
      @confirm="confirmDeleteRechargeCard"
      @cancel="showRechargeDeleteConfirm = false"
      @close="showRechargeDeleteConfirm = false"
    />
  </div>
</template>
