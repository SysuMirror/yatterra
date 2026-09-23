import { useLocation, useNavigate } from 'react-router'
import { motion } from 'framer-motion'
import { LayoutDashboard, Box, Server, Workflow, Swords } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

const tabs = [
  { key: 'home', path: '/', icon: LayoutDashboard, label: '概览' },
  { key: 'pods', path: '/pods', icon: Box, label: 'Pod' },
  { key: 'host', path: '/infra/host', icon: Server, label: '主机' },
  { key: 'harness', path: '/dev/harness', icon: Workflow, label: '编排' },
  { key: 'threat', path: '/threat-map', icon: Swords, label: '攻防' },
] as const

export function MobileTabBar() {
  const location = useLocation()
  const navigate = useNavigate()

  // Determine active tab by matching path prefix
  const activeKey = tabs.find((t) => {
    if (t.path === '/') return location.pathname === '/'
    return location.pathname.startsWith(t.path)
  })?.key ?? 'home'

  return (
    <nav
      className="mobile-tabbar fixed bottom-0 left-0 right-0 z-[var(--z-chrome)] md:hidden"
      style={{ paddingBottom: 'var(--sab)' }}
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map((tab) => {
          const isActive = activeKey === tab.key
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              onClick={() => { haptic('selection'); navigate(tab.path) }}
              aria-current={isActive ? 'page' : undefined}
              className="relative flex flex-col items-center justify-center w-16 h-14 active:scale-90 transition-transform duration-100"
            >
              {/* Active indicator pill */}
              {isActive && (
                <motion.div
                  layoutId="mobileTabIndicator"
                  className="absolute top-1 left-1/2 -translate-x-1/2 w-5 h-0.5 rounded-full bg-accent"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <Icon
                size={20}
                className={cn(
                  'relative z-10 transition-colors duration-150',
                  isActive ? 'text-accent' : 'text-muted',
                )}
              />
              <span
                className={cn(
                  'text-[10px] mt-0.5 relative z-10 transition-colors duration-150',
                  isActive ? 'text-accent font-medium' : 'text-muted',
                )}
              >
                {tab.label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
