/**
 * 手机 IDE 布局渲染器(useIsIdeDesktop() false 时启用,含横屏手机)—— 原生 App 感。
 *
 * 结构(只有一条顶栏 + 一条底栏,2026-10 重构):
 *  - 唯一顶栏 .ide-m-header:☰ 平台导航抽屉 + ‹ 返回 Pod + pod 名(点它 = Pod 切换器)
 *    + ⋯ 面板配置。
 *    手机进 IDE 时平台 TopBar 由 routes/_layout.tsx 让位(hideTopBar),
 *    高度对齐 var(--topbar-h)(48px + 安全区),不再上下叠两条栏。
 *  - 内容区:同一时刻一个活动面板铺满(非活动面板 display:none 保留挂载,
 *    xterm / SSE / WS 不断连;进入面板加 .ide-m-panel-active 淡入上移)。
 *    AI 助手与其它面板同构,就是一个普通 Tab(不再有底部抽屉)。
 *  - 底部 Tab 条(对齐平台 MobileTabBar 质感):framer-motion layoutId
 *    弹簧 pill + haptic + active:scale;固定顺序 文件/编辑器/终端/日志/AI
 *    (终端/日志手机上默认点亮,可在 "…" 里关掉并落盘),树里其它面板跟在后面。
 *
 * 持久化:活动面板 id 写进 StoredIdeLayout.mobile(防抖),由 IdeShell 落盘;
 * 旧记录没有 activePanel 时回退 'editor'。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'framer-motion'
import { Check, ChevronDown, ChevronLeft, Ellipsis, Menu } from 'lucide-react'
import type { LayoutNode, StoredIdeLayout } from './types'
import { panelType } from './types'
import { getPanel } from './registry'
import { flattenForMobile } from './layout'
import { PANEL_TOGGLES } from './IdeShell'
import { openPodPicker } from './PodPicker'
import { hasPanelType, setPanelToggleHandler, setVisiblePanels, togglePanel, useVisiblePanels } from './panelToggles'
import { ActionSheet } from '@/components/ui/ActionSheet'
import { useSidebarStore } from '@/stores/sidebar'
import { haptic } from '@/lib/haptic'
import { cn } from '@/lib/cn'
import './ide-theme.css'

interface MobileIdeLayoutProps {
  podName: string
  stored: StoredIdeLayout
  /** 预设切换信号:变化时按 stored 重置。 */
  rebuildNonce: number
  onPersist: (next: StoredIdeLayout) => void
}

/** 手机底栏的规范顺序(与桌面预设无关,保证底栏稳定:文件/编辑器/终端/日志/AI)。 */
const MOBILE_BAR_ORDER = ['files', 'editor', 'terminal', 'logs', 'ai'] as const
/** 手机默认打开的面板:终端/日志在桌面上需要手动开,但手机上它们是 IDE 的核心常驻入口,
 *  默认点亮(用户可在 "…" 里关掉,选择会落盘)。 */
const MOBILE_DEFAULT_ON: readonly string[] = MOBILE_BAR_ORDER

/** 从 mobile 覆盖读活动面板;旧记录没有/失效时回退 'editor' → 首个面板。 */
function readActivePanel(saved: StoredIdeLayout['mobile'], panels: string[]): string {
  const active = saved?.activePanel
  if (typeof active === 'string' && panels.includes(active)) return active
  if (panels.includes('editor')) return 'editor'
  return panels[0] ?? 'editor'
}

/** 落盘被显式关掉的面板(override 里的 false 项)。 */
function hiddenFromOverride(override: Record<string, boolean>): string[] {
  return Object.entries(override).filter(([, on]) => !on).map(([id]) => id)
}

export function MobileIdeLayout({ podName, stored, rebuildNonce, onPersist }: MobileIdeLayoutProps) {
  const navigate = useNavigate()
  const { setMobileOpen } = useSidebarStore()
  const [tree, setTree] = useState<LayoutNode>(stored.tree)

  // ── 面板开关(顶栏 "…" → ActionSheet;files/editor 常驻不可关)──
  // 覆盖表记录用户的显式选择,关掉的面板 id 落盘到 mobile.hidden(下次进来仍是关的)。
  const [panelOverride, setPanelOverride] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((stored.mobile?.hidden ?? []).map((id) => [id, false])),
  )
  const [sheetOpen, setSheetOpen] = useState(false)
  const visiblePanels = useVisiblePanels()
  // 树里存的是布局 key(桌面多实例可带 ':N' 后缀);手机按类型单实例,
  // 统一归一成类型 id 再消费
  const treePanels = useMemo(() => flattenForMobile(tree).flatMap((s) => s.siblings).map(panelType), [tree])
  const isPanelEnabled = useCallback(
    (pid: string) =>
      pid === 'files' || pid === 'editor'
        ? true
        : (panelOverride[pid] ?? (treePanels.includes(pid) || MOBILE_DEFAULT_ON.includes(pid))),
    [panelOverride, treePanels],
  )
  useEffect(() => {
    setPanelToggleHandler((panelId, open) => {
      if (panelId === 'files' || panelId === 'editor') return
      setPanelOverride((prev) => ({ ...prev, [panelId]: open }))
    })
    return () => { setPanelToggleHandler(null) }
  }, [])

  // Tab 条面板集合:先按手机的规范顺序排(文件/编辑器/终端/日志/AI),再补布局树里
  // 出现的其它面板(浏览器/设置等)。按类型去重,多实例折叠成一个入口。
  const barPanels = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (p: string) => {
      if (!seen.has(p) && isPanelEnabled(p)) { seen.add(p); out.push(p) }
    }
    MOBILE_BAR_ORDER.forEach(push)
    flattenForMobile(tree).flatMap((s) => s.siblings).map(panelType).forEach(push)
    return out
  }, [tree, isPanelEnabled])

  // 用 barPanels(而非布局树)校验保存的活动面板 —— 终端/日志是手机默认点亮但不在树里,
  // 若按树校验,上次停在「日志」的用户刷新后会被弹回「编辑器」。
  const [activePanel, setActivePanel] = useState<string>(() => readActivePanel(stored.mobile, barPanels))

  // 面板按需挂载:只有被打开过的面板才真正挂载(终端=一个 PTY、日志=一条日志流),
  // 之后 display:none 保活、不再卸载。底栏可以列出终端/日志而不用替用户提前开 shell。
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([activePanel]))
  const isMounted = (pid: string) => pid === activePanel || mounted.has(pid)

  const persistRef = useRef(onPersist)
  persistRef.current = onPersist

  // 树的面板集合变化(预设切换/顶栏开关)→ 活动面板失效则回退(自动切到 editor)
  useEffect(() => {
    if (!barPanels.includes(activePanel)) {
      setActivePanel(readActivePanel(undefined, barPanels))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barPanels])

  // 顶栏开关状态同步
  useEffect(() => {
    setVisiblePanels(barPanels)
  }, [barPanels])

  // 预设切换 → 整体重置(开关覆盖表一并清空,树重新成为面板集合的数据源)
  const firstNonce = useRef(true)
  useEffect(() => {
    if (firstNonce.current) { firstNonce.current = false; return }
    setTree(stored.tree)
    setPanelOverride({})
    const panels = flattenForMobile(stored.tree).flatMap((s) => s.siblings).map(panelType)
    setActivePanel(readActivePanel(stored.mobile, panels))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildNonce])

  // 防抖持久化(手机不再写 order/weights;旧字段被替换属预期,桌面不受影响)
  const hiddenPanels = useMemo(() => hiddenFromOverride(panelOverride), [panelOverride])
  useEffect(() => {
    const t = setTimeout(() => {
      persistRef.current({ ...stored, tree, mobile: { activePanel, hidden: hiddenPanels } })
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, activePanel, hiddenPanels])

  // ── 面板切换 ──

  const switchPanel = (panelId: string) => {
    if (panelId === activePanel) return
    haptic('selection')
    setActivePanel(panelId)
    setMounted((prev) => (prev.has(panelId) ? prev : new Set(prev).add(panelId)))
  }

  // ActionSheet 行:与桌面顶栏图标组同源(files 常驻不列);选中态打 ✓
  const sheetItems = useMemo(
    () => PANEL_TOGGLES
      .filter((p) => p.id !== 'files')
      .map((p) => ({
        key: p.id,
        label: p.label,
        icon: hasPanelType(visiblePanels, p.id)
          ? <Check size={16} className="text-accent" />
          : <span className="w-4 h-4" />,
        onClick: () => togglePanel(p.id),
      })),
    [visiblePanels],
  )

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: 'var(--ide-bg)' }}>
      {/* 唯一顶栏:☰ 平台导航 + 返回 Pod + pod 名 + "…" 面板配置 */}
      <header className="ide-m-header" style={{ height: 'var(--topbar-h)', paddingTop: 'var(--sat)' }}>
        <button
          aria-label="打开导航菜单"
          onClick={() => { haptic('light'); setMobileOpen(true) }}
          className="ide-m-iconbtn"
        >
          <Menu size={20} />
        </button>
        <button
          aria-label="返回 Pod 详情"
          onClick={() => navigate(`/pods/${podName}`)}
          className="ide-m-iconbtn"
        >
          <ChevronLeft size={22} />
        </button>
        {/* pod 名 = 切换器入口(与桌面顶栏同一交互) */}
        <button
          type="button"
          onClick={() => { haptic('light'); openPodPicker() }}
          aria-haspopup="dialog"
          aria-label={`当前 Pod ${podName},点击切换`}
          className="ide-m-title ide-m-podbtn flex-1 flex items-center gap-1 min-w-0"
        >
          <span className="truncate">{podName}</span>
          <ChevronDown size={14} className="shrink-0 opacity-60" />
        </button>
        <button
          aria-label="面板设置"
          aria-haspopup="dialog"
          onClick={() => { haptic('light'); setSheetOpen(true) }}
          className="ide-m-iconbtn"
        >
          <Ellipsis size={20} />
        </button>
      </header>

      {/* 内容区:活动面板全屏铺满;打开过的非活动面板 display:none 保留挂载(不断连/不丢状态) */}
      <div className="relative flex-1 min-h-0">
        {barPanels.filter(isMounted).map((pid) => {
          const contract = getPanel(pid)
          const Comp = contract?.component
          if (!Comp) return null
          const active = pid === activePanel
          return (
            <div
              key={pid}
              aria-hidden={!active}
              className={cn('ide-m-panel absolute inset-0', active && 'ide-m-panel-active')}
              style={active ? undefined : { display: 'none' }}
            >
              <Comp
                podName={podName}
                panelId={pid}
                panelKey={pid}
                surface="mobile"
                maximized={false}
                activate={() => switchPanel(pid)}
                toggleMaximize={() => {}}
              />
            </div>
          )
        })}
      </div>

      {/* 底部 Tab 条(对齐平台 MobileTabBar):弹簧 pill + haptic */}
      <nav
        aria-label="IDE 面板切换"
        className="ide-m-tabbar"
        style={{ paddingBottom: 'var(--sab)' }}
      >
        <div className="flex items-center h-14">
          {/* 面板切换组:共享 layoutId 弹簧 pill 在活动面板间滑动 */}
          <div className="flex items-center justify-around flex-1 min-w-0">
            {barPanels.map((pid) => {
              const contract = getPanel(pid)
              if (!contract) return null
              const Icon = contract.icon
              const active = pid === activePanel
              return (
                <button
                  key={pid}
                  onClick={() => switchPanel(pid)}
                  aria-current={active ? 'true' : undefined}
                  className={cn('ide-m-tabbar-item', active && 'ide-m-tabbar-item-active')}
                >
                  {active && (
                    <motion.span
                      layoutId="ideTabIndicator"
                      className="ide-m-tab-pill"
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  )}
                  <Icon size={20} className="relative z-10" />
                  <span className="ide-m-tabbar-label relative z-10">{contract.title}</span>
                </button>
              )
            })}
          </div>
        </div>
      </nav>

      {/* 面板配置 ActionSheet:与桌面顶栏开关同源同总线 */}
      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="面板"
        items={sheetItems}
      />
    </div>
  )
}
