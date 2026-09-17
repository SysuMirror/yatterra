import { useEffect, useState, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { checkForUpdate, onStatusChange, getStatus, type UpdateStatus } from '@/lib/sw-update'

/**
 * Auto + manual PWA update notifier:
 *
 * - Auto: checks every 5 min + on visibility change (PWA back to foreground)
 * - When new version found → shows bottom "刷新获取新版本" button
 * - User taps → page reloads with new code (controllerchange in main.tsx)
 * - Also exports a manual trigger for the "检查更新" button in profile
 */
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 min

export function SWUpdateNotifier() {
  const [status, setStatus] = useState<UpdateStatus>(getStatus())
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    onStatusChange(setStatus)

    // Periodic auto-check
    timerRef.current = setInterval(() => {
      checkForUpdate()
    }, CHECK_INTERVAL)

    // Check when PWA returns to foreground
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (status !== 'found') return null

  return (
    <button
      onClick={() => location.reload()}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)]
        flex items-center gap-2 px-5 py-3 rounded-2xl
        bg-accent text-white text-sm font-semibold
        hover:opacity-90 active:scale-[0.97]
        transition-all duration-150"
      style={{
        boxShadow: '0 8px 32px rgba(10, 132, 255, 0.35)',
        paddingBottom: 'calc(0.75rem + var(--sab, 0px))',
      }}
    >
      <RefreshCw size={16} />
      刷新获取新版本
    </button>
  )
}
