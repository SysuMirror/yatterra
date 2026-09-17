import { useEffect } from 'react'
import { NavLink, Link, useLocation } from 'react-router'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import {
  LayoutDashboard, Box, Server, HardDrive, Database, Globe, Monitor, Network,
  Workflow, Plug, Bot, ShieldCheck, FolderOpen, Users, User,
  BookOpen, Swords, ChevronLeft, ChevronRight, X,
} from 'lucide-react'
import { useSidebarStore } from '@/stores/sidebar'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'
import { motionBind } from '@/lib/gesture'

import { useAuth } from '@/hooks/useAuth'

interface NavItem {
  to: string
  icon: React.ReactNode
  label: string
  perm?: string  // required permission; undefined = visible to all logged-in users
}

interface NavGroup {
  label: string
  to?: string  // clickable group header link
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: '',
    items: [
      { to: '/', icon: <LayoutDashboard size={18} />, label: '概览', perm: 'group.view' },
      { to: '/pods', icon: <Box size={18} />, label: 'Pod', perm: 'group.view' },
    ],
  },
  {
    label: '基础设施',
    to: '/infra',
    items: [
      { to: '/infra/host', icon: <Server size={18} />, label: '主机', perm: 'infra.host' },
      { to: '/infra/fleet', icon: <Network size={18} />, label: '集群', perm: 'infra.host' },
      { to: '/infra/gpu', icon: <Monitor size={18} />, label: 'GPU', perm: 'infra.host' },
      { to: '/infra/storage', icon: <HardDrive size={18} />, label: '存储', perm: 'infra.storage.read' },
      { to: '/infra/databases', icon: <Database size={18} />, label: '数据库', perm: 'infra.db.read' },
      { to: '/infra/proxy', icon: <Globe size={18} />, label: '子域名', perm: 'infra.proxy' },
    ],
  },
  {
    label: '开发',
    to: '/dev',
    items: [
      { to: '/dev/harness', icon: <Workflow size={18} />, label: '编排', perm: 'dev.harness' },
      { to: '/dev/mcp', icon: <Plug size={18} />, label: 'MCP', perm: 'dev.mcp' },
      { to: '/dev/llm', icon: <Bot size={18} />, label: 'LLM', perm: 'dev.llm' },
    ],
  },
  {
    label: '运维',
    to: '/ops',
    items: [
      { to: '/ops/audit', icon: <ShieldCheck size={18} />, label: '审计', perm: 'ops.audit' },
      { to: '/ops/shared', icon: <FolderOpen size={18} />, label: '共享', perm: 'ops.shared.read' },
      { to: '/threat-map', icon: <Swords size={18} />, label: '攻防', perm: 'ops.threat' },
    ],
  },
  {
    label: '',
    items: [
      { to: '/users', icon: <Users size={18} />, label: '用户', perm: 'admin.users' },
      { to: '/profile', icon: <User size={18} />, label: '个人' },
      { to: '/docs', icon: <BookOpen size={18} />, label: '文档' },
    ],
  },
]

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const location = useLocation()
  const { hasPerm } = useAuth()
  // Permission-filtered nav: drop items the user lacks perms for,
  // then drop whole groups whose items are all hidden.
  const visibleGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter((i) => !i.perm || hasPerm(i.perm)) }))
    .filter((group) => group.items.length > 0)
  return (
    <nav className="flex-1 py-3" aria-label="主导航">
      {visibleGroups.map((group, gi) => (
        <div key={gi}>
          {group.label && (
            <div
              className={cn(
                'py-2 text-[11px] font-semibold uppercase tracking-wider transition-opacity duration-150',
                collapsed ? 'opacity-0 h-0 py-0 overflow-hidden' : 'px-4 opacity-100',
              )}
            >
              {group.to ? (
                <Link to={group.to} className="text-muted hover:text-ink transition-colors">{group.label}</Link>
              ) : (
                <span className="text-muted">{group.label}</span>
              )}
            </div>
          )}
          {group.items.map((item) => {
            const isActive = item.to === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(item.to)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => { haptic('light'); onNavigate?.() }}
                title={collapsed ? item.label : undefined}
                className={({ isActive: active }) =>
                  cn(
                    'flex items-center rounded-md text-sm font-medium transition-all duration-150',
                    collapsed ? 'justify-center mx-2 w-10 h-10' : 'gap-3 mx-2 px-2.5 py-2',
                    active || isActive
                      ? 'bg-accent/10 text-accent font-semibold ring-1 ring-inset ring-accent/10'
                      : 'text-ink-2 hover:bg-black/[0.05] hover:text-ink active:bg-black/[0.08] active:scale-[0.97]',
                  )
                }
              >
                <span className="flex-shrink-0">{item.icon}</span>
                <span className={cn('whitespace-nowrap overflow-hidden', collapsed && 'sr-only')}>
                  {item.label}
                </span>
              </NavLink>
            )
          })}
          {gi < visibleGroups.length - 1 && group.label && (
            <div className={cn('mx-4 my-2 h-px bg-black/[0.06] transition-opacity duration-150', collapsed && 'opacity-0')} />
          )}
        </div>
      ))}
    </nav>
  )
}

const DRAWER_W = 260

export default function Sidebar() {
  const { collapsed, toggle, mobileOpen, setMobileOpen } = useSidebarStore()
  const isDesktop = useIsDesktop()

  // Mobile drawer: Esc closes; page scroll locks while open
  useEffect(() => {
    if (isDesktop || !mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [isDesktop, mobileOpen, setMobileOpen])

  if (isDesktop) {
    return (
      <motion.aside
        className="hidden md:flex h-full z-[var(--z-chrome)] flex-col flex-shrink-0 overflow-y-auto overflow-x-hidden"
        style={{
          background: 'rgba(255, 255, 255, 0.96)',
          backdropFilter: 'blur(var(--blur-sm)) saturate(160%)',
          WebkitBackdropFilter: 'blur(var(--blur-sm)) saturate(160%)',
          borderRight: '1px solid var(--line)',
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.03)',
        }}
        animate={{ width: collapsed ? 56 : 220 }}
        transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      >
        <NavList collapsed={collapsed} />
        <button
          onClick={() => { haptic('light'); toggle() }}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          className="flex items-center justify-center h-10 mx-2 mb-2 rounded-lg text-muted hover:bg-black/[0.05] hover:text-ink active:bg-black/[0.08] active:scale-95 transition-all duration-100"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </motion.aside>
    )
  }

  // Mobile: framer-motion drawer with swipe-to-close (never rendered on desktop)
  return (
    <div className="md:hidden">
      <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </div>
  )
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const x = useMotionValue(open ? 0 : -DRAWER_W)

  // Sync position when open state changes externally (hamburger button, escape key)
  useEffect(() => {
    animate(x, open ? 0 : -DRAWER_W, {
      type: 'spring',
      stiffness: 300,
      damping: 30,
    })
  }, [open])

  // Swipe-to-close gesture
  const bind = useDrag(
    ({ movement: [mx], velocity: [vx], active, cancel }) => {
      if (!open) { cancel(); return }

      if (active) {
        // Follow finger: only allow dragging left (negative movement)
        const clamped = Math.min(0, mx)
        // Rubber-band resistance when dragging past closed position
        if (clamped < -DRAWER_W) {
          const overshoot = clamped + DRAWER_W
          const rubber = (overshoot * DRAWER_W * 0.55) / (DRAWER_W + 0.55 * Math.abs(overshoot))
          x.set(-DRAWER_W + rubber)
        } else {
          x.set(clamped)
        }
        return
      }

      // On release: dismiss if dragged far enough or fast enough
      if (mx < -60 || (mx < -20 && vx < -0.3)) {
        onClose()
      } else {
        // Snap back open with velocity handoff
        animate(x, 0, { type: 'spring', stiffness: 300, damping: 30, velocity: vx })
      }
    },
    {
      axis: 'x',
      enabled: open,
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[var(--z-drawer)] md:hidden" style={{ pointerEvents: 'auto' }}>
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />

          {/* Drawer panel with gesture support */}
          <motion.aside
            role="dialog"
            aria-modal
            aria-label="导航菜单"
            className="absolute left-0 top-0 bottom-0 flex flex-col max-w-[85vw] bg-[#fafafb]"
            style={{
              x,
              width: DRAWER_W,
              paddingTop: 'var(--sat)',
              borderRight: '1px solid rgba(0,0,0,0.1)',
              boxShadow: '4px 0 24px rgba(0,0,0,0.12)',
            }}
            initial={{ x: -DRAWER_W }}
            animate={{ x: 0 }}
            exit={{ x: -DRAWER_W }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            {...motionBind(bind())}
          >
            <div className="flex items-center justify-between h-12 px-4 border-b border-black/[0.08] flex-shrink-0">
              <span className="text-sm font-bold tracking-tight">sseinfra</span>
              <button
                onClick={() => { haptic('light'); onClose() }}
                aria-label="关闭菜单"
                className="flex items-center justify-center w-10 h-10 rounded-lg text-muted hover:bg-black/[0.05] hover:text-ink active:bg-black/[0.08] active:scale-95 transition-all duration-100"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavList collapsed={false} onNavigate={onClose} />
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}
