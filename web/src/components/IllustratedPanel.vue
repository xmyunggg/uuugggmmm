<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { useDialog } from 'naive-ui/es/dialog'
import { NModal } from 'naive-ui/es/modal'
import { NProgress } from 'naive-ui/es/progress'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useAccountStore } from '@/stores/account'
import { useIllustratedStore } from '@/stores/illustrated'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const illustratedStore = useIllustratedStore()
const toast = useToastStore()
const dialog = useDialog()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { data, loading, buying, error } = storeToRefs(illustratedStore)
const currentType = ref<'crop' | 'mutant'>('crop')
const detailsOpen = ref(false)
const claiming = ref(false)
const rewardList = ref<HTMLElement | null>(null)
let claimRevision = 0

const book = computed(() => data.value?.[currentType.value] || null)
const isConnected = computed(() => !!currentAccount.value?.running)
const collectedCount = computed(() => (Array.isArray(book.value?.items) ? book.value.items : []).filter((item: any) => item.unlocked).length)
const currentBonuses = computed(() => {
  const bonuses = Array.isArray(book.value?.attributeBonuses) ? book.value.attributeBonuses : []
  return bonuses.length ? bonuses : (book.value?.currentBonus ? [book.value.currentBonus] : [])
})
const illustratedBuffs = computed(() => Array.isArray(book.value?.buffs) ? book.value.buffs : [])
const currentIllustratedBuffs = computed(() => Array.isArray(book.value?.currentBuffs) ? book.value.currentBuffs : [])
const illustratedLevelMap = computed(() => new Map(
  (Array.isArray(book.value?.levels) ? book.value.levels : []).map((level: any) => [Number(level?.level) || 0, level]),
))
function formatBuffValue(bonus: any) {
  const value = Number(bonus?.value) || 0
  return bonus?.valueType === 'probability' ? `触发概率 ${value / 10}%` : `数量 +${value}`
}
function formatBuffLevelState(bonus: any) {
  if (Number(bonus?.level) <= Number(book.value?.level || 0))
    return '已达成'
  const level = illustratedLevelMap.value.get(Number(bonus?.level) || 0) as any
  return level?.progress ? `${level.progress} 进度` : '未达成'
}
const mutantGroups = computed(() => {
  const items = Array.isArray(book.value?.items) ? [...book.value.items].sort((a: any, b: any) => Number(a.sort || 0) - Number(b.sort || 0)) : []
  return [
    { key: 'gold', label: '黄金果实', items: items.filter((item: any) => item.group === 'gold') },
    { key: 'decoration', label: '装扮果实', items: items.filter((item: any) => item.group === 'decoration') },
    { key: 'activity', label: '活动果实', items: items.filter((item: any) => item.group === 'activity') },
  ]
})

function progressPercent(value: any, next: any) {
  const current = Math.max(0, Number(value) || 0)
  const target = Math.max(current, Number(next) || 0)
  return target > 0 ? Math.min(100, Math.round(current / target * 100)) : 0
}

// 当前分册里「未解锁 + 种子商店在售 + 等级达标」的条目，由服务端标注 canBuy
const buyableItems = computed<any[]>(() => (Array.isArray(book.value?.items) ? book.value.items : []).filter((item: any) => item.canBuy))
const buyableCost = computed(() => buyableItems.value.reduce((sum: number, item: any) => sum + (Number(item.price) || 0), 0))

async function handleBuyOne(item: any) {
  const accountId = currentAccountId.value
  if (!accountId || !item?.goodsId)
    return
  try {
    const response = await illustratedStore.buySeed(accountId, Number(item.goodsId), Number(item.price) || 0)
    if (!response?.ok) {
      toast.error(getApiErrorMessage(response, `购买 ${item.name} 失败`))
      return
    }
    toast.success(`已购买 ${item.name}`)
    await refresh()
  }
  catch (cause: any) {
    toast.error(getApiErrorMessage(cause, `购买 ${item.name} 失败`))
  }
}

async function handleBuyAll() {
  const accountId = currentAccountId.value
  if (!accountId || !buyableItems.value.length)
    return
  const type = currentType.value === 'mutant' ? 2 : 1
  dialog.warning({
    title: '一键购买种子',
    content: `将为 ${buyableItems.value.length} 个未解锁图鉴条目购买种子，预计消耗 ${buyableCost.value} 金币。是否继续？`,
    positiveText: '确认购买',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await illustratedStore.buyAllSeeds(accountId, type as 1 | 2)
        if (!response?.ok) {
          toast.error(getApiErrorMessage(response, '一键购买失败'))
          return
        }
        const result = response.data || {}
        const failed = Number(result.failCount) || 0
        if (failed > 0)
          toast.warning(`已购买 ${result.successCount || 0} 个，${failed} 个失败`)
        else
          toast.success(`已购买 ${result.successCount || 0} 个种子`)
        await refresh()
      }
      catch (cause: any) {
        toast.error(getApiErrorMessage(cause, '一键购买失败'))
      }
    },
  })
}

async function refresh() {
  if (currentAccountId.value && isConnected.value)
    await illustratedStore.fetch(currentAccountId.value)
}

async function claimRewards() {
  if (claiming.value || loading.value || !book.value?.claimable || !isConnected.value)
    return
  const accountId = currentAccountId.value
  const revision = ++claimRevision
  claiming.value = true
  try {
    const response = await api.post('/api/illustrated/claim', { type: currentType.value === 'crop' ? 1 : 2 }, { headers: { 'x-account-id': accountId }, skipErrorToast: true } as any)
    if (revision !== claimRevision)
      return
    if (!response.data?.ok)
      throw new Error(getApiErrorMessage(response.data, '图鉴奖励领取失败'))
    const result = response.data.data
    const message = result.rewards?.map((item: any) => `${item.name} ×${item.count}`).join('、') || '领取成功'
    illustratedStore.reset()
    if (result.snapshot)
      data.value = result.snapshot
    if (result.refreshRequired)
      toast.warning(`${message}。请刷新确认最新进度`)
    else toast.success(message)
  }
  catch (cause) {
    if (revision === claimRevision) {
      toast.error(getApiErrorMessage(cause, '图鉴奖励领取失败'))
      await refresh()
    }
  }
  finally {
    if (revision === claimRevision)
      claiming.value = false
  }
}
async function scrollToNextReward() {
  await nextTick()
  const target = rewardList.value?.querySelector<HTMLElement>('[data-next="true"]')
  if (target && rewardList.value)
    rewardList.value.scrollTop = target.offsetTop - rewardList.value.offsetTop
}

watch([currentAccountId, isConnected], () => {
  claimRevision++
  claiming.value = false
  detailsOpen.value = false
}, { flush: 'sync' })

onMounted(refresh)
watch(currentAccountId, () => {
  illustratedStore.reset()
  void refresh()
})
watch(isConnected, refresh)
</script>

<template>
  <div class="space-y-5">
    <div class="cartoon-card rounded-2xl bg-white p-5 shadow-lg dark:bg-gray-800">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="flex items-center gap-2 text-xl font-bold font-display">
            <span class="i-carbon-book text-amber-600" /> 图鉴
          </h3>
          <p class="mt-1 text-sm text-gray-500">
            查看作物收藏、超变果实与图鉴属性加成
          </p>
        </div>
        <NButton secondary :loading="loading" :disabled="!currentAccountId || !isConnected" @click="refresh">
          <span class="i-carbon-renew mr-1" /> 刷新
        </NButton>
      </div>

      <NTabs v-model:value="currentType" type="segment" animated>
        <NTab name="crop">
          作物图鉴
        </NTab>
        <NTab name="mutant">
          超变图鉴
        </NTab>
      </NTabs>
    </div>

    <div v-if="!currentAccountId" class="cartoon-card rounded-2xl p-12 text-center text-gray-500 shadow-md">
      <span class="i-carbon-user-avatar mb-3 block text-5xl" /> 请先选择农场账号
    </div>
    <div v-else-if="!isConnected" class="cartoon-card rounded-2xl p-12 text-center text-gray-500 shadow-md">
      <span class="i-carbon-network-4 mb-3 block text-5xl" /> 请先启动账号
    </div>
    <div v-else-if="loading && !data" class="flex justify-center cartoon-card rounded-2xl p-12 shadow-md">
      <span class="i-svg-spinners-90-ring-with-bg text-4xl text-amber-500" />
    </div>
    <div v-else-if="error" class="cartoon-card rounded-2xl p-8 text-center text-red-600 shadow-md">
      <div>{{ error }}</div>
      <NButton class="mt-3" secondary type="error" @click="refresh">
        重试
      </NButton>
    </div>
    <template v-else-if="book">
      <section class="illustrated-progress rounded-2xl p-4">
        <div class="illustrated-progress__badge">
          <b>{{ book.level || 0 }}</b><small>等级</small>
        </div>
        <div class="illustrated-progress__main">
          <div class="flex items-center justify-between gap-2">
            <strong>{{ currentType === 'mutant' ? '超变图鉴进度' : '作物图鉴进度' }}</strong>
            <div class="flex items-center gap-2">
              <NButton v-if="buyableItems.length" size="tiny" type="primary" :loading="buying" @click="handleBuyAll">
                一键购买 {{ buyableItems.length }} 个
              </NButton><span class="text-sm font-bold">{{ book.progress || 0 }} / {{ book.nextLevelProgress || '—' }}</span><NButton size="tiny" secondary @click="detailsOpen = true">
                详情
              </NButton>
            </div>
          </div>
          <NProgress class="mt-2" type="line" status="success" :percentage="progressPercent(book.progress, book.nextLevelProgress)" :show-indicator="false" />
        </div>
      </section>

      <div v-if="currentType === 'mutant'" class="space-y-4">
        <div v-for="group in mutantGroups" :key="group.key" class="cartoon-card rounded-2xl bg-white p-5 shadow-lg dark:bg-gray-800">
          <h4 class="mb-3 text-lg font-bold">
            {{ group.label }} <span class="text-sm text-gray-400">({{ group.items.length }})</span>
          </h4>
          <div v-if="group.items.length" class="grid grid-cols-4 gap-2 lg:grid-cols-6 md:grid-cols-5">
            <div v-for="item in group.items" :key="item.seedId" class="border rounded-xl p-3" :class="item.unlocked ? 'border-amber-300 bg-amber-50/50 dark:bg-amber-950/20' : 'border-gray-200 opacity-55 dark:border-gray-700'">
              <img v-if="item.image" :src="item.image" alt="" class="mx-auto h-10 w-10 object-contain sm:h-12 sm:w-12">
              <div class="mt-1 truncate text-center text-xs font-medium">
                {{ item.name }}
              </div>
              <div class="text-center text-xs text-gray-500">
                {{ item.unlocked ? '已解锁' : '未解锁' }}
              </div>
            </div>
          </div>
          <div v-else class="text-sm text-gray-400">
            暂无记录
          </div>
        </div>
      </div>
      <div v-else class="cartoon-card rounded-2xl bg-white p-5 shadow-lg dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h4 class="text-lg font-bold">
            作物图鉴
          </h4><span class="text-sm text-gray-500">已收藏 {{ collectedCount }} / {{ book.items?.length || 0 }}</span>
        </div>
        <div class="grid grid-cols-4 gap-2 lg:grid-cols-6 md:grid-cols-5">
          <div v-for="item in book.items" :key="item.seedId" class="border rounded-xl p-3" :class="item.unlocked ? 'border-green-300 bg-green-50/50 dark:bg-green-950/20' : (item.canBuy ? 'border-blue-300 bg-blue-50/40 dark:bg-blue-950/20' : 'border-gray-200 opacity-55 dark:border-gray-700')">
            <img v-if="item.image" :src="item.image" alt="" class="mx-auto h-10 w-10 object-contain sm:h-12 sm:w-12">
            <div class="mt-1 truncate text-center text-xs font-medium">
              {{ item.name }}
            </div>
            <div class="text-center text-xs text-gray-500">
              {{ item.unlocked ? '已收藏' : (item.canBuy ? `可购买 · ${item.price} 金币` : '未收藏') }}
            </div>
            <NButton v-if="item.canBuy" class="mt-1 w-full" size="tiny" type="primary" :loading="buying" @click="handleBuyOne(item)">
              购买种子
            </NButton>
          </div>
        </div>
      </div>

      <NModal v-model:show="detailsOpen" @after-enter="scrollToNextReward">
        <NCard :title="currentType === 'mutant' ? '超变图鉴属性加成' : '作物图鉴收藏奖励'" closable class="illustrated-rewards-modal max-w-3xl w-[calc(100vw-24px)]" @close="detailsOpen = false">
          <template v-if="currentType === 'mutant'">
            <div class="mb-4 rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
              <div class="mb-2 text-sm font-semibold">
                当前加成
              </div>
              <div v-if="currentIllustratedBuffs.length" class="flex flex-wrap gap-2">
                <span v-for="bonus in currentIllustratedBuffs" :key="`current-buff-${bonus.id}`" class="rounded-lg bg-white px-2 py-1 text-sm dark:bg-gray-900">{{ bonus.name }}：{{ formatBuffValue(bonus) }}</span>
              </div>
              <div v-else class="text-sm text-gray-500">
                暂无当前加成
              </div>
            </div>
            <div v-if="illustratedBuffs.length" class="grid max-h-[60vh] gap-2 overflow-y-auto lg:grid-cols-3 sm:grid-cols-2">
              <div v-for="bonus in illustratedBuffs" :key="`all-buff-${bonus.id}`" class="border rounded-xl p-3" :class="bonus.level <= (book.level || 0) ? 'border-green-300 bg-green-50/50 dark:bg-green-950/20' : 'border-gray-200 dark:border-gray-700'">
                <div class="flex items-center justify-between text-sm">
                  <span class="font-semibold">Lv.{{ bonus.level }}</span>
                  <span :class="bonus.level <= (book.level || 0) ? 'text-green-600' : 'text-gray-400'">{{ formatBuffLevelState(bonus) }}</span>
                </div>
                <div class="mt-2 flex flex-wrap gap-1">
                  <span class="rounded bg-white/80 px-1.5 py-0.5 text-xs dark:bg-gray-900/50">{{ bonus.name }} · {{ formatBuffValue(bonus) }}</span>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-gray-500">
              暂无属性加成
            </div>
          </template>
          <div v-else class="mb-4 rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
            <div class="mb-2 flex justify-between gap-3 font-semibold">
              <span>{{ book.level }}级</span><span>{{ book.progress }} / {{ book.nextLevelProgress || '—' }}</span>
            </div>
            <NProgress type="line" status="success" :percentage="progressPercent(book.progress, book.nextLevelProgress)" :show-indicator="false" />
            <div class="mb-2 mt-3 text-sm font-semibold">
              当前加成
            </div>
            <div v-if="currentBonuses.length" class="flex flex-wrap gap-2">
              <span v-for="bonus in currentBonuses" :key="bonus.itemId" class="rounded-lg bg-white px-2 py-1 text-sm dark:bg-gray-900">{{ bonus.name }} +{{ bonus.count }}</span>
            </div>
            <div v-else class="text-sm text-gray-500">
              暂无当前加成
            </div>
          </div>
          <div v-if="currentType !== 'mutant'" ref="rewardList" class="illustrated-rewards-list" role="region" aria-label="收藏奖励" tabindex="0">
            <div v-for="level in book.levels" :key="level.level" :data-next="level.level === (book.levels.find((v: any) => !v.claimed)?.level)" class="illustrated-reward-row" :class="{ claimed: level.claimed, claimable: level.canClaim }">
              <div><strong>{{ level.level }}级</strong><small>{{ level.progress }} 进度</small></div>
              <div class="illustrated-reward-items">
                <span v-for="reward in level.rewards" :key="reward.itemId" :title="reward.name"><img v-if="reward.image" :src="reward.image" :alt="reward.name">{{ reward.count }}</span>
              </div>
              <span class="reward-state">{{ level.claimed ? '已领取' : level.canClaim ? '可领取' : '未达成' }}</span>
            </div>
          </div>
          <template #footer>
            <NButton v-if="currentType === 'crop' || book.claimable" block type="primary" :loading="claiming" :disabled="!book.claimable || loading || claiming" @click="claimRewards">
              领取奖励
            </NButton>
          </template>
        </NCard>
      </NModal>
    </template>
  </div>
</template>

<style scoped>
.illustrated-rewards-modal {
  max-height: calc(100dvh - 32px);
}
.illustrated-rewards-modal :deep(.n-card-content) {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.illustrated-rewards-modal :deep(.n-card-header),
.illustrated-rewards-modal :deep(.n-card__footer) {
  flex-shrink: 0;
}
.illustrated-rewards-list {
  min-height: 0;
  overflow-y: auto;
  max-height: 55vh;
  display: grid;
  gap: 10px;
}
.illustrated-reward-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px;
  border: 1px solid #d7dbc8;
  border-radius: 12px;
}
.illustrated-reward-row small {
  display: block;
  color: #888;
  margin-top: 4px;
}
.illustrated-reward-row.claimable {
  border-color: #71ad51;
  background: #d6eccc22;
}
.illustrated-reward-row.claimed {
  opacity: 0.6;
}
.illustrated-reward-items {
  display: flex;
  gap: 12px;
  margin-left: auto;
  flex-wrap: wrap;
}
.illustrated-reward-items span {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-weight: 600;
}
.illustrated-reward-items img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}
.reward-state {
  font-size: 12px;
  white-space: nowrap;
}
.illustrated-progress {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  color: #172033;
  border: 1px solid rgba(37, 99, 235, 0.18);
  background: rgba(255, 255, 255, 0.7);
  box-shadow:
    0 12px 30px rgba(30, 41, 59, 0.08),
    inset 0 1px rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(16px);
}
.illustrated-progress__badge {
  width: 58px;
  height: 58px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(37, 99, 235, 0.16);
  border-radius: 14px;
  color: #1d4ed8;
  background: rgba(226, 238, 250, 0.9);
}
.illustrated-progress__badge b {
  font-size: 25px;
  line-height: 1;
}
.illustrated-progress__badge small {
  font-size: 10px;
}
.illustrated-progress__main {
  min-width: 0;
}
.illustrated-progress__main strong {
  color: #172033;
}
:global(.dark) .illustrated-progress {
  color: #d8e7e1;
  border-color: rgba(116, 174, 151, 0.2);
  background: rgba(31, 41, 55, 0.78);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.04);
}
:global(.dark) .illustrated-progress__badge {
  color: #9bd9bd;
  border-color: rgba(116, 174, 151, 0.22);
  background: rgba(45, 91, 73, 0.48);
}
:global(.dark) .illustrated-progress__main strong {
  color: #e5eee9;
}
@media (max-width: 520px) {
  .illustrated-progress {
    grid-template-columns: 54px minmax(0, 1fr);
    gap: 8px;
    padding: 12px;
  }
}
</style>
