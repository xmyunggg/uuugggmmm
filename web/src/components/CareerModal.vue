<script setup lang="ts">
import type { Account } from '@/stores/account'
import { NModal } from 'naive-ui/es/modal'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

export interface CareerHarvestItem {
  seedId: number
  fruitId?: number
  name: string
  image?: string
  harvestCount: number
}

export interface CareerProfile {
  gid?: number
  name?: string
  avatar?: string
  level?: number
  exp?: number
  /** 历史累计收获（旧字段名） */
  harvest?: number
  /** 历史累计摘取（旧字段名） */
  steal?: number
  totalHarvestCount?: number
  totalStealCount?: number
  items?: CareerHarvestItem[]
}

const props = defineProps<{
  show: boolean
  account?: Account | null
  profile?: CareerProfile | null
  loading?: boolean
  error?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'refresh'): void
}>()

const harvestedItems = computed(() => (props.profile?.items || [])
  .filter(item => Number(item.harvestCount) > 0)
  .sort((a, b) => Number(b.harvestCount) - Number(a.harvestCount)))

const totalHarvest = computed(() => Number(
  props.profile?.totalHarvestCount ?? props.profile?.harvest ?? 0,
))
const totalSteal = computed(() => Number(
  props.profile?.totalStealCount ?? props.profile?.steal ?? 0,
))
const topItems = computed(() => harvestedItems.value.slice(0, 3))
const name = computed(() => String(
  props.profile?.name || props.account?.nick || props.account?.name || '农场主',
))
const avatar = computed(() => String(props.profile?.avatar || props.account?.avatar || ''))
const level = computed(() => Number(props.profile?.level || 0))
const exp = computed(() => Number(props.profile?.exp || 0))
const gid = computed(() => Number(props.profile?.gid || 0))
const stolenRatio = computed(() => {
  if (totalHarvest.value <= 0)
    return totalSteal.value > 0 ? '--' : '0%'
  const percent = totalSteal.value / totalHarvest.value * 100
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`
})

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0))
}

function formatCompact(value: number) {
  const numeric = Number(value || 0)
  const units = [
    { threshold: 100000000, divisor: 100000000, suffix: '亿' },
    { threshold: 10000000, divisor: 10000000, suffix: '千万' },
    { threshold: 1000000, divisor: 1000000, suffix: '百万' },
    { threshold: 10000, divisor: 10000, suffix: '万' },
    { threshold: 1000, divisor: 1000, suffix: '千' },
  ]
  const unit = units.find(item => Math.abs(numeric) >= item.threshold)
  if (!unit)
    return formatNumber(numeric)
  const compact = numeric / unit.divisor
  const digits = compact >= 100 ? 0 : 1
  return `${compact.toFixed(digits).replace(/\.0+$|(?<=\.\d)0+$/g, '')}${unit.suffix}`
}

function close() {
  emit('close')
}
</script>

<template>
  <NModal
    :show="show"
    :auto-focus="false"
    :mask-closable="true"
    @update:show="(value: boolean) => { if (!value) close() }"
  >
    <section
      class="mx-auto max-w-2xl w-full overflow-hidden farm-card rounded-2xl bg-white shadow-xl dark:bg-gray-800"
      style="max-height: min(88vh, 760px)"
      role="dialog"
      aria-modal="true"
    >
      <header class="flex items-center gap-4 border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        <div class="h-14 w-14 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-blue-100 ring-2 ring-white dark:bg-blue-900/30 dark:ring-gray-700">
          <img v-if="avatar" :src="avatar" :alt="name" class="h-full w-full object-cover">
          <span v-else class="text-xl text-blue-600 font-bold dark:text-blue-300">{{ name.slice(0, 1) }}</span>
        </div>
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-lg text-gray-900 font-bold dark:text-gray-100">
            {{ name }}
          </h2>
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span class="rounded-lg bg-blue-100 px-2 py-0.5 text-blue-700 font-semibold dark:bg-blue-900/30 dark:text-blue-300">
              Lv.{{ level }}
            </span>
            <span class="rounded-lg bg-emerald-50 px-2 py-0.5 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
              经验 {{ formatNumber(exp) }}
            </span>
            <span v-if="gid" class="text-gray-400">
              角色编号：{{ gid }}
            </span>
          </div>
        </div>
        <BaseButton variant="text" size="sm" @click="close">
          <span class="i-carbon-close text-xl" />
        </BaseButton>
      </header>

      <div class="max-h-[calc(min(88vh,760px)-92px)] overflow-y-auto p-5">
        <div v-if="loading" class="h-56 flex flex-col items-center justify-center gap-3 text-gray-400">
          <span class="i-carbon-circle-dash animate-spin text-3xl" />
          <span>正在读取角色生涯...</span>
        </div>

        <div v-else-if="error" class="h-48 flex flex-col items-center justify-center gap-3 text-center">
          <span class="i-carbon-warning-alt text-3xl text-amber-500" />
          <p class="text-sm text-gray-500 dark:text-gray-400">
            {{ error }}
          </p>
          <BaseButton variant="primary" size="sm" @click="emit('refresh')">
            重新加载
          </BaseButton>
        </div>

        <template v-else>
          <div class="grid grid-cols-2 gap-3">
            <div class="rounded-2xl bg-gray-50 p-4 text-center dark:bg-gray-700/30" :title="`精确数量：${formatNumber(totalHarvest)}`">
              <div class="flex items-center justify-center gap-1.5 text-sm text-green-600 dark:text-green-300">
                <span class="i-carbon-wheat" />
                <span>历史累计收获</span>
              </div>
              <div class="mt-1 text-2xl text-green-600 font-bold dark:text-green-300">
                {{ formatCompact(totalHarvest) }}
              </div>
            </div>
            <div class="rounded-2xl bg-gray-50 p-4 text-center dark:bg-gray-700/30" :title="`精确数量：${formatNumber(totalSteal)}`">
              <div class="flex items-center justify-center gap-1.5 text-sm text-orange-500 dark:text-orange-300">
                <span class="i-carbon-run" />
                <span>摘取好友作物</span>
              </div>
              <div class="mt-1 text-2xl text-orange-500 font-bold dark:text-orange-300">
                {{ formatCompact(totalSteal) }}
              </div>
              <div class="mt-0.5 text-[10px] text-gray-400">
                收偷比 {{ stolenRatio }}
              </div>
            </div>
          </div>

          <template v-if="topItems.length">
            <div class="mb-3 mt-6 flex items-baseline gap-2">
              <h3 class="text-base text-gray-900 font-bold dark:text-gray-100">
                收获排行
              </h3>
              <span class="text-xs text-gray-400">Top 3</span>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div v-for="(item, index) in topItems" :key="item.seedId" class="text-center">
                <div
                  class="mx-auto mb-1.5 h-6 w-6 flex items-center justify-center rounded-full text-xs text-white font-bold"
                  :class="index === 0 ? 'bg-amber-400' : index === 1 ? 'bg-slate-400' : 'bg-orange-400'"
                >
                  {{ index + 1 }}
                </div>
                <div class="mx-auto h-14 w-14 flex items-center justify-center">
                  <img v-if="item.image" :src="item.image" :alt="item.name" class="max-h-full max-w-full object-contain">
                  <span v-else class="i-carbon-sprout text-3xl text-green-400" />
                </div>
                <div class="mt-1 truncate text-xs text-gray-600 dark:text-gray-300">
                  {{ item.name }}
                </div>
                <div class="text-base text-blue-700 font-bold dark:text-blue-300">
                  {{ formatNumber(item.harvestCount) }}
                </div>
              </div>
            </div>
          </template>

          <div class="mb-3 mt-6 flex items-baseline gap-2">
            <h3 class="text-base text-gray-900 font-bold dark:text-gray-100">
              收获明细
            </h3>
            <span class="text-xs text-gray-400">({{ harvestedItems.length }})</span>
          </div>
          <div v-if="harvestedItems.length" class="grid grid-cols-3 gap-3 sm:grid-cols-4">
            <div
              v-for="item in harvestedItems"
              :key="item.seedId"
              class="rounded-xl bg-gray-50 p-3 text-center dark:bg-gray-700/30"
            >
              <div class="mx-auto h-12 w-12 flex items-center justify-center">
                <img v-if="item.image" :src="item.image" :alt="item.name" class="max-h-full max-w-full object-contain">
                <span v-else class="i-carbon-sprout text-3xl text-green-400" />
              </div>
              <div class="mt-1.5 truncate text-xs text-gray-600 dark:text-gray-300" :title="item.name">
                {{ item.name }}
              </div>
              <div class="mt-0.5 text-sm text-gray-900 font-bold dark:text-gray-100">
                {{ formatNumber(item.harvestCount) }}
              </div>
            </div>
          </div>
          <div v-else class="rounded-2xl bg-gray-50 py-10 text-center text-sm text-gray-400 dark:bg-gray-700/30">
            暂无收获记录
          </div>
        </template>
      </div>
    </section>
  </NModal>
</template>
