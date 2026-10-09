/**
 * IDE 跨面板通信总线(zustand store)。
 *
 * 契约约定面板之间不互相 import,跨面板协作一律走这里:
 *   - EditorPanel → AiPanel:
 *       setEditorContext()  发布「当前打开文件 + 光标位置(可选 ±50 行 snippet)」,
 *                           AiPanel 发送问题时自动注入为上下文(用户零操作);
 *       pushEdit()          保存/创建/删除文件时上报,AiPanel 注入「最近编辑动作」;
 *       ask()               「选中即问」: {question, path?, code?},
 *                           AiPanel 消费(consumeAsk)后组装成首条用户消息并 activate()。
 *   - AiPanel → EditorPanel:
 *       notifySaved(path)   用户接受 diff 卡片、PUT files/save 写入成功后调用;
 *                           EditorPanel 订阅 savedSignal 变化即可刷新对应文件。
 *
 * 所有通道都是「最后一次写入生效」的信号量/快照语义,不存回调引用,
 * 面板随时卸载/重建都不会留悬空引用(手机渲染器会卸载不可见面板)。
 */
import { create } from 'zustand'

/** EditorPanel 发布的当前编辑上下文(路径 + 光标,snippet 为可选的 ±50 行窗口)。 */
export interface IdeEditorContext {
  path: string
  /** 1-based 当前行号 */
  cursorLine?: number
  /** 光标 ±50 行窗口文本;缺省时 AiPanel 自行拉取全文并切片 */
  snippet?: string
}

/** 一次编辑动作(最近编辑动作上下文用)。 */
export interface IdeEditAction {
  path: string
  kind: 'save' | 'create' | 'delete'
  ts: number
}

/** 「选中即问」请求(任意面板 → AiPanel)。 */
export interface IdeAskRequest {
  question: string
  /** 选中代码所在文件 */
  path?: string
  /** 选中的代码片段 */
  code?: string
  ts: number
}

interface IdeBusState {
  editorContext: IdeEditorContext | null
  recentEdits: IdeEditAction[]
  askRequest: IdeAskRequest | null
  /** 文件被外部写入(如 AI diff 被接受)的信号;订阅方比较 ts 判断新事件 */
  savedSignal: { path: string; ts: number } | null
  setEditorContext: (ctx: IdeEditorContext | null) => void
  pushEdit: (action: Omit<IdeEditAction, 'ts'>) => void
  ask: (req: Omit<IdeAskRequest, 'ts'>) => void
  consumeAsk: () => void
  notifySaved: (path: string) => void
}

export const useIdeBusStore = create<IdeBusState>((set, get) => ({
  editorContext: null,
  recentEdits: [],
  askRequest: null,
  savedSignal: null,
  setEditorContext: (ctx) => set({ editorContext: ctx }),
  pushEdit: (action) =>
    set({ recentEdits: [{ ...action, ts: Date.now() }, ...get().recentEdits].slice(0, 20) }),
  ask: (req) => set({ askRequest: { ...req, ts: Date.now() } }),
  consumeAsk: () => set({ askRequest: null }),
  notifySaved: (path) => set({ savedSignal: { path, ts: Date.now() } }),
}))
