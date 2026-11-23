import { useRef, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Outlet } from 'react-router'
import { motion, AnimatePresence, useMotionValue, animate, useReducedMotion } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { useQueryClient } from '@tanstack/react-query'
import TopBar from '@/components/layout/TopBar'
import Sidebar from '@/components/layout/Sidebar'
import { MobileTabBar } from '@/components/layout/MobileTabBar'
import { GlobalAiAssistant } from '@/components/domain/GlobalAiAssistant'
import { AiContextMenu } from '@/components/domain/AiContextMenu'
import { PodPickerHost } from '@/ide/PodPicker'
import { PullToRefresh } from '@/components/ui/PullToRefresh'
import { OnboardingGuide } from '@/components/ui/OnboardingGuide'
import { useSidebarStore } from '@/stores/sidebar'
import { useNavStore } from '@/stores/nav'
import { useIsDesktop, useIsIdeDesktop } from '@/hooks/useMediaQuery'
import { APP_ROUTES } from '@/lib/appRoutes'

/** Apple-style rubber-band */
function rubberband(overshoot: number, dim: number, constant = 0.55): number {
  return (overshoot * dim * constant) / (dim + constant * Math.abs(overshoot))
}

// Page transition variants based on navigation direction
const forwardVariants = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
}

const backVariants = {
  initial: { opacity: 0, x: -40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
}

// Fallback for desktop — simple fade+slide
const desktopVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
}

export default function MainLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const isIdeDesktop = useIsIdeDesktop()
  const { mobileOpen, setMobileOpen } = useSidebarStore()
  const { direction, setDirection } = useNavStore()
  const qc = useQueryClient()
  const reduceMotion = useReducedMotion()
  const prevPathname = useRef(location.pathname)

  // 控制台界面为简体中文;公开页(reports/landing)自行覆盖 document lang
  useEffect(() => {
    document.documentElement.lang = 'zh-CN'
  }, [])

  useEffect(() => {
    const path = location.pathname
    const hit = APP_ROUTES.find((route) => {
      if (route.path === path) return true
      if (!route.path.includes(':')) return false
      const pat = route.path.split('/').filter(Boolean)
      const seg = path.split('/').filter(Boolean)
      return pat.length === seg.length && pat.every((part, i) => part.startsWith(':') || part === seg[i])
    })
    document.title = hit ? `${hit.label} · YatTerra` : 'YatTerra'
  }, [location.pathname])

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname, isDesktop, setMobileOpen])

  // Detect navigation direction by comparing path depth
  useEffect(() => {
    const prev = prevPathname.current
    const curr = location.pathname
    prevPathname.current = curr

    // Same path (e.g. query change) — no direction change
    if (prev === curr) return

    // Compare path depth: deeper = forward, shallower = back
    const prevDepth = prev.split('/').filter(Boolean).length
    const currDepth = curr.split('/').filter(Boolean).length

    if (currDepth > prevDepth) {
      setDirection('forward')
    } else if (currDepth < prevDepth) {
      setDirection('back')
    }
    // Same depth: keep current direction
  }, [location.pathname, setDirection])

  // Is this a detail page? (deeper than 1 segment, e.g. /pods/my-pod)
  const isDetailPage = !isDesktop && location.pathname.split('/').filter(Boolean).length > 1

  // Web IDE 需要整屏画布:去掉页面 padding / 下拉刷新 / 外层滚动,
  // 面板内部自己管理滚动。
  const isIdePage = /^\/pods\/[^/]+\/ide\/?$/.test(location.pathname)

  // 手机 IDE 接管唯一顶栏:平台 TopBar 让位,由 MobileIdeLayout 自绘
  // (☰ 导航 / ‹ 返回 Pod / pod 名 / ⋯ 面板配置),避免两条 48px 栏上下叠。
  // 桌面 IDE 仍保留平台 TopBar(那里 IDE 只有一条 36px 工具行)。
  // 用 useIsIdeDesktop(宽度 + 高度)与 IdeShell 的内核选择保持同一断言,否则横屏手机
  // 会一边渲染手机 IDE 顶栏一边保留平台 TopBar,两条栏又叠回来。
  const hideTopBar = isIdePage && !isIdeDesktop

  // 同一个断言也管平台常驻侧栏:横屏手机(844×390)平台 md: 判桌面,Sidebar 会
  // 走桌面分支 → 220px 常驻侧栏抢走窄屏宽度,而且 IDE 顶栏的 ☰ 调起抽屉时
  // mobileOpen 没人消费(抽屉只在手机分支渲染)。把 IDE 的结论透传下去。
  const ideMobile = isIdePage && !isIdeDesktop

  // ── Edge swipe: open sidebar OR go back ──
  // On detail pages: left-edge swipe = go back
  // On list/root pages: left-edge swipe = open sidebar
  const pageX = useMotionValue(0)

  const edgeBind = useDrag(
    ({ movement: [mx], velocity: [vx], active, cancel, initial: [startX], canceled }) => {
      if (isDesktop) { cancel(); return }

      if (canceled) { pageX.set(0); return }

      if (isDetailPage) {
        // Swipe-from-left-edge to go back
        if (startX > 24) { cancel(); return }
        if (mobileOpen) { cancel(); return }

        if (active) {
          // 1:1 finger tracking — page slides right
          const clamped = Math.max(0, mx)
          // Rubber-band past 50% screen width
          const maxDrag = window.innerWidth * 0.5
          if (clamped > maxDrag) {
            pageX.set(maxDrag + rubberband(clamped - maxDrag, maxDrag))
          } else {
            pageX.set(clamped)
          }
          return
        }

        // On release: go back or snap
        if (mx > 80 || (mx > 40 && vx > 0.3)) {
          animate(pageX, window.innerWidth, {
            type: 'spring',
            stiffness: 200,
            damping: 25,
            velocity: vx,
            onComplete: () => {
              pageX.set(0)
              navigate(-1)
            },
          })
        } else {
          animate(pageX, 0, { type: 'spring', stiffness: 400, damping: 30, velocity: vx })
        }
      } else {
        // Swipe-from-left-edge to open sidebar
        if (mobileOpen) { cancel(); return }
        if (startX > 24) { cancel(); return }
        if (!active && mx > 40) {
          setMobileOpen(true)
        }
      }
    },
    {
      axis: 'x',
      enabled: !isDesktop && !mobileOpen,
      filterTaps: false,
      pointer: { touch: true },
    },
  )

  // Choose transition variants based on direction and device
  const variants = isDesktop ? desktopVariants : (direction === 'forward' ? forwardVariants : backVariants)

  return (
    <div className="h-full min-h-0 overflow-hidden">
      {!hideTopBar && <TopBar />}

      <div
        className={hideTopBar ? 'flex h-[100dvh]' : 'flex h-[calc(100dvh-var(--topbar-h))]'}
        style={hideTopBar ? undefined : { marginTop: 'var(--topbar-h)' }}
      >
        <Sidebar forceMobile={ideMobile} />
        <main
          data-ux="ux-page-title"
          {...edgeBind()}
          className={
            isIdePage
              ? 'flex-1 min-w-0 overflow-hidden touch-auto'
              : 'flex-1 min-w-0 overflow-y-auto overflow-x-hidden touch-pan-y'
          }
          style={!isDesktop && !isIdePage ? { paddingBottom: 'var(--mobile-tabbar-h)' } : undefined}
        >
          {isIdePage ? (
            // IDE:整屏画布,无 padding / 无转场动画(dockview 拖拽不受 transform 影响)
            <div className="h-full">
              <Outlet />
            </div>
          ) : (
            <PullToRefresh
              enabled={!isDesktop}
              onRefresh={() => qc.invalidateQueries().then(() => {})}
            >
              <div className="px-3 py-4 sm:px-6 sm:py-6 lg:px-8 xl:px-10 2xl:mx-auto 2xl:max-w-[80%]">
                <AnimatePresence mode="wait">
                  <motion.div
                    data-onboarding-page={location.pathname}
                    data-ux="ux-reduced-motion"
                    key={location.pathname}
                    initial={reduceMotion ? false : variants.initial}
                    animate={variants.animate}
                    exit={reduceMotion ? undefined : variants.exit}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                    style={{
                      willChange: 'opacity, transform',
                      // Swipe-to-go-back: page follows finger
                      x: isDetailPage ? pageX : 0,
                    }}
                  >
                    <Outlet />
                  </motion.div>
                </AnimatePresence>
              </div>
            </PullToRefresh>
          )}
        </main>
      </div>

      {/* Mobile bottom tab bar — hidden when sidebar drawer is open; IDE 自带底栏 */}
      {!isDesktop && !mobileOpen && !isIdePage && <MobileTabBar />}

      {/* IDE 有自己的 AI 面板,不再叠全局助手 */}
      {!isIdePage && <GlobalAiAssistant />}
      {/* Pod 切换器宿主:IDE 顶栏 pod 名 / 底栏 IDE Tab 长按 / 侧栏 IDE 右键 都落到这里 */}
      <PodPickerHost />
      <AiContextMenu />
      <OnboardingGuide />
    </div>
  )
}
