/**
 * 面板开关总线(顶栏图标组 ↔ 布局内核)。
 *
 * 顶栏(IdeShell)渲染 files/terminal/logs/ai 四个开关按钮,按钮状态 =
 * 该面板当前是否在布局里;点击 → togglePanel() 经当前挂载的内核处理器
 * (桌面 dockview 增删面板 / 手机切换条显隐)执行,内核动作完成后回调
 * setVisiblePanels() 同步状态,顶栏经 useVisiblePanels() 订阅重渲染。
 *
 * 内核挂载时 setPanelToggleHandler(handler) 注册,卸载时置 null;
 * 桌面在 onDidLayoutChange(用户手动关标签/拖拽)里也回写可见集合。
 */
import { useSyncExternalStore } from 'react'

type ToggleHandler = (panelId: string, open: boolean) => void

let visible: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
let handler: ToggleHandler | null = null

function emit() {
  for (const l of listeners) l()
}

/** 内核上报当前在布局里的面板 id 集合(无变化时不触发渲染)。 */
export function setVisiblePanels(ids: Iterable<string>): void {
  const next = new Set(ids)
  if (next.size === visible.size && [...next].every((id) => visible.has(id))) return
  visible = next
  emit()
}

/** 内核挂载/卸载时注册/注销开关处理器。 */
export function setPanelToggleHandler(h: ToggleHandler | null): void {
  handler = h
}

/** 顶栏开关点击:open = 目标状态(当前不可见 → 打开)。 */
export function togglePanel(panelId: string): void {
  handler?.(panelId, !visible.has(panelId))
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** 顶栏订阅:当前在布局里的面板 id 集合。 */
export function useVisiblePanels(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => visible)
}
