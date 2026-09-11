import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Menu, LogOut, User, ChevronRight } from 'lucide-react'
import { useSidebarStore } from '@/stores/sidebar'
import { useAuthStore } from '@/stores/auth'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { Dialog } from '@/components/ui/Dialog'
import { authApi } from '@/api/auth'
import { useNavigate } from 'react-router'
import { haptic } from '@/lib/haptic'

export default function TopBar() {
  const { toggle, setMobileOpen } = useSidebarStore()
  const { user, role, logout } = useAuthStore()
  const isDesktop = useIsDesktop()
  const navigate = useNavigate()
  const [notifOpen, setNotifOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const notifRef = useRef<HTMLButtonElement>(null)
  const avatarRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })
  const [notifPos, setNotifPos] = useState({ top: 0, right: 0 })

  // Calculate position from a button ref — called synchronously on click
  const calcPos = useCallback((ref: React.RefObject<HTMLButtonElement | null>) => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      return { top: rect.bottom + 8, right: window.innerWidth - rect.right }
    }
    return { top: 0, right: 0 }
  }, [])

  // Open handlers: compute position FIRST, then open
  const openNotif = useCallback(() => {
    if (isDesktop) setNotifPos(calcPos(notifRef))
    setNotifOpen((v) => !v)
  }, [isDesktop, calcPos])

  const openProfile = useCallback(() => {
    if (isDesktop) setMenuPos(calcPos(avatarRef))
    setProfileOpen((v) => !v)
  }, [isDesktop, calcPos])

  // Recalc on window resize while open
  useEffect(() => {
    if (!profileOpen && !notifOpen) return
    const onResize = () => {
      if (profileOpen) setMenuPos(calcPos(avatarRef))
      if (notifOpen) setNotifPos(calcPos(notifRef))
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

  const initial = (user || '?').trim().charAt(0).toUpperCase() || '?'

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
        className="fixed top-0 left-0 right-0 z-50 flex items-center px-3 sm:px-4"
        style={{
          paddingTop: 'var(--sat)',
          minHeight: 'var(--topbar-h)',
          height: 'var(--topbar-h)',
          background: 'var(--surface-4)',
          backdropFilter: 'var(--blur-lg)',
          WebkitBackdropFilter: 'var(--blur-lg)',
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
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
          <span className="text-white font-bold text-sm tracking-tight">sseinfra</span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Notification bell */}
          <button
            ref={notifRef}
            aria-label="通知"
            onClick={() => { haptic('light'); openNotif() }}
            className="flex items-center justify-center w-10 h-10 rounded-lg text-white/50 hover:bg-white/10 hover:text-white/90 active:bg-white/15 active:scale-95 transition-all duration-100"
          >
            <Bell size={20} />
          </button>
          {!isDesktop && (
            <Dialog open={notifOpen} onClose={() => setNotifOpen(false)} title="通知">
              <div className="py-8 text-sm text-muted text-center">暂无通知</div>
            </Dialog>
          )}

          {/* Avatar button */}
          <button
            ref={avatarRef}
            onClick={() => { haptic('light'); openProfile() }}
            className="flex items-center justify-center w-10 h-10 rounded-full bg-white/12 border-[0.5px] border-white/15 hover:bg-white/18 active:bg-white/22 active:scale-95 transition-all duration-100"
            title={user || undefined}
            aria-label="用户菜单"
          >
            <span className="text-white/80 text-xs font-bold">{initial}</span>
          </button>
        </div>

        {/* Mobile: bottom sheet */}
        {!isDesktop && (
          <Dialog open={profileOpen} onClose={() => setProfileOpen(false)} title="账户">
            <div className="space-y-1 -mx-4 -mt-2">
              <div className="px-5 py-4 border-b border-black/[0.06]">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-full bg-accent/10 flex items-center justify-center">
                    <span className="text-accent text-sm font-bold">{initial}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink">{user || '—'}</p>
                    <p className="text-xs text-muted">{role || 'user'}</p>
                  </div>
                </div>
              </div>
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
      </header>

      {/* Desktop dropdowns via portal — position computed on click, not in useEffect */}
      {createPortal(
        <>
          {isDesktop && notifOpen && (
            <div
              id="notif-dropdown"
              className="fixed z-[60] w-64 rounded-xl bg-white shadow-2 border border-black/[0.06] p-4 text-sm text-ink-2 text-center"
              style={{ top: notifPos.top, right: notifPos.right }}
            >
              暂无通知
            </div>
          )}

          {isDesktop && profileOpen && (
            <div
              id="profile-dropdown"
              className="fixed z-[60] w-56 rounded-xl bg-white shadow-2 border border-black/[0.06] overflow-hidden"
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              <div className="px-4 py-3 border-b border-black/[0.06]">
                <p className="text-sm font-semibold text-ink truncate">{user || '—'}</p>
                <p className="text-xs text-muted mt-0.5">{role || 'user'}</p>
              </div>
              <div className="py-1">
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
        </>,
        document.body,
      )}
    </>
  )
}
