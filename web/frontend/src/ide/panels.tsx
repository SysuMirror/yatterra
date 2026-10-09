/**
 * 内置面板的占位实现 —— 后续 agent 会把这里逐个替换为真面板:
 *   files / editor / terminal / ai / logs / settings
 * 占位只保证注册表完整、布局内核可渲染、build 通过。
 * 替换时:新建 src/ide/panels/<id>.tsx,然后把 registry.tsx 里对应条目的
 * component 换成新组件即可,不要改 id。
 */
import type { PanelProps } from './types'

export function PlaceholderPanel({ panelId, surface, maximized }: PanelProps) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-2 text-muted select-none">
      <div className="text-sm font-semibold">面板: {panelId}</div>
      <div className="text-xs opacity-70">占位实现,等待接入</div>
      <div className="text-[11px] opacity-50">surface={surface} maximized={String(maximized)}</div>
    </div>
  )
}
