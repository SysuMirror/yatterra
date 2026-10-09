import { create } from 'zustand'

/**
 * IDE 编辑器/终端偏好(zustand + localStorage + CSS 变量,模式同 theme.ts)。
 *
 * 写入 document.documentElement 的 CSS 变量:
 *   --ide-fs        编辑器字号(px)
 *   --ide-tfs       终端字号(px)
 *   --ide-scale     UI 缩放(无单位,面板内容可 calc() 引用)
 * 面板组件内请用 var(--ide-fs) / var(--ide-tfs) 取字号,不要自己再存一份。
 */

const STORAGE_KEY = 'yatterra.ide.prefs'

export interface EditorPrefsState {
  /** 编辑器字号 px(手机默认 16,桌面默认 14) */
  editorFontSize: number
  /** 终端字号 px(手机默认 16,桌面默认 14) */
  terminalFontSize: number
  /** UI 缩放,0.8–1.4 */
  uiScale: number
  setEditorFontSize: (px: number) => void
  setTerminalFontSize: (px: number) => void
  setUiScale: (scale: number) => void
}

const MIN_FS = 10
const MAX_FS = 28
const clampFs = (px: number) => Math.min(MAX_FS, Math.max(MIN_FS, Math.round(px)))
const clampScale = (s: number) => Math.min(1.4, Math.max(0.8, Math.round(s * 100) / 100))

const isDesktop = () =>
  typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches

const defaultFs = () => (isDesktop() ? 14 : 16)

interface StoredPrefs {
  editorFontSize?: unknown
  terminalFontSize?: unknown
  uiScale?: unknown
}

const readPrefs = (): StoredPrefs => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoredPrefs) : {}
  } catch {
    return {}
  }
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** 把偏好刷到 :root 的 CSS 变量。 */
export const applyEditorPrefs = (prefs: Pick<EditorPrefsState, 'editorFontSize' | 'terminalFontSize' | 'uiScale'>) => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--ide-fs', `${clampFs(prefs.editorFontSize)}px`)
  root.style.setProperty('--ide-tfs', `${clampFs(prefs.terminalFontSize)}px`)
  root.style.setProperty('--ide-scale', String(clampScale(prefs.uiScale)))
}

const persist = (prefs: StoredPrefs) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)) } catch { /* private mode */ }
}

/** 应用启动时调用一次(模式同 initTheme)。 */
export const initEditorPrefs = () => {
  const stored = readPrefs()
  const prefs = {
    editorFontSize: clampFs(num(stored.editorFontSize, defaultFs())),
    terminalFontSize: clampFs(num(stored.terminalFontSize, defaultFs())),
    uiScale: clampScale(num(stored.uiScale, 1)),
  }
  applyEditorPrefs(prefs)
  useEditorPrefsStore.setState(prefs)
}

export const useEditorPrefsStore = create<EditorPrefsState>((set, get) => {
  const stored = typeof window === 'undefined' ? ({} as StoredPrefs) : readPrefs()
  const initial = {
    editorFontSize: clampFs(num(stored.editorFontSize, defaultFs())),
    terminalFontSize: clampFs(num(stored.terminalFontSize, defaultFs())),
    uiScale: clampScale(num(stored.uiScale, 1)),
  }
  if (typeof window !== 'undefined') applyEditorPrefs(initial)
  return {
    ...initial,
    setEditorFontSize: (px) => {
      const editorFontSize = clampFs(px)
      persist({ ...get(), editorFontSize })
      set({ editorFontSize })
      applyEditorPrefs({ ...get(), editorFontSize })
    },
    setTerminalFontSize: (px) => {
      const terminalFontSize = clampFs(px)
      persist({ ...get(), terminalFontSize })
      set({ terminalFontSize })
      applyEditorPrefs({ ...get(), terminalFontSize })
    },
    setUiScale: (scale) => {
      const uiScale = clampScale(scale)
      persist({ ...get(), uiScale })
      set({ uiScale })
      applyEditorPrefs({ ...get(), uiScale })
    },
  }
})
