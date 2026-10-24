<script setup lang="ts">
import { onMounted } from 'vue'
import { useSupportContact } from '@/composables/useSupportContact'

/**
 * 联系客服弹窗（全局唯一实例）。
 * 桌面端入口在侧边栏「账号续费」下方，移动端入口在底部导航栏，这里不提供入口。
 */
const {
  config,
  show,
  previewQrcode,
  title,
  subtitle,
  qrcodeHint,
  qqTitle,
  wechatTitle,
  groupTitle,
  safeGroupLink,
  safeQrcodeUrl,
  qqChatLink,
  visible,
  load,
  copy,
  close,
} = useSupportContact()

onMounted(load)
</script>

<template>
  <Teleport to="body">
    <Transition name="support-fade">
      <div
        v-if="visible && show"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
        @click="close"
      >
        <div
          class="support-dialog max-w-md w-full border border-gray-200 rounded-xl bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800"
          @click.stop
        >
          <div class="mb-4 flex items-start justify-between gap-3">
            <div class="min-w-0 flex items-start gap-3">
              <div class="mt-0.5 h-9 w-9 flex shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
                <div class="i-carbon-headset text-lg" />
              </div>
              <div class="min-w-0">
                <h3 class="text-base text-gray-900 font-semibold dark:text-white">
                  {{ title }}
                </h3>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {{ subtitle }}
                </p>
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 border-none bg-transparent p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              aria-label="关闭"
              @click="close"
            >
              <div class="i-carbon-close text-lg" />
            </button>
          </div>

          <div class="space-y-2">
            <div
              v-if="config?.qq"
              class="support-row support-row-split"
            >
              <button
                type="button"
                class="support-row-main"
                @click="copy(config.qq, qqTitle)"
              >
                <span class="i-carbon-chat shrink-0 text-lg text-blue-500" />
                <span class="support-row-label">{{ qqTitle }}</span>
                <span class="support-row-value">{{ config.qq }}</span>
                <span class="i-carbon-copy shrink-0 text-base text-gray-400" />
              </button>
              <a
                v-if="qqChatLink"
                :href="qqChatLink"
                target="_blank"
                rel="noopener noreferrer"
                class="support-jump-btn"
                title="打开 QQ 对话"
                aria-label="打开 QQ 对话"
              >
                <span class="support-jump-text">点击打开</span>
                <span class="i-carbon-arrow-up-right shrink-0 text-base text-gray-400" />
              </a>
            </div>

            <button
              v-if="config?.wechat"
              type="button"
              class="support-row"
              @click="copy(config.wechat, wechatTitle)"
            >
              <span class="i-carbon-logo-wechat shrink-0 text-lg text-green-500" />
              <span class="support-row-label">{{ wechatTitle }}</span>
              <span class="support-row-value">{{ config.wechat }}</span>
              <span class="i-carbon-copy shrink-0 text-base text-gray-400" />
            </button>

            <!-- 群号与加群链接合并为一行：有群号可复制，有链接可跳转 -->
            <div
              v-if="config?.group || safeGroupLink"
              class="support-row support-row-split"
            >
              <button
                v-if="config?.group"
                type="button"
                class="support-row-main"
                @click="copy(config.group, groupTitle)"
              >
                <span class="i-carbon-user-multiple shrink-0 text-lg text-violet-500" />
                <span class="support-row-label">{{ groupTitle }}</span>
                <span class="support-row-value">{{ config.group }}</span>
                <span class="i-carbon-copy shrink-0 text-base text-gray-400" />
              </button>
              <span
                v-else
                class="support-row-main support-row-static"
              >
                <span class="i-carbon-user-multiple shrink-0 text-lg text-violet-500" />
                <span class="support-row-label">{{ groupTitle }}</span>
              </span>
              <a
                v-if="safeGroupLink"
                :href="safeGroupLink"
                target="_blank"
                rel="noopener noreferrer"
                class="support-jump-btn"
                title="打开加群链接"
                aria-label="打开加群链接"
              >
                <span class="support-jump-text">点击打开</span>
                <span class="i-carbon-arrow-up-right shrink-0 text-base text-gray-400" />
              </a>
            </div>
          </div>

          <div v-if="safeQrcodeUrl" class="mt-4 text-center">
            <p class="mb-2 text-xs text-gray-500 dark:text-gray-400">
              {{ qrcodeHint }}
            </p>
            <img
              :src="safeQrcodeUrl"
              alt="微信客服二维码"
              class="support-qrcode"
              title="点击放大"
              @click="previewQrcode = true"
            >
          </div>

          <div class="mt-6 flex justify-end">
            <button
              type="button"
              class="support-close-btn"
              @click="close"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="support-fade">
      <div
        v-if="previewQrcode && safeQrcodeUrl"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-6"
        @click="previewQrcode = false"
      >
        <img :src="safeQrcodeUrl" alt="微信客服二维码" class="max-h-[80vh] max-w-full object-contain">
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 面板必须是不透明的：全局 `.bg-white` 被重映射为半透明的 --ui-surface
   （rgba(255, 255, 255, 0.78)），会让弹窗背后的页面内容透出来，这里显式压掉。
   带 scope 属性的选择器权重高于 `.bg-white`，两条都是 !important 时本规则胜出。
   注意：本文件不要用 :global()，该工具链会把它编译成无作用域的裸规则。 */
.support-dialog {
  background-color: #fffdf6 !important;
}

.support-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface-soft, rgba(238, 243, 248, 0.8));
  cursor: pointer;
  text-align: left;
}

/* 普通行整行可点；QQ 行拆成「复制区 + 跳转区」，内边距交给子元素 */
.support-row:not(.support-row-split) {
  padding: 10px 12px;
}

.support-row-split {
  gap: 0;
  overflow: hidden;
  padding: 0;
  cursor: default;
}

.support-row-main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

/* 只有链接、没有群号时这一侧不可点，仅作标题展示 */
.support-row-static {
  cursor: default;
}

.support-jump-btn {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  gap: 4px;
  padding: 0 12px;
  border-left: 1px solid var(--ui-border);
  color: var(--ui-primary, #2563eb);
}

.support-jump-text {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.support-jump-btn:hover {
  background: var(--ui-primary-soft, rgba(37, 99, 235, 0.1));
  border-radius: 0 10px 10px 0;
}

.support-row:hover {
  border-color: color-mix(in srgb, var(--theme-primary, #2563eb) 40%, var(--ui-border));
}

.support-row-label {
  flex: none;
  color: #6b7280;
  font-size: 13px;
}

.support-row-value {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: #111827;
  font-size: 14px;
  font-weight: 600;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.support-qrcode {
  display: inline-block;
  max-height: 200px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  object-fit: contain;
  cursor: zoom-in;
}

.support-close-btn {
  padding: 8px 18px;
  border: none;
  border-radius: 10px;
  background: var(--theme-gradient, var(--ui-primary, #2563eb));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.support-fade-enter-active,
.support-fade-leave-active {
  transition: opacity 0.15s ease;
}

.support-fade-enter-from,
.support-fade-leave-to {
  opacity: 0;
}
</style>
