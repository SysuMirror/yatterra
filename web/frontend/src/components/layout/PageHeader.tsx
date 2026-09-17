import type { ReactNode } from 'react'
import { DocHint } from '@/components/domain/DocHint'

interface PageHeaderProps {
  title: string
  description?: string
  count?: string | number
  actions?: ReactNode
  children?: ReactNode
  /** Deep link into /docs: section id + optional item index */
  doc?: { section: string; item?: number; label?: string }
}

export default function PageHeader({ title, description, count, actions, children, doc }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
      <div className="flex items-baseline gap-3 flex-wrap min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-ink">{title}</h1>
        {count !== undefined && count !== '' && (
          <span className="text-sm font-medium text-muted tnum">{count}</span>
        )}
        {description && (
          <span className="text-sm text-muted">{description}</span>
        )}
        {doc && (
          <DocHint section={doc.section} item={doc.item} label={doc.label ?? '使用文档'} />
        )}
      </div>
      {(actions || children) && (
        <div className="flex items-center gap-2 flex-wrap">
          {actions}
          {children}
        </div>
      )}
    </div>
  )
}
