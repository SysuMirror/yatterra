/**
 * 手机 IDE 布局渲染器(useIsDesktop() false 时启用)。
 *
 * 单面板全屏 + 底部切换条:
 *  - 同一时刻一个活动面板铺满内容区(无堆叠头/卡片边框/外层 padding),
 *    非活动面板用 display:none 保留挂载(xterm / SSE / WS 不断连,切回即用;
 *    xterm 在 display:none 时 ResizeObserver 报 0×0,fit 被 try/catch 吞掉,
 *    切回时 RO 再报真实尺寸触发 refit)
 *  - 底部一条 48px(+safe-area)切换条:面板图标 + 小字标签,激活项 accent
 *    高亮,点击切换(haptic);质感对齐平台 MobileTabBar
 *  - AI 面板(mobileDrawer)不进切换条、不占布局:底部抽屉 25/50/90 三档,
 *    拖把手实时跟手,松手吸附;点把手收起/展开;切换条最右 AI 按钮开合
 *  - 内容区左右边缘(~24px)起手横滑切上/下一个面板(haptic);
 *    只认边缘起手,避免劫持 CodeMirror 横向滚动 / xterm 手势
 *
 * 持久化:活动面板 id(activePanel)与抽屉档位/开合写进 StoredIdeLayout.mobile
 * (防抖),由 IdeShell 落盘;旧记录(堆叠时代的 order/weights)没有
 * activePanel 时回退 'editor'。布局树仍是面板集合的数据源(预设切换会改变
 * 切换条内容);layout.ts 的堆叠类型/函数桌面与旧记录兼容仍在,手机不再消费。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LayoutNode, StoredIdeLayout } from './types'
import { getPanel, listPanels } from './registry'
import { flattenForMobile, panelsInTree } from './layout'
import { setPanelToggleHandler, setVisiblePanels } from './panelToggles'
import { haptic } from '@/lib/haptic'
import { cn } from '@/lib/cn'
import './ide-theme.css'

const DRAWER_SNAPS: Array<0.25 | 0.5 | 0.9> = [0.25, 0.5, 0.9]
/** 边缘横滑起手区宽度(px)。 */
const EDGE_SWIPE_ZONE = 24
/** 边缘横滑触发距离(px)。 */
const EDGE_SWIPE_THRESHOLD = 40

interface MobileIdeLayoutProps {
  podName: string
  stored: StoredIdeLayout
  /** 预设切换信号:变化时按 stored 重置。 */
  rebuildNonce: number
  onPersist: (next: StoredIdeLayout) => void
}

/** 从 mobile 覆盖读活动面板;旧记录没有/失效时回退 'editor' → 首个面板。 */
function readActivePanel(saved: StoredIdeLayout['mobile'], panels: string[]): string {
  const active = saved?.activePanel
  if (typeof active === 'string' && panels.includes(active)) return active
  if (panels.includes('editor')) return 'editor'
  return panels[0] ?? 'editor'
}

export function MobileIdeLayout({ podName, stored, rebuildNonce, onPersist }: MobileIdeLayoutProps) {
  const [tree, setTree] = useState<LayoutNode>(stored.tree)

  // ── 顶栏面板开关(手机简化:控制切换条/抽屉里对应项的显隐)──
  // files/editor 常驻不可关;其余面板默认跟随布局树,顶栏开关写入覆盖表。
  // 覆盖表是会话级状态(不落盘):树仍是持久化布局的数据源。
  const [panelOverride, setPanelOverride] = useState<Record<string, boolean>>({})
  const treePanels = useMemo(() => panelsInTree(tree), [tree])
  const isPanelEnabled = useCallback(
    (pid: string) => pid === 'files' || pid === 'editor' ? true : (panelOverride[pid] ?? treePanels.includes(pid)),
    [panelOverride, treePanels],
  )
  useEffect(() => {
    setPanelToggleHandler((panelId, open) => {
      if (panelId === 'files' || panelId === 'editor') return
      setPanelOverride((prev) => ({ ...prev, [panelId]: open }))
    })
    return () => { setPanelToggleHandler(null) }
  }, [])

  // 切换条面板集合:堆叠槽位的全部面板(mobileDrawer 面板除外),按开关过滤;
  // 被开关打开但不在树里的面板追加到末尾
  const slots = useMemo(() => flattenForMobile(tree), [tree])
  const barPanels = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of slots.flatMap((s) => s.siblings)) {
      if (!seen.has(p) && isPanelEnabled(p)) { seen.add(p); out.push(p) }
    }
    for (const p of ['terminal', 'logs']) {
      if (!seen.has(p) && isPanelEnabled(p)) { seen.add(p); out.push(p) }
    }
    return out
  }, [slots, isPanelEnabled])

  const [activePanel, setActivePanel] = useState<string>(() =>
    readActivePanel(stored.mobile, flattenForMobile(stored.tree).flatMap((s) => s.siblings)),
  )

  // 抽屉(mobileDrawer 面板,如 ai):不进切换条,底部覆盖层;顶栏开关关闭时不渲染
  const drawerPanelId = useMemo(
    () => listPanels().find((c) => c.mobileDrawer && isPanelEnabled(c.id))?.id,
    [isPanelEnabled],
  )
  const drawerContract = drawerPanelId ? getPanel(drawerPanelId) : undefined

  const [drawerSnap, setDrawerSnap] = useState<0.25 | 0.5 | 0.9>(() => {
    const s = stored.mobile?.drawerSnap
    return s === 0.25 || s === 0.5 || s === 0.9 ? s : 0.5
  })
  const [drawerOpen, setDrawerOpen] = useState<boolean>(stored.mobile?.drawerOpen !== false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const persistRef = useRef(onPersist)
  persistRef.current = onPersist

  // 树的面板集合变化(预设切换/顶栏开关)→ 活动面板失效则回退(自动切到 editor)
  useEffect(() => {
    if (!barPanels.includes(activePanel)) {
      setActivePanel(readActivePanel(undefined, barPanels))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barPanels])

  // 顶栏开关状态同步:切换条面板 + 抽屉面板
  useEffect(() => {
    setVisiblePanels(drawerPanelId ? [...barPanels, drawerPanelId] : barPanels)
  }, [barPanels, drawerPanelId])

  // 预设切换 → 整体重置(开关覆盖表一并清空,树重新成为面板集合的数据源)
  const firstNonce = useRef(true)
  useEffect(() => {
    if (firstNonce.current) { firstNonce.current = false; return }
    setTree(stored.tree)
    setPanelOverride({})
    const panels = flattenForMobile(stored.tree).flatMap((s) => s.siblings)
    setActivePanel(readActivePanel(stored.mobile, panels))
    const s = stored.mobile?.drawerSnap
    setDrawerSnap(s === 0.25 || s === 0.5 || s === 0.9 ? s : 0.5)
    setDrawerOpen(stored.mobile?.drawerOpen !== false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildNonce])

  // 防抖持久化(手机不再写 order/weights;旧字段被替换属预期,桌面不受影响)
  useEffect(() => {
    const t = setTimeout(() => {
      persistRef.current({
        ...stored,
        tree,
        mobile: { activePanel, drawerSnap, drawerOpen },
      })
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, activePanel, drawerSnap, drawerOpen])

  // ── 面板切换 ──

  const switchPanel = (panelId: string) => {
    if (panelId === activePanel) return
    haptic('selection')
    setActivePanel(panelId)
  }

  /** 切上/下一个面板(环绕)。dir=-1 上一个,+1 下一个。 */
  const cyclePanel = (dir: -1 | 1) => {
    if (barPanels.length < 2) return
    const i = barPanels.indexOf(activePanel)
    if (i < 0) return
    const next = barPanels[(i + dir + barPanels.length) % barPanels.length]!
    switchPanel(next)
  }

  // ── 边缘横滑(只在左右 ~24px 起手才生效;不拦截普通点按/纵向滚动) ──

  const edgeDrag = useRef<{ id: number; startX: number; startY: number; dir: -1 | 1; fired: boolean } | null>(null)

  const onAreaPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return // 桌面调试鼠标不参与
    const w = e.currentTarget.clientWidth
    if (e.clientX > EDGE_SWIPE_ZONE && e.clientX < w - EDGE_SWIPE_ZONE) return
    edgeDrag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dir: e.clientX <= EDGE_SWIPE_ZONE ? -1 : 1,
      fired: false,
    }
  }
  const onAreaPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = edgeDrag.current
    if (!st || st.id !== e.pointerId || st.fired) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    // 左缘右滑 → 上一个;右缘左滑 → 下一个;横向显著主导才触发
    if (Math.abs(dx) > EDGE_SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.4 && dx * st.dir < 0) {
      st.fired = true
      haptic('light')
      cyclePanel(st.dir)
    }
  }
  const onAreaPointerEnd = () => { edgeDrag.current = null }

  // ── 软键盘适配:抽屉内输入框聚焦时,整块抽屉上移键盘高度 ─────────────────
  // iOS 的布局视口不随键盘收缩(100dvh 不变,只有 visualViewport 缩),抽屉锚在
  // 布局视口底缘,输入区数学上必然落在键盘后面(点输入框 = 盲打)。这里复用
  // EditorPanel 键盘辅助条的公式 kbOffset = innerHeight - (vv.offsetTop + vv.height),
  // 聚焦抽屉内可编辑元素时给抽屉容器 translateY 抬升;同时覆盖 AI 抽屉输入框
  // 与抽屉内其它可编辑元素。
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const [kbOffset, setKbOffset] = useState(0)
  useEffect(() => {
    const drawer = drawerRef.current
    const vv = window.visualViewport
    if (!drawer || !vv) return
    const editableFocused = () => {
      const el = document.activeElement
      if (!el || !drawer.contains(el)) return false
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable === true
    }
    const update = () => {
      const off = window.innerHeight - (vv.offsetTop + vv.height)
      setKbOffset(editableFocused() && off > 80 ? off : 0)
    }
    // focusout 时 activeElement 还没切换,下一帧再算
    const scheduleUpdate = () => requestAnimationFrame(update)
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    drawer.addEventListener('focusin', update)
    drawer.addEventListener('focusout', scheduleUpdate)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      drawer.removeEventListener('focusin', update)
      drawer.removeEventListener('focusout', scheduleUpdate)
      setKbOffset(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerPanelId])

  // ── 底部抽屉 ──

  const drawerDrag = useRef<{ startY: number; startPx: number; moved: boolean } | null>(null)
  const [drawerLivePx, setDrawerLivePx] = useState<number | null>(null)

  const containerHeight = () => rootRef.current?.clientHeight ?? window.innerHeight

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const containerH = containerHeight()
    drawerMoved.current = false
    drawerDrag.current = { startY: e.clientY, startPx: drawerSnap * containerH, moved: false }
  }
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = drawerDrag.current
    if (!st) return
    const containerH = containerHeight()
    // 上拖增高
    const px = Math.min(containerH * 0.95, Math.max(containerH * 0.15, st.startPx - (e.clientY - st.startY)))
    if (Math.abs(px - st.startPx) > 4) { st.moved = true; drawerMoved.current = true }
    setDrawerLivePx(px)
  }
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const st = drawerDrag.current
    drawerDrag.current = null
    if (!st) { setDrawerLivePx(null); return }
    if (!st.moved) { setDrawerLivePx(null); return } // 纯点按 → 交给 onClick 收起/展开
    const containerH = containerHeight()
    const ratio = (drawerLivePx ?? st.startPx) / containerH
    // 吸附到 25/50/90 三档
    let best: 0.25 | 0.5 | 0.9 = 0.5
    let bestDist = Infinity
    for (const sp of DRAWER_SNAPS) {
      const d = Math.abs(ratio - sp)
      if (d < bestDist) { bestDist = d; best = sp }
    }
    haptic('selection')
    // 收起态上拖 = 拉开抽屉(把手有拖动暗示,不能毫无反应)
    if (!drawerOpen && drawerLivePx !== null && drawerLivePx > st.startPx) setDrawerOpen(true)
    setDrawerSnap(best)
    setDrawerLivePx(null)
  }
  // 拖动后浏览器仍会派发 click —— 用标记吞掉,避免拖完立刻收起
  const drawerMoved = useRef(false)
  const onHandleClick = () => {
    if (drawerMoved.current) { drawerMoved.current = false; return }
    haptic('light')
    setDrawerOpen((o) => !o)
  }

  const DrawerComp = drawerContract?.component
  const DrawerIcon = drawerContract?.icon

  return (
    <div ref={rootRef} className="h-full flex flex-col min-h-0" style={{ background: 'var(--ide-bg)' }}>
      {/* 内容区:活动面板全屏铺满;非活动面板 display:none 保留挂载(不断连/不丢状态) */}
      <div
        className="relative flex-1 min-h-0"
        onPointerDown={onAreaPointerDown}
        onPointerMove={onAreaPointerMove}
        onPointerUp={onAreaPointerEnd}
        onPointerCancel={onAreaPointerEnd}
      >
        {barPanels.map((pid) => {
          const contract = getPanel(pid)
          const Comp = contract?.component
          if (!Comp) return null
          const active = pid === activePanel
          return (
            <div
              key={pid}
              aria-hidden={!active}
              className="absolute inset-0"
              style={active ? undefined : { display: 'none' }}
            >
              <Comp
                podName={podName}
                panelId={pid}
                surface="mobile"
                maximized={false}
                activate={() => switchPanel(pid)}
                toggleMaximize={() => {}}
              />
            </div>
          )
        })}

        {/* 底部抽屉(mobileDrawer 面板,覆盖在活动面板之上;聚焦输入时整体上移避开软键盘) */}
        {drawerPanelId && drawerContract && (
          <div
            ref={drawerRef}
            className="ide-drawer"
            style={{
              height: drawerLivePx !== null ? Math.max(44, drawerLivePx) : (drawerOpen ? `${drawerSnap * 100}%` : 44),
              ...(kbOffset ? { transform: `translateY(${-kbOffset}px)` } : undefined),
            }}
          >
            {/* 把手:拖动调档,点按收起/展开 */}
            <div
              className="ide-drawer-handle"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              onClick={onHandleClick}
            >
              <div className="ide-drawer-grip" />
              <div className="flex items-center gap-1">
                {DrawerIcon && <DrawerIcon size={13} />}
                {drawerContract.title}
              </div>
            </div>
            {drawerOpen && (
              <div className="h-[calc(100%-44px)] min-h-0 relative">
                {DrawerComp && (
                  <DrawerComp
                    podName={podName}
                    panelId={drawerPanelId}
                    surface="mobile"
                    maximized={false}
                    activate={() => setDrawerOpen(true)}
                    toggleMaximize={() => setDrawerSnap((s) => (s === 0.9 ? 0.25 : s === 0.5 ? 0.9 : 0.5))}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部切换条:面板图标 + 小字标签(质感对齐 MobileTabBar),最右 AI 按钮开合抽屉 */}
      <nav
        aria-label="IDE 面板切换"
        className="ide-mbar"
        style={{ paddingBottom: 'var(--sab)' }}
      >
        <div className="flex items-center justify-around">
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
                className={cn('ide-mbar-item', active && 'ide-mbar-item-active')}
              >
                <Icon size={18} />
                <span className="ide-mbar-label">{contract.title}</span>
              </button>
            )
          })}
          {/* AI 抽屉开关(布局里有 mobileDrawer 面板才显示) */}
          {drawerContract && (
            <button
              onClick={() => { haptic('light'); setDrawerOpen((o) => !o) }}
              aria-label={drawerOpen ? '收起 AI 助手' : '展开 AI 助手'}
              aria-pressed={drawerOpen}
              className={cn('ide-mbar-item', drawerOpen && 'ide-mbar-item-active')}
            >
              {DrawerIcon && <DrawerIcon size={18} />}
              <span className="ide-mbar-label">AI</span>
            </button>
          )}
        </div>
      </nav>
    </div>
  )
}
