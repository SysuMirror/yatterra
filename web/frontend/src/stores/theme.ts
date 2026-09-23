import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  cycleMode: () => void
}

const STORAGE_KEY = 'yatterra_theme'
const modes: ThemeMode[] = ['system', 'light', 'dark']
const mediaQuery = () => window.matchMedia('(prefers-color-scheme: dark)')
const readMode = (): ThemeMode => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  } catch {
    return 'system'
  }
}
const resolveMode = (mode: ThemeMode): ResolvedTheme => {
  if (mode !== 'system') return mode
  return mediaQuery().matches ? 'dark' : 'light'
}

export const applyTheme = (mode: ThemeMode = readMode()) => {
  const resolved = resolveMode(mode)
  const root = document.documentElement
  root.dataset.themeMode = mode
  root.dataset.theme = resolved
  root.classList.toggle('theme-dark', resolved === 'dark')
  root.classList.toggle('theme-light', resolved === 'light')
  root.style.colorScheme = resolved
  return resolved
}

export const initTheme = () => {
  const mode = readMode()
  const resolved = applyTheme(mode)
  useThemeStore.setState({ mode, resolved })

  const onSystemChange = () => {
    const current = useThemeStore.getState().mode
    if (current !== 'system') return
    useThemeStore.setState({ resolved: applyTheme(current) })
  }

  const query = mediaQuery()
  query.addEventListener?.('change', onSystemChange)
  return () => query.removeEventListener?.('change', onSystemChange)
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: typeof window === 'undefined' ? 'system' : readMode(),
  resolved: typeof window === 'undefined' ? 'light' : applyTheme(readMode()),
  setMode: (mode) => {
    try { localStorage.setItem(STORAGE_KEY, mode) } catch {}
    set({ mode, resolved: applyTheme(mode) })
  },
  cycleMode: () => {
    const current = get().mode
    const next = modes[(modes.indexOf(current) + 1) % modes.length]!
    get().setMode(next)
  },
}))
