/**
 * 日志面板:GET /api/pods/<name>/logs 拉初始尾部(300 行)+
 * SSE /api/pods/<name>/logs/stream 跟随(kubectl logs -f,自带 --tail=100 重放)。
 *
 *  - 去重:流重放的 100 行通常已含在初始快照里,按「流前缀 == 快照尾缀」
 *    匹配跳过,避免开头重复 100 行;
 *  - 自动滚底:滚离底部自动暂停跟随,出现「回到底部」浮动按钮;
 *    也可手动暂停/恢复跟随;
 *  - 级别着色:error/warn/info/debug 按关键词着色,行数上限 2000 防爆内存;
 *  - 手机可用:工具栏按钮 ≥44px 命中,内容区 flex-1 自适应填满面板。
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Eraser, Loader2, Pause, Play, ScrollText } from 'lucide-react'
import { useSSE } from '@/hooks/useSSE'
import { podsApi } from '@/api/pods'
import { cn } from '@/lib/cn'
import type { PanelProps } from '../types'

const MAX_LINES = 2000
/** SSE 流结束标记(后端 _iter_log_process 发出) */
const STREAM_END_MARK = '(日志流结束)'

type Level = 'error' | 'warn' | 'info' | 'debug' | 'end' | 'default'

function levelOf(line: string): Level {
  if (line === STREAM_END_MARK) return 'end'
  if (/(error|failed|failure|fatal|panic|critical|traceback|exception|errno)/i.test(line)) return 'error'
  if (/(warn|deprecated)/i.test(line)) return 'warn'
  if (/\b(info|notice)\b/i.test(line)) return 'info'
  if (/\b(debug|verbose|trace)\b/i.test(line)) return 'debug'
  return 'default'
}

const LEVEL_COLOR: Record<Level, string> = {
  error: 'text-[#ff6b6b]',
  warn: 'text-[#f0c674]',
  info: 'text-[#9cc4ff]',
  debug: 'text-[#8b8b90]',
  end: 'text-white/30',
  default: 'text-[#f5f5f7]',
}

export function LogsPanel({ podName, surface }: PanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<string[]>([])
  // lines 的同步镜像:onOpen 重建去重窗口时要读「当前」显示尾部,
  // 不能依赖 state 闭包(SSE 回调触发时 React 可能尚未重渲染)
  const linesRef = useRef<string[]>([])
  const [initState, setInitState] = useState<'loading' | 'done' | 'error'>('loading')
  // 跟随 = 滚底吸附;paused = 用户手动暂停(不被滚动恢复)
  const [follow, setFollow] = useState(true)
  const [paused, setPaused] = useState(false)
  const stick = follow && !paused

  // SSE 去重状态:流的前若干行是初始快照尾部的重放
  const dedupeRef = useRef<{ tail: string[]; buffer: string[]; active: boolean }>({
    tail: [], buffer: [], active: false,
  })

  const appendLines = (fresh: string[]) => {
    if (fresh.length === 0) return
    const next = [...linesRef.current, ...fresh].slice(-MAX_LINES)
    linesRef.current = next
    setLines(next)
  }

  const replaceLines = (next: string[]) => {
    linesRef.current = next
    setLines(next)
  }

  // 初始快照:每次挂载重新拉(手机渲染器会卸载面板)
  useEffect(() => {
    let disposed = false
    replaceLines([])
    setInitState('loading')
    podsApi.logs(podName, 300)
      .then((text) => {
        if (disposed) return
        const init = text ? text.split('\n').filter((l) => l !== '') : []
        replaceLines(init)
        dedupeRef.current = { tail: init.slice(-100), buffer: [], active: true }
        setInitState('done')
      })
      .catch(() => {
        if (disposed) return
        // 初始拉取失败也继续:只靠 SSE(它自带 tail=100)
        dedupeRef.current = { tail: [], buffer: [], active: false }
        setInitState('error')
      })
    return () => { disposed = true }
  }, [podName])

  // SSE 跟随(初始快照落定后再连,缩小与快照的时间窗)
  const streamUrl = initState !== 'loading' ? `/api/pods/${podName}/logs/stream` : null
  useSSE(streamUrl, {
    // 每次(重)连接都重建去重窗口:后端 logs/stream 每次连接都用
    // --tail=100 重放最后 100 行,useSSE 在切页隐藏/offline/onerror 时
    // 都会断开重连,若不重置窗口,重放行会被盲目追加成重复内容。
    // 用当前显示尾部做匹配基准;STREAM_END_MARK 是本端合成的标记行,
    // 后端不会重放,须剔除否则破坏前缀匹配。
    onOpen: () => {
      const tail = linesRef.current
        .filter((l) => l !== STREAM_END_MARK)
        .slice(-100)
      dedupeRef.current = { tail, buffer: [], active: true }
    },
    onMessage: (data) => {
      const d = dedupeRef.current
      if (!d.active) {
        appendLines([data])
        return
      }
      d.buffer.push(data)
      // 找最大 k:buffer[0..k) == tail 的最后 k 行 → 这 k 行是重放,跳过
      const maxK = Math.min(d.buffer.length, d.tail.length)
      let match = 0
      for (let k = maxK; k > 0; k--) {
        let ok = true
        for (let i = 0; i < k; i++) {
          if (d.buffer[i] !== d.tail[d.tail.length - k + i]) { ok = false; break }
        }
        if (ok) { match = k; break }
      }
      const flushAll = data === STREAM_END_MARK || d.buffer.length > d.tail.length
      if (match > 0 || flushAll) {
        let fresh = d.buffer.slice(match)
        // 重连后重放全被去重、期间无新日志时,不重复堆叠结束标记行
        if (
          fresh.length === 1 && fresh[0] === STREAM_END_MARK &&
          linesRef.current[linesRef.current.length - 1] === STREAM_END_MARK
        ) {
          fresh = []
        }
        d.buffer = []
        d.active = false
        appendLines(fresh)
      }
    },
  })

  // 自动滚底
  useEffect(() => {
    if (!stick) return
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, stick])

  const onScroll = () => {
    if (paused) return // 手动暂停期间不因滚动自动恢复
    const el = containerRef.current
    if (!el) return
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const backToBottom = () => {
    setFollow(true)
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const mobile = surface === 'mobile'
  const toolBtn = cn(
    'inline-flex items-center gap-1 rounded-lg text-xs font-medium transition-colors',
    mobile ? 'h-9 px-2.5' : 'h-7 px-2',
    'text-muted hover:text-ink hover:bg-ink/5 active:bg-ink/[0.07]',
  )

  return (
    <div className="relative h-full w-full flex flex-col min-h-0">
      {/* 工具栏(紧凑;标题由布局层标签承载,这里只留功能项) */}
      <div className={cn('flex items-center gap-1.5 shrink-0 mb-1 px-0.5', mobile ? 'h-10' : 'h-8')}>
        <span className="text-[11px] text-muted/60 shrink-0 tabular-nums">{lines.length} 行</span>
        {initState === 'loading' && <span className="text-[11px] text-muted/60 shrink-0">加载中…</span>}
        {initState === 'error' && <span className="text-[11px] text-warn shrink-0">初始拉取失败，仅跟随新日志</span>}
        <div className="flex-1" />
        <button
          type="button"
          aria-label={paused ? '恢复跟随' : '暂停跟随'}
          title={paused ? '恢复自动滚底' : '暂停自动滚底'}
          onClick={() => { setPaused((v) => !v); if (paused) backToBottom() }}
          className={cn(toolBtn, paused && 'text-accent bg-accent/10')}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          <span className="hidden sm:inline">{paused ? '跟随' : '暂停'}</span>
        </button>
        <button
          type="button"
          aria-label="清空显示"
          title="清空显示(不影响容器日志)"
          onClick={() => replaceLines([])}
          className={toolBtn}
        >
          <Eraser size={13} />
          <span className="hidden sm:inline">清空</span>
        </button>
      </div>

      {/* 日志内容:暗底等宽,级别着色 */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-auto rounded-xl p-3 font-mono text-xs leading-5 bg-[#0b0f14]"
        style={{ fontSize: 'var(--ide-tfs, 13px)', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.15) transparent' }}
      >
        {lines.length === 0 && (
          <div className="h-full min-h-[140px] flex flex-col items-center justify-center gap-2 px-6 text-center select-none">
            {initState === 'loading' ? (
              <Loader2 size={16} className="animate-spin" style={{ color: 'var(--ide-mut)' }} />
            ) : (
              <ScrollText size={16} style={{ color: 'var(--ide-mut)' }} />
            )}
            <p className="ide-cmt text-[13px]">
              {initState === 'loading' ? '// 正在拉取日志…' : '// 暂无日志'}
            </p>
            <p className="ide-cmt ide-cmt-dim text-[12px]">
              {initState === 'loading' ? '// 读取容器最近 300 行输出' : '// 容器产生新输出后会自动出现在这里'}
            </p>
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} className="hover:bg-white/5 px-1 -mx-1 rounded whitespace-pre-wrap break-all">
            <span className="text-white/25 select-none mr-3">{String(i + 1).padStart(4, ' ')}</span>
            <span className={LEVEL_COLOR[levelOf(line)]}>{line}</span>
          </div>
        ))}
      </div>

      {/* 脱离底部时的浮动回底按钮(44px 命中) */}
      {!stick && (
        <button
          type="button"
          onClick={backToBottom}
          className="absolute bottom-3 right-3 h-11 px-4 rounded-xl text-xs font-medium text-white bg-accent/85 glass-blur shadow-2 flex items-center gap-1.5"
        >
          <ArrowDown size={13} />
          回到底部
        </button>
      )}
    </div>
  )
}
