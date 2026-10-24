<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'

const props = defineProps<{
  content: string
  hasPassword: boolean
}>()

const show = defineModel<boolean>('show', { required: true })

const password = ref('')
const unlocked = ref(false)
const error = ref('')
const loading = ref(false)

watch(show, (value) => {
  if (!value)
    return
  error.value = ''
  password.value = ''
  unlocked.value = !props.hasPassword
})

async function verify() {
  if (!password.value) {
    error.value = '请输入密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.post('/api/super-admin-announcement/verify', { password: password.value })
    if (data?.ok && data.valid) {
      unlocked.value = true
    }
    else {
      error.value = '密码错误'
    }
  }
  catch (e: any) {
    error.value = getApiErrorMessage(e, '密码校验失败')
  }
  finally {
    loading.value = false
  }
}

const visibleContent = computed(() => unlocked.value ? props.content : '')
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
              <div class="i-carbon-notification text-lg" />
            </div>
            <div class="min-w-0">
              <h3 class="text-base text-gray-900 font-semibold dark:text-white">
                系统公告
              </h3>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                来自超级管理员
              </p>
            </div>
          </div>

          <template v-if="unlocked">
            <div class="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words border border-gray-100 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 leading-relaxed dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
              {{ visibleContent || '（暂无公告）' }}
            </div>
            <div class="mt-6 flex justify-end">
              <BaseButton variant="primary" @click="show = false">
                知道了
              </BaseButton>
            </div>
          </template>

          <template v-else>
            <p class="text-sm text-gray-600 dark:text-gray-400">
              该公告受密码保护，请输入访问密码查看。
            </p>
            <div class="mt-4">
              <BaseInput
                v-model="password"
                type="password"
                label="访问密码"
                placeholder="请输入公告密码"
                @keyup.enter="verify"
              />
            </div>
            <p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">
              {{ error }}
            </p>
            <div class="mt-6 flex justify-end gap-3">
              <BaseButton variant="secondary" @click="show = false">
                取消
              </BaseButton>
              <BaseButton variant="primary" :loading="loading" @click="verify">
                查看公告
              </BaseButton>
            </div>
          </template>
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
