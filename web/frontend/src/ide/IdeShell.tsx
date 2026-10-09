/**
 * IDE 页面外壳:顶栏(返回 / Pod 名 / IDE 徽章 / 面板开关图标组)+ 布局内核分流。
 * 桌面(useIsDesktop)→ DesktopIdeLayout(dockview);
 * 手机 → MobileIdeLayout(垂直堆叠 + AI 底部抽屉)。
 *
 * 面板开关(VS Code 活动栏心智):files / terminal / logs / ai 四个 32px 图标,
 * 点亮 = 该面板在布局里;点击经 panelToggles 总线交给当前内核(桌面增删
 * dockview 面板,手机控制切换条/抽屉显隐)。布局预设的保存/应用/删除只在
 * SettingsPanel 里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, FolderOpen, Terminal, ScrollText, Sparkles } from 'lucide-react'
import type { LayoutNode, StoredIdeLayout } from './types'
import {
  BUILTIN_PRESETS,
  loadLayout,
  loadUserPresets,
  saveLayout,
} from './layout'
import { DesktopIdeLayout } from './DesktopIdeLayout'
import { MobileIdeLayout } from './MobileIdeLayout'
import { IDE_APPLY_PRESET_EVENT } from './panels/SettingsPanel'
import { togglePanel, useVisiblePanels } from './panelToggles'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { haptic } from '@/lib/haptic'
import { cn } from '@/lib/cn'

interface IdeShellProps {
  podName: string
}

/** 顶栏面板开关(顺序 = 出现顺序);editor 常驻,不设开关。 */
const PANEL_TOGGLES = [
  { id: 'files', icon: FolderOpen, label: '文件' },
  { id: 'terminal', icon: Terminal, label: '终端' },
  { id: 'logs', icon: ScrollText, label: '日志' },
  { id: 'ai', icon: Sparkles, label: 'AI 助手' },
] as const

export function IdeShell({ podName }: IdeShellProps) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const [stored, setStored] = useState<StoredIdeLayout>(() => loadLayout(podName))
  const [rebuildNonce, setRebuildNonce] = useState(0)
  const [userPresets, setUserPresets] = useState<Record<string, LayoutNode>>(() => loadUserPresets())
  const visiblePanels = useVisiblePanels()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 记住最近打开的 pod, /ide 入口页据此直达
  useEffect(() => {
    try { localStorage.setItem('yatterra.ide.lastPod', podName) } catch { /* ignore */ }
  }, [podName])

  // 布局内核回传 → 落盘(轻防抖,吸收桌面 onDidLayoutChange 的密集触发)
  const onPersist = useCallback((next: StoredIdeLayout) => {
    setStored(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveLayout(podName, next), 200)
  }, [podName])

  /** 应用预设:重置树,清掉 dockview 快照与手机覆盖,通知两端渲染器重建。 */
  const applyPreset = useCallback(
    (name: string) => {
      const tree: LayoutNode | null = BUILTIN_PRESETS[name] ? BUILTIN_PRESETS[name]!() : (userPresets[name] ?? null)
      if (!tree) return
      haptic('selection')
      onPersist({ version: 1, tree })
      setRebuildNonce((n) => n + 1)
    },
    [userPresets, onPersist],
  )

  // 设置面板的「应用预设/恢复默认」:面板不能直接改布局树,经 CustomEvent 通知外壳
  useEffect(() => {
    const h = (e: Event) => {
      const name = (e as CustomEvent).detail?.name
      if (typeof name === 'string') applyPreset(name)
    }
    window.addEventListener(IDE_APPLY_PRESET_EVENT, h)
    return () => window.removeEventListener(IDE_APPLY_PRESET_EVENT, h)
  }, [applyPreset])

  const onToggleClick = useCallback((panelId: string) => {
    haptic('light')
    togglePanel(panelId)
  }, [])

  const toggleButtons = useMemo(
    () => PANEL_TOGGLES.map(({ id, icon: Icon, label }) => {
      const on = visiblePanels.has(id)
      return (
        <button
          key={id}
          type="button"
          onClick={() => onToggleClick(id)}
          title={`${on ? '关闭' : '打开'}${label}面板`}
          aria-label={`${on ? '关闭' : '打开'}${label}面板`}
          aria-pressed={on}
          className={cn('ide-toggle-btn', on && 'ide-toggle-btn-on')}
        >
          <Icon size={15} />
        </button>
      )
    }),
    [visiblePanels, onToggleClick],
  )

  return (
    <div className="ide-root h-full flex flex-col min-h-0">
      {/* IDE 顶栏:36px,ide-bg 底,底部 1px line */}
      <header className="h-9 shrink-0 flex items-center gap-1 px-1.5 border-b" style={{ background: 'var(--ide-bg)', borderColor: 'var(--ide-line)' }}>
        <button
          aria-label="返回 Pod 详情"
          onClick={() => navigate(`/pods/${podName}`)}
          className="ide-icon-btn"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="font-mono text-[13px] truncate" style={{ color: 'var(--ide-ink)' }}>{podName}</span>
        <span
          className="hidden sm:inline shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium tracking-wide"
          style={{ background: 'var(--ide-elev)', color: 'var(--ide-ink-2)' }}
        >
          IDE
        </span>

        <div className="flex-1 min-w-0" />

        {/* 面板开关图标组:点亮 = 面板在布局里;点击开/关(桌面 dockview / 手机切换条) */}
        <div className="flex items-center gap-0.5">
          {toggleButtons}
        </div>
      </header>

      {/* 布局内核:桌面 dockview / 手机垂直堆叠 */}
      <div className="flex-1 min-h-0">
        {isDesktop ? (
          <DesktopIdeLayout podName={podName} stored={stored} rebuildNonce={rebuildNonce} onPersist={onPersist} />
        ) : (
          <MobileIdeLayout podName={podName} stored={stored} rebuildNonce={rebuildNonce} onPersist={onPersist} />
        )}
      </div>
    </div>
  )
}
