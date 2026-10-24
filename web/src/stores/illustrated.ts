import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export const useIllustratedStore = defineStore('illustrated', () => {
  const data = ref<any>(null)
  const loading = ref(false)
  const buying = ref(false)
  const error = ref('')
  let requestId = 0

  async function fetch(accountId: string) {
    if (!accountId)
      return false
    const id = ++requestId
    loading.value = true
    error.value = ''
    try {
      const response = await api.get('/api/illustrated', {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (id !== requestId)
        return false
      if (!response.data?.ok) {
        error.value = getApiErrorMessage(response.data, '无法读取图鉴数据')
        return false
      }
      data.value = response.data.data || null
      return true
    }
    catch (cause: any) {
      if (id !== requestId)
        return false
      error.value = getApiErrorMessage(cause, '无法读取图鉴数据')
      return false
    }
    finally {
      if (id === requestId)
        loading.value = false
    }
  }

  function reset() {
    requestId++
    data.value = null
    loading.value = false
    buying.value = false
    error.value = ''
  }

  /** 购买单个未解锁图鉴条目对应的种子 */
  async function buySeed(accountId: string, goodsId: number, price: number) {
    if (!accountId)
      return null
    buying.value = true
    try {
      const response = await api.post('/api/illustrated/buy', { goodsId, price }, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      return response.data
    }
    finally {
      buying.value = false
    }
  }

  /** 一键购买该册图鉴中全部可购买的种子 */
  async function buyAllSeeds(accountId: string, illustratedType: 1 | 2 = 1) {
    if (!accountId)
      return null
    buying.value = true
    try {
      const response = await api.post('/api/illustrated/buy-all', { illustrated_type: illustratedType }, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      return response.data
    }
    finally {
      buying.value = false
    }
  }

  return { data, loading, buying, error, fetch, reset, buySeed, buyAllSeeds }
})
