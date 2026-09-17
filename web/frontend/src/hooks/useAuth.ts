import { useAuthStore } from '@/stores/auth'
import { api } from '@/api/client'
import { useNavigate } from 'react-router'

/** Auth hook — provides user info + login/logout actions. */
export function useAuth() {
  const store = useAuthStore()
  const navigate = useNavigate()

  const logout = async () => {
    try {
      await api.post('/auth/logout')
    } catch {
      // Ignore — we'll clear local state regardless
    }
    store.logout()
    navigate('/login')
  }

  return {
    user: store.user,
    role: store.role,
    perms: store.perms,
    isLoggedIn: store.isLoggedIn,
    // "*" (super role) grants every permission
    hasPerm: (perm: string) => store.perms.has('*') || store.perms.has(perm),
    hasAnyPerm: (perms: string[]) =>
      store.perms.has('*') || perms.some((p) => store.perms.has(p)),
    logout,
  }
}
