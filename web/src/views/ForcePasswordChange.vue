<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PasswordStrengthMeter from '@/components/login/PasswordStrengthMeter.vue'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'
import { getPasswordStrength } from '@/composables/usePasswordStrength'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const userStore = useUserStore()

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const error = ref('')
const saving = ref(false)
const touched = ref(false)

const strength = computed(() => getPasswordStrength(newPassword.value))

async function handleSubmit() {
  touched.value = true
  error.value = ''

  if (!oldPassword.value) {
    error.value = '请输入当前密码'
    return
  }
  if (newPassword.value.length < 6) {
    error.value = '密码长度至少6位'
    return
  }
  if (!strength.value.valid) {
    error.value = '密码强度不足：需包含大写字母、小写字母、数字、特殊符号中的至少两种'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  if (newPassword.value === oldPassword.value) {
    error.value = '新密码不能与当前密码相同'
    return
  }

  saving.value = true
  try {
    const res = await userStore.changePassword(oldPassword.value, newPassword.value)
    if (!res.ok) {
      error.value = res.error || '修改失败'
      return
    }
    // 后端改密后会作废当前会话，这里清干净本地状态再回登录页
    await userStore.logout()
    router.replace({ name: 'login' })
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '修改失败'
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="ref-ui force-pwd-shell">
    <section class="force-pwd-page mx-auto max-w-xl py-8 space-y-6">
      <div class="glass-card rounded-3xl p-8">
        <div class="mb-6 flex items-center gap-3">
          <div class="i-carbon-password text-2xl text-amber-500" />
          <div>
            <h1 class="text-2xl font-bold">
              请修改默认密码
            </h1>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              当前管理员仍在使用默认密码，修改后才能进入面板。
            </p>
          </div>
        </div>

        <div class="mb-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          默认密码是公开已知的，未修改前面板接口与实时通道都会被拒绝。请设置一个独立的高强度密码。
        </div>

        <form class="space-y-4" @submit.prevent="handleSubmit">
          <BaseInput
            v-model="oldPassword"
            type="password"
            label="当前密码"
            placeholder="请输入当前登录密码"
          />
          <BaseInput
            v-model="newPassword"
            type="password"
            label="新密码"
            placeholder="请输入新密码"
            @input="touched = true"
          />
          <PasswordStrengthMeter
            v-if="touched && newPassword"
            :strength="strength"
          />
          <BaseInput
            v-model="confirmPassword"
            type="password"
            label="确认新密码"
            placeholder="请再次输入新密码"
          />

          <div v-if="error" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {{ error }}
          </div>

          <BaseButton type="submit" variant="primary" :loading="saving" block>
            确认修改并重新登录
          </BaseButton>
        </form>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* App.vue 的 .app-shell 是 h-screen + overflow-hidden：独立页面（登录页也是这么做的）
   必须自带滚动容器，否则窗口矮一点下半部分会被裁掉，鼠标滚轮也滚不动。 */
.force-pwd-shell {
  height: 100dvh;
  overflow-y: auto;
  overflow-x: hidden;
}

.force-pwd-page {
  min-height: 100dvh;
  background: var(--app-bg);
}

.glass-card {
  border-radius: 16px;
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  background: var(--theme-glass);
}
</style>
