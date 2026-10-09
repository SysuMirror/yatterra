import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Menu, LogOut, User, ChevronRight, HelpCircle, CheckCheck } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSidebarStore } from '@/stores/sidebar'
import { useAuthStore } from '@/stores/auth'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { Dialog } from '@/components/ui/Dialog'
import { authApi } from '@/api/auth'
import { pushApi, type PushEvent } from '@/api/notifications'
import { useLocation, useNavigate } from 'react-router'
import { haptic } from '@/lib/haptic'
import { ThemePicker } from '@/components/ui/ThemePicker'
import { formatRelativeTime } from '@/lib/format'

function eventTime(ts: number): string {
  try { return formatRelativeTime(new Date(ts * 1000).toISOString()) } catch { return '' }
}

export default function TopBar() {
  const { toggle, setMobileOpen } = useSidebarStore()
  const { user, username, displayName, avatarUrl, role, logout } = useAuthStore()
  const isDesktop = useIsDesktop()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const hasGuide = true
  const [notifOpen, setNotifOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)
  const notifRef = useRef<HTMLButtonElement>(null)
  const avatarRef = useRef<HTMLButtonElement>(null)
  // Store position in a ref so the dropdown reads it synchronously on mount
  const menuPosRef = useRef({ top: 0, right: 0 })
  const notifPosRef = useRef({ top: 0, right: 0 })
  // Also keep state to trigger re-renders when position changes (resize)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })
  const [notifPos, setNotifPos] = useState({ top: 0, right: 0 })

  const calcPos = useCallback((ref: React.RefObject<HTMLButtonElement | null>) => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      return { top: rect.bottom + 8, right: window.innerWidth - rect.right }
    }
    return { top: 60, right: 8 } // fallback: below typical topbar
  }, [])

  const openNotif = useCallback(() => {
    const pos = calcPos(notifRef)
    notifPosRef.current = pos
    if (isDesktop) setNotifPos(pos)
    setNotifOpen((v) => !v)
  }, [isDesktop, calcPos])

  const openProfile = useCallback(() => {
    const pos = calcPos(avatarRef)
    menuPosRef.current = pos
    if (isDesktop) setMenuPos(pos)
    setProfileOpen((v) => !v)
  }, [isDesktop, calcPos])

  // Recalc on window resize while open
  useEffect(() => {
    if (!profileOpen && !notifOpen) return
    const onResize = () => {
      if (profileOpen) {
        const pos = calcPos(avatarRef)
        menuPosRef.current = pos
        setMenuPos(pos)
      }
      if (notifOpen) {
        const pos = calcPos(notifRef)
        notifPosRef.current = pos
        setNotifPos(pos)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [profileOpen, notifOpen, calcPos])

  // Click-outside dismiss for desktop dropdown
  useEffect(() => {
    if (!profileOpen && !notifOpen) return
    if (!isDesktop) return
    const handleClick = (e: MouseEvent) => {
      if (notifOpen && notifRef.current && !notifRef.current.contains(e.target as Node)) {
        const notifEl = document.getElementById('notif-dropdown')
        if (!notifEl || !notifEl.contains(e.target as Node)) setNotifOpen(false)
      }
      if (profileOpen && avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        const menuEl = document.getElementById('profile-dropdown')
        if (!menuEl || !menuEl.contains(e.target as Node)) {
          setProfileOpen(false)
        }
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [notifOpen, profileOpen, isDesktop])

  const shownName = displayName || username || user || '?'; const initial = shownName.trim().charAt(0).toUpperCase() || '?'

  // ── 通知中心数据 ──
  const qc = useQueryClient()
  const [notifKind, setNotifKind] = useState<string>('')
  const { data: notifData } = useQuery({
    queryKey: ['push-events', notifKind],
    queryFn: () => pushApi.events({ limit: 20, kind: notifKind || undefined }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const notifEvents: PushEvent[] = notifData?.events ?? []
  const unreadCount = notifData?.unread ?? 0

  const markRead = useMutation({
    mutationFn: (keys: string[]) => pushApi.markRead(keys),
    onSettled: () => qc.invalidateQueries({ queryKey: ['push-events'] }),
  })
  const markAllRead = useMutation({
    mutationFn: () => pushApi.markAllRead(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['push-events'] }),
  })

  const NOTIF_KIND_CHIPS: { label: string; kind: string }[] = [
    { label: '全部', kind: '' },
    { label: '故障', kind: 'pod-down' },
    { label: '部署', kind: 'deploy-result' },
    { label: '审批', kind: 'approval-pending' },
    { label: '系统', kind: 'broadcast' },
  ]

  const openEvent = (ev: PushEvent) => {
    if (!ev.read) markRead.mutate([ev.event_key])
    setNotifOpen(false)
    if (ev.url) navigate(ev.url)
  }

  const NotifList = ({ compact }: { compact?: boolean }) => (
    <>
      <div className={`flex items-center justify-between ${compact ? 'px-5 py-3 border-b border-black/[0.06]' : 'mb-3'}`}>
        <span className="text-xs text-muted">
          {unreadCount > 0 ? `${unreadCount} 条未读` : notifEvents.length > 0 ? '最近通知' : '通知'}
        </span>
        {unreadCount > 0 && (
          <button
            data-onboarding-target="notifications-read-all"
            onClick={() => { haptic('light'); markAllRead.mutate() }}
            disabled={markAllRead.isPending}
            className="flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50"
          >
            <CheckCheck size={13} /> 全部已读
          </button>
        )}
      </div>
      <div data-onboarding-target="notifications-filter" className={`flex items-center gap-1.5 overflow-x-auto ${compact ? 'px-5 py-2 border-b border-black/[0.06]' : 'mb-2'}`}>
        {NOTIF_KIND_CHIPS.map((c) => (
          <button
            key={c.kind}
            onClick={() => { haptic('light'); setNotifKind(c.kind) }}
            className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors ${
              notifKind === c.kind
                ? 'bg-accent text-white font-semibold'
                : 'bg-black/[0.05] text-ink-2 hover:bg-black/[0.08]'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      {notifEvents.length === 0 ? (
        <div className="py-8 text-sm text-muted text-center">暂无通知</div>
      ) : (
        <div className={compact ? '' : 'max-h-[360px] overflow-y-auto'}>
          {notifEvents.map((ev) => (
            <button
              key={ev.event_key}
              onClick={() => { haptic('light'); openEvent(ev) }}
              className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-black/[0.03] active:bg-black/[0.06] transition-colors"
            >
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${ev.read ? 'bg-black/15' : 'bg-accent'}`} />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm truncate ${ev.read ? 'text-ink-2' : 'text-ink font-semibold'}`}>{ev.title}</span>
                <span className="block text-xs text-muted line-clamp-2">{ev.body}</span>
                <span className="block text-[10px] text-muted/70 mt-0.5 tnum">{eventTime(ev.ts)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } catch { /* best effort */ }
    logout()
    // 清掉 React Query 缓存:auth-check 里还缓存着 is_logged_in=true,
    // 不清的话退出后再进受保护页会被缓存"复活"成死 session 的假登录态。
    qc.clear()
    setProfileOpen(false)
    navigate('/login')
  }

  return (
    <>
      <header
        className="fixed top-0 left-0 right-0 z-[var(--z-chrome)] flex items-center px-3 sm:px-4"
        style={{
          paddingTop: 'var(--sat)',
          minHeight: 'var(--topbar-h)',
          height: 'var(--topbar-h)',
          background: 'rgba(23, 33, 43, 0.96)',
          backdropFilter: 'var(--blur-lg)',
          WebkitBackdropFilter: 'var(--blur-lg)',
          borderBottom: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        {/* Hamburger */}
        <button
          onClick={() => { haptic('light'); isDesktop ? toggle() : setMobileOpen(true) }}
          aria-label={isDesktop ? '收起侧栏' : '打开菜单'}
          className="flex items-center justify-center w-10 h-10 rounded-lg text-white/60 hover:bg-white/10 hover:text-white/90 active:bg-white/15 active:scale-95 transition-all duration-100"
        >
          <Menu size={20} />
        </button>

        <div className="flex items-center gap-2 ml-2 sm:ml-3">
          <div className="w-2 h-2 rounded-full bg-accent shadow-[0_0_8px_rgba(10,132,255,0.5)]" />
          <span className="text-white font-bold text-sm tracking-tight">YatTerra</span>
        </div>

        <div className="flex min-w-0 items-center gap-1.5 ml-auto">
          {/* Page onboarding guide */}
          <button
            type="button"
            data-onboarding-ui
            data-onboarding-launcher
            aria-label={hasGuide ? '打开新手指引' : '打开入门文档'}
            title={hasGuide ? '新手指引' : '入门文档'}
            onClick={() => { haptic('light'); hasGuide ? window.dispatchEvent(new CustomEvent('yatterra:onboarding-toggle')) : navigate('/docs') }}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-white/50 hover:bg-white/10 hover:text-white/90 active:bg-white/15 active:scale-95 transition-all duration-100"
          >
            <HelpCircle size={20} />
          </button>

          {/* Notification bell */}
          <button
            ref={notifRef}
            data-onboarding-target="notifications-bell"
            aria-label="通知"
            onClick={() => { haptic('light'); openNotif() }}
            className="relative flex items-center justify-center w-10 h-10 rounded-lg text-white/50 hover:bg-white/10 hover:text-white/90 active:bg-white/15 active:scale-95 transition-all duration-100"
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[16px] h-[16px] px-1 rounded-full bg-bad text-white text-[10px] font-bold flex items-center justify-center tnum">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {/* Avatar button */}
          <button
            ref={avatarRef}
            onClick={() => { haptic('light'); openProfile() }}
            className="relative flex shrink-0 items-center justify-center w-11 h-11 overflow-hidden rounded-full bg-white/12 border-[0.5px] border-white/15 hover:bg-white/18 active:bg-white/22 active:scale-95 transition-all duration-100"
            title={shownName || undefined}
            aria-label="用户菜单"
          >
            {avatarUrl && failedAvatar !== avatarUrl
              ? <img key={avatarUrl} src={avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailedAvatar(avatarUrl)} />
              : <span className="text-white/80 text-xs font-bold">{initial}</span>}
          </button>
        </div>
      </header>

      {/* Mobile dialogs — rendered OUTSIDE <header> so their position:fixed
          isn't trapped by the header's backdrop-filter containing block
          (which would pin the bottom sheet to the top of the viewport). */}
      {!isDesktop && (
        <Dialog open={notifOpen} onClose={() => setNotifOpen(false)} title="通知">
          <div className="-mx-4 -mt-2">
            <NotifList compact />
          </div>
        </Dialog>
      )}
      {!isDesktop && (
        <Dialog open={profileOpen} onClose={() => setProfileOpen(false)} title="账户">
          <div className="space-y-1 -mx-4 -mt-2">
            <div className="px-5 py-4 border-b border-black/[0.06]">
              <div className="flex items-center gap-3">
                <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/10">
                  {avatarUrl && failedAvatar !== avatarUrl
                    ? <img key={avatarUrl} src={avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailedAvatar(avatarUrl)} />
                    : <span className="text-accent text-sm font-bold">{initial}</span>}
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink">{shownName || '—'}</p>
                  <p className="text-xs text-muted">{role || 'user'}</p>
                </div>
              </div>
            </div>
            <div className="px-4 py-3"><ThemePicker /></div>
            <button
              onClick={() => { haptic('light'); setProfileOpen(false); navigate('/profile') }}
              className="w-full flex items-center gap-3 px-5 py-3.5 text-sm text-ink-2 hover:bg-black/[0.03] active:bg-black/[0.06] active:scale-[0.98] transition-all text-left"
            >
              <User size={16} className="text-muted" />
              <span className="flex-1">个人管理</span>
              <ChevronRight size={14} className="text-muted/50" />
            </button>
            <button
              onClick={() => { haptic('heavy'); handleLogout() }}
              className="w-full flex items-center gap-3 px-5 py-3.5 text-sm text-red-600 hover:bg-red-50 active:bg-red-100 active:scale-[0.98] transition-all text-left"
            >
              <LogOut size={16} />
              <span className="flex-1">退出登录</span>
            </button>
          </div>
        </Dialog>
      )}

      {/* Desktop dropdowns via portal — uses a fixed overlay container so
          position:absolute inside it behaves like fixed but without
          containing-block pitfalls from backdrop-filter etc. */}
      {createPortal(
        <div
          id="topbar-dropdown-layer"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 'var(--z-popover)',
            pointerEvents: 'none',
          }}
        >
          {isDesktop && notifOpen && (
            <div
              id="notif-dropdown"
              data-onboarding-target="notifications-panel"
              className="absolute w-80 rounded-xl bg-white shadow-2 border border-black/[0.06] p-4 text-sm text-ink-2"
              style={{ top: notifPosRef.current.top, right: notifPosRef.current.right, pointerEvents: 'auto' }}
            >
              <NotifList />
            </div>
          )}

          {isDesktop && profileOpen && (
            <div
              id="profile-dropdown"
              className="absolute w-72 rounded-xl bg-surface-0 shadow-2 border border-black/[0.06] overflow-hidden"
              style={{ top: menuPosRef.current.top, right: menuPosRef.current.right, pointerEvents: 'auto' }}
            >
              <div className="px-4 py-3 border-b border-black/[0.06]">
                <p className="text-sm font-semibold text-ink truncate">{shownName || '—'}</p>
                <p className="text-xs text-muted mt-0.5">{role || 'user'}</p>
              </div>
              <div className="py-1">
                <div className="px-3 py-2"><ThemePicker /></div>
                <button
                  onClick={() => { haptic('light'); setProfileOpen(false); navigate('/profile') }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-ink-2 hover:bg-black/[0.03] active:bg-black/[0.06] active:scale-[0.98] transition-all text-left"
                >
                  <User size={15} className="text-muted" />
                  <span className="flex-1">个人管理</span>
                  <ChevronRight size={14} className="text-muted/50" />
                </button>
                <button
                  onClick={() => { haptic('heavy'); handleLogout() }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 active:bg-red-100 active:scale-[0.98] transition-all text-left"
                >
                  <LogOut size={15} />
                  <span className="flex-1">退出登录</span>
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
