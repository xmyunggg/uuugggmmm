<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'
import BaseSwitch from '@/components/ref-ui/BaseSwitch.vue'
import BaseTextarea from '@/components/ref-ui/BaseTextarea.vue'
import ConfirmModal from '@/components/ref-ui/ConfirmModal.vue'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

interface AntiResaleConfig {
  enabled: boolean
  title: string
  author: string
  qq: string
  content: string
  userThreshold: number
  intervalSeconds: number
  countdownSeconds: number
  accountLimitEnabled: boolean
  accountLimitThreshold: number
}

const toast = useToastStore()
const userStore = useUserStore()
const isSuperAdmin = computed(() => userStore.isSuperAdmin)

function createDefaultAntiResaleConfig(): AntiResaleConfig {
  return {
    enabled: true,
    title: '重要声明',
    author: '',
    qq: '',
    content: '',
    userThreshold: 999999999,
    intervalSeconds: 2,
    countdownSeconds: 10,
    accountLimitEnabled: false,
    accountLimitThreshold: 999999999,
  }
}

function normalizeAntiResaleConfig(source: Partial<AntiResaleConfig> | null | undefined): AntiResaleConfig {
  const defaults = createDefaultAntiResaleConfig()
  const toNumber = (value: unknown, fallback: number) => {
    const num = Number(value)
    return Number.isFinite(num) && num >= 0 ? num : fallback
  }
  return {
    enabled: typeof source?.enabled === 'boolean' ? source.enabled : defaults.enabled,
    title: String(source?.title ?? defaults.title),
    author: String(source?.author ?? defaults.author),
    qq: String(source?.qq ?? defaults.qq),
    content: String(source?.content ?? defaults.content),
    userThreshold: toNumber(source?.userThreshold, defaults.userThreshold),
    intervalSeconds: toNumber(source?.intervalSeconds, defaults.intervalSeconds),
    countdownSeconds: toNumber(source?.countdownSeconds, defaults.countdownSeconds),
    accountLimitEnabled: typeof source?.accountLimitEnabled === 'boolean' ? source.accountLimitEnabled : defaults.accountLimitEnabled,
    accountLimitThreshold: toNumber(source?.accountLimitThreshold, defaults.accountLimitThreshold),
  }
}

// ==================== 系统公告（管理员） ====================
const announcementContent = ref('')
const announcementShowOnce = ref(true)
const announcementUpdatedAt = ref(0)
const announcementLoading = ref(false)
const announcementSaving = ref(false)
const showAnnouncementConfirm = ref(false)

async function loadAnnouncement() {
  announcementLoading.value = true
  try {
    const { data } = await api.get('/api/announcement')
    if (data?.ok && data.data) {
      announcementContent.value = String(data.data.content || '')
      announcementShowOnce.value = data.data.showOnce !== false
      announcementUpdatedAt.value = Number(data.data.updatedAt) || 0
    }
  }
  catch (error) {
    toast.error(`加载系统公告失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    announcementLoading.value = false
  }
}

async function saveAnnouncement() {
  announcementSaving.value = true
  try {
    const { data } = await api.post('/api/admin/announcement', {
      content: announcementContent.value,
      showOnce: announcementShowOnce.value,
      confirmed: true,
    })
    if (data?.ok) {
      announcementContent.value = String(data.data?.content ?? announcementContent.value)
      announcementShowOnce.value = data.data?.showOnce !== false
      announcementUpdatedAt.value = Number(data.data?.updatedAt) || Date.now()
      toast.success(announcementContent.value ? '系统公告已保存' : '系统公告已清空')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    announcementSaving.value = false
    showAnnouncementConfirm.value = false
  }
}

// ==================== 超级管理员公告 ====================
const superAdminContent = ref('')
const superAdminPassword = ref('')
const superAdminHasPassword = ref(false)
const superAdminUpdatedAt = ref(0)
const superAdminLoading = ref(false)
const superAdminSaving = ref(false)
const showSuperAdminConfirm = ref(false)

async function loadSuperAdminAnnouncement() {
  if (!isSuperAdmin.value)
    return
  superAdminLoading.value = true
  try {
    const { data } = await api.get('/api/super-admin-announcement')
    if (data?.ok && data.data) {
      superAdminContent.value = String(data.data.content || '')
      superAdminHasPassword.value = !!data.data.hasPassword
      superAdminUpdatedAt.value = Number(data.data.updatedAt) || 0
    }
  }
  catch (error) {
    toast.error(`加载超级管理员公告失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    superAdminLoading.value = false
  }
}

async function saveSuperAdminAnnouncement() {
  superAdminSaving.value = true
  try {
    const { data } = await api.post('/api/super-admin/announcement', {
      content: superAdminContent.value,
      password: superAdminPassword.value,
      confirmed: true,
    })
    if (data?.ok) {
      superAdminContent.value = String(data.data?.content ?? superAdminContent.value)
      superAdminHasPassword.value = !!data.data?.hasPassword
      superAdminUpdatedAt.value = Number(data.data?.updatedAt) || Date.now()
      superAdminPassword.value = ''
      toast.success('超级管理员公告已保存')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    superAdminSaving.value = false
    showSuperAdminConfirm.value = false
  }
}

// ==================== 防倒卖声明 ====================
const antiResaleConfig = ref<AntiResaleConfig>(createDefaultAntiResaleConfig())
const antiResaleUserCount = ref(0)
const antiResaleLoading = ref(false)
const antiResaleSaving = ref(false)
const showAntiResaleConfirm = ref(false)
const accountLimitChecking = ref(false)

async function loadAntiResaleConfig() {
  antiResaleLoading.value = true
  try {
    const { data } = await api.get('/api/anti-resale-config', { skipErrorToast: true } as any)
    if (data?.ok) {
      antiResaleConfig.value = normalizeAntiResaleConfig(data.config)
      antiResaleUserCount.value = Number(data.userCount) || 0
    }
  }
  catch (error) {
    toast.error(`加载防倒卖配置失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    antiResaleLoading.value = false
  }
}

async function saveAntiResaleConfig() {
  antiResaleSaving.value = true
  try {
    const { data } = await api.post('/api/super-admin/anti-resale-config', {
      ...antiResaleConfig.value,
      confirmed: true,
    })
    if (data?.ok) {
      antiResaleConfig.value = normalizeAntiResaleConfig(data.config)
      toast.success('防倒卖声明配置已保存')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    antiResaleSaving.value = false
    showAntiResaleConfirm.value = false
  }
}

async function checkAccountLimit() {
  accountLimitChecking.value = true
  try {
    const { data } = await api.post('/api/super-admin/check-account-limit')
    if (data?.ok) {
      if (data.enabled && data.triggered)
        toast.warning(data.message || '运行账号数量超过阈值')
      else
        toast.success(data.message || '检查完成')
    }
    else {
      toast.error(getApiErrorMessage(data, '检查失败'))
    }
  }
  catch (error) {
    toast.error(`检查失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    accountLimitChecking.value = false
  }
}

function formatUpdatedAt(value: number): string {
  if (!value)
    return '未设置'
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

onMounted(() => {
  loadAnnouncement()
  loadSuperAdminAnnouncement()
  loadAntiResaleConfig()
})
</script>

<template>
  <div class="space-y-4">
    <!-- 系统公告 -->
    <section class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
      <div class="mb-4 flex items-start gap-3">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
          <span class="i-carbon-megaphone text-xl" />
        </div>
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            系统公告
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            登录用户进入面板后弹出；上次更新时间：{{ formatUpdatedAt(announcementUpdatedAt) }}
          </p>
        </div>
      </div>

      <div v-if="announcementLoading" class="py-6 text-center text-gray-500">
        <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
      </div>

      <template v-else>
        <BaseTextarea
          v-model="announcementContent"
          label="公告内容"
          :rows="5"
          placeholder="留空表示不展示公告"
        />
        <div class="mt-3 border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3">
          <BaseSwitch v-model="announcementShowOnce" label="每用户只弹一次（关闭后每次登录都会弹出）" />
        </div>
        <div class="mt-3 flex justify-end border-t border-[var(--theme-border)] pt-3">
          <BaseButton
            variant="primary"
            size="sm"
            :loading="announcementSaving"
            @click="showAnnouncementConfirm = true"
          >
            保存系统公告
          </BaseButton>
        </div>
      </template>
    </section>

    <!-- 超级管理员公告 -->
    <section
      v-if="isSuperAdmin"
      class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md"
    >
      <div class="mb-4 flex items-start gap-3">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-600 dark:bg-purple-900/25 dark:text-purple-400">
          <span class="i-carbon-notification text-xl" />
        </div>
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            超级管理员公告
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            展示在登录页；设置密码后需输入密码才能查看。上次更新时间：{{ formatUpdatedAt(superAdminUpdatedAt) }}
          </p>
        </div>
      </div>

      <div v-if="superAdminLoading" class="py-6 text-center text-gray-500">
        <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
      </div>

      <template v-else>
        <BaseTextarea
          v-model="superAdminContent"
          label="公告内容"
          :rows="4"
          placeholder="留空表示不展示公告"
        />
        <div class="mt-3">
          <BaseInput
            v-model="superAdminPassword"
            type="password"
            label="访问密码"
            :placeholder="superAdminHasPassword ? '留空表示保持原密码不变' : '留空表示无需密码即可查看'"
          />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            当前状态：{{ superAdminHasPassword ? '已设置密码' : '未设置密码（所有人可见）' }}
          </p>
        </div>
        <div class="mt-3 flex justify-end border-t border-[var(--theme-border)] pt-3">
          <BaseButton
            variant="primary"
            size="sm"
            :loading="superAdminSaving"
            @click="showSuperAdminConfirm = true"
          >
            保存超级管理员公告
          </BaseButton>
        </div>
      </template>
    </section>

    <!-- 防倒卖声明 -->
    <section
      v-if="isSuperAdmin"
      class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md"
    >
      <div class="mb-4 flex items-start gap-3">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
          <span class="i-carbon-warning-alt text-xl" />
        </div>
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            防倒卖声明
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            注册用户数达到阈值时在登录页展示；当前注册用户数：{{ antiResaleUserCount }}
          </p>
        </div>
      </div>

      <div v-if="antiResaleLoading" class="py-6 text-center text-gray-500">
        <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
      </div>

      <template v-else>
        <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3">
          <BaseSwitch v-model="antiResaleConfig.enabled" label="启用防倒卖声明" />
        </div>

        <div class="grid grid-cols-1 mt-3 gap-3 sm:grid-cols-3">
          <BaseInput v-model="antiResaleConfig.title" label="标题" type="text" placeholder="重要声明" />
          <BaseInput v-model="antiResaleConfig.author" label="作者" type="text" placeholder="留空则不展示" />
          <BaseInput v-model="antiResaleConfig.qq" label="联系 QQ" type="text" placeholder="留空则不展示" />
        </div>

        <div class="mt-3">
          <BaseTextarea
            v-model="antiResaleConfig.content"
            label="声明内容"
            :rows="5"
            placeholder="展示给用户的声明正文"
          />
        </div>

        <div class="grid grid-cols-1 mt-3 gap-3 sm:grid-cols-3">
          <BaseInput
            v-model.number="antiResaleConfig.userThreshold"
            label="触发用户数阈值"
            type="number"
            min="1"
            placeholder="999999999"
          />
          <BaseInput
            v-model.number="antiResaleConfig.intervalSeconds"
            label="展示间隔（秒）"
            type="number"
            min="1"
            placeholder="2"
          />
          <BaseInput
            v-model.number="antiResaleConfig.countdownSeconds"
            label="关闭倒计时（秒）"
            type="number"
            min="5"
            placeholder="10"
          />
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          保存后服务端会按下限收敛：阈值 / 间隔最小 1，倒计时最小 5 秒。
        </p>

        <div class="mt-4 border-t border-[var(--theme-border)] pt-4">
          <p class="text-sm text-gray-700 font-medium dark:text-gray-300">
            账号数量限制
          </p>
          <p class="mt-1 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            当前版本检测到运行账号数超过阈值时<strong>仅告警</strong>，不会自动清空或踢下线账号。
          </p>
          <div class="grid grid-cols-1 mt-3 gap-3 sm:grid-cols-2">
            <div class="border border-[var(--theme-border)] rounded-lg bg-[var(--theme-glass)] p-3">
              <BaseSwitch v-model="antiResaleConfig.accountLimitEnabled" label="启用账号数量限制检测" />
            </div>
            <BaseInput
              v-model.number="antiResaleConfig.accountLimitThreshold"
              label="运行账号数阈值"
              type="number"
              min="1"
              placeholder="25"
            />
          </div>
          <div class="mt-3 flex justify-end">
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="accountLimitChecking"
              :disabled="antiResaleSaving"
              @click="checkAccountLimit"
            >
              立即检查
            </BaseButton>
          </div>
        </div>

        <div class="mt-3 flex justify-end border-t border-[var(--theme-border)] pt-3">
          <BaseButton
            variant="primary"
            size="sm"
            :loading="antiResaleSaving"
            @click="showAntiResaleConfirm = true"
          >
            保存防倒卖配置
          </BaseButton>
        </div>
      </template>
    </section>

    <ConfirmModal
      :show="showAnnouncementConfirm"
      title="保存系统公告"
      message="保存后所有登录用户（按上述规则）将看到该公告，确定继续吗？"
      type="primary"
      confirm-text="保存"
      confirmation-code="UPDATE_ANNOUNCEMENT"
      :loading="announcementSaving"
      @confirm="saveAnnouncement"
      @cancel="showAnnouncementConfirm = false"
      @close="showAnnouncementConfirm = false"
    />

    <ConfirmModal
      :show="showSuperAdminConfirm"
      title="保存超级管理员公告"
      message="保存后登录页将展示该公告，确定继续吗？"
      type="primary"
      confirm-text="保存"
      confirmation-code="UPDATE_SUPER_ADMIN_ANNOUNCEMENT"
      :loading="superAdminSaving"
      @confirm="saveSuperAdminAnnouncement"
      @cancel="showSuperAdminConfirm = false"
      @close="showSuperAdminConfirm = false"
    />

    <ConfirmModal
      :show="showAntiResaleConfirm"
      title="保存防倒卖配置"
      message="该配置会影响登录页声明展示与账号数量检测，确定继续吗？"
      type="danger"
      confirm-text="保存"
      confirmation-code="UPDATE_ANTI_RESALE_CONFIG"
      :loading="antiResaleSaving"
      @confirm="saveAntiResaleConfig"
      @cancel="showAntiResaleConfirm = false"
      @close="showAntiResaleConfirm = false"
    />
  </div>
</template>
