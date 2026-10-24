import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export interface UserCard {
  code: string
  description: string
  days: number
  durationValue?: number
  durationUnit?: 'hour' | 'day'
  durationMs?: number | null
  isPermanent?: boolean
  expiresAt: number | null
  enabled: boolean
}

export type UserRole = 'admin' | 'super_admin' | 'user' | 'agent'

export interface AgentSpec {
  id: string
  name: string
  type: 'time' | 'quota'
  description?: string
  enabled: boolean
  createdAt: number
  durationValue?: number
  durationUnit?: 'hour' | 'day'
  isPermanent?: boolean
  accountLimit?: number
  value?: number
  /** 生成 1 张卡扣除的代理余额，0 表示免费 */
  price: number
}

export interface AgentInfo {
  username: string
  enabled: boolean
  note: string
  quotaTotal: number
  quotaDaily: number
  usedTotal: number
  usedDaily: number
  remainingTotal: number
  remainingDaily: number
  specIds: string[] | null
  /** 代理余额 */
  balance: number
  createdAt: number
  specs?: AgentSpec[]
}

export interface AgentRechargeCard {
  code: string
  amount: number
  description?: string
  enabled: boolean
  usedBy: string | null
  usedAt: number | null
  createdAt: number
  createdBy?: string | null
}

export interface AdminInfo {
  username: string
  role: UserRole
  card: UserCard | null
  accountLimit: number
  avatar?: string
  mustChangePassword?: boolean
  agent?: AgentInfo | null
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials'
  remainingMs?: number
  data?: {
    token: string
    role: UserRole
    card: UserCard | null
    accountLimit: number
    user: { username: string }
    mustChangePassword?: boolean
  }
}

export interface Card {
  code: string
  description: string
  days: number
  value?: number
  accountLimit?: number
  durationValue?: number
  durationUnit?: 'hour' | 'day'
  durationMs?: number | null
  isPermanent?: boolean
  type: 'time' | 'quota'
  enabled: boolean
  usedBy: string | null
  usedAt: number | null
  createdAt: number
}

function formatNumber(value: number) {
  if (Number.isInteger(value))
    return String(value)
  return Number(value.toFixed(2)).toString()
}

function formatDurationMs(durationMs: number) {
  const totalHours = Math.round(durationMs / 3600000)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0 && hours > 0)
    return `${days}天${hours}小时`
  if (days > 0)
    return `${days}天`
  if (hours > 0)
    return `${hours}小时`
  return '未激活'
}

export function getCardQuotaValue(card: Partial<Card> | Partial<UserCard> | null | undefined) {
  return Number((card as Partial<Card>)?.value ?? card?.days ?? 0)
}

export function formatTimeDuration(card: Partial<Card> | Partial<UserCard> | null | undefined) {
  if (!card)
    return '无'
  if (card.isPermanent === true || card.days === -1 || card.durationValue === -1)
    return '永久'
  const durationMs = Number(card.durationMs)
  if (Number.isFinite(durationMs) && durationMs > 0)
    return formatDurationMs(durationMs)
  const durationValue = Number(card.durationValue)
  const durationUnit = card.durationUnit === 'hour' ? 'hour' : 'day'
  if (Number.isFinite(durationValue) && durationValue > 0)
    return `${formatNumber(durationValue)}${durationUnit === 'hour' ? '小时' : '天'}`
  const days = Number(card.days)
  if (Number.isFinite(days) && days > 0)
    return `${formatNumber(days)}天`
  return '未激活'
}

export function formatCardValue(card: Card) {
  if (card.type === 'quota')
    return `+${formatNumber(getCardQuotaValue(card))}额度`
  const durationText = formatTimeDuration(card)
  const limit = Number(card.accountLimit)
  if (Number.isFinite(limit) && limit > 0)
    return `${durationText} / 额度${limit}个`
  return durationText
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  // 默认值是 null 时 vueuse 会挑到 any 序列化器（write = String(v)），对象会被存成 "[object Object]"，
  // 于是刷新/重新整页进入 /admin 时守卫读到没有 role 的脏缓存，直接跳回首页。这里显式用 JSON 并容忍旧脏值。
  const userInfo = useStorage<AdminInfo | null>('user_info', null, undefined, {
    serializer: {
      read: (value: string) => {
        try {
          return JSON.parse(value)
        }
        catch {
          return null
        }
      },
      write: (value: AdminInfo | null) => JSON.stringify(value),
    },
  })
  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => userInfo.value?.role === 'admin' || userInfo.value?.role === 'super_admin')
  const isSuperAdmin = computed(() => userInfo.value?.role === 'super_admin')
  const isAgent = computed(() => userInfo.value?.role === 'agent')
  const agentInfo = computed(() => userInfo.value?.agent || null)
  const username = computed(() => userInfo.value?.username || '')
  const userCard = computed(() => userInfo.value?.card)
  const accountLimit = computed(() => userInfo.value?.accountLimit ?? 2)
  const avatar = computed(() => userInfo.value?.avatar || '')
  const roleLabel = computed(() => {
    if (userInfo.value?.role === 'super_admin')
      return '超级管理员'
    if (userInfo.value?.role === 'admin')
      return '管理员'
    if (userInfo.value?.role === 'agent')
      return '代理'
    return '用户'
  })

  // 检查用户是否过期
  const isExpired = computed(() => {
    if (!userInfo.value?.card?.expiresAt)
      return false
    return Date.now() > userInfo.value.card.expiresAt
  })

  // 获取过期时间显示
  const expireTimeText = computed(() => {
    if (!userInfo.value?.card)
      return '无卡密'
    if (userInfo.value.card.isPermanent === true || userInfo.value.card.days === -1)
      return '永久有效'
    if (!userInfo.value.card.expiresAt)
      return '未激活'
    const date = new Date(userInfo.value.card.expiresAt)
    return date.toLocaleString('zh-CN')
  })

  async function login(username: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username, password })
      if (res.data.ok) {
        token.value = res.data.data.token
        userInfo.value = {
          username: res.data.data.user.username,
          role: res.data.data.role,
          card: res.data.data.card ?? null,
          accountLimit: res.data.data.accountLimit ?? 2,
          mustChangePassword: res.data.data.mustChangePassword,
          agent: res.data.data.agent ?? null,
        }
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function register(username: string, password: string, cardCode: string) {
    const res = await api.post('/api/register', { username, password, cardCode })
    return res.data
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok)
        userInfo.value = res.data.data
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function renew(cardCode: string) {
    const res = await api.post('/api/user/renew', { cardCode })
    if (res.data.ok && userInfo.value) {
      userInfo.value.card = res.data.data.card
      userInfo.value.accountLimit = res.data.data.accountLimit
    }
    return res.data
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    return res.data
  }

  async function verifyResetPassword(username: string, cardCode: string) {
    const res = await api.post('/api/public/reset-password/verify', { username, cardCode })
    return res.data
  }

  async function resetPassword(username: string, cardCode: string, newPassword: string) {
    const res = await api.post('/api/public/reset-password/confirm', { username, cardCode, newPassword })
    return res.data
  }

  // 管理员功能
  async function getAllUsers() {
    const res = await api.get('/api/admin/users')
    return res.data
  }

  async function getLoginLogs(limit = 100, offset = 0) {
    const res = await api.get('/api/admin/login-logs', { params: { limit, offset } })
    return res.data
  }

  async function clearLoginLogs(payload?: { confirmed?: boolean }) {
    const res = await api.delete('/api/admin/login-logs', { data: payload })
    return res.data
  }

  async function clearExpiredUsers(payload?: { confirmed?: boolean }) {
    const res = await api.post('/api/admin/users/clear-expired', payload)
    return res.data
  }

  async function updateUser(username: string, updates: Partial<UserCard>, payload?: { confirmed?: boolean }) {
    const res = await api.post(`/api/admin/users/${username}`, { ...updates, ...payload })
    return res.data
  }

  async function deleteUser(username: string, payload?: { confirmed?: boolean }) {
    const res = await api.delete(`/api/admin/users/${username}`, { data: payload })
    return res.data
  }

  async function renewUser(username: string, cardCode: string, payload?: { confirmed?: boolean }) {
    const res = await api.post(`/api/admin/users/${username}/renew`, { cardCode, ...payload })
    return res.data
  }

  async function getAllCards() {
    const res = await api.get('/api/admin/cards')
    return res.data
  }

  async function createCard(
    description: string,
    days: number,
    count?: number,
    type?: 'time' | 'quota',
    payload?: {
      confirmed?: boolean
      durationValue?: number
      durationUnit?: 'hour' | 'day'
      value?: number
      accountLimit?: number
    },
  ) {
    const res = await api.post('/api/admin/cards', { description, days, count, type, ...payload })
    return res.data
  }

  async function updateCard(code: string, updates: Partial<Card>, payload?: { confirmed?: boolean }) {
    const res = await api.post(`/api/admin/cards/${code}`, { ...updates, ...payload })
    return res.data
  }

  async function deleteCard(code: string, payload?: { confirmed?: boolean }) {
    const res = await api.delete(`/api/admin/cards/${code}`, { data: payload })
    return res.data
  }

  async function deleteCardsBatch(codes: string[], payload?: { confirmed?: boolean }) {
    const res = await api.post('/api/admin/cards/batch-delete', { codes, ...payload })
    return res.data
  }

  /** 清空已使用卡密（usedBy 有值的）。 */
  async function clearUsedCards(payload?: { confirmed?: boolean }) {
    const res = await api.post('/api/admin/cards/clear-used', { ...payload })
    return res.data
  }

  /** 清空全部卡密，需要带上确认短语。 */
  async function clearAllCards(payload?: { confirmed?: boolean, confirmText?: string }) {
    const res = await api.post('/api/admin/cards/clear-all', { ...payload })
    return res.data
  }

  // ---- 代理管理（管理员）----
  async function getAllAgents() {
    const res = await api.get('/api/admin/agents')
    return res.data
  }

  async function createAgent(payload: Record<string, any>) {
    const res = await api.post('/api/admin/agents', { ...payload, confirmed: true })
    return res.data
  }

  async function editAgent(username: string, payload: Record<string, any>) {
    const res = await api.post(`/api/admin/agents/${username}/edit`, { ...payload, confirmed: true })
    return res.data
  }

  async function deleteAgent(username: string) {
    const res = await api.delete(`/api/admin/agents/${username}`, { data: { confirmed: true } })
    return res.data
  }

  async function getAgentStats(username: string) {
    const res = await api.get(`/api/admin/agents/${username}/stats`)
    return res.data
  }

  async function getAgentCards(username: string) {
    const res = await api.get(`/api/admin/agents/${username}/cards`)
    return res.data
  }

  async function getAgentCustomers(username: string) {
    const res = await api.get(`/api/admin/agents/${username}/customers`)
    return res.data
  }

  async function getAllAgentSpecs() {
    const res = await api.get('/api/admin/agent-specs')
    return res.data
  }

  async function createAgentSpec(payload: Record<string, any>) {
    const res = await api.post('/api/admin/agent-specs', { ...payload, confirmed: true })
    return res.data
  }

  async function updateAgentSpec(id: string, payload: Record<string, any>) {
    const res = await api.post(`/api/admin/agent-specs/${id}`, { ...payload, confirmed: true })
    return res.data
  }

  async function deleteAgentSpec(id: string) {
    const res = await api.delete(`/api/admin/agent-specs/${id}`, { data: { confirmed: true } })
    return res.data
  }

  // ---- 代理充值卡（管理员）----
  async function getAllAgentRechargeCards() {
    const res = await api.get('/api/admin/agent-recharge-cards')
    return res.data
  }

  async function createAgentRechargeCards(payload: Record<string, any>) {
    const res = await api.post('/api/admin/agent-recharge-cards', { ...payload, confirmed: true })
    return res.data
  }

  async function deleteAgentRechargeCard(code: string) {
    const res = await api.delete(`/api/admin/agent-recharge-cards/${code}`, { data: { confirmed: true } })
    return res.data
  }

  // ---- 代理自助 ----
  async function fetchAgentMe() {
    const res = await api.get('/api/agent/me')
    if (res.data.ok && userInfo.value)
      userInfo.value.agent = res.data.data
    return res.data
  }

  async function fetchAgentStats() {
    const res = await api.get('/api/agent/stats')
    return res.data
  }

  async function fetchMyAgentCards() {
    const res = await api.get('/api/agent/cards')
    return res.data
  }

  async function fetchMyAgentCustomers() {
    const res = await api.get('/api/agent/customers')
    return res.data
  }

  async function generateAgentCards(specId: string, count: number, description?: string) {
    const res = await api.post('/api/agent/cards', { specId, count, description })
    if (res.data.ok && res.data.data?.agent && userInfo.value)
      userInfo.value.agent = res.data.data.agent
    return res.data
  }

  async function redeemAgentRechargeCard(code: string) {
    const res = await api.post('/api/agent/recharge', { code })
    if (res.data.ok && res.data.data?.agent && userInfo.value)
      userInfo.value.agent = res.data.data.agent
    return res.data
  }

  async function fetchAgentRechargeRecords() {
    const res = await api.get('/api/agent/recharge-records')
    return res.data
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    isAdmin,
    isSuperAdmin,
    isAgent,
    agentInfo,
    username,
    userCard,
    accountLimit,
    avatar,
    roleLabel,
    isExpired,
    expireTimeText,
    login,
    register,
    logout,
    fetchUserInfo,
    renew,
    changePassword,
    verifyResetPassword,
    resetPassword,
    getAllUsers,
    getLoginLogs,
    clearLoginLogs,
    clearExpiredUsers,
    updateUser,
    deleteUser,
    renewUser,
    getAllCards,
    createCard,
    updateCard,
    deleteCard,
    deleteCardsBatch,
    clearUsedCards,
    clearAllCards,
    getAllAgents,
    createAgent,
    editAgent,
    deleteAgent,
    getAgentStats,
    getAgentCards,
    getAgentCustomers,
    getAllAgentSpecs,
    createAgentSpec,
    updateAgentSpec,
    deleteAgentSpec,
    getAllAgentRechargeCards,
    createAgentRechargeCards,
    deleteAgentRechargeCard,
    fetchAgentMe,
    fetchAgentStats,
    fetchMyAgentCards,
    fetchMyAgentCustomers,
    generateAgentCards,
    redeemAgentRechargeCard,
    fetchAgentRechargeRecords,
  }
})
