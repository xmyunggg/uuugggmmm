<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AnnouncementModal from '@/components/AnnouncementModal.vue'
import HeaderAccountMenu from '@/components/HeaderAccountMenu.vue'
import MobileBottomNav from '@/components/MobileBottomNav.vue'
import Sidebar from '@/components/Sidebar.vue'
import SupportContactButton from '@/components/SupportContactButton.vue'
import { useAppStore } from '@/stores/app'
import { useUserStore } from '@/stores/user'

const appStore = useAppStore()
const userStore = useUserStore()
const route = useRoute()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const { sidebarOpen, sidebarCollapsed } = storeToRefs(appStore)
const navigationExpanded = computed(() => isDesktop.value ? !sidebarCollapsed.value : sidebarOpen.value)
const navigationToggleLabel = computed(() => navigationExpanded.value ? '收起侧栏' : '展开侧栏')

function toggleNavigation() {
  if (isDesktop.value)
    appStore.toggleSidebarCollapsed()
  else
    appStore.toggleSidebar()
}
</script>

<template>
  <div class="liquid-layout w-screen flex overflow-hidden">
    <div
      v-if="sidebarOpen"
      class="navigation-overlay fixed inset-0 z-40 lg:hidden"
      @click="appStore.closeSidebar"
    />

    <Sidebar />

    <main class="app-main relative h-full min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
      <header v-if="!route.meta.fullBleed" class="glass-app-header">
        <div class="header-left">
          <button
            class="header-icon-btn"
            type="button"
            aria-controls="app-sidebar"
            :aria-expanded="navigationExpanded"
            :aria-label="navigationToggleLabel"
            :title="navigationToggleLabel"
            @click="toggleNavigation"
          >
            <div class="i-carbon-menu text-xl" />
          </button>
          <div class="header-avatar">
            <img src="/icon.png" alt="QQ农场智能助手" class="h-full w-full object-cover">
          </div>
          <div class="header-title">
            QQ农场智能助手
          </div>
        </div>

        <HeaderAccountMenu v-if="!userStore.isAgent" />
      </header>

      <div class="app-content min-h-0 flex flex-1 flex-col overflow-hidden">
        <div
          class="page-scroll custom-scrollbar flex flex-1 flex-col"
          :class="route.meta.fullBleed ? 'overflow-hidden p-0' : 'overflow-y-auto'"
        >
          <RouterView v-slot="{ Component, route: currentRoute }">
            <Transition name="page-fade" mode="out-in">
              <component :is="Component" :key="currentRoute.path" />
            </Transition>
          </RouterView>
        </div>
      </div>
    </main>

    <MobileBottomNav v-if="!route.meta.fullBleed" />

    <AnnouncementModal />

    <SupportContactButton v-if="!userStore.isAgent" />
  </div>
</template>

<style scoped>
.liquid-layout {
  height: 100dvh;
}

.navigation-overlay {
  background: rgba(20, 40, 26, 0.42);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.glass-app-header {
  display: flex;
  min-height: 64px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 8px 0;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(255, 253, 246, 0.8), rgba(247, 251, 240, 0.64));
  box-shadow:
    0 10px 28px rgba(35, 70, 40, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  backdrop-filter: blur(20px) saturate(140%);
}

.header-left {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.header-icon-btn {
  display: flex;
  height: 36px;
  width: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--ui-muted);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.header-icon-btn:hover {
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
}

.header-avatar {
  display: flex;
  height: 32px;
  width: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 9999px;
  box-shadow: 0 0 0 1px var(--ui-border) inset;
}

/* 窄屏也保留网站名称，超长时截断而不是隐藏 */
.header-title {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (min-width: 768px) {
  .glass-app-header {
    margin: 16px 16px 0;
    padding: 0 20px;
  }

  .header-title {
    font-size: 18px;
  }
}

.page-scroll {
  min-height: 0;
  padding: 22px clamp(16px, 2.4vw, 34px) 28px;
}

.page-scroll > :deep(*) {
  flex: 0 0 auto;
  width: 100%;
  max-width: 1580px;
  margin-inline: auto;
}

.page-fade-enter-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.page-fade-leave-active {
  transition: opacity 0.1s ease;
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(3px);
}

.page-fade-leave-to {
  opacity: 0;
}

@media (max-width: 1023px) {
  .page-scroll {
    /* Keep the last card/button above the fixed mobile navigation bar. */
    padding: 14px 12px calc(132px + env(safe-area-inset-bottom));
    scroll-padding-bottom: calc(132px + env(safe-area-inset-bottom));
  }
}

@media (max-width: 480px) {
  .glass-app-header {
    margin-inline: 8px;
  }

  .page-scroll {
    padding-inline: 8px;
  }
}
</style>
