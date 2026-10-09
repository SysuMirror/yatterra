import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as TermIcon, RotateCw, Sparkles, Loader2, Maximize2, Minimize2, Minus, Plus, Rotate3d } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { aiApi } from '@/api/ai'
import { MarkdownContent } from '@/components/ai'
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

const FONT_MIN = 8
const FONT_MAX = 40
const FONT_KEY = 'yatterra.term.fontSize'

function loadFontSize(): number {
  const raw = Number(localStorage.getItem(FONT_KEY))
  return Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX ? raw : 13
}

function touchDistance(touches: TouchList): number {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return 0
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
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
  const termRef = useRef<any>(null)
  const fitRef = useRef<any>(null)
  const sendResizeRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle')
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  // NOTE: must be declared here, above the `if (!running) return` guard below.
  // A hook after a conditional return changes the hook count when `running`
  // flips (Stopped → Running), which makes React throw
  // "Rendered more hooks than during the previous render".
  const [aiInput, setAiInput] = useState('')
  const [fontSize, setFontSize] = useState(loadFontSize)
  const [fullscreen, setFullscreen] = useState(false)
  const [rotated, setRotated] = useState(false)
  // Geometry of the *visual* viewport (see the effect further down).
  const [vv, setVv] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  // Fullscreen chrome: the header row auto-hides a few seconds after the last
  // interaction so the terminal itself owns the whole screen; tapping the pane
  // brings it back. The AI bar is a floating panel, closed by default.
  const [chromeVisible, setChromeVisible] = useState(true)
  const [aiOpen, setAiOpen] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const savedAncestorsRef = useRef<Array<{
    el: HTMLElement
    willChange: string; transform: string; contain: string; filter: string; perspective: string
    overflow: string; overscroll: string; touchAction: string
  }>>([])

  // Enter fullscreen and restore every ancestor we neutralised. Called from the
  // exit paths (button, Escape, system gesture) so nothing is left mutated.
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
    setAiOpen(false)
    setChromeVisible(true)
  }, [])

  // True fullscreen = browser Fullscreen API (hides the address bar and
  // browser chrome on mobile). Falls back to the CSS fixed overlay when the
  // API is unavailable or rejected (iOS Safari, iframe without allowfullscreen).
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
      try { await el.requestFullscreen(); apiOk = true } catch { /* ignore */ }
    }
    setFullscreen(true)
    if (!apiOk) return
    // Keep state in sync when the user exits via the system gesture or an Esc
    // handled by the browser itself, not by our button.
    document.addEventListener('fullscreenchange', function onFs() {
      if (!document.fullscreenElement) {
        document.removeEventListener('fullscreenchange', onFs)
        leaveFullscreen()
      }
    })
  }

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
          fontSize: loadFontSize(),
          fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
          theme: {
            background: '#1d1d1f',
            foreground: '#f5f5f7',
            cursor: '#0a84ff',
            selectionBackground: 'rgba(10,132,255,0.25)',
            // ANSI palette tuned for the dark background — xterm's default
            // palette assumes a light background, so plain `black`/`blue`
            // output (ls, git, PS1) would be nearly invisible here.
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
        try { fit.fit() } catch { /* container may be 0×0 while tab animates in */ }
        termRef.current = term
        fitRef.current = fit

        const sendResize = () => {
          try {
            fit.fit()
          } catch { return }
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

        // Copy/paste. xterm owns every keydown on its hidden textarea and
        // cancels the default action, so the browser never gets to run its own
        // Ctrl+C / Ctrl+V: Ctrl+C always turned into ^C (SIGINT) and Ctrl+V
        // into ^V, and neither ever touched the clipboard.
        //
        // Returning `false` makes xterm bail out *without* cancelling, which
        // hands the keystroke back to the browser: the native `copy` event then
        // reaches xterm's own copy listener (it fills clipboardData from the
        // selection) and the native `paste` event reaches its paste listener
        // (it routes the text back through onData -> PTY). Letting the browser
        // drive the clipboard keeps permissions and bracketed paste handled the
        // way xterm intends.
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== 'keydown' || e.altKey) return true
          const k = e.key.toLowerCase()
          if ((e.ctrlKey || e.metaKey) && k === 'c') {
            // Only yield to the browser when there is something to copy,
            // otherwise keep ^C so Ctrl+C still interrupts the command.
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

  /** Apply a font size to the live terminal, refit and tell the PTY. */
  const applyFontSize = (next: number) => {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(next)))
    setFontSize(clamped)
    try { localStorage.setItem(FONT_KEY, String(clamped)) } catch { /* private mode */ }
    const term = termRef.current
    if (term) {
      term.options.fontSize = clamped
      sendResizeRef.current?.()
    }
  }

  // Two-finger pinch on the terminal adjusts the font size. Single-finger
  // touches are left alone so xterm keeps handling scroll/selection.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !running) return
    let startDist = 0
    let startFont = 13

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = touchDistance(e.touches)
        startFont = termRef.current?.options.fontSize ?? fontSize
      } else {
        startDist = 0
      }
    }
    const onMove = (e: TouchEvent) => {
      if (!startDist || e.touches.length !== 2) return
      // Stop the browser from zooming the whole page instead.
      e.preventDefault()
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
        if (typeof cur === 'number') {
          setFontSize(cur)
          try { localStorage.setItem(FONT_KEY, String(cur)) } catch { /* private mode */ }
        }
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
  }, [running, fontSize])

  // A `position: fixed` box is laid out against its nearest ancestor that has
  // a transform / filter / perspective / will-change / contain — not the
  // viewport. The framer-motion page-transition wrappers in AppShell and
  // routes/pods/$name.tsx leave `will-change: opacity, transform` behind after
  // they settle, which silently traps the fullscreen overlay inside the
  // content column. Neutralise those ancestors while the overlay is up so it
  // really covers the whole screen (the xterm node itself is never moved, so
  // the PTY session survives).
  useEffect(() => {
    if (!fullscreen) return
    const saved = savedAncestorsRef.current
    for (let n = paneRef.current?.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n)
      const transformed =
        cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' ||
        cs.contain !== 'none' || (cs.willChange !== 'auto' && cs.willChange !== '')
      // A scrollable ancestor is just as bad: `position: fixed` is anchored to
      // it, so any scroll (rubber-band, keyboard, momentum) drags the overlay
      // off screen. Pin the ones we find while the overlay is up.
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
        // Freeze the scroll offset so the fixed overlay cannot drift, and stop
        // the container from swallowing touch gestures meant for xterm.
        n.scrollTop = 0
        n.style.overflow = 'hidden'
        n.style.overscrollBehavior = 'none'
        n.style.touchAction = 'none'
      }
    }
    return () => { leaveFullscreen() }
  }, [fullscreen, leaveFullscreen])

  // The top bar and the mobile bottom tab bar live outside the pane's ancestor
  // chain, so the overlay cannot cover them by stacking alone (and on iOS the
  // PWA's own chrome sits above the page entirely). Hide them while the
  // terminal owns the screen.
  useEffect(() => {
    if (!fullscreen) return
    const chrome = Array.from(document.querySelectorAll('header, .mobile-tabbar')) as HTMLElement[]
    const prev = chrome.map((el) => el.style.display)
    chrome.forEach((el) => { el.style.display = 'none' })
    return () => { chrome.forEach((el, i) => { el.style.display = prev[i] ?? '' }) }
  }, [fullscreen])

  // Refit whenever the layout changes (fullscreen toggle, rotation, …).
  useEffect(() => {
    const id = requestAnimationFrame(() => sendResizeRef.current?.())
    return () => cancelAnimationFrame(id)
  }, [fullscreen, rotated, vv])

  // Escape leaves fullscreen; lock every scroll container so the page behind
  // stays put (locking <body> alone is not enough — `main` scrolls on desktop,
  // and on mobile the browser's own scroll is what collapses its toolbars and
  // makes the overlay jump).
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

  // Auto-hide the floating header while fullscreen: any pointer/key activity on
  // the pane shows it again and restarts the timer. The AI panel pins it open.
  useEffect(() => {
    if (!fullscreen) { setChromeVisible(true); return }
    const arm = () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = window.setTimeout(() => {
        if (!aiOpen) setChromeVisible(false)
      }, 3500)
    }
    setChromeVisible(true)
    arm()
    const pane = paneRef.current
    const onAct = () => { setChromeVisible(true); arm() }
    pane?.addEventListener('pointerdown', onAct)
    pane?.addEventListener('keydown', onAct)
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
      pane?.removeEventListener('pointerdown', onAct)
      pane?.removeEventListener('keydown', onAct)
    }
  }, [fullscreen, aiOpen])

  useEffect(() => { if (aiOpen) setChromeVisible(true) }, [aiOpen])

  // Rotation only makes sense filling the screen; leaving fullscreen resets it.
  useEffect(() => {
    if (!fullscreen && rotated) setRotated(false)
  }, [fullscreen, rotated])

  // Track the visual viewport. On phones the *layout* viewport that
  // `position: fixed` resolves against is taller than the area the user can
  // actually see while the address/tool bars are showing, so an `inset-0`
  // overlay pokes out under the browser chrome and lurches every time those
  // bars collapse or expand on scroll. Pinning to the visual viewport keeps the
  // terminal exactly on the visible screen.
  useEffect(() => {
    const v = window.visualViewport
    if (!v || (!fullscreen && !rotated)) { setVv(null); return }
    const update = () => setVv({ top: v.offsetTop, left: v.offsetLeft, width: v.width, height: v.height })
    update()
    v.addEventListener('resize', update)
    v.addEventListener('scroll', update)
    return () => {
      v.removeEventListener('resize', update)
      v.removeEventListener('scroll', update)
    }
  }, [fullscreen, rotated])

  if (!running) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-muted', className)}>
        <TermIcon size={28} className="opacity-40" />
        <p className="text-sm">Pod 未运行，启动后才能打开终端</p>
      </div>
    )
  }

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

  // Landscape view: the whole pane is laid out at the swapped viewport size and
  // rotated 90°, so the phone can be held upright while the shell is wide.
  // The header, terminal and AI bar all rotate together and stay usable.
  const rotateStyle: React.CSSProperties | undefined = rotated
    ? {
        position: 'fixed',
        top: vv ? vv.top + vv.height / 2 : '50%',
        left: vv ? vv.left + vv.width / 2 : '50%',
        right: 'auto',
        bottom: 'auto',
        width: vv ? vv.height : '100vh',
        height: vv ? vv.width : '100vw',
        transform: 'translate(-50%, -50%) rotate(90deg)',
        zIndex: 110,
      }
    : undefined

  // Pin the overlay to the *visual* viewport when we have one, so browser
  // chrome collapsing on scroll cannot shift it.
  const fullscreenStyle: React.CSSProperties | undefined = fullscreen
    ? {
        position: 'fixed',
        top: vv ? vv.top : 0,
        left: vv ? vv.left : 0,
        right: vv ? 'auto' : 0,
        bottom: vv ? 'auto' : 0,
        ...(vv ? { width: vv.width, height: vv.height } : {}),
        padding: '0.75rem',
        paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
        paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
      }
    : undefined

  return (
    <div
      ref={paneRef}
      className={cn(
        // `relative` and `fixed` are both Tailwind position utilities; whichever
        // lands later in the generated stylesheet wins, so never emit both.
        fullscreen ? 'fixed inset-0 z-[100] bg-[#1d1d1f]' : 'relative',
        className,
      )}
    >
      {/* Everything lives in this inner layer so the landscape rotation can be
          applied to it. Rotating the pane itself does nothing while it is the
          native fullscreen element — the browser forces that element to the
          screen size and the transform is dropped. */}
      <div className="flex flex-col" style={rotated ? rotateStyle : fullscreenStyle}>
      <div
        className={cn(
          // Fullscreen: a translucent overlay floating above the terminal so it
          // costs no layout height; it fades out after a few idle seconds.
          fullscreen &&
            'absolute top-0 left-0 right-0 z-20 flex items-center gap-2 px-3 py-2 bg-[#1d1d1f]/85 backdrop-blur-sm transition-opacity duration-300',
          fullscreen && !chromeVisible && 'opacity-0 pointer-events-none',
          !fullscreen && 'flex items-center gap-2 mb-2',
          (fullscreen || rotated) && 'text-white',
        )}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full',
          status === 'open' ? 'bg-ok' : status === 'connecting' ? 'bg-warn animate-pulse' : 'bg-bad')} />
        <span className={cn('text-xs truncate', (fullscreen || rotated) ? 'text-white/70' : 'text-muted')}>
          {status === 'connecting' && '连接中…'}
          {status === 'open' && `已连接 · ${podName}（cloud 用户）`}
          {status === 'closed' && '会话已断开'}
          {status === 'error' && `连接失败: ${error}`}
        </span>
        <div className="flex-1" />
        {/* Font size controls — same effect as the pinch gesture. */}
        <div className={cn('flex items-center rounded-lg overflow-hidden',
          (fullscreen || rotated) ? 'bg-white/10' : 'bg-black/[0.04]')}>
          <button
            type="button"
            aria-label="缩小字号"
            onClick={() => applyFontSize(fontSize - 1)}
            disabled={fontSize <= FONT_MIN}
            className={cn('px-2 py-1.5 disabled:opacity-30 transition-colors',
              (fullscreen || rotated) ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-black/[0.04]')}
          >
            <Minus size={13} />
          </button>
          <span className={cn('px-1 text-[10px] tabular-nums select-none',
            (fullscreen || rotated) ? 'text-white/50' : 'text-muted')}>{fontSize}</span>
          <button
            type="button"
            aria-label="放大字号"
            onClick={() => applyFontSize(fontSize + 1)}
            disabled={fontSize >= FONT_MAX}
            className={cn('px-2 py-1.5 disabled:opacity-30 transition-colors',
              (fullscreen || rotated) ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-black/[0.04]')}
          >
            <Plus size={13} />
          </button>
        </div>
        {/* AI helper toggle: only meaningful while the floating layout is up. */}
        {fullscreen && (
          <button
            type="button"
            aria-label={aiOpen ? '关闭 AI 助手' : 'AI 助手'}
            onClick={() => setAiOpen((v) => !v)}
            className={cn('p-1.5 rounded-lg transition-colors',
              aiOpen ? 'text-accent bg-white/10' : 'text-white/80 hover:bg-white/10')}
          >
            <Sparkles size={15} />
          </button>
        )}
        {/* Rotate: only offered once the pane fills the screen. */}
        {fullscreen && (
          <button
            type="button"
            aria-label={rotated ? '退出旋转' : '旋转屏幕'}
            onClick={() => setRotated((v) => !v)}
            className={cn('p-1.5 rounded-lg transition-colors',
              rotated ? 'text-accent bg-white/10' : 'text-white/80 hover:bg-white/10')}
          >
            <Rotate3d size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label={fullscreen ? '退出全屏' : '全屏'}
          onClick={toggleFullscreen}
          className={cn('p-1.5 rounded-lg transition-colors',
            (fullscreen || rotated) ? 'text-white/80 hover:bg-white/10' : 'text-muted hover:bg-black/[0.04]')}
        >
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        {status !== 'open' && (
          <Button variant="secondary" size="sm" onClick={() => setNonce((n) => n + 1)}>
            <RotateCw size={13} /> 重连
          </Button>
        )}
      </div>
      <div
        ref={containerRef}
        className={cn(
          'rounded-xl overflow-hidden bg-[#1d1d1f]',
          fullscreen ? 'absolute inset-0 p-2' : 'p-2 h-[min(480px,70vh)]',
          rotated && 'flex-1 min-h-0',
        )}
      />
      {/* AI command help bar. Fullscreen: a floating panel opened from the
          header, so it never steals height from the terminal. */}
      <div className={cn(
        fullscreen && 'absolute left-3 right-3 bottom-3 z-20 rounded-xl bg-[#1d1d1f]/95 backdrop-blur-sm p-2 shadow-lg',
        fullscreen && !aiOpen && 'hidden',
        !fullscreen && 'mt-2',
      )}>
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-accent flex-shrink-0" />
          <input
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !aiLoading) handleAiAsk() }}
            placeholder="问 AI: 解释命令、排查错误、生成脚本..."
            className={cn('flex-1 px-2.5 py-1.5 rounded-lg text-xs border-0 focus:outline-none focus:ring-2 focus:ring-accent/20',
              (fullscreen || rotated) ? 'bg-white/10 text-white placeholder:text-white/40' : 'bg-black/[0.03]')}
          />
          <button
            onClick={handleAiAsk}
            disabled={!aiInput.trim() || aiLoading}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-accent/85 glass-blur text-white disabled:opacity-40 transition-colors"
          >
            {aiLoading ? <Loader2 size={12} className="animate-spin" /> : '问'}
          </button>
        </div>
        {aiTip && (
          <div className="mt-1.5 p-2.5 rounded-lg bg-accent/5 border border-accent/10 max-h-48 overflow-y-auto">
            <div className="flex items-center gap-1 mb-1 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 回答</div>
            <MarkdownContent content={aiTip} size="xs" />
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
