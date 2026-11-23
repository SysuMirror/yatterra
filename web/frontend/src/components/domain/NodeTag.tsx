import { cn } from '../../lib/cn'

/** Location badge: which cluster node a pod runs on (wz8 / spark / …).
 *  Non-default nodes get an accent tint so remote placements stand out. */
export function NodeTag({ node, className }: { node?: string | null; className?: string }) {
  const n = node || 'wz8'
  const isRemote = n !== 'wz8'
  return (
    <span
      title={`运行节点: ${n}`}
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-mono font-medium whitespace-nowrap',
        isRemote ? 'bg-accent/10 text-accent-dark' : 'bg-black/[0.04] text-muted',
        className,
      )}
    >
      {n}
    </span>
  )
}
