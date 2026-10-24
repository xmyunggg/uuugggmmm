import { computed, ref } from 'vue'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

export interface AdminAgent {
  username: string
  role: 'agent'
  enabled: boolean
  note: string
  quotaTotal: number
  quotaDaily: number
  usedTotal: number
  usedDaily: number
  remainingTotal: number
  remainingDaily: number
  specIds: string[] | null
  balance: number
  createdAt: number
}

export interface AgentSpecItem {
  id: string
  name: string
  type: 'time' | 'quota'
  description?: string
  enabled: boolean
  createdAt: number
  durationValue?: number
  durationUnit?: 'hour' | 'day'
  /** 旧版接口的兼容字段：以「天」为单位的时长 */
  days?: number
  isPermanent?: boolean
  accountLimit?: number
  value?: number
  price: number
}

export interface AgentRechargeCardItem {
  code: string
  amount: number
  description?: string
  enabled: boolean
  usedBy: string | null
  usedAt: number | null
  createdAt: number
  createdBy?: string | null
}

export interface AgentForm {
  username: string
  password: string
  note: string
  unlimitedTotal: boolean
  quotaTotal: number
  unlimitedDaily: boolean
  quotaDaily: number
  specIds: string[]
  balance: number
  enabled: boolean
}

export interface AgentSpecForm {
  name: string
  type: 'time' | 'quota'
  durationValue: number
  durationUnit: 'hour' | 'day'
  isPermanent: boolean
  accountLimit: number
  value: number
  price: number
}

export interface AgentCustomer {
  username: string
  role: string
  accountLimit: number
  createdAt: number
  card: { expiresAt: number | null, enabled: boolean, days?: number, isPermanent?: boolean } | null
}

export interface AgentCardItem {
  code: string
  description?: string
  type: 'time' | 'quota'
  enabled: boolean
  usedBy: string | null
  usedAt: number | null
  createdAt: number
  days?: number
  value?: number
  durationValue?: number
  durationUnit?: 'hour' | 'day'
  isPermanent?: boolean
  accountLimit?: number
}

export function formatAgentSpec(spec: AgentSpecItem): string {
  if (spec.type === 'quota')
    return `额度 +${spec.value ?? spec.days ?? 0}`
  const duration = spec.isPermanent
    ? '永久'
    : `${spec.durationValue ?? spec.days ?? 0}${spec.durationUnit === 'hour' ? '小时' : '天'}`
  const limit = Number(spec.accountLimit)
  return Number.isFinite(limit) && limit > 0 ? `${duration} · 额度${limit}` : duration
}

export function formatAgentPrice(price: number | undefined): string {
  const value = Number(price)
  if (!Number.isFinite(value) || value <= 0)
    return '免费'
  return `${value} 元/张`
}

function emptyAgentForm(): AgentForm {
  return {
    username: '',
    password: '',
    note: '',
    unlimitedTotal: true,
    quotaTotal: 0,
    unlimitedDaily: true,
    quotaDaily: 0,
    specIds: [],
    balance: 0,
    enabled: true,
  }
}

function emptySpecForm(): AgentSpecForm {
  return {
    name: '',
    type: 'time',
    durationValue: 7,
    durationUnit: 'day',
    isPermanent: false,
    accountLimit: 0,
    value: 2,
    price: 0,
  }
}

export function useAdminAgents() {
  const userStore = useUserStore()
  const toast = useToastStore()

  const agents = ref<AdminAgent[]>([])
  const specs = ref<AgentSpecItem[]>([])
  const loading = ref(false)
  const searchQuery = ref('')

  // 代理表单
  const showAgentModal = ref(false)
  const agentForm = ref<AgentForm>(emptyAgentForm())
  const editingAgent = ref<AdminAgent | null>(null)
  const savingAgent = ref(false)
  const showSaveConfirm = ref(false)

  // 代理启停/删除
  const showToggleConfirm = ref(false)
  const pendingToggle = ref<AdminAgent | null>(null)
  const toggleLoading = ref(false)
  const showDeleteConfirm = ref(false)
  const pendingDelete = ref<AdminAgent | null>(null)
  const deleteLoading = ref(false)

  // 代理卡密/客户
  const showCardsModal = ref(false)
  const cardsLoading = ref(false)
  const agentCards = ref<AgentCardItem[]>([])
  const cardsAgent = ref<AdminAgent | null>(null)
  const showCustomersModal = ref(false)
  const customersLoading = ref(false)
  const agentCustomers = ref<AgentCustomer[]>([])
  const customersAgent = ref<AdminAgent | null>(null)

  // 规格
  const showSpecModal = ref(false)
  const specForm = ref<AgentSpecForm>(emptySpecForm())
  const editingSpec = ref<AgentSpecItem | null>(null)
  const savingSpec = ref(false)
  const showSpecDeleteConfirm = ref(false)
  const pendingDeleteSpec = ref<AgentSpecItem | null>(null)
  const deletingSpec = ref(false)

  // 代理充值卡
  const rechargeCards = ref<AgentRechargeCardItem[]>([])
  const rechargeLoading = ref(false)
  const showRechargeModal = ref(false)
  const rechargeForm = ref({ amount: 100, count: 1, description: '' })
  const savingRecharge = ref(false)
  const rechargeGenerated = ref<string[]>([])
  const showRechargeDeleteConfirm = ref(false)
  const pendingDeleteRecharge = ref<AgentRechargeCardItem | null>(null)
  const deletingRecharge = ref(false)

  const filteredAgents = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query)
      return agents.value
    return agents.value.filter(agent => agent.username.toLowerCase().includes(query))
  })

  const enabledCount = computed(() => agents.value.filter(agent => agent.enabled).length)
  const totalIssued = computed(() => agents.value.reduce((sum, agent) => sum + agent.usedTotal, 0))

  async function fetchAgents() {
    loading.value = true
    try {
      const res = await userStore.getAllAgents()
      if (res.ok)
        agents.value = res.data
      else
        toast.error(res.error || '获取代理列表失败')
    }
    catch (e: any) {
      toast.error(e.message || '获取代理列表失败')
    }
    finally {
      loading.value = false
    }
  }

  async function fetchSpecs() {
    try {
      const res = await userStore.getAllAgentSpecs()
      if (res.ok)
        specs.value = res.data
      else
        toast.error(res.error || '获取发卡规格失败')
    }
    catch (e: any) {
      toast.error(e.message || '获取发卡规格失败')
    }
  }

  async function fetchRechargeCards() {
    rechargeLoading.value = true
    try {
      const res = await userStore.getAllAgentRechargeCards()
      if (res.ok)
        rechargeCards.value = res.data
      else
        toast.error(res.error || '获取充值卡失败')
    }
    catch (e: any) {
      toast.error(e.message || '获取充值卡失败')
    }
    finally {
      rechargeLoading.value = false
    }
  }

  function openRechargeModal() {
    rechargeForm.value = { amount: 100, count: 1, description: '' }
    rechargeGenerated.value = []
    showRechargeModal.value = true
  }

  async function saveRechargeCards() {
    const form = rechargeForm.value
    const amount = Math.max(0, Number(form.amount) || 0)
    if (amount <= 0) {
      toast.warning('请填写大于 0 的充值面额')
      return
    }
    const count = Math.max(1, Math.min(200, Math.floor(Number(form.count) || 1)))
    savingRecharge.value = true
    try {
      const res = await userStore.createAgentRechargeCards({
        amount,
        count,
        description: form.description.trim() || undefined,
      })
      if (res.ok) {
        rechargeGenerated.value = (res.data.cards || []).map((card: AgentRechargeCardItem) => card.code)
        toast.success(`已生成 ${rechargeGenerated.value.length} 张 ${amount} 元充值卡`)
        await fetchRechargeCards()
      }
      else {
        toast.error(res.error || '生成充值卡失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '生成充值卡失败')
    }
    finally {
      savingRecharge.value = false
    }
  }

  function requestDeleteRechargeCard(card: AgentRechargeCardItem) {
    pendingDeleteRecharge.value = card
    showRechargeDeleteConfirm.value = true
  }

  async function confirmDeleteRechargeCard() {
    if (!pendingDeleteRecharge.value)
      return
    deletingRecharge.value = true
    try {
      const res = await userStore.deleteAgentRechargeCard(pendingDeleteRecharge.value.code)
      if (res.ok) {
        toast.success('充值卡已删除')
        showRechargeDeleteConfirm.value = false
        pendingDeleteRecharge.value = null
        await fetchRechargeCards()
      }
      else {
        toast.error(res.error || '删除失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '删除失败')
    }
    finally {
      deletingRecharge.value = false
    }
  }

  function openCreateAgent() {
    editingAgent.value = null
    agentForm.value = emptyAgentForm()
    showAgentModal.value = true
  }

  function openEditAgent(agent: AdminAgent) {
    editingAgent.value = agent
    agentForm.value = {
      username: agent.username,
      password: '',
      note: agent.note || '',
      unlimitedTotal: agent.quotaTotal < 0,
      quotaTotal: agent.quotaTotal < 0 ? 0 : agent.quotaTotal,
      unlimitedDaily: agent.quotaDaily < 0,
      quotaDaily: agent.quotaDaily < 0 ? 0 : agent.quotaDaily,
      specIds: Array.isArray(agent.specIds) ? [...agent.specIds] : [],
      balance: Number(agent.balance) || 0,
      enabled: agent.enabled,
    }
    showAgentModal.value = true
  }

  function requestSaveAgent() {
    const form = agentForm.value
    if (!editingAgent.value && !form.username.trim()) {
      toast.warning('请填写代理用户名')
      return
    }
    if (!editingAgent.value && !form.password) {
      toast.warning('请填写代理密码')
      return
    }
    showSaveConfirm.value = true
  }

  async function confirmSaveAgent() {
    const form = agentForm.value
    savingAgent.value = true
    try {
      const payload: Record<string, any> = {
        note: form.note,
        quotaTotal: form.unlimitedTotal ? -1 : Number(form.quotaTotal),
        quotaDaily: form.unlimitedDaily ? -1 : Number(form.quotaDaily),
        specIds: form.specIds,
        balance: Number(form.balance) || 0,
        enabled: form.enabled,
      }
      let res: any
      if (editingAgent.value) {
        if (form.password)
          payload.password = form.password
        if (form.username && form.username !== editingAgent.value.username)
          payload.newUsername = form.username
        res = await userStore.editAgent(editingAgent.value.username, payload)
      }
      else {
        payload.username = form.username.trim()
        payload.password = form.password
        res = await userStore.createAgent(payload)
      }

      if (res.ok) {
        toast.success(editingAgent.value ? '代理信息已更新' : '代理创建成功')
        showSaveConfirm.value = false
        showAgentModal.value = false
        editingAgent.value = null
        await fetchAgents()
      }
      else {
        toast.error(res.error || '保存失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '保存失败')
    }
    finally {
      savingAgent.value = false
    }
  }

  function requestToggleAgent(agent: AdminAgent) {
    pendingToggle.value = agent
    showToggleConfirm.value = true
  }

  async function confirmToggleAgent() {
    if (!pendingToggle.value)
      return
    toggleLoading.value = true
    try {
      const agent = pendingToggle.value
      const res = await userStore.editAgent(agent.username, { enabled: !agent.enabled })
      if (res.ok) {
        toast.success(agent.enabled ? '代理已停用' : '代理已启用')
        showToggleConfirm.value = false
        pendingToggle.value = null
        await fetchAgents()
      }
      else {
        toast.error(res.error || '操作失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '操作失败')
    }
    finally {
      toggleLoading.value = false
    }
  }

  function requestDeleteAgent(agent: AdminAgent) {
    pendingDelete.value = agent
    showDeleteConfirm.value = true
  }

  async function confirmDeleteAgent() {
    if (!pendingDelete.value)
      return
    deleteLoading.value = true
    try {
      const res = await userStore.deleteAgent(pendingDelete.value.username)
      if (res.ok) {
        toast.success('代理已删除')
        showDeleteConfirm.value = false
        pendingDelete.value = null
        await fetchAgents()
      }
      else {
        toast.error(res.error || '删除失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '删除失败')
    }
    finally {
      deleteLoading.value = false
    }
  }

  async function openAgentCards(agent: AdminAgent) {
    cardsAgent.value = agent
    showCardsModal.value = true
    cardsLoading.value = true
    try {
      const res = await userStore.getAgentCards(agent.username)
      agentCards.value = res.ok ? res.data : []
    }
    catch {
      agentCards.value = []
    }
    finally {
      cardsLoading.value = false
    }
  }

  async function openAgentCustomers(agent: AdminAgent) {
    customersAgent.value = agent
    showCustomersModal.value = true
    customersLoading.value = true
    try {
      const res = await userStore.getAgentCustomers(agent.username)
      agentCustomers.value = res.ok ? res.data : []
    }
    catch {
      agentCustomers.value = []
    }
    finally {
      customersLoading.value = false
    }
  }

  // ---- 规格 ----
  function openSpecModal() {
    editingSpec.value = null
    specForm.value = emptySpecForm()
    showSpecModal.value = true
  }

  function openEditSpec(spec: AgentSpecItem) {
    editingSpec.value = spec
    specForm.value = {
      name: spec.name,
      type: spec.type,
      durationValue: spec.isPermanent ? 7 : (Number(spec.durationValue) > 0 ? Number(spec.durationValue) : 7),
      durationUnit: spec.durationUnit === 'hour' ? 'hour' : 'day',
      isPermanent: spec.isPermanent === true,
      accountLimit: Number(spec.accountLimit) > 0 ? Number(spec.accountLimit) : 0,
      value: Number(spec.value) > 0 ? Number(spec.value) : 2,
      price: Math.max(0, Number(spec.price) || 0),
    }
    showSpecModal.value = true
  }

  function requestSaveSpec() {
    const form = specForm.value
    if (!form.name.trim()) {
      toast.warning('请填写规格名称')
      return
    }
    saveSpec()
  }

  async function saveSpec() {
    const form = specForm.value
    savingSpec.value = true
    try {
      const payload: Record<string, any> = {
        name: form.name.trim(),
        type: form.type,
        price: Math.max(0, Number(form.price) || 0),
      }
      if (form.type === 'quota') {
        payload.value = Number(form.value)
      }
      else {
        payload.isPermanent = form.isPermanent
        payload.durationUnit = form.durationUnit
        payload.durationValue = form.isPermanent ? -1 : Number(form.durationValue)
        if (Number(form.accountLimit) > 0)
          payload.accountLimit = Number(form.accountLimit)
      }
      const res = editingSpec.value
        ? await userStore.updateAgentSpec(editingSpec.value.id, payload)
        : await userStore.createAgentSpec(payload)
      if (res.ok) {
        toast.success(editingSpec.value ? '规格已更新' : '规格已创建')
        showSpecModal.value = false
        editingSpec.value = null
        await fetchSpecs()
      }
      else {
        toast.error(res.error || (editingSpec.value ? '更新规格失败' : '创建规格失败'))
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '保存规格失败')
    }
    finally {
      savingSpec.value = false
    }
  }

  async function toggleSpec(spec: AgentSpecItem) {
    try {
      const res = await userStore.updateAgentSpec(spec.id, { enabled: !spec.enabled })
      if (res.ok) {
        toast.success(spec.enabled ? '规格已停用' : '规格已启用')
        await fetchSpecs()
      }
      else {
        toast.error(res.error || '操作失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '操作失败')
    }
  }

  function requestDeleteSpec(spec: AgentSpecItem) {
    pendingDeleteSpec.value = spec
    showSpecDeleteConfirm.value = true
  }

  async function confirmDeleteSpec() {
    if (!pendingDeleteSpec.value)
      return
    deletingSpec.value = true
    try {
      const res = await userStore.deleteAgentSpec(pendingDeleteSpec.value.id)
      if (res.ok) {
        toast.success('规格已删除')
        showSpecDeleteConfirm.value = false
        pendingDeleteSpec.value = null
        await fetchSpecs()
      }
      else {
        toast.error(res.error || '删除失败')
      }
    }
    catch (e: any) {
      toast.error(e?.response?.data?.error || e.message || '删除失败')
    }
    finally {
      deletingSpec.value = false
    }
  }

  return {
    agents,
    specs,
    loading,
    searchQuery,
    filteredAgents,
    enabledCount,
    totalIssued,
    showAgentModal,
    agentForm,
    editingAgent,
    savingAgent,
    showSaveConfirm,
    showToggleConfirm,
    pendingToggle,
    toggleLoading,
    showDeleteConfirm,
    pendingDelete,
    deleteLoading,
    showCardsModal,
    cardsLoading,
    agentCards,
    cardsAgent,
    showCustomersModal,
    customersLoading,
    agentCustomers,
    customersAgent,
    showSpecModal,
    specForm,
    editingSpec,
    savingSpec,
    showSpecDeleteConfirm,
    pendingDeleteSpec,
    deletingSpec,
    rechargeCards,
    rechargeLoading,
    showRechargeModal,
    rechargeForm,
    savingRecharge,
    rechargeGenerated,
    showRechargeDeleteConfirm,
    pendingDeleteRecharge,
    deletingRecharge,
    fetchAgents,
    fetchSpecs,
    fetchRechargeCards,
    openCreateAgent,
    openEditAgent,
    requestSaveAgent,
    confirmSaveAgent,
    requestToggleAgent,
    confirmToggleAgent,
    requestDeleteAgent,
    confirmDeleteAgent,
    openAgentCards,
    openAgentCustomers,
    openSpecModal,
    openEditSpec,
    requestSaveSpec,
    saveSpec,
    toggleSpec,
    requestDeleteSpec,
    confirmDeleteSpec,
    openRechargeModal,
    saveRechargeCards,
    requestDeleteRechargeCard,
    confirmDeleteRechargeCard,
  }
}
