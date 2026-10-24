<script setup lang="ts">
import { useDateFormat, useIntervalFn, useMediaQuery, useNow } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NTooltip } from 'naive-ui/es/tooltip'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import AccountModal from '@/components/AccountModal.vue'
import { useSupportContact } from '@/composables/useSupportContact'
import { menuRoutes } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { useStatusStore } from '@/stores/status'
import { useUserStore } from '@/stores/user'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const appStore = useAppStore()
const userStore = useUserStore()
// 桌面端客服入口；与移动端悬浮按钮共用同一弹窗
const {
  visible: supportVisible,
  fabTitle: supportTitle,
  load: loadSupport,
  open: openSupport,
} = useSupportContact()
const route = useRoute()
const router = useRouter()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const { currentAccount } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)
const { sidebarOpen, sidebarCollapsed } = storeToRefs(appStore)
const isSidebarCollapsed = computed(() => isDesktop.value && sidebarCollapsed.value)
const sidebarTooltipTheme = {
  color: 'rgba(31, 43, 35, 0.94)',
  textColor: '#ffffff',
  borderRadius: '9px',
  boxShadow: '0 8px 24px rgba(30, 45, 35, 0.18)',
  padding: '8px 10px',
}

const showUserDropdown = ref(false)
const showTokenDropdown = ref(false)
const showAccountModal = ref(false)
const tokenVisible = ref(false)
const tokenCopied = ref(false)
const accountToEdit = ref<any>(null)
const wsErrorNotifiedAt = ref<Record<string, number>>({})

const systemConnected = ref(true)
const serverUptimeBase = ref(0)
const lastPingTime = ref(Date.now())
const now = useNow({ interval: 1000 })
const formattedTime = useDateFormat(now, 'YYYY-MM-DD HH:mm:ss')

async function checkConnection() {
  try {
    const res = await api.get('/api/ping')
    systemConnected.value = true
    if (res.data.ok && res.data.data) {
      if (res.data.data.uptime) {
        serverUptimeBase.value = res.data.data.uptime
        lastPingTime.value = Date.now()
      }
    }
    const accountRef = currentAccount.value?.id || currentAccount.value?.uin
    if (accountRef) {
      statusStore.connectRealtime(String(accountRef))
    }
  }
  catch {
    systemConnected.value = false
  }
}

async function refreshStatusFallback() {
  if (realtimeConnected.value)
    return

  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  if (accountRef) {
    await statusStore.fetchStatus(String(accountRef))
  }
}

async function handleAccountSaved() {
  await accountStore.fetchAccounts()
  await refreshStatusFallback()
  showAccountModal.value = false
}

onMounted(() => {
  accountStore.fetchAccounts()
  checkConnection()
  // 获取当前用户信息
  userStore.fetchUserInfo()
  // 桌面端客服入口的可见性依赖该配置
  loadSupport()
})

onBeforeUnmount(() => {
  statusStore.disconnectRealtime()
})

function toggleUserDropdown() {
  showUserDropdown.value = !showUserDropdown.value
  if (showUserDropdown.value) {
    showTokenDropdown.value = false
  }
}

function toggleTokenDropdown() {
  showTokenDropdown.value = !showTokenDropdown.value
  if (showTokenDropdown.value) {
    showUserDropdown.value = false
  }
}

function closeFlyouts() {
  showUserDropdown.value = false
  showTokenDropdown.value = false
}

useIntervalFn(checkConnection, 30000)
useIntervalFn(refreshStatusFallback, 10000)

watch(() => currentAccount.value?.id || currentAccount.value?.uin || '', () => {
  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  statusStore.connectRealtime(String(accountRef || ''))
  refreshStatusFallback()
}, { immediate: true })

watch(
  () => [status.value?.accountId, status.value?.status?.avatarUrl] as const,
  ([accountId, avatar]) => {
    const normalizedId = String(accountId || '')
    const normalizedAvatar = String(avatar || '').trim()
    if (!normalizedId || !normalizedAvatar)
      return
    accountStore.syncAccountAvatar(normalizedId, normalizedAvatar)
  },
)

watch(() => status.value?.wsError, (wsError: any) => {
  if (!wsError || Number(wsError.code) !== 400 || !currentAccount.value)
    return

  const errAt = Number(wsError.at) || 0
  const accId = String(currentAccount.value.id || currentAccount.value.uin || '')
  const lastNotified = wsErrorNotifiedAt.value[accId] || 0
  if (errAt <= lastNotified)
    return

  wsErrorNotifiedAt.value[accId] = errAt
  accountToEdit.value = currentAccount.value
  showAccountModal.value = true
}, { deep: true })

const uptime = computed(() => {
  const diff = Math.floor(serverUptimeBase.value + (now.value.getTime() - lastPingTime.value) / 1000)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  return `${h}h ${m}m ${s}s`
})

const connectionStatus = computed(() => {
  if (!systemConnected.value) {
    return {
      text: '系统离线',
      color: 'bg-red-500',
      pulse: false,
    }
  }

  if (!currentAccount.value?.id) {
    return {
      text: '请添加账号',
      color: 'bg-gray-400',
      pulse: false,
    }
  }

  const isConnected = status.value?.connection?.connected
  if (isConnected) {
    return {
      text: '运行中',
      color: 'bg-green-500',
      pulse: true,
    }
  }

  return {
    text: '未连接',
    color: 'bg-gray-400', // Or red? Old version uses gray/offline class which is gray usually
    pulse: false,
  }
})

const navItems = computed(() => {
  return menuRoutes
    .filter((item) => {
      // 代理中心只对代理可见；后台只对管理员可见；其余农场页面代理不可见
      if (item.agentOnly)
        return userStore.isAgent
      if (item.adminOnly)
        return userStore.isAdmin
      return !userStore.isAgent
    })
    .map(item => ({
      path: item.path ? `/${item.path}` : '/',
      label: item.label,
      icon: item.icon,
    }))
})

watch(
  () => route.path,
  () => {
    // Close sidebar on route change (mobile only)
    if (window.innerWidth < 1024)
      appStore.closeSidebar()
  },
)

watch(isSidebarCollapsed, closeFlyouts)

async function handleLogout() {
  await userStore.logout()
  router.push('/login')
}

async function copyToken() {
  const tokenValue = userStore.token
  if (!tokenValue)
    return

  try {
    await navigator.clipboard.writeText(tokenValue)
    tokenCopied.value = true
    setTimeout(() => {
      tokenCopied.value = false
    }, 2000)
  }
  catch (e) {
    console.error('复制失败', e)
  }
}
</script>

<template>
  <aside
    id="app-sidebar"
    class="app-sidebar fixed inset-y-0 left-0 z-50 h-full w-[248px] flex shrink-0 flex-col lg:static lg:translate-x-0"
    :class="[
      sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      { 'is-collapsed': isSidebarCollapsed },
    ]"
    aria-label="主导航"
  >
    <!-- Brand -->
    <div class="sidebar-brand h-15 flex items-center justify-between px-4">
      <NTooltip :disabled="!isSidebarCollapsed" placement="right" :show-arrow="false" :theme-overrides="sidebarTooltipTheme">
        <template #trigger>
          <div class="sidebar-brand__identity min-w-0 flex items-center gap-2.5">
            <span class="brand-mark i-carbon-sprout" />
            <span v-show="!isSidebarCollapsed" class="min-w-0 truncate text-sm font-semibold font-display">
              QQ农场智能助手
            </span>
          </div>
        </template>
        QQ农场智能助手
      </NTooltip>
      <!-- Mobile Close Button -->
      <NButton
        class="lg:hidden"
        quaternary
        circle
        aria-label="关闭侧栏"
        @click="appStore.closeSidebar"
      >
        <div class="i-carbon-close text-xl" />
      </NButton>
    </div>

    <!-- User Info -->
    <div class="sidebar-section border-b border-gray-200/40 p-4 dark:border-gray-700/40">
      <div class="group relative">
        <NTooltip
          :disabled="!isSidebarCollapsed || showUserDropdown"
          placement="right"
          :show-arrow="false"
          :theme-overrides="sidebarTooltipTheme"
        >
          <template #trigger>
            <button
              type="button"
              class="sidebar-control w-full flex items-center justify-between px-3 py-2.5 outline-none transition-colors duration-150"
              style="--focus-ring: var(--theme-primary)"
              aria-haspopup="menu"
              :aria-expanded="showUserDropdown"
              :aria-label="isSidebarCollapsed ? `管理员：${userStore.username || '未登录'}` : undefined"
              @click="toggleUserDropdown"
            >
              <div class="flex items-center gap-3 overflow-hidden">
                <div class="farm-avatar-ring relative h-9 w-9 shrink-0 overflow-hidden rounded-full shadow-md" style="background: var(--ui-primary); padding: 2px;">
                  <div class="h-full w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600">
                    <img
                      :src="userStore.avatar || 'https://thirdqq.qlogo.cn/qqapp/1112386029/BF9C8FC0E5563BEBD93B22F14A9C0566/100'"
                      class="h-full w-full object-cover"
                      @error="(e) => (e.target as HTMLImageElement).src = 'https://thirdqq.qlogo.cn/qqapp/1112386029/BF9C8FC0E5563BEBD93B22F14A9C0566/100'"
                    >
                  </div>
                  <div class="admin-star absolute z-10 h-4 w-4 flex items-center justify-center rounded-full text-[8px] shadow-sm -right-1 -top-1">
                    <span>&#9733;</span>
                  </div>
                </div>
                <div v-show="!isSidebarCollapsed" class="min-w-0 flex flex-col items-start">
                  <span class="font-body w-full truncate text-left text-sm font-medium">
                    {{ userStore.username || '未登录' }}
                  </span>
                  <div class="mt-0.5 flex items-center gap-1.5">
                    <span
                      v-if="userStore.isAdmin || userStore.isAgent"
                      class="admin-badge rounded-lg px-1.5 py-0.2 text-[10px] font-medium leading-tight"
                    >
                      {{ userStore.roleLabel }}
                    </span>
                  </div>
                </div>
              </div>
              <div
                v-show="!isSidebarCollapsed"
                class="i-carbon-chevron-down text-gray-400 transition-transform duration-200"
                :class="{ 'rotate-180': showUserDropdown }"
              />
            </button>
          </template>
          <div class="sidebar-tooltip-content">
            <strong>{{ userStore.username || '未登录' }}</strong>
            <span>{{ userStore.roleLabel }} · 点击查看账户菜单</span>
          </div>
        </NTooltip>

        <!-- User Dropdown Menu -->
        <div
          v-if="showUserDropdown"
          class="sidebar-dropdown absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden py-1"
        >
          <div class="border-b border-gray-100/60 px-4 py-2 dark:border-gray-700/60">
            <div class="text-sm text-gray-900 font-medium dark:text-white">
              {{ userStore.username }}
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400">
              {{ userStore.roleLabel }}
            </div>
          </div>
          <div class="py-1">
            <NButton
              class="sidebar-menu-button"

              quaternary block
              type="error"
              @click="handleLogout"
            >
              <div class="i-carbon-logout" />
              <span>退出登录</span>
            </NButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="sidebar-nav flex-1 overflow-y-auto px-3 py-4 space-y-1">
      <NTooltip
        v-for="item in navItems"
        :key="item.path"
        :disabled="!isSidebarCollapsed"
        placement="right"
        :show-arrow="false"
        :theme-overrides="sidebarTooltipTheme"
      >
        <template #trigger>
          <router-link
            :to="item.path"
            class="sidebar-nav__link group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150"
            :active-class="item.path === '/' ? '' : 'font-medium'"
            :style="{
              color: 'var(--theme-text)',
              opacity: '0.85',
            }"
            :data-nav="item.path"
            :aria-label="isSidebarCollapsed ? item.label : undefined"
          >
            <span class="nav-icon" :class="item.icon" />
            <span v-show="!isSidebarCollapsed" class="font-body">{{ item.label }}</span>
          </router-link>
        </template>
        {{ item.label }}
      </NTooltip>

      <!-- 账号续费：卡密到期前用时间卡/额度卡自助续费，入口固定排在「后台」下面 -->
      <NTooltip
        v-if="!userStore.isAgent"
        :disabled="!isSidebarCollapsed"
        placement="right"
        :show-arrow="false"
        :theme-overrides="sidebarTooltipTheme"
      >
        <template #trigger>
          <router-link
            to="/renewal"
            class="sidebar-nav__link group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150"
            :style="{
              color: 'var(--theme-text)',
              opacity: '0.85',
            }"
            data-nav="/renewal"
            :aria-label="isSidebarCollapsed ? '账号续费' : undefined"
          >
            <span class="nav-icon i-carbon-renew" />
            <span v-show="!isSidebarCollapsed" class="font-body">账号续费</span>
          </router-link>
        </template>
        账号续费
      </NTooltip>

      <!-- 联系客服：桌面端入口，与移动端悬浮按钮共用同一个弹窗实例，排在「账号续费」下面 -->
      <NTooltip
        v-if="supportVisible && isDesktop && !userStore.isAgent"
        :disabled="!isSidebarCollapsed"
        placement="right"
        :show-arrow="false"
        :theme-overrides="sidebarTooltipTheme"
      >
        <template #trigger>
          <button
            type="button"
            class="sidebar-nav__link group w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150"
            :style="{
              color: 'var(--theme-text)',
              opacity: '0.85',
            }"
            data-nav="/support"
            :aria-label="isSidebarCollapsed ? supportTitle : undefined"
            @click="openSupport"
          >
            <span class="nav-icon i-carbon-headset" />
            <span v-show="!isSidebarCollapsed" class="font-body">{{ supportTitle }}</span>
          </button>
        </template>
        {{ supportTitle }}
      </NTooltip>
    </nav>

    <!-- Token Display (All Users) -->
    <div v-if="userStore.token" class="sidebar-token relative border-t border-gray-200/40 px-3 py-2 dark:border-gray-700/40">
      <NTooltip
        :disabled="!isSidebarCollapsed || showTokenDropdown"
        placement="right"
        :show-arrow="false"
        :theme-overrides="sidebarTooltipTheme"
      >
        <template #trigger>
          <button
            type="button"
            class="sidebar-token__trigger w-full flex items-center justify-between rounded-xl px-3 py-2 transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
            aria-haspopup="true"
            :aria-expanded="showTokenDropdown"
            :aria-label="isSidebarCollapsed ? '我的 Token' : undefined"
            @click="toggleTokenDropdown"
          >
            <div class="flex items-center gap-2">
              <div class="i-carbon-password text-base" :style="{ color: 'var(--theme-primary)' }" />
              <span v-show="!isSidebarCollapsed" class="text-xs text-gray-500 font-medium dark:text-gray-400">我的 Token</span>
            </div>
            <div
              v-show="!isSidebarCollapsed"
              class="i-carbon-chevron-down text-gray-400 transition-transform duration-200"
              :class="{ 'rotate-180': showTokenDropdown }"
            />
          </button>
        </template>
        我的 Token · 点击查看
      </NTooltip>
      <div
        v-show="showTokenDropdown"
        class="sidebar-token__details px-1 pt-2 transition-all"
      >
        <div class="mb-1 flex items-center justify-between">
          <button
            class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
            :class="tokenVisible ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'"
            @click="tokenVisible = !tokenVisible"
          >
            <div :class="tokenVisible ? 'i-carbon-view-off' : 'i-carbon-view'" />
            <span>{{ tokenVisible ? '隐藏' : '显示' }}</span>
          </button>
          <button
            class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
            :class="tokenCopied ? 'text-green-500' : 'text-gray-500 dark:text-gray-400'"
            @click="copyToken"
          >
            <div v-if="tokenCopied" class="i-carbon-checkmark" />
            <div v-else class="i-carbon-copy" />
            <span>{{ tokenCopied ? '已复制' : '复制' }}</span>
          </button>
        </div>
        <div class="break-all rounded-xl bg-gray-100/50 px-2 py-1.5 text-[10px] text-gray-600 font-mono dark:bg-gray-700/50 dark:text-gray-400">
          {{ tokenVisible ? userStore.token : '••••••••••••••••' }}
        </div>
      </div>
    </div>

    <!-- Footer Status -->
    <div class="sidebar-footer relative mt-auto p-4">
      <template v-if="!isSidebarCollapsed">
        <div class="mb-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <div class="flex items-center gap-1.5">
            <div
              class="h-2 w-2 rounded-full"
              :class="[connectionStatus.color, { 'animate-pulse': connectionStatus.pulse }]"
            />
            <span>{{ connectionStatus.text }}</span>
          </div>
          <span>{{ uptime }}</span>
        </div>
        <div class="mt-1 flex flex-col gap-0.5 text-xs text-gray-400 font-mono">
          <div class="flex items-center justify-between">
            <span>{{ formattedTime }}</span>
          </div>
        </div>
      </template>
      <div v-else class="sidebar-footer__compact">
        <NTooltip placement="right" :show-arrow="false" :theme-overrides="sidebarTooltipTheme">
          <template #trigger>
            <span class="sidebar-footer__icon" tabindex="0" :aria-label="`连接状态：${connectionStatus.text}`">
              <span class="i-carbon-connection-signal text-lg" />
              <span
                class="sidebar-status-dot"
                :class="[connectionStatus.color, { 'animate-pulse': connectionStatus.pulse }]"
              />
            </span>
          </template>
          <div class="sidebar-tooltip-content">
            <strong>{{ connectionStatus.text }}</strong>
            <span>服务运行时长 {{ uptime }}</span>
          </div>
        </NTooltip>
        <NTooltip placement="right" :show-arrow="false" :theme-overrides="sidebarTooltipTheme">
          <template #trigger>
            <span class="sidebar-footer__icon" tabindex="0" :aria-label="`当前时间：${formattedTime}`">
              <span class="i-carbon-time text-lg" />
            </span>
          </template>
          <div class="sidebar-tooltip-content">
            <strong>当前时间</strong>
            <span>{{ formattedTime }}</span>
          </div>
        </NTooltip>
      </div>
    </div>
  </aside>

  <!-- Overlay for mobile when sidebar is open -->
  <div
    v-if="showUserDropdown || showTokenDropdown"
    class="fixed inset-0 z-40 bg-transparent"
    @click="closeFlyouts"
  />

  <AccountModal
    :show="showAccountModal"
    :edit-data="accountToEdit"
    @close="showAccountModal = false; accountToEdit = null"
    @saved="handleAccountSaved"
  />
</template>

<style scoped>
.app-sidebar {
  color: var(--ui-ink);
  border-right: 1px solid rgba(59, 92, 57, 0.16);
  background: linear-gradient(180deg, rgba(252, 254, 248, 0.86) 0%, rgba(238, 247, 229, 0.78) 100%);
  box-shadow:
    10px 0 32px rgba(35, 70, 40, 0.1),
    inset -1px 0 0 rgba(255, 255, 255, 0.84);
  transition:
    transform 0.2s ease,
    width 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  -webkit-backdrop-filter: blur(22px) saturate(135%);
  backdrop-filter: blur(22px) saturate(135%);
}

.sidebar-brand {
  min-height: 62px;
  border-bottom: 1px solid rgba(59, 92, 57, 0.14);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92);
}

.brand-mark {
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: #fff;
  font-size: 18px;
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.3);
}

.sidebar-control {
  border: 1px solid rgba(59, 92, 57, 0.16);
  border-radius: 14px;
  color: var(--ui-ink);
  background: rgba(255, 255, 255, 0.55);
}

.sidebar-control:hover {
  border-color: var(--ui-border-strong);
  background: rgba(255, 255, 255, 0.84);
}

.sidebar-control:focus-visible,
.sidebar-token__trigger:focus-visible,
.sidebar-nav__link:focus-visible,
.sidebar-footer__icon:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ui-primary) 55%, transparent);
  outline-offset: 2px;
}

.sidebar-dropdown {
  border: 1px solid rgba(59, 92, 57, 0.16);
  border-radius: 14px;
  color: var(--ui-ink);
  background: var(--ui-surface-strong);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.92),
    var(--ui-shadow-lg);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  backdrop-filter: blur(18px) saturate(145%);
}

.sidebar-footer {
  border-top: 1px solid rgba(59, 92, 57, 0.14);
  background: rgba(232, 243, 220, 0.62);
}

.sidebar-footer__compact {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.sidebar-footer__icon {
  position: relative;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--ui-muted);
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.sidebar-footer__icon:hover {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.sidebar-status-dot {
  position: absolute;
  right: 7px;
  bottom: 7px;
  width: 7px;
  height: 7px;
  border: 1.5px solid rgba(255, 255, 255, 0.96);
  border-radius: 999px;
}

.sidebar-tooltip-content {
  min-width: 132px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-block: 1px;
  line-height: 1.35;
}

.sidebar-tooltip-content strong {
  font-size: 12px;
  font-weight: 600;
}

.sidebar-tooltip-content span {
  font-size: 11px;
  opacity: 0.78;
}

nav a:hover,
nav button.sidebar-nav__link:hover {
  background: rgba(219, 234, 254, 0.72);
}

.nav-icon {
  width: 19px;
  height: 19px;
  flex: none;
  color: var(--ui-muted);
}

.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 2px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.5);
}

.router-link-active {
  background: linear-gradient(135deg, #60a5fa, #2563eb) !important;
  color: #fff !important;
  font-weight: 600;
  box-shadow: 0 8px 20px rgba(37, 99, 235, 0.3) !important;
  border-radius: 12px;
  opacity: 1 !important;
}

.router-link-active .nav-icon {
  color: #fff;
}

.router-link-exact-active {
  background: linear-gradient(135deg, #60a5fa, #2563eb) !important;
  color: #fff !important;
  font-weight: 600;
  box-shadow: 0 8px 20px rgba(37, 99, 235, 0.3) !important;
  border-radius: 12px;
  opacity: 1 !important;
}

.router-link-exact-active .nav-icon {
  color: #fff;
}

/* Dropdown active item */
.bg-green-50 {
  background-color: color-mix(in srgb, var(--theme-primary) 10%, transparent) !important;
}

.dark\:bg-green-900\/10 {
  background-color: color-mix(in srgb, var(--theme-primary) 15%, transparent) !important;
}

/* Farm avatar ring glow effect */
.farm-avatar-ring {
  transition: box-shadow 0.16s ease;
}

.farm-avatar-ring:hover {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 18%, transparent);
}

.admin-badge {
  color: #725d9e;
  background: var(--ui-violet-soft);
}

.admin-star {
  color: #8b6321;
  background: var(--ui-warning-soft);
}

.sidebar-menu-button {
  width: 100%;
  min-height: 34px;
  padding: 8px 12px;
  border-radius: 10px;
}

.sidebar-menu-button :deep(.n-button__content) {
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
}

@media (min-width: 1024px) {
  .app-sidebar.is-collapsed {
    width: 72px;
  }

  .app-sidebar.is-collapsed .sidebar-brand {
    justify-content: center;
    padding-inline: 0;
  }

  .app-sidebar.is-collapsed .sidebar-brand__identity {
    justify-content: center;
  }

  .app-sidebar.is-collapsed .sidebar-section {
    padding: 10px 11px;
  }

  .app-sidebar.is-collapsed .sidebar-control {
    min-height: 48px;
    justify-content: center;
    padding: 5px;
  }

  .app-sidebar.is-collapsed .sidebar-dropdown {
    width: 280px;
    right: auto;
    left: calc(100% + 12px);
    top: 0;
    margin-top: 0;
  }

  .app-sidebar.is-collapsed .sidebar-nav {
    padding: 12px 10px;
    scrollbar-width: none;
  }

  .app-sidebar.is-collapsed .sidebar-nav::-webkit-scrollbar {
    width: 0;
  }

  .app-sidebar.is-collapsed .sidebar-nav__link {
    min-height: 42px;
    justify-content: center;
    gap: 0;
    padding: 10px;
  }

  .app-sidebar.is-collapsed .nav-icon {
    width: 20px;
    height: 20px;
  }

  .app-sidebar.is-collapsed .sidebar-token {
    padding: 8px 11px;
  }

  .app-sidebar.is-collapsed .sidebar-token__trigger {
    min-height: 42px;
    justify-content: center;
    padding: 0;
  }

  .app-sidebar.is-collapsed .sidebar-token__details {
    position: absolute;
    z-index: 50;
    width: 280px;
    left: calc(100% + 12px);
    bottom: 0;
    padding: 12px;
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    color: var(--ui-ink);
    background: var(--ui-surface-strong);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.92),
      var(--ui-shadow-lg);
    -webkit-backdrop-filter: blur(18px) saturate(145%);
    backdrop-filter: blur(18px) saturate(145%);
  }

  .app-sidebar.is-collapsed .sidebar-footer {
    padding: 8px 11px 10px;
  }
}
</style>
