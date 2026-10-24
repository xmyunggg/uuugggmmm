<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ref-ui/BaseButton.vue'

/**
 * 全站公告：登录后拉取，shouldShow 为 true 时弹出；关闭即标记已读。
 */
const show = ref(false)
const content = ref('')
const updatedAt = ref(0)

function formatUpdatedAt(value: number): string {
  if (!value)
    return ''
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function load() {
  try {
    const res = await api.get('/api/announcement', { skipErrorToast: true } as any)
    const data = res.data?.data
    if (!res.data?.ok || !data?.shouldShow || !data.content)
      return
    content.value = String(data.content)
    updatedAt.value = Number(data.updatedAt) || 0
    show.value = true
  }
  catch {
    // 公告不可用时静默忽略，不打扰用户
  }
}

async function close() {
  show.value = false
  try {
    await api.post('/api/announcement/read')
  }
  catch {
    // 标记失败下次登录会再弹一次，可接受
  }
}

onMounted(load)
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
            <div class="mt-0.5 h-9 w-9 flex shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
              <div class="i-carbon-megaphone text-lg" />
            </div>
            <div class="min-w-0">
              <h3 class="text-base text-gray-900 font-semibold dark:text-white">
                公告
              </h3>
              <p v-if="updatedAt" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                更新于 {{ formatUpdatedAt(updatedAt) }}
              </p>
            </div>
          </div>

          <div class="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words border border-gray-100 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 leading-relaxed dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
            {{ content }}
          </div>

          <div class="mt-6 flex justify-end">
            <BaseButton variant="primary" @click="close">
              我知道了
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
