/**
 * IDE 页面外壳:顶栏(返回 / Pod 名 / IDE 徽章 / 面板开关图标组)+ 布局内核分流。
 * 桌面(useIsIdeDesktop:够宽且够高)→ DesktopIdeLayout(dockview);
 * 手机(含横屏手机)→ MobileIdeLayout(单面板全屏 + 底部 Tab 条)。
 *
 * 面板开关(VS Code 活动栏心智):files / terminal / logs / ai 四个 32px 图标,
 * 点亮 = 该面板在布局里;点击经 panelToggles 总线交给当前内核(桌面增删
 * dockview 面板,手机控制切换条/抽屉显隐)。布局预设的保存/应用/删除只在
 * SettingsPanel 里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, ChevronDown, FolderOpen, Terminal, ScrollText, Sparkles } from 'lucide-react'
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
import { hasPanelType, togglePanel, useVisiblePanels } from './panelToggles'
import { openPodPicker, rememberPod } from './PodPicker'
import { useIsIdeDesktop } from '@/hooks/useMediaQuery'
import { haptic } from '@/lib/haptic'
import { cn } from '@/lib/cn'

interface IdeShellProps {
  podName: string
}

/** 顶栏面板开关(顺序 = 出现顺序);editor 常驻,不设开关。
 * 桌面渲染成顶栏图标组;手机(MobileIdeLayout)复用为 "…" ActionSheet 行。 */
export const PANEL_TOGGLES = [
  { id: 'files', icon: FolderOpen, label: '文件' },
  { id: 'terminal', icon: Terminal, label: '终端' },
  { id: 'logs', icon: ScrollText, label: '日志' },
  { id: 'ai', icon: Sparkles, label: 'AI 助手' },
] as const

export function IdeShell({ podName }: IdeShellProps) {
  const navigate = useNavigate()
  // 内核选择用 useIsIdeDesktop(宽度 + 高度),横屏手机继续走手机内核
  const isDesktop = useIsIdeDesktop()
  const [stored, setStored] = useState<StoredIdeLayout>(() => loadLayout(podName))
  const [rebuildNonce, setRebuildNonce] = useState(0)
  const [userPresets, setUserPresets] = useState<Record<string, LayoutNode>>(() => loadUserPresets())
  const visiblePanels = useVisiblePanels()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 记住最近打开的 pod, /ide 入口页据此直达;同时进 MRU(切换器里的「最近」)
  useEffect(() => {
    try { localStorage.setItem('yatterra.ide.lastPod', podName) } catch { /* ignore */ }
    rememberPod(podName)
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
      // 可见集合存的是布局 key(multi 面板可带 ':N' 后缀),按类型判断点亮
      const on = hasPanelType(visiblePanels, id)
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
      {/* 桌面 IDE 顶栏:36px,ide-bg 底,底部 1px line(手机顶栏由 MobileIdeLayout 自绘) */}
      {isDesktop && (
        <header className="h-9 shrink-0 flex items-center gap-1 px-1.5 border-b" style={{ background: 'var(--ide-bg)', borderColor: 'var(--ide-line)' }}>
          <button
            aria-label="返回 Pod 详情"
            onClick={() => navigate(`/pods/${podName}`)}
            className="ide-icon-btn"
          >
            <ArrowLeft size={16} />
          </button>
          {/* pod 名 = 切换器入口(桌面/手机同一交互;⌘/右键等其它入口见 PodPicker) */}
          <button
            type="button"
            onClick={() => { haptic('light'); openPodPicker() }}
            title="切换 Pod"
            aria-haspopup="dialog"
            aria-label={`当前 Pod ${podName},点击切换`}
            className="ide-pod-btn"
          >
            <span className="font-mono text-[13px] truncate">{podName}</span>
            <ChevronDown size={13} className="shrink-0 opacity-60" />
          </button>
          <span
            className="hidden sm:inline shrink-0 px-1.5 py-0.5 rounded-full text-[11px] font-medium tracking-wide"
            style={{ background: 'var(--ide-elev)', color: 'var(--ide-ink-2)' }}
          >
            IDE
          </span>

          <div className="flex-1 min-w-0" />

          {/* 面板开关图标组:点亮 = 面板在布局里;点击开/关(dockview 增删面板) */}
          <div className="flex items-center gap-0.5">
            {toggleButtons}
          </div>
        </header>
      )}

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
