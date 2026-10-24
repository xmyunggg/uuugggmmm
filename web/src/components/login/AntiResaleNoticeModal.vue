<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import BaseButton from '@/components/ref-ui/BaseButton.vue'

export interface AntiResaleNoticeConfig {
  title: string
  author: string
  qq: string
  content: string
  countdownSeconds: number
}

const props = defineProps<{
  config: AntiResaleNoticeConfig
  userCount: number
}>()

const show = defineModel<boolean>('show', { required: true })

const remaining = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  remaining.value = Math.max(0, Number(props.config.countdownSeconds) || 0)
  if (remaining.value <= 0)
    return
  timer = setInterval(() => {
    remaining.value -= 1
    if (remaining.value <= 0)
      stopTimer()
  }, 1000)
}

watch(show, (value) => {
  if (value)
    startTimer()
  else
    stopTimer()
}, { immediate: true })

onUnmounted(stopTimer)

const canClose = computed(() => remaining.value <= 0)
const closeText = computed(() => canClose.value ? '我已阅读' : `请阅读（${remaining.value}s）`)

function close() {
  if (!canClose.value)
    return
  show.value = false
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="show"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      >
        <div class="max-w-lg w-full border border-gray-200 rounded-xl bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          <div class="mb-4 flex items-start gap-3">
            <div class="mt-0.5 h-9 w-9 flex shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
              <div class="i-carbon-warning-alt text-lg" />
            </div>
            <div class="min-w-0">
              <h3 class="text-base text-gray-900 font-semibold dark:text-white">
                {{ config.title || '重要声明' }}
              </h3>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                当前用户数 {{ userCount }}
              </p>
            </div>
          </div>

          <div class="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words border border-gray-100 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 leading-relaxed dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
            {{ config.content || '（未设置声明内容）' }}
          </div>

          <div v-if="config.author || config.qq" class="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
            <span v-if="config.author">作者：{{ config.author }}</span>
            <span v-if="config.qq">联系 QQ：{{ config.qq }}</span>
          </div>

          <div class="mt-6 flex justify-end">
            <BaseButton
              variant="primary"
              :disabled="!canClose"
              @click="close"
            >
              {{ closeText }}
            </BaseButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
