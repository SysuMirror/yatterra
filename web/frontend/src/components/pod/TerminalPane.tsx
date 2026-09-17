import { useEffect, useRef, useState } from 'react'
import { Terminal as TermIcon, RotateCw, Sparkles, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { aiApi } from '@/api/ai'
import { cn } from '@/lib/cn'

declare global {
  interface Window { io?: any }
}

/** Load the vendored socket.io client (served by Flask at /static/vendor). */
export function preloadSocketIO(): Promise<any> {
  if (window.io) return Promise.resolve(window.io)
  if ((preloadSocketIO as any)._p) return (preloadSocketIO as any)._p
  const p = new Promise<any>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/static/vendor/socket.io.min.js'
    s.onload = () => (window.io ? resolve(window.io) : reject(new Error('socket.io 加载失败')))
    s.onerror = () => reject(new Error('socket.io 加载失败'))
    document.head.appendChild(s)
  })
  ;(preloadSocketIO as any)._p = p
  // One retry on transient failure, then forget the failed promise.
  return p.catch((e) => { delete (preloadSocketIO as any)._p; throw e })
}

interface TerminalPaneProps {
  podName: string
  /** Pod must be Running for the backend to accept a PTY. */
  running: boolean
  className?: string
}

/**
 * Browser shell into the pod. Protocol (Flask-SocketIO, namespace "/"):
 * connect with ?name=<pod>; server emits term_output {data};
 * client emits term_input {data} / term_resize {cols, rows}.
 */
export function TerminalPane({ podName, running, className }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle')
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const outputRef = useRef('')

  useEffect(() => {
    if (!running) return
    let disposed = false
    let term: any = null
    let fit: any = null
    let socket: any = null
    let resizeObs: ResizeObserver | null = null

    setStatus('connecting')
    setError('')

    ;(async () => {
      try {
        const [{ Terminal: XTerm }, { FitAddon }, io] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          preloadSocketIO(),
        ])
        await import('@xterm/xterm/css/xterm.css')
        if (disposed || !containerRef.current) return

        term = new XTerm({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
          theme: {
            background: '#1d1d1f',
            foreground: '#f5f5f7',
            cursor: '#0a84ff',
            selectionBackground: 'rgba(10,132,255,0.25)',
          },
        })
        fit = new FitAddon()
        term.loadAddon(fit)
        term.open(containerRef.current)
        try { fit.fit() } catch { /* container may be 0×0 while tab animates in */ }

        const sendResize = () => {
          try {
            fit.fit()
          } catch { return }
          if (socket?.connected) {
            socket.emit('term_resize', { cols: term.cols, rows: term.rows })
          }
        }
        resizeObs = new ResizeObserver(sendResize)
        resizeObs.observe(containerRef.current)
        sendResize()

        socket = io('/', { query: { name: podName } })
        socket.on('connect', () => { if (!disposed) setStatus('open') })
        socket.on('connect_error', (e: any) => {
          if (disposed) return
          setStatus('error')
          setError(String(e?.message || e))
        })
        socket.on('term_output', (msg: any) => {
          const data = typeof msg === 'string' ? msg : msg?.data
          if (data) term.write(data)
        })
        socket.on('term_exit', (msg: any) => {
          if (disposed) return
          setStatus('closed')
          term.write(`\r\n\x1b[90m— ${(typeof msg === 'string' ? msg : msg?.data) || '会话已结束'} —\x1b[0m\r\n`)
        })
        socket.on('disconnect', () => { if (!disposed) setStatus('closed') })
        term.onData((data: string) => {
          if (socket?.connected) socket.emit('term_input', { data })
        })
      } catch (e: any) {
        if (!disposed) { setStatus('error'); setError(e?.message || String(e)) }
      }
    })()

    return () => {
      disposed = true
      resizeObs?.disconnect()
      try { socket?.close() } catch { /* ignore */ }
      try { term?.dispose() } catch { /* ignore */ }
    }
  }, [podName, running, nonce])

  if (!running) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-muted', className)}>
        <TermIcon size={28} className="opacity-40" />
        <p className="text-sm">Pod 未运行，启动后才能打开终端</p>
      </div>
    )
  }

  const [aiInput, setAiInput] = useState('')

  const handleAiAsk = async () => {
    const q = aiInput.trim()
    if (!q) return
    setAiLoading(true)
    setAiTip('')
    try {
      const res = await aiApi.chat({ message: q, system: '你是终端助手。用户在 Pod 终端中工作。解释命令、建议修复方案、生成常用命令。简洁回答。' })
      setAiTip(res.content)
    } catch {
      setAiTip('AI 请求失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className={cn('relative', className)}>
      <div className="flex items-center gap-2 mb-2">
        <span className={cn('w-1.5 h-1.5 rounded-full',
          status === 'open' ? 'bg-ok' : status === 'connecting' ? 'bg-warn animate-pulse' : 'bg-bad')} />
        <span className="text-xs text-muted">
          {status === 'connecting' && '连接中…'}
          {status === 'open' && `已连接 · ${podName}（cloud 用户）`}
          {status === 'closed' && '会话已断开'}
          {status === 'error' && `连接失败: ${error}`}
        </span>
        <div className="flex-1" />
        {status !== 'open' && (
          <Button variant="secondary" size="sm" onClick={() => setNonce((n) => n + 1)}>
            <RotateCw size={13} /> 重连
          </Button>
        )}
      </div>
      <div
        ref={containerRef}
        className="h-[min(480px,70vh)] rounded-xl overflow-hidden bg-[#1d1d1f] p-2"
      />
      {/* AI command help bar */}
      <div className="mt-2">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-accent flex-shrink-0" />
          <input
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !aiLoading) handleAiAsk() }}
            placeholder="问 AI: 解释命令、排查错误、生成脚本..."
            className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-black/[0.03] border-0 focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
          <button
            onClick={handleAiAsk}
            disabled={!aiInput.trim() || aiLoading}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-accent text-white disabled:opacity-40 transition-colors"
          >
            {aiLoading ? <Loader2 size={12} className="animate-spin" /> : '问'}
          </button>
        </div>
        {aiTip && (
          <div className="mt-1.5 p-2.5 rounded-lg bg-accent/5 border border-accent/10 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto">
            <div className="flex items-center gap-1 mb-1 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 回答</div>
            {aiTip}
          </div>
        )}
      </div>
    </div>
  )
}
