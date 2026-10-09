/**
 * 全局 AI 助手 store —— 三套助手统一后的唯一面板状态。
 *
 * 各页面的 <PageAiAssistant page=... context=... /> 退化为薄触发器:
 * 挂载时 registerPage() 登记当前页 + 页面上下文, 点击/FAB 打开这份全局面板;
 * 旧 forwardRef send(text) 走 sendFromPage()。面板本体挂在 routes/_layout.tsx。
 */
import { create } from 'zustand'

interface PendingSend { text: string; seq: number }

/** 页面操作模式: restricted=AI 提议→用户确认; yolo=直接自动执行 */
export type AssistantMode = 'restricted' | 'yolo'

interface AiAssistantState {
  open: boolean
  /** 当前面板使用的页面键(如 dashboard / pod:xxx) */
  page: string
  /** 当前页登记的页面上下文(页面数据摘要) */
  context: string
  /** 页面操作模式(持久化由面板按 user 写 localStorage, store 只存内存值) */
  mode: AssistantMode
  setMode: (mode: AssistantMode) => void
  /** 待发送的预设问题(ref.send / 通知回跳带入), seq 用于去重触发 */
  pendingSend: PendingSend | null
  /** 各页面挂载时登记的 page+context(FAB 打开时取当前页) */
  registered: { page: string; context: string } | null
  registerPage: (page: string, context?: string) => void
  openPanel: () => void
  openWith: (page: string, context?: string) => void
  sendFromPage: (page: string, context: string | undefined, text: string) => void
  consumePendingSend: () => PendingSend | null
  close: () => void
}

export const useAiAssistantStore = create<AiAssistantState>((set, get) => ({
  open: false,
  page: 'dashboard',
  context: '',
  mode: 'restricted',
  setMode: (mode) => set({ mode }),
  pendingSend: null,
  registered: null,
  registerPage: (page, context = '') => set({ registered: { page, context } }),
  openPanel: () => {
    const reg = get().registered
    // 打开时若未显式指定页面, 用最近登记的页面(即当前路由所在页)
    set({ open: true, ...(reg ? { page: reg.page, context: reg.context } : {}) })
  },
  openWith: (page, context = '') => set({ open: true, page, context }),
  sendFromPage: (page, context, text) => set(st => ({
    open: true,
    page,
    context: context ?? '',
    pendingSend: { text, seq: (st.pendingSend?.seq ?? 0) + 1 },
  })),
  consumePendingSend: () => {
    const p = get().pendingSend
    if (p) set({ pendingSend: null })
    return p
  },
  close: () => set({ open: false }),
}))
