import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <motion.div
      className={cn('flex flex-col items-center justify-center py-16 text-center', className)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
    >
      {icon && (
        <div className="w-12 h-12 mb-4 rounded-2xl flex items-center justify-center bg-black/[0.04] text-muted">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-ink mb-1">{title}</h3>
      {description && <p className="text-sm text-muted max-w-[280px]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </motion.div>
  )
}
