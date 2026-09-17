import { cn } from '@/lib/cn'

interface SkeletonProps {
  className?: string
  width?: string | number
  height?: string | number
  rounded?: string
}

export function Skeleton({ className, width, height, rounded = 'rounded-lg' }: SkeletonProps) {
  return (
    <div
      className={cn('animate-pulse bg-black/[0.06]', rounded, className)}
      style={{ width, height }}
    />
  )
}

export function SkeletonCard() {
  return (
    <div className="p-5 rounded-2xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-3">
      <Skeleton width="60%" height={20} />
      <Skeleton width="100%" height={14} />
      <Skeleton width="40%" height={14} />
    </div>
  )
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <Skeleton width={28} height={28} rounded="rounded-full" />
          <Skeleton width="30%" height={14} />
          <Skeleton width="20%" height={14} />
          <Skeleton width="15%" height={14} className="ml-auto" />
        </div>
      ))}
    </div>
  )
}
