import { computed, ref } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'
import { writeToClipboard } from '@/utils/clipboard'

/**
 * 联系客服：后台「后台 → 客服」配置后，桌面端在侧边栏「账号续费」下方展示入口，
 * 移动端在底部导航栏展示入口。未启用或未配置任何联系方式时整体隐藏。
 *
 * 状态提到模块级单例，各入口与弹窗共用同一份配置和弹窗实例，避免重复拉取接口。
 */
export interface SupportConfig {
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

const config = ref<SupportConfig | null>(null)
const show = ref(false)
const previewQrcode = ref(false)
let loadPromise: Promise<void> | null = null

const title = computed(() => config.value?.title || '联系客服')
const fabTitle = computed(() => config.value?.fabTitle || '联系客服')
const subtitle = computed(() => config.value?.subtitle || '点击即可复制联系方式')
const qrcodeHint = computed(() => config.value?.qrcodeHint || '扫码添加微信客服')
const qqTitle = computed(() => config.value?.qqTitle || '客服 QQ')
const wechatTitle = computed(() => config.value?.wechatTitle || '客服微信')
const groupTitle = computed(() => config.value?.groupTitle || 'QQ 群号')

/** 群链接只允许 http(s)，避免配置成 javascript: 之类的伪协议 */
const safeGroupLink = computed(() => {
  const link = String(config.value?.groupLink || '').trim()
  return /^https?:\/\//i.test(link) ? link : ''
})

/** 二维码图片地址：http(s) 或站内相对路径；其余（如 javascript:）一律丢弃 */
const safeQrcodeUrl = computed(() => {
  const url = String(config.value?.qrcodeUrl || '').trim()
  if (!url)
    return ''
  if (/^https?:\/\//i.test(url))
    return url
  // 站内相对路径：以单个 / 开头，排除 //evil.com 这类协议相对地址
  if (/^\/(?!\/)/.test(url))
    return url
  return ''
})

/**
 * 客服 QQ 会话链接：由 QQ 号自动拼接腾讯官方链接。
 * 仅纯数字且长度合理的 QQ 号才生成，移动端优先唤起 QQ 客户端。
 */
const qqChatLink = computed(() => {
  const qq = String(config.value?.qq || '').trim()
  if (!/^\d{5,12}$/.test(qq))
    return ''
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  return isMobile
    ? `mqqwpa://im/chat?chat_type=wpa&uin=${qq}&version=1&src_type=web`
    : `https://wpa.qq.com/msgrd?v=3&uin=${qq}&site=qq&menu=yes`
})

/**
 * 至少有一项可展示的联系方式才显示入口。
 * 这里按「过滤后实际会渲染的内容」判断，避免只配了非法地址时弹出空窗口。
 */
const hasAnyContact = computed(() => {
  const cfg = config.value
  if (!cfg)
    return false
  return !!(cfg.qq || cfg.wechat || cfg.group || safeGroupLink.value || safeQrcodeUrl.value)
})

const visible = computed(() => !!config.value?.enabled && hasAnyContact.value)

async function load() {
  if (loadPromise)
    return loadPromise
  loadPromise = (async () => {
    try {
      const res = await api.get('/api/support-config', { skipErrorToast: true } as any)
      if (!res.data?.ok)
        return
      const data = res.data.data || {}
      config.value = {
        enabled: data.enabled === true,
        title: String(data.title || '').trim(),
        fabTitle: String(data.fabTitle || '').trim(),
        subtitle: String(data.subtitle || '').trim(),
        qrcodeHint: String(data.qrcodeHint || '').trim(),
        qqTitle: String(data.qqTitle || '').trim(),
        wechatTitle: String(data.wechatTitle || '').trim(),
        groupTitle: String(data.groupTitle || '').trim(),
        qq: String(data.qq || '').trim(),
        wechat: String(data.wechat || '').trim(),
        qrcodeUrl: String(data.qrcodeUrl || '').trim(),
        group: String(data.group || '').trim(),
        groupLink: String(data.groupLink || '').trim(),
      }
    }
    catch {
      // 客服配置不可用时静默忽略，不打扰用户；
      // 清掉缓存的 Promise，让下次挂载能重试，避免一次网络抖动就永久隐藏入口
      loadPromise = null
    }
  })()
  return loadPromise
}

async function copy(text: string, label: string) {
  if (!text)
    return
  const toast = useToastStore()
  try {
    await writeToClipboard(text)
    toast.success(`${label}已复制`)
  }
  catch {
    toast.error('复制失败，请手动选择复制')
  }
}

function open() {
  if (visible.value)
    show.value = true
}

function close() {
  show.value = false
  previewQrcode.value = false
}

export function useSupportContact() {
  return {
    config,
    show,
    previewQrcode,
    title,
    fabTitle,
    subtitle,
    qrcodeHint,
    qqTitle,
    wechatTitle,
    groupTitle,
    safeGroupLink,
    safeQrcodeUrl,
    qqChatLink,
    hasAnyContact,
    visible,
    load,
    copy,
    open,
    close,
  }
}
