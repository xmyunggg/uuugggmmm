<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useSupportContact } from '@/composables/useSupportContact'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
// 客服入口与侧边栏入口共用同一弹窗；这里只负责窄屏的底部导航项
const {
  visible: supportVisible,
  fabTitle: supportTitle,
  load: loadSupport,
  open: openSupport,
} = useSupportContact()

const farmItems = [
  { path: '/', label: '首页', icon: 'i-carbon-home' },
  { path: '/game-mall', label: '商城', icon: 'i-carbon-shopping-cart' },
  { path: '/personal', label: '农场', icon: 'i-carbon-sprout' },
  { path: '/activity', label: '活动', icon: 'i-carbon-events' },
  { path: '/settings', label: '设置', icon: 'i-carbon-settings' },
]

// 代理只能使用代理中心，底部导航不应指向农场页面（否则会被路由守卫弹回）
const items = computed(() => userStore.isAgent
  ? [{ path: '/agent', label: '代理中心', icon: 'i-carbon-user-multiple' }]
  : farmItems)

// 客服是打开弹窗而非路由跳转，代理端不展示（与侧边栏入口一致）
const showSupport = computed(() => !userStore.isAgent && supportVisible.value)
const columns = computed(() => items.value.length + (showSupport.value ? 1 : 0))

onMounted(loadSupport)
</script>

<template>
  <nav class="mobile-bottom-nav lg:hidden" aria-label="主要导航" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
    <RouterLink
      v-for="item in items"
      :key="item.path"
      :to="item.path"
      class="mobile-bottom-nav__item"
      exact-active-class="mobile-bottom-nav__item--active"
    >
      <div :class="item.icon" class="mobile-bottom-nav__icon" />
      <span class="mobile-bottom-nav__label">{{ item.label }}</span>
    </RouterLink>

    <button
      v-if="showSupport"
      type="button"
      class="mobile-bottom-nav__item mobile-bottom-nav__action"
      :aria-label="supportTitle"
      :title="supportTitle"
      @click="openSupport"
    >
      <div class="mobile-bottom-nav__icon i-carbon-headset" />
      <span class="mobile-bottom-nav__label">{{ supportTitle }}</span>
    </button>
  </nav>
</template>

<style scoped>
.mobile-bottom-nav {
  position: fixed;
  z-index: 35;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  left: max(14px, env(safe-area-inset-left));
  display: none;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  min-height: 66px;
  padding: 7px 8px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 24px;
  background: linear-gradient(135deg, rgba(255, 253, 246, 0.92), rgba(241, 249, 233, 0.84));
  box-shadow:
    0 16px 42px rgba(35, 70, 40, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: blur(22px) saturate(135%);
  backdrop-filter: blur(22px) saturate(135%);
}

@media (max-width: 1023px) {
  .mobile-bottom-nav {
    display: grid;
  }
}

.mobile-bottom-nav__item {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 3px;
  border-radius: 17px;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.1;
  text-decoration: none;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}

/* 客服项是 button，需清掉浏览器默认外观以对齐其它导航项 */
.mobile-bottom-nav__action {
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
}

.mobile-bottom-nav__icon {
  width: 22px;
  height: 22px;
}

/* 标题可由后台自定义，超长时截断而不是撑破等分栅格 */
.mobile-bottom-nav__label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-bottom-nav__item--active {
  color: var(--ui-primary);
  background: rgba(219, 234, 254, 0.86);
  box-shadow: none !important;
}
</style>
