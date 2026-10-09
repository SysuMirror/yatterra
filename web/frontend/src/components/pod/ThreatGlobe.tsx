import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { aiApi } from '@/api/ai'
import { MarkdownContent } from '@/components/ai'
import { cn } from '@/lib/cn'

declare global {
  interface Window { echarts?: any }
}

const SCRIPTS = ['/static/vendor/echarts.min.js', '/static/vendor/echarts-gl.min.js']

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = document.querySelector(`script[data-src="${src}"]`)
    if (done) return resolve()
    const s = document.createElement('script')
    s.src = src
    s.dataset.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`加载失败: ${src}`))
    document.head.appendChild(s)
  })
}

let _echartsReady: Promise<any> | null = null

export function preloadECharts(): Promise<any> {
  if (window.echarts && _echartsReady) return _echartsReady
  if (!_echartsReady) {
    _echartsReady = (async () => {
      for (const src of SCRIPTS) await loadScript(src)
      if (!window.echarts) throw new Error('echarts 初始化失败')
      return window.echarts
    })()
    _echartsReady.catch(() => { _echartsReady = null })
  }
  return _echartsReady
}

export const PATTERNS: Record<string, { label: string; color: string }> = {
  honeypot: { label: '蜜罐', color: '#a78bfa' },
  targeted: { label: '定向', color: '#ff7a68' },
  'multi-scan': { label: '多探', color: '#f0a35e' },
  'brute-force': { label: '爆破', color: '#ff5d4d' },
  'credential-stuffing': { label: '撞库', color: '#ffd166' },
  recon: { label: '侦察', color: '#6fb3e0' },
  suspicious: { label: '可疑', color: '#b0a99f' },
}

/** Fallback used when a pattern is unknown or missing. */
const FALLBACK_PATTERN = { label: '可疑', color: '#b0a99f' }

export function patColor(p?: string): string {
  return (p && PATTERNS[p]?.color) || FALLBACK_PATTERN.color
}

export function patLabel(p?: string): string {
  return (p && PATTERNS[p]?.label) || FALLBACK_PATTERN.label
}

/** Stable per-IP jitter so co-located IPs spread into a small cluster. */
function jitter(ip: string): [number, number] {
  let h = 0
  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) | 0
  return [((h & 0xff) / 255 - 0.5) * 1.4, ((h >> 8 & 0xff) / 255 - 0.5) * 1.4]
}

/** Whiten a hex color so the comet trail reads as a hot core of its arc. */
function tint(hex: string, amt = 0.55): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#ffffff'
  const n = parseInt(m[1] ?? '', 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * amt))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

interface ThreatData {
  target?: { lat?: number; lon?: number; name?: string }
  attacks?: any[]
  normal?: any[]
}

function buildLinesAndPoints(data: ThreatData) {
  const target = data.target || {}
  const attacks = data.attacks || []
  const normal = data.normal || []

  const attackLines = attacks.filter((a) => a.lat && a.lon && target.lat && target.lon).map((a) => {
    const j = jitter(a.ip)
    const color = patColor(a.pattern)
    return {
      coords: [[a.lon + j[0], a.lat + j[1]], [target.lon, target.lat]],
      value: a.count,
      lineStyle: { color },
      effect: {
        show: true,
        period: 3.2 + ((a.count || 1) % 7) * 0.35,
        trailWidth: 2.4,
        trailLength: 0.55,
        trailColor: tint(color),
      },
    }
  })
  const normalLines = normal.filter((n) => n.lat && n.lon && target.lat && target.lon).map((n) => {
    const j = jitter(n.ip)
    return { coords: [[n.lon + j[0], n.lat + j[1]], [target.lon, target.lat]], value: n.count }
  })
  const attackPoints = attacks.filter((a) => a.lat && a.lon).map((a) => {
    const j = jitter(a.ip)
    const color = patColor(a.pattern)
    return {
      value: [a.lon + j[0], a.lat + j[1], a.count],
      ip: a.ip, city: a.city, country: a.country, count: a.count,
      banned: a.banned, pattern: a.pattern, response: a.response,
      itemStyle: { color },
    }
  })
  // Soft glow disc behind every attack point — additive blending turns it
  // into a bloom halo without paying for a post-processing pass.
  const attackHalos = attackPoints.map((p) => ({
    ...p,
    itemStyle: { color: (p.itemStyle as { color: string }).color, opacity: 0.14 },
  }))
  const normalPoints = normal.filter((n) => n.lat && n.lon).map((n) => {
    const j = jitter(n.ip)
    return { value: [n.lon + j[0], n.lat + j[1], n.count], ip: n.ip, city: n.city, country: n.country, count: n.count }
  })
  const targetPoints = target.lat ? [{ value: [target.lon, target.lat, 100], name: target.name || '本站' }] : []
  return { attackLines, normalLines, attackPoints, attackHalos, normalPoints, targetPoints }
}

function fmtPoint(d: any, c: string): string {
  let s = `<b style="color:${c}">${d.ip}</b><br>${d.city || ''} ${d.country || ''}<br>连接 ${d.count} 次`
  if (d.pattern) s += `<br>模式: <b style="color:${patColor(d.pattern)}">${patLabel(d.pattern)}</b>`
  if (d.banned) s += '<br><span style="color:#d4b87a">已封禁</span>'
  return s
}

const EARTH_URL = '/static/vendor/earth.jpg?v=20260910b'

/** Fresh `HTMLImageElement` for the globe texture, every time.
 *
 *  echarts-gl caches the uploaded GPU texture per image element: once the
 *  chart re-renders its series, the cached texture is dropped and the sphere
 *  goes flat grey — and re-sending the SAME element does not bring it back.
 *  Handing it a newly decoded element is the only thing that forces a
 *  re-upload, so every setOption that touches the globe must be paired with a
 *  brand-new image (browser HTTP cache keeps this ~free). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function loadEarthImage(): Promise<HTMLImageElement | string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      // echarts-gl uploads the bitmap synchronously during render; without an
      // explicit decode the GPU upload can grab an undecoded frame and the
      // sphere renders as a flat grey shell.
      if (typeof img.decode === 'function') {
        img.decode().then(
          () => resolve(img),
          () => resolve(img),
        )
      } else resolve(img)
    }
    img.onerror = () => resolve(EARTH_URL) // fall back to URL load
    img.src = EARTH_URL
  })
}

function buildGlobeOption(data: ThreatData, earth?: HTMLImageElement | string) {
  const L = buildLinesAndPoints(data)
  return {
    backgroundColor: '#050507',
    globe: {
      environment: 'none',
      baseTexture: earth ?? EARTH_URL,
      shading: 'lambert',
      light: {
        ambient: { intensity: 0.5 },
        main: { intensity: 1.3, shadow: false },
      },
      atmosphere: { show: true, offset: 4, color: '#5b8cff', glowPower: 3, innerGlowPower: 2 },
      globeOuterRadius: 100,
      // The camera must never enter the atmosphere/bloom shell — closer than
      // ~radius the view clips and washes out to white (echarts-gl default
      // minDistance is 40 < radius 100). Bound the zoom range instead.
      viewControl: {
        autoRotate: true,
        autoRotateSpeed: 4,
        autoRotateAfterStill: 3,
        distance: 220,
        minDistance: 150,
        maxDistance: 420,
        rotateSensitivity: 2,
        zoomSensitivity: 1.2,
      },
      silent: false,
    },
    tooltip: {
      show: true,
      backgroundColor: 'rgba(11,15,26,0.92)',
      borderColor: 'rgba(79,124,208,0.35)',
      textStyle: { color: '#dbe4f5', fontSize: 12 },
      formatter: (p: any) => {
        const d = p?.data
        return d && d.ip ? fmtPoint(d, patColor(d.pattern)) : ''
      },
    },
    series: [
      {
        // Arcs are tinted per attack pattern so the sky matches the legend;
        // per-item `effect` gives each comet a trail in its own hue.
        type: 'lines3D', coordinateSystem: 'globe', blendMode: 'lighter',
        lineStyle: { width: 2.2, opacity: 0.75, color: '#ff4a30' },
        effect: { show: true, period: 4, trailWidth: 2.4, trailLength: 0.5, trailColor: '#ffd9cc' },
        data: L.attackLines,
      },
      {
        type: 'lines3D', coordinateSystem: 'globe', blendMode: 'lighter',
        lineStyle: { width: 1.5, opacity: 0.4, color: '#4fae7a' },
        effect: { show: true, period: 7, trailWidth: 1.6, trailLength: 0.35, trailColor: '#8fd8ab' },
        data: L.normalLines,
      },
      {
        type: 'scatter3D', coordinateSystem: 'globe', blendMode: 'lighter', silent: true,
        symbolSize: (v: number[]) => Math.min(7 + (v[2] ?? 0) / 260, 18) * 2.6,
        itemStyle: { opacity: 0.1 },
        data: L.attackHalos,
      },
      {
        type: 'scatter3D', coordinateSystem: 'globe', blendMode: 'lighter',
        symbolSize: (v: number[]) => Math.min(7 + (v[2] ?? 0) / 260, 18),
        itemStyle: { opacity: 1 },
        data: L.attackPoints,
      },
      {
        type: 'scatter3D', coordinateSystem: 'globe', blendMode: 'lighter',
        symbolSize: 5, itemStyle: { color: '#6fbf8f', opacity: 0.65 },
        data: L.normalPoints,
      },
      {
        // Target marker. No 3D text label (it clips into the sphere at limb
        // angles) — the target identity lives in the fixed HUD panel.
        type: 'scatter3D', coordinateSystem: 'globe', silent: true, symbolSize: 30,
        itemStyle: { color: 'rgba(52,211,153,0.12)', borderColor: 'rgba(52,211,153,0.85)', borderWidth: 2, opacity: 0.9 },
        data: L.targetPoints,
      },
      {
        type: 'scatter3D', coordinateSystem: 'globe', symbolSize: 13,
        itemStyle: { color: '#34d399', opacity: 1, borderColor: '#d1fae5', borderWidth: 2.5 },
        emphasis: { scale: 1.4 },
        data: L.targetPoints,
      },
    ],
  }
}

interface ThreatGlobeProps {
  data: ThreatData
  className?: string
}

/** 3D attack globe — ECharts GL loaded from the vendored files. */
export function ThreatGlobe({ data, className }: ThreatGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)
  const dataRef = useRef<ThreatData>(data)
  const [failed, setFailed] = useState<string>('')
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiAnalyze = async () => {
    if (aiTip) { setAiTip(''); return }
    setAiLoading(true)
    try {
      const attacks = data?.attacks ?? []
      const summary = `威胁数据: ${attacks.length} 个攻击源\n${attacks.slice(0, 20).map(a => `  ${a.ip} (${a.city ?? '?'}, ${a.country ?? '?'}) - ${patLabel(a.pattern)}, ${a.count} 次${a.banned ? ', 已封禁' : ''}`).join('\n')}`
      const res = await aiApi.analyze({ text: summary, task: 'explain' })
      setAiTip(res.content)
    } catch {
      setAiTip('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  dataRef.current = data
  useEffect(() => {
    let disposed = false
    let ro: ResizeObserver | null = null
    let rebuilds = 0

    // echarts.init on a 0×0 container (hidden/background tab) fails to
    // create a canvas — init lazily on the first non-zero size instead.
    const ensureChart = async () => {
      const el = containerRef.current
      if (!el || chartRef.current || !window.echarts) return
      const rect = el.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return
      try {
        // Cap DPR: at devicePixelRatio 2+ the framebuffer is 4× the pixels
        // and rotating a textured globe can OOM the GL context (white globe).
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
        const chart = window.echarts.init(el, null, { renderer: 'canvas', devicePixelRatio: dpr })
        chartRef.current = chart
        // WebGL context loss while rotating is recoverable: block the
        // browser's "context lost forever" default and rebuild the chart,
        // re-uploading the cached texture. Bounded to avoid hot loops.
        el.querySelector('canvas')?.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          if (++rebuilds > 5) return
          setTimeout(() => {
            if (disposed) return
            try { chart.dispose() } catch { /* ignore */ }
            if (chartRef.current === chart) chartRef.current = null
            ensureChart()
          }, 400 * rebuilds)
        })
        // Two independent decodes: the option's baseTexture and the follow-up
        // re-apply must be *different* image elements, otherwise echarts-gl
        // reuses the (sometimes never-uploaded) cached GPU texture and the
        // sphere renders flat grey. The re-apply must also land in a *later*
        // task than the initial setOption — back-to-back calls in one task
        // reliably leave the sphere grey.
        const [earth, reapply] = await Promise.all([loadEarthImage(), loadEarthImage()])
        if (disposed || chartRef.current !== chart) return
        chart.setOption(buildGlobeOption(dataRef.current, earth))
        await nextTask()
        if (disposed || chartRef.current !== chart) return
        chart.setOption({ globe: { baseTexture: reapply } })
      } catch (e: any) {
        setFailed(e?.message || String(e))
      }
    }

    ;(async () => {
      try {
        await preloadECharts()
        if (disposed) return
        ensureChart()
        ro = new ResizeObserver(() => {
          ensureChart()
          chartRef.current?.resize()
        })
        ro.observe(containerRef.current!)
        // ResizeObserver alone can miss the transition (hidden tabs, headless
        // embeds) — poll briefly until the chart exists as a fallback.
        let tries = 0
        const iv = setInterval(() => {
          if (disposed || chartRef.current || ++tries > 30) {
            clearInterval(iv)
            return
          }
          ensureChart()
        }, 600)
      } catch (e: any) {
        if (!disposed) setFailed(e?.message || String(e))
      }
    })()
    return () => {
      disposed = true
      ro?.disconnect()
      try { chartRef.current?.dispose() } catch { /* ignore */ }
      chartRef.current = null
    }
  }, [])

  // Refresh series when data changes without re-creating the globe.
  // Order matters: updating `series` invalidates echarts-gl's globe texture,
  // so a second setOption carrying a *freshly decoded* baseTexture has to
  // follow in a later task — otherwise the earth silently turns grey for the
  // rest of the session.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !data) return
    let cancelled = false
    ;(async () => {
      const earth = await loadEarthImage()
      if (cancelled || chartRef.current !== chart) return
      try {
        chart.setOption({ series: buildGlobeOption(data).series })
        await nextTask()
        if (cancelled || chartRef.current !== chart) return
        chart.setOption({ globe: { baseTexture: earth } })
      } catch { /* chart may be mid-init */ }
    })()
    return () => { cancelled = true }
  }, [data])

  return (
    <div className={cn('relative h-full w-full', className)}>
      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
          <p className="text-sm">3D 地图加载失败</p>
          <p className="text-xs">{failed}</p>
        </div>
      ) : (
        <div className="absolute inset-0" ref={containerRef} />
      )}
      {/* AI analysis button */}
      <button
        onClick={handleAiAnalyze}
        disabled={aiLoading}
        className="absolute top-3 right-3 z-20 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-mono text-[10px] tracking-wider uppercase text-white/80 bg-black/50 hover:bg-black/75 hover:text-white disabled:opacity-40 transition-colors border border-white/10 backdrop-blur-md"
      >
        {aiLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} className="text-[#a78bfa]" />}
        AI 分析
      </button>
      {aiTip && (
        <div className="absolute bottom-11 left-3 right-3 z-20 pointer-events-auto p-3 rounded-lg bg-black/80 backdrop-blur-md border border-white/10 text-white/90 max-h-44 overflow-y-auto shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
          <div className="flex items-center gap-1 mb-1.5 text-[10px] font-semibold tracking-wider text-[#a78bfa]"><Sparkles size={9} /> AI 分析</div>
          <MarkdownContent content={aiTip} size="xs" />
        </div>
      )}
    </div>
  )
}
