import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Menu, LogOut, User, ChevronRight, HelpCircle } from 'lucide-react'
import { useSidebarStore } from '@/stores/sidebar'
import { useAuthStore } from '@/stores/auth'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { Dialog } from '@/components/ui/Dialog'
import { authApi } from '@/api/auth'
import { useLocation, useNavigate } from 'react-router'
import { haptic } from '@/lib/haptic'
import { ThemePicker } from '@/components/ui/ThemePicker'

export default function TopBar() {
  const { toggle, setMobileOpen } = useSidebarStore()
  const { user, username, displayName, avatarUrl, role, logout } = useAuthStore()
  const isDesktop = useIsDesktop()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const hasGuide = pathname === '/' || pathname === '/pods' || pathname === '/docs' || /^\/pods\/[^/]+$/.test(pathname)
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

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } catch { /* best effort */ }
    logout()
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
            aria-label="通知"
            onClick={() => { haptic('light'); openNotif() }}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-white/50 hover:bg-white/10 hover:text-white/90 active:bg-white/15 active:scale-95 transition-all duration-100"
          >
            <Bell size={20} />
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
          <div className="py-8 text-sm text-muted text-center">暂无通知</div>
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
              className="absolute w-64 rounded-xl bg-white shadow-2 border border-black/[0.06] p-4 text-sm text-ink-2 text-center"
              style={{ top: notifPosRef.current.top, right: notifPosRef.current.right, pointerEvents: 'auto' }}
            >
              暂无通知
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
