/**
 * IDE 编辑器面板的跨面板通信 store(zustand,模块级 —— 手机渲染器卸载不可见
 * 面板后重挂时,打开的标签/文档内容/脏状态从这里恢复)。
 *
 * 使用方:
 *  - EditorPanel(src/ide/panels/EditorPanel.tsx):唯一消费者。
 *  - files 面板:用户点文件时调 openFile(pod, path) 即可在编辑器打开;
 *    编辑器面板挂载状态下收到 openSeq 变化会自行 activate() 请求布局层定位。
 *  - ai 面板:订阅 pendingAsk(或挂载/更新时 consumeAsk)拿「选中即问」的
 *    { action, text, path, line } 渲染提问;seq 单调递增可用于去重触发。
 *
 * 标签列表(tabs/active)按 pod 持久化到 localStorage(仅路径,内容只在内存),
 * key: yatterra.ide.editor.<podName>。
 */
import { create } from 'zustand'

/** 「选中即问」的动作类型 */
export type EditorAskAction = 'explain' | 'fix' | 'optimize' | 'test'

/** 一次「选中即问」请求(由 AI 面板消费) */
export interface EditorAiAsk {
  pod: string
  action: EditorAskAction
  /** 选中的文本 */
  text: string
  /** 所在文件路径 */
  path: string
  /** 选区首行行号(1 起) */
  line: number
  /** 单调递增序号,消费方用于去重触发 */
  seq: number
}

/** 单个打开文件的状态 */
export interface EditorDoc {
  path: string
  /** 当前文本(编辑中) */
  content: string
  /** 最近一次加载/保存成功的文本;dirty = content !== saved */
  saved: string
  /** 只读(超大/被截断文件) */
  readOnly: boolean
  /** 内容被后端 256KB 截断(只读打开,防止保存覆盖丢数据) */
  truncated?: boolean
  /** 加载失败信息(非空时不渲染编辑器) */
  error: string
  /** 是否已完成首次加载 */
  loaded: boolean
}

/** 单个 pod 的编辑器状态 */
export interface PodEditorState {
  /** 打开的文件路径(有序) */
  tabs: string[]
  active: string | null
  docs: Record<string, EditorDoc>
  /** 手机返回栈:此前激活过的路径(旧→新),左滑 goBack 弹出末尾 */
  history: string[]
}

const tabsKey = (pod: string) => `yatterra.ide.editor.${pod}`

/** 稳定空对象,zustand selector 的兜底返回值(引用不变避免多余渲染) */
export const EMPTY_POD_STATE: PodEditorState = { tabs: [], active: null, docs: {}, history: [] }

const HISTORY_LIMIT = 30

/** 从 localStorage 恢复某 pod 的标签列表(内容需重新从后端加载) */
function loadPod(pod: string): PodEditorState {
  try {
    const raw = localStorage.getItem(tabsKey(pod))
    if (raw) {
      const data = JSON.parse(raw) as { tabs?: unknown; active?: unknown }
      if (Array.isArray(data.tabs) && data.tabs.every((t) => typeof t === 'string')) {
        const tabs = [...new Set(data.tabs as string[])]
        const active =
          typeof data.active === 'string' && tabs.includes(data.active)
            ? data.active
            : (tabs[0] ?? null)
        return { tabs, active, docs: {}, history: [] }
      }
    }
  } catch {
    /* private mode / 损坏数据 → 空状态 */
  }
  return { tabs: [], active: null, docs: {}, history: [] }
}

function persistPod(pod: string, st: PodEditorState): void {
  try {
    localStorage.setItem(tabsKey(pod), JSON.stringify({ tabs: st.tabs, active: st.active }))
  } catch {
    /* private mode */
  }
}

interface EditorBusState {
  pods: Record<string, PodEditorState>
  /** 外部 openFile 的序号(按 pod),编辑器面板据此 activate() */
  openSeq: Record<string, number>
  pendingAsk: EditorAiAsk | null
  /** 打开(或激活)一个文件 —— files 面板点文件时调用 */
  openFile: (pod: string, path: string) => void
  /** 关闭标签(脏检查/确认由面板负责,这里只改状态) */
  closeTab: (pod: string, path: string) => void
  /** 切换激活标签;pushHistory=false 时不进返回栈(goBack 自身用) */
  setActive: (pod: string, path: string, opts?: { pushHistory?: boolean }) => void
  /** 手机左滑:回到上一个激活过的文件 */
  goBack: (pod: string) => void
  /** 更新某文件的内容/脏状态/加载结果 */
  patchDoc: (pod: string, path: string, patch: Partial<EditorDoc>) => void
  /** 「选中即问」:写入 pendingAsk 等 AI 面板消费 */
  askAi: (ask: Omit<EditorAiAsk, 'seq'>) => void
  /** AI 面板取走 pendingAsk(取后清空) */
  consumeAsk: () => EditorAiAsk | null
}

export const useEditorBusStore = create<EditorBusState>((set, get) => ({
  pods: {},
  openSeq: {},
  pendingAsk: null,

  openFile: (pod, path) =>
    set((st) => {
      const prev = st.pods[pod] ?? loadPod(pod)
      const tabs = prev.tabs.includes(path) ? prev.tabs : [...prev.tabs, path]
      const history =
        prev.active && prev.active !== path
          ? [...prev.history.filter((h) => h !== prev.active), prev.active].slice(-HISTORY_LIMIT)
          : prev.history
      const next: PodEditorState = { ...prev, tabs, active: path, history }
      persistPod(pod, next)
      return {
        pods: { ...st.pods, [pod]: next },
        openSeq: { ...st.openSeq, [pod]: (st.openSeq[pod] ?? 0) + 1 },
      }
    }),

  closeTab: (pod, path) =>
    set((st) => {
      const prev = st.pods[pod] ?? loadPod(pod)
      const idx = prev.tabs.indexOf(path)
      if (idx < 0) return st
      const tabs = prev.tabs.filter((p) => p !== path)
      const docs = { ...prev.docs }
      delete docs[path]
      const active =
        prev.active === path ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : prev.active
      const next: PodEditorState = {
        tabs,
        active,
        docs,
        history: prev.history.filter((h) => h !== path),
      }
      persistPod(pod, next)
      return { pods: { ...st.pods, [pod]: next } }
    }),

  setActive: (pod, path, opts) =>
    set((st) => {
      const prev = st.pods[pod] ?? loadPod(pod)
      if (!prev.tabs.includes(path) || prev.active === path) return st
      const history =
        opts?.pushHistory === false || !prev.active
          ? prev.history
          : [...prev.history.filter((h) => h !== prev.active), prev.active].slice(-HISTORY_LIMIT)
      const next: PodEditorState = { ...prev, active: path, history }
      persistPod(pod, next)
      return { pods: { ...st.pods, [pod]: next } }
    }),

  goBack: (pod) =>
    set((st) => {
      const prev = st.pods[pod] ?? loadPod(pod)
      const last = prev.history[prev.history.length - 1]
      if (!last || !prev.tabs.includes(last)) return st
      const next: PodEditorState = {
        ...prev,
        active: last,
        history: prev.history.slice(0, -1),
      }
      persistPod(pod, next)
      return { pods: { ...st.pods, [pod]: next } }
    }),

  patchDoc: (pod, path, patch) =>
    set((st) => {
      const prev = st.pods[pod] ?? loadPod(pod)
      const doc: EditorDoc =
        prev.docs[path] ?? { path, content: '', saved: '', readOnly: false, error: '', loaded: false }
      const next: PodEditorState = { ...prev, docs: { ...prev.docs, [path]: { ...doc, ...patch } } }
      return { pods: { ...st.pods, [pod]: next } }
    }),

  askAi: (ask) =>
    set((st) => ({ pendingAsk: { ...ask, seq: (st.pendingAsk?.seq ?? 0) + 1 } })),

  consumeAsk: () => {
    const p = get().pendingAsk
    if (p) set({ pendingAsk: null })
    return p
  },
}))
