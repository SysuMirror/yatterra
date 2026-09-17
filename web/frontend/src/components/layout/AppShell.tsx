import { useLocation } from 'react-router'
import { Outlet } from 'react-router'
import { motion, AnimatePresence } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import TopBar from './TopBar'
import Sidebar from './Sidebar'
import { MobileTabBar } from './MobileTabBar'
import { AgentWidget } from '@/components/domain/AgentWidget'
import { useSidebarStore } from '@/stores/sidebar'
import { useIsDesktop } from '@/hooks/useMediaQuery'

export default function AppShell() {
  const isDesktop = useIsDesktop()
  const { mobileOpen, setMobileOpen } = useSidebarStore()
  const location = useLocation()

  // Left-edge swipe to open sidebar on mobile
  const edgeBind = useDrag(
    ({ movement: [mx], active, cancel, event }) => {
      if (isDesktop || mobileOpen) { cancel(); return }

      // Only activate from the left 24px edge
      const startX = (event as PointerEvent).clientX
      if (startX > 24) { cancel(); return }

      if (!active && mx > 40) {
        setMobileOpen(true)
      }
    },
    {
      axis: 'x',
      enabled: !isDesktop && !mobileOpen,
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  return (
    <div className="min-h-screen bg-transparent">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[var(--z-skip)] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-2">跳转到主要内容</a>
      <TopBar />

      {/* Left-edge swipe zone to open sidebar (mobile only) */}
      {!isDesktop && !mobileOpen && (
        <div
          className="fixed top-0 left-0 bottom-0 w-6 z-[var(--z-edge)] touch-pan-y"
          {...edgeBind()}
          aria-hidden="true"
        />
      )}

      {/* Main content */}
      <div className="flex" style={{ paddingTop: 'var(--topbar-h)' }}>
        <Sidebar />
        <main
          id="main-content" aria-label="主要内容" className="flex-1 min-w-0 min-h-0 min-h-[calc(100vh-var(--topbar-h))]"
          style={!isDesktop ? { paddingBottom: 'var(--mobile-tabbar-h)' } : undefined}
        >
          <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-6 sm:py-6 lg:px-8 xl:px-10">
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {!isDesktop && <MobileTabBar />}

      <AgentWidget />
    </div>
  )
}
