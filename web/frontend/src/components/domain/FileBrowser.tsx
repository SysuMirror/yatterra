import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Folder, File, ChevronRight, FolderPlus, FilePlus, Download, Copy, Trash2, Sparkles, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'
import { useLongPress } from '@/hooks/useLongPress'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet'
import { aiApi } from '@/api/ai'

export interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
  modified?: string
  path?: string
  children?: FileEntry[]
}

interface FileBrowserProps {
  entries: FileEntry[]
  onOpen: (path: string) => void
  onExpand?: (path: string) => Promise<FileEntry[]>
  onDownload?: (path: string) => void
  onCreateFile?: (path: string) => void
  onCreateDir?: (path: string) => void
  onDelete?: (path: string) => void
  className?: string
}

export function FileBrowser({ entries, onOpen, onExpand, onDownload, onCreateFile, onCreateDir, onDelete, className }: FileBrowserProps) {
  const [aiQuery, setAiQuery] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMatches, setAiMatches] = useState<Set<string> | null>(null)

  // Flatten entries for AI search
  const flattenPaths = useCallback((items: FileEntry[], prefix = '/'): string[] => {
    const paths: string[] = []
    for (const item of items) {
      const p = `${prefix}${item.name}`
      paths.push(p)
      if (item.children?.length) {
        paths.push(...flattenPaths(item.children, `${p}/`))
      }
    }
    return paths
  }, [])

  const handleAiSearch = async () => {
    const q = aiQuery.trim()
    if (!q) { setAiMatches(null); return }
    setAiLoading(true)
    try {
      const allPaths = flattenPaths(entries)
      const res = await aiApi.analyze({
        text: `文件列表:\n${allPaths.join('\n')}\n\n用户查找: ${q}\n\n返回最匹配的文件路径，每行一个，只返回路径不要解释。`,
        task: 'explain',
      })
      const matched = new Set(
        res.content.split('\n').map(l => l.trim().replace(/^\s*[-*•]\s*/, '')).filter(l => l.startsWith('/'))
      )
      setAiMatches(matched.size > 0 ? matched : null)
    } catch {
      setAiMatches(null)
    } finally {
      setAiLoading(false)
    }
  }

  const isMatch = (path: string): boolean => {
    if (!aiMatches) return false
    for (const m of aiMatches) {
      if (path === m || path.startsWith(m) || m.startsWith(path)) return true
    }
    return false
  }

  return (
    <div className={cn('text-sm', className)}>
      {/* AI search bar */}
      <div className="flex items-center gap-1.5 mb-2 px-2">
        <Sparkles size={12} className="text-accent flex-shrink-0" />
        <input
          value={aiQuery}
          onChange={(e) => setAiQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAiSearch() }}
          placeholder="AI 搜索文件: 描述要找的文件..."
          className="flex-1 px-2 py-1 rounded-md text-xs bg-black/[0.03] border-0 focus:outline-none focus:ring-1 focus:ring-accent/20"
        />
        {aiLoading && <Loader2 size={12} className="animate-spin text-muted" />}
        {aiMatches && <button onClick={() => { setAiMatches(null); setAiQuery('') }} className="text-xs text-muted hover:text-ink">清除</button>}
      </div>
      {(onCreateFile || onCreateDir) && (
        <div className="flex items-center gap-1 mb-2 px-2">
          {onCreateFile && (
            <button onClick={() => { haptic('light'); onCreateFile('/') }} className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted hover:text-ink hover:bg-black/[0.04] active:scale-95 transition-all">
              <FilePlus size={12} /> 新文件
            </button>
          )}
          {onCreateDir && (
            <button onClick={() => { haptic('light'); onCreateDir('/') }} className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted hover:text-ink hover:bg-black/[0.04] active:scale-95 transition-all">
              <FolderPlus size={12} /> 新目录
            </button>
          )}
        </div>
      )}
      {entries.map((entry) => (
        <FileNode key={entry.name} entry={entry} path="/" onOpen={onOpen} onExpand={onExpand} onDownload={onDownload} onDelete={onDelete} depth={0} isMatch={isMatch} />
      ))}
    </div>
  )
}

function FileNode({ entry, path, onOpen, onExpand, onDownload, onDelete, depth, highlighted, isMatch }: {
  entry: FileEntry
  path: string
  onOpen: (path: string) => void
  onExpand?: (path: string) => Promise<FileEntry[]>
  onDownload?: (path: string) => void
  onDelete?: (path: string) => void
  depth: number
  highlighted?: boolean
  isMatch?: (path: string) => boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | undefined>(entry.children)
  const loadingRef = useRef(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const fullPath = `${path}${entry.name}`
  const isDir = entry.type === 'dir'
  const navPath = entry.path || fullPath
  const nodeHighlighted = isMatch ? isMatch(navPath) : highlighted
  const isDesktop = useIsDesktop()

  const handleToggle = async () => {
    if (!isDir) {
      haptic('light')
      onOpen(navPath)
      return
    }
    haptic('light')
    if (loadingRef.current) return
    if (!expanded && !children && onExpand) {
      loadingRef.current = true
      setLoading(true)
      setLoadError(false)
      try {
        const kids = await onExpand(navPath)
        setChildren(kids)
        setExpanded(true)
      } catch {
        setLoadError(true)
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
      return
    }
    setExpanded(!expanded)
  }

  // Long-press context menu (mobile only)
  const longPress = useLongPress({
    onLongPress: () => {
      if (!isDesktop) setCtxOpen(true)
    },
    enabled: !isDesktop,
  })

  const ctxItems: ActionSheetItem[] = [
    {
      key: 'copy-path',
      label: '复制路径',
      icon: <Copy size={16} />,
      onClick: () => { navigator.clipboard.writeText(navPath) },
    },
  ]
  if (!isDir && onDownload) {
    ctxItems.push({
      key: 'download',
      label: '下载',
      icon: <Download size={16} />,
      onClick: () => onDownload(navPath),
    })
  }
  if (onDelete) {
    ctxItems.push({
      key: 'delete',
      label: '删除',
      icon: <Trash2 size={16} />,
      danger: true,
      onClick: () => onDelete(navPath),
    })
  }

  // Responsive indent: 12px on mobile, 16px on larger
  const indent = depth * 16 + 8

  return (
    <div>
      <div
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-2 sm:py-1.5 rounded-lg text-sm',
          'hover:bg-black/[0.03] active:bg-black/[0.06] transition-colors',
          isDir && 'cursor-pointer',
          nodeHighlighted && 'bg-accent/10 ring-1 ring-accent/30',
        )}
        style={{ paddingLeft: `${indent}px` }}
        {...longPress}
      >
        <button
          className="flex-1 flex items-center gap-1.5 text-left min-w-0"
          onClick={handleToggle}
          aria-expanded={isDir ? expanded : undefined}
          aria-busy={isDir ? loading : undefined}
        >
          {isDir ? (
            <>
              {loading ? (
                <span className="w-[14px] h-[14px] border-2 border-muted border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : loadError ? (
                <span className="w-[14px] text-xs text-red-500 flex-shrink-0" aria-hidden="true">!</span>
              ) : (
                <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.15 }} className="flex-shrink-0">
                  <ChevronRight size={14} className="text-muted" />
                </motion.span>
              )}
              <Folder size={15} className={expanded ? 'text-accent' : 'text-muted'} />
            </>
          ) : (
            <>
              <span className="w-[14px] flex-shrink-0" />
              <File size={15} className="text-muted flex-shrink-0" />
            </>
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        {!isDir && onDownload && (
          <button
            onClick={(e) => { e.stopPropagation(); haptic('light'); onDownload(navPath) }}
            className="p-1.5 sm:p-1 rounded-md text-muted hover:text-ink hover:bg-black/[0.06] active:bg-black/[0.10] active:scale-90 transition-all flex-shrink-0"
            title="下载"
          >
            <Download size={13} />
          </button>
        )}
      </div>

      {/* Mobile long-press context menu */}
      {!isDesktop && (
        <ActionSheet
          open={ctxOpen}
          onClose={() => setCtxOpen(false)}
          title={entry.name}
          items={ctxItems}
        />
      )}

      {isDir && loadError && (
        <div className="py-2 text-xs text-red-500" style={{ paddingLeft: `${indent + 16}px` }}>
          加载失败，点击目录重试
        </div>
      )}

      <AnimatePresence initial={false}>
        {isDir && expanded && children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            {children.length === 0 ? (
              <div className="py-2 text-xs text-muted italic" style={{ paddingLeft: `${indent + 16}px` }}>
                （空目录）
              </div>
            ) : (
              children.map((child) => (
                <FileNode key={child.name} entry={child} path={`${navPath}/`} onOpen={onOpen} onExpand={onExpand} onDownload={onDownload} onDelete={onDelete} depth={depth + 1} isMatch={isMatch} />
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
