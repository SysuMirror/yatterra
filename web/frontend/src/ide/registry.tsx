/**
 * IDE 面板注册表。
 *
 * 布局内核(DesktopIdeLayout/MobileIdeLayout)只通过 getPanel()/listPanels()
 * 消费这里的数据,不直接 import 任何具体面板 —— 新面板注册即可用。
 *
 * 注册方式(详见 src/ide/types.ts 顶部契约注释):
 *
 *   registerPanel({
 *     id: 'mypanel',            // 唯一,布局 JSON 按它引用,发布后勿改
 *     title: '我的面板',
 *     icon: MyLucideIcon,
 *     component: MyPanel,       // (props: PanelProps) => JSX
 *     minSize: 160,             // 可选:手机堆叠最小高度(px)
 *     mobileDrawer: false,      // 可选:手机吸附为底部抽屉
 *   })
 */
import {
  FolderOpen,
  Code2,
  Terminal as TerminalIcon,
  Sparkles,
  ScrollText,
  Settings as SettingsIcon,
} from 'lucide-react'
import type { PanelContract } from './types'
import { FileTreePanel } from './panels/FileTreePanel'
import { EditorPanel } from './panels/EditorPanel'
import { TerminalPanel } from './panels/TerminalPanel'
import { AiPanel } from './panels/AiPanel'
import { LogsPanel } from './panels/LogsPanel'
import { SettingsPanel } from './panels/SettingsPanel'

const registry = new Map<string, PanelContract>()

/** 注册(或覆盖)一个面板。id 冲突时后者生效并 console.warn。 */
export function registerPanel(contract: PanelContract): void {
  if (registry.has(contract.id)) {
    console.warn(`[ide] panel "${contract.id}" re-registered, overriding`)
  }
  registry.set(contract.id, contract)
}

export function getPanel(id: string): PanelContract | undefined {
  return registry.get(id)
}

export function listPanels(): PanelContract[] {
  return [...registry.values()]
}

// ── 内置面板注册 ────────────────────────────────────────────────────────────

registerPanel({
  id: 'files',
  title: '文件',
  icon: FolderOpen,
  component: FileTreePanel,
  minSize: 140,
})

registerPanel({
  id: 'editor',
  title: '编辑器',
  icon: Code2,
  component: EditorPanel,
  minSize: 160,
})

registerPanel({
  id: 'terminal',
  title: '终端',
  icon: TerminalIcon,
  component: TerminalPanel,
  minSize: 200,
})

registerPanel({
  id: 'ai',
  title: 'AI 助手',
  icon: Sparkles,
  component: AiPanel,
  minSize: 200,
  // 手机上吸附为底部抽屉(25/50/90 三档),不进垂直堆叠
  mobileDrawer: true,
})

registerPanel({
  id: 'logs',
  title: '日志',
  icon: ScrollText,
  component: LogsPanel,
  minSize: 120,
})

registerPanel({
  id: 'settings',
  title: '设置',
  icon: SettingsIcon,
  component: SettingsPanel,
  minSize: 140,
})
