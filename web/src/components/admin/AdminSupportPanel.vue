<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ref-ui/BaseButton.vue'
import BaseInput from '@/components/ref-ui/BaseInput.vue'
import BaseSwitch from '@/components/ref-ui/BaseSwitch.vue'
import ConfirmModal from '@/components/ref-ui/ConfirmModal.vue'
import { useToastStore } from '@/stores/toast'

interface SupportConfig {
  enabled: boolean
  title: string
  fabTitle: string
  subtitle: string
  qrcodeHint: string
  qqTitle: string
  wechatTitle: string
  groupTitle: string
  qq: string
  wechat: string
  qrcodeUrl: string
  group: string
  groupLink: string
}

const toast = useToastStore()

function createDefaultSupportConfig(): SupportConfig {
  return {
    enabled: false,
    title: '联系客服',
    fabTitle: '联系客服',
    subtitle: '点击即可复制联系方式',
    qrcodeHint: '扫码添加微信客服',
    qqTitle: '客服 QQ',
    wechatTitle: '客服微信',
    groupTitle: 'QQ 群号',
    qq: '',
    wechat: '',
    qrcodeUrl: '',
    group: '',
    groupLink: '',
  }
}

/** 标题类字段留空时回退默认文案，与后端 normalizeSupportConfig 保持一致 */
const TITLE_KEYS = ['title', 'fabTitle', 'subtitle', 'qrcodeHint', 'qqTitle', 'wechatTitle', 'groupTitle'] as const

function normalizeSupportConfig(source: Partial<SupportConfig> | null | undefined): SupportConfig {
  const defaults = createDefaultSupportConfig()
  const pick = (value: unknown, fallback: string) =>
    value === undefined || value === null ? fallback : String(value).trim()
  type StringKey = Exclude<keyof SupportConfig, 'enabled'>
  const text = (key: StringKey): string => {
    const value = pick(source?.[key], defaults[key])
    if ((TITLE_KEYS as readonly string[]).includes(key))
      return value || defaults[key]
    return value
  }
  return {
    enabled: typeof source?.enabled === 'boolean' ? source.enabled : defaults.enabled,
    title: text('title'),
    fabTitle: text('fabTitle'),
    subtitle: text('subtitle'),
    qrcodeHint: text('qrcodeHint'),
    qqTitle: text('qqTitle'),
    wechatTitle: text('wechatTitle'),
    groupTitle: text('groupTitle'),
    qq: text('qq'),
    wechat: text('wechat'),
    qrcodeUrl: text('qrcodeUrl'),
    group: text('group'),
    groupLink: text('groupLink'),
  }
}

const supportConfig = ref<SupportConfig>(createDefaultSupportConfig())
const loading = ref(false)
const saving = ref(false)
const showSaveConfirm = ref(false)

async function loadSupportConfig() {
  loading.value = true
  try {
    const { data } = await api.get('/api/support-config', { skipErrorToast: true } as any)
    if (data?.ok)
      supportConfig.value = normalizeSupportConfig(data.data)
  }
  catch (error) {
    toast.error(`加载联系客服配置失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    loading.value = false
  }
}

async function saveSupportConfig() {
  saving.value = true
  try {
    const { data } = await api.post('/api/admin/support-config', {
      ...supportConfig.value,
      confirmed: true,
    })
    if (data?.ok) {
      supportConfig.value = normalizeSupportConfig(data.data)
      toast.success(supportConfig.value.enabled ? '联系客服配置已保存并生效' : '联系客服入口已关闭')
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (error) {
    toast.error(`保存失败: ${getApiErrorMessage(error, '未知错误')}`)
  }
  finally {
    saving.value = false
    showSaveConfirm.value = false
  }
}

onMounted(loadSupportConfig)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
        联系客服
      </h3>
      <BaseButton variant="primary" size="sm" :loading="saving" @click="showSaveConfirm = true">
        保存
      </BaseButton>
    </div>

    <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] px-4 py-3 text-sm text-gray-600 backdrop-blur-md dark:text-gray-300">
      配置后，登录用户在面板右上角会看到客服悬浮按钮，点击即可查看这里的联系方式。
      <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">
        所有字段留空表示不展示该项；关闭开关后用户端入口整体隐藏。
      </span>
    </div>

    <div v-if="loading" class="py-8 text-center text-gray-500">
      <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
    </div>

    <template v-else>
      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
        <BaseSwitch v-model="supportConfig.enabled" label="向用户展示联系客服入口" />
      </div>

      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
        <p class="mb-3 text-sm text-gray-700 font-medium dark:text-gray-300">
          标题文字（留空则用默认值）
        </p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BaseInput
            v-model="supportConfig.title"
            label="弹窗标题"
            type="text"
            placeholder="联系客服"
          />
          <BaseInput
            v-model="supportConfig.fabTitle"
            label="入口文字"
            type="text"
            placeholder="联系客服"
          />
          <BaseInput
            v-model="supportConfig.subtitle"
            label="弹窗副标题"
            type="text"
            placeholder="点击即可复制联系方式"
          />
          <BaseInput
            v-model="supportConfig.qrcodeHint"
            label="扫码提示文字"
            type="text"
            placeholder="扫码添加微信客服"
          />
          <BaseInput
            v-model="supportConfig.qqTitle"
            label="客服 QQ 行标题"
            type="text"
            placeholder="客服 QQ"
          />
          <BaseInput
            v-model="supportConfig.wechatTitle"
            label="客服微信行标题"
            type="text"
            placeholder="客服微信"
          />
          <BaseInput
            v-model="supportConfig.groupTitle"
            label="QQ 群行标题"
            type="text"
            placeholder="QQ 群号"
          />
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          「QQ 群行标题」同时用于群号和加群链接（两者合并为一行展示）。
        </p>
      </div>

      <div class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
        <p class="mb-3 text-sm text-gray-700 font-medium dark:text-gray-300">
          联系方式内容
        </p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BaseInput
            v-model="supportConfig.qq"
            label="客服 QQ"
            type="text"
            placeholder="留空则不展示"
          />
          <BaseInput
            v-model="supportConfig.wechat"
            label="客服微信"
            type="text"
            placeholder="留空则不展示"
          />
          <BaseInput
            v-model="supportConfig.group"
            label="QQ 群号"
            type="text"
            placeholder="留空则不展示"
          />
          <BaseInput
            v-model="supportConfig.groupLink"
            label="加群链接"
            type="text"
            placeholder="https://qm.qq.com/q/..."
          />
          <BaseInput
            v-model="supportConfig.qrcodeUrl"
            label="微信二维码图片地址"
            type="text"
            placeholder="https://... 或 /uploads/xxx.png"
          />
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          群号与加群链接合并为一行：只填群号可复制，只填链接显示「点击打开」，两者都填则同时展示。
        </p>
      </div>

      <div v-if="supportConfig.qrcodeUrl" class="border border-[var(--theme-border)] rounded-2xl bg-[var(--theme-glass)] p-4 backdrop-blur-md">
        <p class="mb-2 text-sm text-gray-700 font-medium dark:text-gray-300">
          微信二维码预览
        </p>
        <img
          :src="supportConfig.qrcodeUrl"
          alt="客服二维码"
          class="max-h-52 border border-[var(--theme-border)] rounded-lg object-contain"
        >
      </div>
    </template>

    <ConfirmModal
      :show="showSaveConfirm"
      title="保存联系客服配置"
      message="保存后所有登录用户将看到该客服入口（按上述内容），确定继续吗？"
      type="primary"
      confirm-text="保存"
      confirmation-code="UPDATE_SUPPORT_CONFIG"
      :loading="saving"
      @confirm="saveSupportConfig"
      @cancel="showSaveConfirm = false"
      @close="showSaveConfirm = false"
    />
  </div>
</template>
