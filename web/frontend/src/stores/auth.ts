import { create } from 'zustand'

interface AuthState {
  user: string | null
  role: string
  perms: Set<string>
  isLoggedIn: boolean
  login: (user: string, role: string, perms: string[]) => void
  logout: () => void
  hydrate: () => void
}

/**
 * Persist auth UI state for instant re-hydration.
 * localStorage: survives tab close / browser restart (the real auth is still
 * the httpOnly session cookie — this only caches user/role/perms for render).
 */
const STORAGE_KEY = 'sseinfra_auth'

function saveToStorage(state: { user: string | null; role: string; perms: string[]; isLoggedIn: boolean }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
}

function loadFromStorage(): { user: string | null; role: string; perms: string[]; isLoggedIn: boolean } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  role: '',
  perms: new Set(),
  isLoggedIn: false,
  login: (user, role, perms) => {
    const state = { user, role, perms, isLoggedIn: true }
    saveToStorage(state)
    set({ user, role, perms: new Set(perms), isLoggedIn: true })
  },
  logout: () => {
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* */ }
    set({ user: null, role: '', perms: new Set(), isLoggedIn: false })
  },
  /** Re-hydrate from sessionStorage on app boot. */
  hydrate: () => {
    const saved = loadFromStorage()
    if (saved && saved.isLoggedIn) {
      set({ user: saved.user, role: saved.role, perms: new Set(saved.perms), isLoggedIn: true })
    }
  },
}))
