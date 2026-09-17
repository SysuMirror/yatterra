/** Format a number with compact notation (e.g. 1.2K, 3.5M). */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return n.toFixed(0)
}

/** Format bytes to human-readable string. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`
}

/** Format a percentage with 1 decimal. */
export function formatPercent(value: number, total: number): string {
  if (total === 0) return '0%'
  return `${((value / total) * 100).toFixed(1)}%`
}

/** Format duration in seconds to human-readable. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
  }
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  return `${d}d ${h}h`
}

/** Format an ISO date string to relative time. */
export function formatRelativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

/** Format an ISO date string to a short date. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/** Format an ISO date string to a short datetime. */
export function formatDatetime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Pod status → Chinese label shown in the UI. */
export const POD_STATUS_LABELS: Record<string, string> = {
  Running: '运行中',
  Stopped: '已停止',
  Pending: '等待中',
  Failed: '失败',
  Succeeded: '已完成',
  Unknown: '未知',
}

export function podStatusLabel(status: string): string {
  return POD_STATUS_LABELS[status] ?? status
}

/** Compact resource spec, e.g. "4C · 8G · 2 GPU · 40G". */
export function formatSpec(cpu?: number | string | null, mem?: number | string | null, gpus?: number, storage?: number | string | null): string {
  const parts: string[] = []
  if (cpu != null && cpu !== '') parts.push(`${cpu}C`)
  if (mem != null && mem !== '') parts.push(`${mem}G`)
  if (gpus) parts.push(`${gpus} GPU`)
  if (storage != null && storage !== '') parts.push(`${storage}G`)
  return parts.join(' · ')
}
