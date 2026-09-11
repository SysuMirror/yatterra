import { useRef, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useSSE } from '@/hooks/useSSE'
import { cn } from '@/lib/cn'

interface LogViewerProps {
  podName: string
  streamUrl?: string
  initialLogs?: string
  className?: string
}

export function LogViewer({ podName, streamUrl, initialLogs = '', className }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>(initialLogs ? initialLogs.split('\n') : [])
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  useSSE(
    streamUrl || null,
    {
      onMessage: (data) => {
        setLogs((prev) => [...prev, data])
      },
    },
  )

  useEffect(() => {
    if (!autoScroll || !containerRef.current) return
    containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [logs, autoScroll])

  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }

  return (
    <div className={cn('relative', className)}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-muted">日志</span>
        <span className="text-xs text-muted/60">{logs.length} 行</span>
        <div className="flex-1" />
        <button
          onClick={() => setLogs([])}
          className="text-xs text-muted hover:text-ink transition-colors"
        >
          清空
        </button>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-[400px] overflow-y-auto rounded-xl p-4 font-mono text-xs leading-5 bg-[#1d1d1f] text-[#f5f5f7]"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}
      >
        {logs.map((line, i) => (
          <div key={i} className="hover:bg-white/5 px-1 -mx-1 rounded">
            <span className="text-white/30 select-none mr-3">{String(i + 1).padStart(4, ' ')}</span>
            {line}
          </div>
        ))}
        {!logs.length && (
          <div className="text-white/30 text-center py-8">等待日志...</div>
        )}
      </div>

      {!autoScroll && (
        <motion.button
          className="absolute bottom-4 right-4 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-accent shadow-2"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          onClick={() => {
            setAutoScroll(true)
            if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight
          }}
        >
          ↓ 滚到底部
        </motion.button>
      )}
    </div>
  )
}
