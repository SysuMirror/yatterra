import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { acceptUpdate, checkForUpdate, onStatusChange, getStatus, type UpdateStatus } from '@/lib/sw-update'

const CHECK_INTERVAL = 5 * 60 * 1000

export function SWUpdateNotifier() {
  const [status, setStatus] = useState<UpdateStatus>(getStatus())

  useEffect(() => {
    const unsubscribe = onStatusChange(setStatus)
    const check = () => { if (document.visibilityState === 'visible' && navigator.onLine) void checkForUpdate() }
    const timer = window.setInterval(check, CHECK_INTERVAL)
    document.addEventListener('visibilitychange', check)
    void checkForUpdate()
    return () => {
      unsubscribe()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  if (status !== 'found') return null

  return (
    <button
      onClick={() => { void acceptUpdate() }}
      className="fixed bottom-[calc(var(--mobile-tabbar-h,0px)+1rem)] left-1/2 -translate-x-1/2 z-[var(--z-toast)] inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 rounded-2xl bg-accent/90 glass-blur text-white text-sm font-semibold hover:bg-accent active:scale-[0.97] transition-all duration-150 md:bottom-6"
      style={{ boxShadow: '0 8px 32px rgba(10, 132, 255, 0.35)' }}
    >
      <RefreshCw size={16} />
      刷新获取新版本
    </button>
  )
}
