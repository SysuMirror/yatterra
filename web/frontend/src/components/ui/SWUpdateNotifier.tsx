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
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)] flex items-center gap-2 px-5 py-3 rounded-2xl bg-accent text-white text-sm font-semibold hover:opacity-90 active:scale-[0.97] transition-all duration-150"
      style={{ boxShadow: '0 8px 32px rgba(10, 132, 255, 0.35)', paddingBottom: 'calc(0.75rem + var(--sab, 0px))' }}
    >
      <RefreshCw size={16} />
      刷新获取新版本
    </button>
  )
}
