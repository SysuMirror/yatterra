import { create } from 'zustand'
export interface AuthProfile { userId: string | null; username: string | null; displayName: string | null; avatarUrl: string | null; displaySource: string | null }
interface AuthState extends AuthProfile { user: string | null; role: string; perms: Set<string>; isLoggedIn: boolean; login: (user: string | null, role: string, perms: string[], profile?: Partial<AuthProfile>) => void; logout: () => void; hydrate: () => void }
const STORAGE_KEY = 'sseinfra_auth'
type Stored = Partial<AuthProfile> & { user?: string | null; role: string; perms: string[]; isLoggedIn: boolean }
const save = (v: Stored) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch {} }
const load = (): Stored | null => { try { const v = localStorage.getItem(STORAGE_KEY); return v ? JSON.parse(v) : null } catch { return null } }
export const useAuthStore = create<AuthState>((set) => ({
  user: null, userId: null, username: null, displayName: null, avatarUrl: null, displaySource: null, role: '', perms: new Set(), isLoggedIn: false,
  login: (user, role, perms, profile = {}) => { const username = profile.username ?? user; const v = { user: username, userId: profile.userId ?? null, username, displayName: profile.displayName ?? username, avatarUrl: profile.avatarUrl ?? null, displaySource: profile.displaySource ?? null, role, perms, isLoggedIn: true }; save(v); set({ ...v, perms: new Set(perms) }) },
  logout: () => { try { localStorage.removeItem(STORAGE_KEY) } catch {}; set({ user: null, userId: null, username: null, displayName: null, avatarUrl: null, displaySource: null, role: '', perms: new Set(), isLoggedIn: false }) },
  hydrate: () => { const v = load(); if (v?.isLoggedIn) set({ user: v.user ?? v.username ?? null, userId: v.userId ?? null, username: v.username ?? v.user ?? null, displayName: v.displayName ?? v.username ?? v.user ?? null, avatarUrl: v.avatarUrl ?? null, displaySource: v.displaySource ?? null, role: v.role ?? '', perms: new Set(v.perms || []), isLoggedIn: true }) },
}))
