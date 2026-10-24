<script setup lang="ts">
import type { Account } from '@/stores/account'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import AccountModal from '@/components/AccountModal.vue'
import RemarkModal from '@/components/RemarkModal.vue'
import { getPlatformClass, getPlatformLabel, useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const { accounts, currentAccount } = storeToRefs(accountStore)
const { status } = storeToRefs(statusStore)

const showDropdown = ref(false)
const showAccountModal = ref(false)
const showRemarkModal = ref(false)
const accountToEdit = ref<Account | null>(null)
const avatarErrors = ref(new Set<string>())

const triggerRef = useTemplateRef<HTMLElement>('trigger')
const dropdownPos = ref({ top: 0, left: 0, width: 300 })

const platform = computed(() => getPlatformLabel(currentAccount.value?.platform))

/** 登录后的实时昵称优先于本地备注，未登录时不显示「未登录」占位 */
function liveName() {
  const name = String(status.value?.status?.name || '').trim()
  return name && name !== '未登录' ? name : ''
}

function displayNameOf(acc?: Account | null) {
  if (!acc)
    return '选择账号'
  const nick = currentAccount.value?.id === acc.id ? liveName() : ''
  const remark = String(acc.name || '').trim()
  const display = nick || String(acc.nick || '').trim()
  if (display && remark && display !== remark)
    return `${display} (${remark})`
  return display || remark || String(acc.uin || acc.id || '') || '选择账号'
}

function avatarOf(acc?: Account | null) {
  if (!acc)
    return ''
  const id = String(acc.id || '')
  const live = id && id === String(status.value?.accountId || '')
    ? String(status.value?.status?.avatarUrl || '').trim()
    : ''
  return live || String(acc.avatar || '').trim()
}

function avatarKey(acc?: Account | null) {
  return String(acc?.id || acc?.uin || '')
}

function canShowAvatar(acc?: Account | null) {
  const key = avatarKey(acc)
  return !!avatarOf(acc) && !!key && !avatarErrors.value.has(key)
}

function markAvatarError(acc?: Account | null) {
  const key = avatarKey(acc)
  if (!key)
    return
  avatarErrors.value = new Set(avatarErrors.value).add(key)
}

const displayName = computed(() => displayNameOf(currentAccount.value))
const currentAvatar = computed(() => avatarOf(currentAccount.value))
const subtitle = computed(() => String(currentAccount.value?.uin || currentAccount.value?.id || ''))

function updateDropdownPos() {
  const el = triggerRef.value
  if (!el)
    return
  const rect = el.getBoundingClientRect()
  const gap = 8
  const width = Math.min(320, window.innerWidth - gap * 2)
  const left = Math.min(
    Math.max(gap, rect.right - width),
    window.innerWidth - width - gap,
  )
  dropdownPos.value = { top: rect.bottom + gap, left, width }
}

async function openDropdown() {
  updateDropdownPos()
  showDropdown.value = true
  await nextTick()
  updateDropdownPos()
}

function closeDropdown() {
  showDropdown.value = false
}

function toggleDropdown() {
  if (showDropdown.value)
    closeDropdown()
  else
    openDropdown()
}

function handleScroll() {
  if (showDropdown.value)
    updateDropdownPos()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape')
    closeDropdown()
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, true)
  window.addEventListener('resize', handleScroll)
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll, true)
  window.removeEventListener('resize', handleScroll)
  window.removeEventListener('keydown', handleKeydown)
})

function selectAccount(acc: Account) {
  accountStore.setCurrentAccount(acc)
  closeDropdown()
}

function openAddAccount() {
  accountToEdit.value = null
  showAccountModal.value = true
  closeDropdown()
}

function openRemarkModal(acc: Account) {
  accountToEdit.value = acc
  showRemarkModal.value = true
  closeDropdown()
}

async function handleAccountSaved() {
  await accountStore.fetchAccounts()
  showAccountModal.value = false
  showRemarkModal.value = false
  accountToEdit.value = null
}
</script>

<template>
  <div class="header-account">
    <button
      ref="trigger"
      type="button"
      class="header-account-trigger"
      aria-haspopup="menu"
      :aria-expanded="showDropdown"
      :aria-label="`当前账号：${displayName}`"
      :title="displayName"
      @click="toggleDropdown"
    >
      <div class="header-account-avatar">
        <img
          v-if="canShowAvatar(currentAccount)"
          :src="currentAvatar"
          :alt="displayName"
          class="h-full w-full object-cover"
          @error="markAvatarError(currentAccount)"
        >
        <div v-else class="i-carbon-user text-base text-gray-400" />
      </div>
      <div class="header-account-meta">
        <span class="header-account-name">{{ displayName }}</span>
        <span class="header-account-sub">
          <span
            v-if="platform"
            class="rounded-lg px-1.5 py-0.2 text-[10px] font-medium leading-tight"
            :class="getPlatformClass(currentAccount?.platform)"
          >
            {{ platform }}
          </span>
          <span class="truncate">{{ subtitle || '未选择' }}</span>
        </span>
      </div>
      <div
        class="i-carbon-chevron-down shrink-0 text-gray-400 transition-transform duration-200"
        :class="{ 'rotate-180': showDropdown }"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="showDropdown"
        class="fixed inset-0 z-[9998] bg-transparent"
        @click="closeDropdown"
      />

      <div
        v-if="showDropdown"
        class="header-account-dropdown fixed z-[9999] overflow-hidden py-1"
        :style="{ top: `${dropdownPos.top}px`, left: `${dropdownPos.left}px`, width: `${dropdownPos.width}px` }"
        role="menu"
      >
        <div class="custom-scrollbar max-h-72 overflow-y-auto">
          <template v-if="accounts.length > 0">
            <div
              v-for="acc in accounts"
              :key="acc.id || acc.uin"
              class="flex items-center rounded-xl transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
              :style="{ backgroundColor: currentAccount?.id === acc.id ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : undefined }"
            >
              <button type="button" class="min-w-0 flex flex-1 items-center gap-3 px-3 py-2.5" @click="selectAccount(acc)">
                <div class="h-8 w-8 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 shadow-sm dark:bg-gray-600">
                  <img
                    v-if="canShowAvatar(acc)"
                    :src="avatarOf(acc)"
                    :alt="displayNameOf(acc)"
                    class="h-full w-full object-cover"
                    @error="markAvatarError(acc)"
                  >
                  <div v-else class="i-carbon-user text-gray-400" />
                </div>
                <div class="min-w-0 flex flex-1 flex-col items-start">
                  <span class="w-full truncate text-left text-sm font-medium">
                    {{ displayNameOf(acc) }}
                  </span>
                  <div class="flex items-center gap-1.5">
                    <span
                      v-if="getPlatformLabel(acc.platform)"
                      class="rounded-lg px-1.5 py-0.2 text-[10px] font-medium leading-tight"
                      :class="getPlatformClass(acc.platform)"
                    >
                      {{ getPlatformLabel(acc.platform) }}
                    </span>
                    <span class="truncate text-xs text-gray-400">{{ acc.uin || acc.id }}</span>
                  </div>
                </div>
                <div v-if="currentAccount?.id === acc.id" class="i-carbon-checkmark" :style="{ color: 'var(--theme-primary)' }" />
              </button>
              <NButton quaternary circle size="tiny" title="修改备注" aria-label="修改备注" @click="openRemarkModal(acc)">
                <div class="i-carbon-edit" />
              </NButton>
              <span class="w-1" />
            </div>
          </template>
          <div v-else class="px-4 py-3 text-center text-sm text-gray-400">
            暂无账号
          </div>
        </div>

        <div class="mt-1 border-t border-gray-100/60 px-1 pt-1 dark:border-gray-700/60">
          <NButton class="header-account-add" quaternary block type="primary" @click="openAddAccount">
            <div class="i-carbon-add" />
            <span>添加账号</span>
          </NButton>
          <router-link
            :to="{ path: '/settings', query: { tab: 'account' } }"
            class="header-account-action"
            @click="closeDropdown"
          >
            <div class="i-carbon-add-alt" />
            <span>管理账号</span>
          </router-link>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <AccountModal
        :show="showAccountModal"
        :edit-data="accountToEdit"
        @close="showAccountModal = false; accountToEdit = null"
        @saved="handleAccountSaved"
      />
      <RemarkModal
        :show="showRemarkModal"
        :account="accountToEdit"
        @close="showRemarkModal = false; accountToEdit = null"
        @saved="handleAccountSaved"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.header-account {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
}

.header-account-trigger {
  display: flex;
  max-width: min(80vw, 360px);
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border: none;
  border-radius: 11px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.header-account-trigger:hover {
  background: var(--ui-primary-soft);
}

.header-account-avatar {
  display: flex;
  height: 36px;
  width: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 9999px;
  background: var(--ui-surface);
  box-shadow: 0 0 0 1px var(--ui-border) inset;
}

.header-account-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}

.header-account-name {
  overflow: hidden;
  max-width: 100%;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-account-sub {
  display: flex;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
  color: var(--ui-muted);
  font-size: 12px;
}

.header-account-dropdown {
  border: 1px solid rgba(59, 92, 57, 0.16);
  border-radius: 16px;
  background: var(--ui-surface-strong);
  box-shadow:
    var(--ui-shadow-sm),
    0 14px 34px rgba(35, 70, 40, 0.16);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  backdrop-filter: blur(18px) saturate(140%);
}

.header-account-action {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  color: var(--ui-primary);
  font-size: 14px;
  transition: background-color 0.15s ease;
}

.header-account-action:hover {
  background: var(--ui-primary-soft);
}

/* naive 不会给默认插槽里的图标补间距，补上后与下方「管理账号」的图标-文字间距一致 */
.header-account-add :deep(.n-button__content) {
  gap: 8px;
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

@media (max-width: 640px) {
  .header-account-sub {
    display: none;
  }

  .header-account-trigger {
    max-width: 54vw;
    padding: 6px 9px;
  }

  .header-account-avatar {
    height: 32px;
    width: 32px;
  }

  .header-account-name {
    font-size: 14px;
  }
}
</style>
