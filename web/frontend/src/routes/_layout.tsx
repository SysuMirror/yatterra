import { useRef, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Outlet } from 'react-router'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { useQueryClient } from '@tanstack/react-query'
import TopBar from '@/components/layout/TopBar'
import Sidebar from '@/components/layout/Sidebar'
import { MobileTabBar } from '@/components/layout/MobileTabBar'
import { AgentWidget } from '@/components/domain/AgentWidget'
import { AiContextMenu } from '@/components/domain/AiContextMenu'
import { PullToRefresh } from '@/components/ui/PullToRefresh'
import { OnboardingGuide } from '@/components/ui/OnboardingGuide'
import { useSidebarStore } from '@/stores/sidebar'
import { useNavStore } from '@/stores/nav'
import { useIsDesktop } from '@/hooks/useMediaQuery'

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
  const { mobileOpen, setMobileOpen } = useSidebarStore()
  const { direction, setDirection } = useNavStore()
  const qc = useQueryClient()
  const prevPathname = useRef(location.pathname)

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
      <TopBar />

      <div className="flex h-[calc(100dvh-var(--topbar-h))]" style={{ marginTop: 'var(--topbar-h)' }}>
        <Sidebar />
        <main
          {...edgeBind()}
          className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden touch-pan-y"
          style={!isDesktop ? { paddingBottom: 'var(--mobile-tabbar-h)' } : undefined}
        >
          <PullToRefresh
            enabled={!isDesktop}
            onRefresh={() => qc.invalidateQueries().then(() => {})}
          >
            <div className="px-3 py-4 sm:px-6 sm:py-6 lg:px-8 xl:px-10 2xl:mx-auto 2xl:max-w-[80%]">
              <AnimatePresence mode="wait">
                <motion.div
                  data-onboarding-page={location.pathname}
                  key={location.pathname}
                  initial={variants.initial}
                  animate={variants.animate}
                  exit={variants.exit}
                  transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
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
        </main>
      </div>

      {/* Mobile bottom tab bar — hidden when sidebar drawer is open */}
      {!isDesktop && !mobileOpen && <MobileTabBar />}

      <AgentWidget />
      <AiContextMenu />
      <OnboardingGuide />
    </div>
  )
}
