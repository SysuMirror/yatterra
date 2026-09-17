import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface Column<T> {
  key: string
  title: string
  sortable?: boolean
  /** CSS width value — supports px, fr, minmax(), auto, etc.
   *  For responsive flex columns use minmax() e.g. 'minmax(120px, 2fr)' */
  width?: string
  render?: (row: T, index: number) => React.ReactNode
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  keyFn: (row: T) => string
  onRowClick?: (row: T) => void
  empty?: React.ReactNode
  className?: string
}

type SortDir = 'asc' | 'desc' | null

export function DataTable<T>({ columns, data, keyFn, onRowClick, empty, className }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)

  const sorted = useMemo(() => {
    if (!sortKey || !sortDir) return data
    return [...data].sort((a, b) => {
      const av = (a as any)[sortKey]
      const bv = (b as any)[sortKey]
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, sortKey, sortDir])

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : sortDir === 'desc' ? null : 'asc')
      if (sortDir === 'desc') setSortKey(null)
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  if (!data.length) {
    return empty ? <div className="py-12">{empty}</div> : null
  }

  // Build grid-template-columns from column widths for proper flex sizing
  const gridCols = columns.map((col) => col.width || 'auto').join(' ')

  return (
    <div className={cn('overflow-x-auto rounded-xl border-[0.5px] border-black/[0.06]', className)}>
      <table className="w-full text-sm" style={{ tableLayout: 'auto' }}>
        <thead>
          <tr className="border-b border-black/[0.06] bg-black/[0.02]">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'px-3 py-2.5 text-left text-xs font-semibold text-muted whitespace-nowrap',
                  col.sortable && 'cursor-pointer select-none hover:text-ink',
                )}
                style={{ width: col.width?.includes('minmax') ? undefined : col.width, minWidth: col.width?.includes('minmax') ? undefined : undefined }}
              >
                <span className="inline-flex items-center gap-1">
                  {col.title}
                  {col.sortable && (
                    sortKey === col.key && sortDir ? (
                      sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                    ) : (
                      <ChevronsUpDown size={12} className="opacity-40" />
                    )
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <colgroup>
          {columns.map((col) => (
            <col
              key={col.key}
              style={col.width ? { width: col.width.includes('minmax') ? undefined : col.width } : undefined}
            />
          ))}
        </colgroup>
        <tbody>
          <AnimatePresence initial={false}>
            {sorted.map((row, i) => (
              <motion.tr
                key={keyFn(row)}
                className={cn(
                  'border-b border-black/[0.04] last:border-0',
                  onRowClick && 'cursor-pointer hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors',
                )}
                onClick={() => onRowClick?.(row)}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15, delay: Math.min(i * 0.02, 0.3) }}
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-2.5">
                    <div className="max-w-[320px] truncate">
                      {col.render ? col.render(row, i) : (row as any)[col.key]}
                    </div>
                  </td>
                ))}
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}
