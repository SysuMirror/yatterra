/**
 * 终端面板 —— src/components/pod/TerminalPane.tsx 的面板化移植。
 * (原文件保留不动,Pod 详情页仍在用;这里只复用它的 socket.io 加载器。)
 *
 * 与 TerminalPane 的差异:
 *  - 字号统一走 editorPrefs store(var(--ide-tfs)):首次挂载把旧 key
 *    `yatterra.term.fontSize` 一次性迁移进 store,此后反向镜像回去,
 *    IDE 设置面板 / 捏合手势 / 详情页 TerminalPane 三处保持一致;
 *  - 面板容器尺寸变化(拖分隔条、最大化、手机堆叠)由 ResizeObserver
 *    驱动 fit addon 重算并通知 PTY term_resize;
 *  - 保留捏合缩放与移动端全屏(Fullscreen API + fixed 兜底 +
 *    visual viewport pinning,ancestor 中和逻辑同 TerminalPane);
 *  - 手机渲染器会卸载不可见面板:xterm/socket/ResizeObserver 全部在
 *    effect 清理里释放,重挂载时 PTY 会话重建(契约允许)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Terminal as TermIcon,
  Loader2,
  RotateCw,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Expand,
  Shrink,
} from 'lucide-react'
import { preloadSocketIO } from '@/components/pod/TerminalPane'
import { api } from '@/api/client'
import { useEditorPrefsStore } from '@/stores/editorPrefs'
import { cn } from '@/lib/cn'
import type { PanelProps } from '../types'

// store 的字号范围(10–28);旧 TerminalPane 允许 8–40,迁移时夹到 store 范围
const FONT_MIN = 10
const FONT_MAX = 28
const LEGACY_FONT_KEY = 'yatterra.term.fontSize'
const PREFS_KEY = 'yatterra.ide.prefs'

function touchDistance(touches: TouchList): number {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return 0
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export function TerminalPanel({ podName, surface, maximized, toggleMaximize }: PanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const sendResizeRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle')
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  // 全屏时 visual viewport 的几何(手机浏览器地址栏收缩会让 fixed 漂移)
  const [vv, setVv] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  const terminalFontSize = useEditorPrefsStore((s) => s.terminalFontSize)
  const setTerminalFontSize = useEditorPrefsStore((s) => s.setTerminalFontSize)

  // Pod 运行状态:与详情页共用 ['pod', name] 查询缓存,后台低频轮询
  const { data: pod } = useQuery<any>({
    queryKey: ['pod', podName],
    queryFn: () => api.get(`/pods/${podName}`),
    enabled: !!podName,
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  })
  const statusKnown = pod !== undefined
  const running = pod?.status === 'Running'

  // ── 字号:旧 key 一次性迁移 → store,此后 store → 旧 key 反向镜像 ──────
  const migratedRef = useRef(false)
  useEffect(() => {
    if (migratedRef.current) return
    migratedRef.current = true
    try {
      // store 从未写入过(无 yatterra.ide.prefs)才采用旧值,避免覆盖设置面板的值
      if (!localStorage.getItem(PREFS_KEY)) {
        const raw = Number(localStorage.getItem(LEGACY_FONT_KEY))
        if (Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX) {
          setTerminalFontSize(raw)
        }
      }
    } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try { localStorage.setItem(LEGACY_FONT_KEY, String(terminalFontSize)) } catch { /* private mode */ }
  }, [terminalFontSize])

  // ── xterm + SocketIO 主装配(同 TerminalPane 协议) ─────────────────────
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
          fontSize: useEditorPrefsStore.getState().terminalFontSize,
          fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
          theme: {
            background: '#0b0f14',
            foreground: '#f5f5f7',
            cursor: '#0a84ff',
            selectionBackground: 'rgba(10,132,255,0.25)',
            // 暗底配色(同 TerminalPane:xterm 默认调色板按亮底设计)
            black: '#3a3a3c',
            red: '#ff6b6b',
            green: '#5fd38d',
            yellow: '#f0c674',
            blue: '#6aa9ff',
            magenta: '#d18aff',
            cyan: '#5fd3d3',
            white: '#d8d8dc',
            brightBlack: '#7a7a7e',
            brightRed: '#ff8f8f',
            brightGreen: '#8ce8ac',
            brightYellow: '#ffd98a',
            brightBlue: '#9cc4ff',
            brightMagenta: '#e3aaff',
            brightCyan: '#8ce8e8',
            brightWhite: '#ffffff',
          },
        })
        fit = new FitAddon()
        term.loadAddon(fit)
        term.open(containerRef.current)
        try { fit.fit() } catch { /* 容器可能还是 0×0(标签页动画中) */ }
        termRef.current = term
        fitRef.current = fit

        // 面板容器 resize(拖分隔条/最大化/手机堆叠)→ fit 重算 + 通知 PTY
        const sendResize = () => {
          try { fit.fit() } catch { return }
          if (socket?.connected) {
            socket.emit('term_resize', { cols: term.cols, rows: term.rows })
          }
        }
        sendResizeRef.current = sendResize
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

        // Ctrl+C/Ctrl+V 交还浏览器剪贴板(有选区才让 ^C 变复制,同 TerminalPane)
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== 'keydown' || e.altKey) return true
          const k = e.key.toLowerCase()
          if ((e.ctrlKey || e.metaKey) && k === 'c') {
            return term.hasSelection() ? false : true
          }
          if ((e.ctrlKey || e.metaKey) && k === 'v') return false
          return true
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
      termRef.current = null
      fitRef.current = null
      sendResizeRef.current = null
    }
  }, [podName, running, nonce])

  // 字号变化(设置面板滑杆 / +/- 按钮)→ 应用到活终端并 refit
  useEffect(() => {
    const term = termRef.current
    if (term && term.options.fontSize !== terminalFontSize) {
      term.options.fontSize = terminalFontSize
      sendResizeRef.current?.()
    }
  }, [terminalFontSize])

  // 布局层最大化 / 全屏切换后下一帧 refit(ResizeObserver 之外的双保险)
  useEffect(() => {
    const id = requestAnimationFrame(() => sendResizeRef.current?.())
    return () => cancelAnimationFrame(id)
  }, [maximized, fullscreen])

  // ── 捏合缩放:双指改字号,松手提交 store ────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el || !running) return
    let startDist = 0
    let startFont = terminalFontSize

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = touchDistance(e.touches)
        startFont = termRef.current?.options.fontSize ?? terminalFontSize
      } else {
        startDist = 0
      }
    }
    const onMove = (e: TouchEvent) => {
      if (!startDist || e.touches.length !== 2) return
      e.preventDefault() // 阻止浏览器整页缩放
      const ratio = touchDistance(e.touches) / startDist
      const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(startFont * ratio)))
      const term = termRef.current
      if (term && term.options.fontSize !== next) {
        term.options.fontSize = next
        sendResizeRef.current?.()
      }
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length >= 2) return
      if (startDist) {
        const cur = termRef.current?.options.fontSize
        if (typeof cur === 'number') setTerminalFontSize(cur)
      }
      startDist = 0
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  // ── 移动端全屏:Fullscreen API + fixed 兜底 ─────────────────────────────
  const savedAncestorsRef = useRef<Array<{
    el: HTMLElement
    willChange: string; transform: string; contain: string; filter: string; perspective: string
    overflow: string; overscroll: string; touchAction: string
  }>>([])

  const leaveFullscreen = useCallback(() => {
    for (const s of savedAncestorsRef.current) {
      s.el.style.willChange = s.willChange
      s.el.style.transform = s.transform
      s.el.style.contain = s.contain
      s.el.style.filter = s.filter
      s.el.style.perspective = s.perspective
      s.el.style.overflow = s.overflow
      s.el.style.overscrollBehavior = s.overscroll
      s.el.style.touchAction = s.touchAction
    }
    savedAncestorsRef.current = []
    setFullscreen(false)
  }, [])

  const toggleFullscreen = async () => {
    const el = paneRef.current
    if (fullscreen) {
      if (document.fullscreenElement) {
        try { await document.exitFullscreen() } catch { /* ignore */ }
      }
      leaveFullscreen()
      return
    }
    let apiOk = false
    if (el?.requestFullscreen) {
      try { await el.requestFullscreen(); apiOk = true } catch { /* iOS Safari / iframe */ }
    }
    setFullscreen(true)
    if (!apiOk) return
    document.addEventListener('fullscreenchange', function onFs() {
      if (!document.fullscreenElement) {
        document.removeEventListener('fullscreenchange', onFs)
        leaveFullscreen()
      }
    })
  }

  // 中和 transform/will-change/滚动祖先,否则 fixed 兜底被 framer-motion
  // 页面过渡残留的 will-change 困在内容列里(同 TerminalPane)
  useEffect(() => {
    if (!fullscreen) return
    const saved = savedAncestorsRef.current
    for (let n = paneRef.current?.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n)
      const transformed =
        cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' ||
        cs.contain !== 'none' || (cs.willChange !== 'auto' && cs.willChange !== '')
      const scrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll'
      if (!transformed && !scrollable) continue
      saved.push({
        el: n,
        willChange: n.style.willChange,
        transform: n.style.transform,
        contain: n.style.contain,
        filter: n.style.filter,
        perspective: n.style.perspective,
        overflow: n.style.overflow,
        overscroll: n.style.overscrollBehavior,
        touchAction: n.style.touchAction,
      })
      if (transformed) {
        n.style.willChange = 'auto'
        n.style.transform = 'none'
        n.style.contain = 'none'
        n.style.filter = 'none'
        n.style.perspective = 'none'
      }
      if (scrollable) {
        n.scrollTop = 0
        n.style.overflow = 'hidden'
        n.style.overscrollBehavior = 'none'
        n.style.touchAction = 'none'
      }
    }
    return () => { leaveFullscreen() }
  }, [fullscreen, leaveFullscreen])

  // 隐藏顶栏/手机底栏(它们在 overlay 的祖先链之外,盖不住)
  useEffect(() => {
    if (!fullscreen) return
    const chrome = Array.from(document.querySelectorAll('header, .mobile-tabbar')) as HTMLElement[]
    const prev = chrome.map((el) => el.style.display)
    chrome.forEach((el) => { el.style.display = 'none' })
    return () => { chrome.forEach((el, i) => { el.style.display = prev[i] ?? '' }) }
  }, [fullscreen])

  // Escape 退出 + 锁滚动
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leaveFullscreen() }
    const html = document.documentElement
    const prevHtml = html.style.overflow
    const prevBody = document.body.style.overflow
    html.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      html.style.overflow = prevHtml
      document.body.style.overflow = prevBody
      window.removeEventListener('keydown', onKey)
    }
  }, [fullscreen, leaveFullscreen])

  // 全屏时钉住 visual viewport(手机地址栏收缩不让 overlay 漂移)
  useEffect(() => {
    const v = window.visualViewport
    if (!v || !fullscreen) { setVv(null); return }
    const update = () => setVv({ top: v.offsetTop, left: v.offsetLeft, width: v.width, height: v.height })
    update()
    v.addEventListener('resize', update)
    v.addEventListener('scroll', update)
    return () => {
      v.removeEventListener('resize', update)
      v.removeEventListener('scroll', update)
    }
  }, [fullscreen])

  // ── 渲染(hooks 全部在前,条件 return 在后) ────────────────────────────
  const mobile = surface === 'mobile'
  const iconBtn = mobile ? 'h-9 w-9' : 'h-8 w-8'

  if (!statusKnown) {
    return (
      <div className="h-full w-full ide-empty flex flex-col items-center justify-center gap-2 px-6 text-center select-none">
        <Loader2 size={16} className="animate-spin" style={{ color: 'var(--ide-mut)' }} />
        <p className="ide-cmt text-[13px]">// 检查 Pod 状态…</p>
      </div>
    )
  }

  if (!running) {
    return (
      <div className="h-full w-full ide-empty flex flex-col items-center justify-center gap-2 px-6 text-center select-none">
        <p className="ide-cmt text-[13px]">// Pod 未运行</p>
        <p className="ide-cmt ide-cmt-dim text-[12px]">// 启动 Pod 后,即可在这里打开交互式终端</p>
      </div>
    )
  }

  const fullscreenStyle: React.CSSProperties | undefined = fullscreen
    ? {
        position: 'fixed',
        top: vv ? vv.top : 0,
        left: vv ? vv.left : 0,
        right: vv ? 'auto' : 0,
        bottom: vv ? 'auto' : 0,
        ...(vv ? { width: vv.width, height: vv.height } : {}),
        padding: '0.5rem',
        paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
      }
    : undefined

  return (
    <div
      ref={paneRef}
      className={cn(
        fullscreen ? 'fixed inset-0 z-[100] bg-[#0b0f14]' : 'relative h-full w-full',
      )}
    >
      <div className="flex flex-col h-full" style={fullscreenStyle}>
        {/* 状态条 + 字号 + 最大化/全屏 */}
        <div
          className={cn(
            'flex items-center gap-1.5 shrink-0 mb-1.5',
            fullscreen ? 'text-white' : 'text-muted',
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
            status === 'open' ? 'bg-ok' : status === 'connecting' ? 'bg-warn animate-pulse' : 'bg-bad')} />
          <span className={cn('text-xs truncate', fullscreen ? 'text-white/70' : 'text-muted')}>
            {status === 'connecting' && '连接中…'}
            {status === 'open' && `已连接 · ${podName}`}
            {status === 'closed' && '会话已断开'}
            {status === 'error' && `连接失败: ${error}`}
          </span>
          <div className="flex-1" />
          {/* 字号(与捏合手势、设置面板同源) */}
          <div className={cn('flex items-center rounded-lg overflow-hidden shrink-0',
            fullscreen ? 'bg-white/10' : 'bg-ink/5')}>
            <button
              type="button"
              aria-label="缩小字号"
              onClick={() => setTerminalFontSize(terminalFontSize - 1)}
              disabled={terminalFontSize <= FONT_MIN}
              className={cn('flex items-center justify-center disabled:opacity-30 transition-colors',
                iconBtn,
                fullscreen ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-ink/5')}
            >
              <Minus size={13} />
            </button>
            <span className={cn('px-1 text-[10px] tabular-nums select-none',
              fullscreen ? 'text-white/50' : 'text-muted')}>{terminalFontSize}</span>
            <button
              type="button"
              aria-label="放大字号"
              onClick={() => setTerminalFontSize(terminalFontSize + 1)}
              disabled={terminalFontSize >= FONT_MAX}
              className={cn('flex items-center justify-center disabled:opacity-30 transition-colors',
                iconBtn,
                fullscreen ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-ink/5')}
            >
              <Plus size={13} />
            </button>
          </div>
          {status !== 'open' && (
            <button
              type="button"
              aria-label="重连"
              onClick={() => setNonce((n) => n + 1)}
              className={cn('flex items-center justify-center rounded-lg transition-colors',
                iconBtn,
                fullscreen ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-ink/5')}
            >
              <RotateCw size={14} />
            </button>
          )}
          {/* 布局层最大化(桌面=group 最大化;手机单面板全屏模式下无意义,隐藏) */}
          {!mobile && (
          <button
            type="button"
            aria-label={maximized ? '还原面板大小' : '最大化面板'}
            title={maximized ? '还原面板大小' : '最大化面板'}
            onClick={toggleMaximize}
            className={cn('flex items-center justify-center rounded-lg transition-colors',
              iconBtn,
              fullscreen ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-ink/5')}
          >
            {maximized ? <Shrink size={14} /> : <Expand size={14} />}
          </button>
          )}
          {/* 浏览器全屏(手机隐藏地址栏) */}
          <button
            type="button"
            aria-label={fullscreen ? '退出全屏' : '全屏'}
            onClick={toggleFullscreen}
            className={cn('flex items-center justify-center rounded-lg transition-colors',
              iconBtn,
              fullscreen ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-ink/5')}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
        <div
          ref={containerRef}
          className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#0b0f14]"
        />
      </div>
    </div>
  )
}
