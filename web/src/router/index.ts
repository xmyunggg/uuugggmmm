import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { menuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

const adminToken = useStorage('admin_token', '')
let validatedToken = ''
let validatingPromise: Promise<boolean> | null = null

async function ensureTokenValid() {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return false

  if (validatedToken && validatedToken === token)
    return true

  if (validatingPromise)
    return validatingPromise

  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res) => {
    const ok = !!(res.data && res.data.ok)
    if (ok) {
      validatedToken = token
      const userStore = useUserStore()
      userStore.fetchUserInfo().catch(() => {})
    }
    return ok
  }).catch(() => false).finally(() => {
    validatingPromise = null
  })

  return validatingPromise
}

async function ensureUserInfo() {
  const userStore = useUserStore()
  if (!userStore.userInfo)
    await userStore.fetchUserInfo().catch(() => {})
  return userStore.userInfo
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: menuRoutes.map(route => ({
        path: route.path,
        name: route.name,
        component: route.component,
        meta: {
          ...route.meta,
          adminOnly: route.adminOnly === true,
          agentOnly: route.agentOnly === true,
        },
      })),
    },
    {
      path: '/mystery-shop',
      name: 'mystery-shop',
      redirect: to => ({ name: 'game-mall', query: { ...to.query, tab: 'mystery' }, hash: to.hash }),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
    {
      path: '/force-password-change',
      name: 'force-password-change',
      component: () => import('@/views/ForcePasswordChange.vue'),
    },
    {
      path: '/renewal',
      name: 'renewal',
      component: () => import('@/views/Renewal.vue'),
    },
  ],
})

router.beforeEach(async (to, _from) => {
  NProgress.start()

  if (to.name === 'renewal') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const valid = await ensureTokenValid()
    if (!valid) {
      adminToken.value = ''
      validatedToken = ''
    }
    return true
  }

  if (to.name === 'login') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const valid = await ensureTokenValid()
    if (valid)
      return { name: 'dashboard' }
    adminToken.value = ''
    validatedToken = ''
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    return { name: 'login' }
  }

  const valid = await ensureTokenValid()
  if (!valid) {
    adminToken.value = ''
    validatedToken = ''
    return { name: 'login' }
  }

  // 默认密码未改时，后端会拒绝除改密外的所有接口，必须先把用户带到改密页
  const info = await ensureUserInfo()
  if (info?.mustChangePassword) {
    return to.name === 'force-password-change' ? true : { name: 'force-password-change' }
  }
  if (to.name === 'force-password-change')
    return { name: 'dashboard' }

  if (to.meta.agentOnly) {
    const info = await ensureUserInfo()
    if (info?.role !== 'agent')
      return { name: 'dashboard' }
    return true
  }

  if (to.meta.adminOnly) {
    const info = await ensureUserInfo()
    const role = info?.role
    if (role !== 'admin' && role !== 'super_admin')
      return { name: 'dashboard' }
  }

  // 代理账号只能进入代理中心，其余农场/后台页面一律重定向
  if (!to.meta.agentOnly) {
    const info = await ensureUserInfo()
    if (info?.role === 'agent')
      return { name: 'agent-center' }
  }

  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
