import { useLocation, useNavigate } from 'react-router'
import { motion } from 'framer-motion'
import { LayoutDashboard, Box, Server, Code2, Swords, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'
import { useLongPress } from '@/hooks/useLongPress'
import { openPodPicker } from '@/ide/PodPicker'

const tabs = [
  { key: 'home', path: '/console', icon: LayoutDashboard, label: '概览' },
  { key: 'pods', path: '/pods', icon: Box, label: 'Pod' },
  { key: 'infra', path: '/infra', icon: Server, label: '总览' },
  { key: 'ide', path: '/ide', icon: Code2, label: 'IDE' },
  { key: 'threat', path: '/threat-map', icon: Swords, label: '攻防' },
] as const

export function MobileTabBar() {
  const location = useLocation()
  const navigate = useNavigate()

  // Determine active tab by matching path prefix. The home tab points at
  // /console (the dashboard) — "/" is the public landing page, so it must not
  // be treated as the console's active state.
  const activeKey = tabs.find((t) => {
    if (t.path === '/console') return location.pathname === '/console'
    // /infra matches the overview and every nested infra page, not only /infra/host.
    if (t.path === '/infra') return location.pathname === '/infra' || location.pathname.startsWith('/infra/')
    return location.pathname.startsWith(t.path)
  })?.key ?? 'home'

  return (
    <nav
      className="mobile-tabbar fixed bottom-0 left-0 right-0 z-[var(--z-chrome)] md:hidden"
      style={{ paddingBottom: 'var(--sab)' }}
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map((tab) => (
          <TabButton
            key={tab.key}
            icon={tab.icon}
            label={tab.label}
            active={activeKey === tab.key}
            /** IDE Tab:单击仍是「回上次的 Pod」,长按弹出 Pod 切换器 */
            onLongPress={tab.key === 'ide' ? openPodPicker : undefined}
            onClick={() => navigate(tab.path)}
          />
        ))}
      </div>
    </nav>
  )
}

/** 单个 Tab。抽成组件是因为 useLongPress 是 hook,不能写在 .map 回调里。 */
function TabButton({
  icon: Icon,
  label,
  active,
  onClick,
  onLongPress,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
  onLongPress?: () => void
}) {
  const longPress = useLongPress({
    onLongPress: () => { onLongPress?.() },
    enabled: !!onLongPress,
    delay: 450,
  })

  return (
    <button
      onClick={() => {
        // 长按已经处理过了 → 吞掉随后这次 click,不要顺带导航
        if (longPress.wasLongPress()) return
        haptic('selection')
        onClick()
      }}
      aria-current={active ? 'page' : undefined}
      className="relative flex flex-col items-center justify-center w-16 h-14 active:scale-90 transition-transform duration-100"
      onPointerDown={onLongPress ? longPress.onPointerDown : undefined}
      onLostPointerCapture={onLongPress ? longPress.onLostPointerCapture : undefined}
    >
      {/* Active indicator pill */}
      {active && (
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
          active ? 'text-accent' : 'text-muted',
        )}
      />
      <span
        className={cn(
          'text-[10px] mt-0.5 relative z-10 transition-colors duration-150',
          active ? 'text-accent font-medium' : 'text-muted',
        )}
      >
        {label}
      </span>
    </button>
  )
}
