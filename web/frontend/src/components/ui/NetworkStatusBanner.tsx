import { WifiOff } from 'lucide-react'
import { useNetworkStatus } from '@/lib/network-status'

export function NetworkStatusBanner() {
  const online = useNetworkStatus()
  if (online) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[var(--z-toast)] flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[#1d1d1f]/95"
      style={{ paddingTop: 'calc(0.5rem + var(--sat, 0px))' }}
    >
      <WifiOff size={14} aria-hidden="true" />
      <span>当前离线：已缓存的页面仍可查看，数据操作将在恢复网络后重试</span>
    </div>
  )
}
