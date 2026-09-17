import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { aiApi } from '@/api/ai'
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
    return {
      coords: [[a.lon + j[0], a.lat + j[1]], [target.lon, target.lat]],
      value: a.count,
    }
  })
  const normalLines = normal.filter((n) => n.lat && n.lon && target.lat && target.lon).map((n) => {
    const j = jitter(n.ip)
    return { coords: [[n.lon + j[0], n.lat + j[1]], [target.lon, target.lat]], value: n.count }
  })
  const attackPoints = attacks.filter((a) => a.lat && a.lon).map((a) => {
    const j = jitter(a.ip)
    return {
      value: [a.lon + j[0], a.lat + j[1], a.count],
      ip: a.ip, city: a.city, country: a.country, count: a.count,
      banned: a.banned, pattern: a.pattern, response: a.response,
      itemStyle: { color: patColor(a.pattern) },
    }
  })
  const normalPoints = normal.filter((n) => n.lat && n.lon).map((n) => {
    const j = jitter(n.ip)
    return { value: [n.lon + j[0], n.lat + j[1], n.count], ip: n.ip, city: n.city, country: n.country, count: n.count }
  })
  const targetPoints = target.lat ? [{ value: [target.lon, target.lat, 100], name: target.name || '本站' }] : []
  return { attackLines, normalLines, attackPoints, normalPoints, targetPoints }
}

function fmtPoint(d: any, c: string): string {
  let s = `<b style="color:${c}">${d.ip}</b><br>${d.city || ''} ${d.country || ''}<br>连接 ${d.count} 次`
  if (d.pattern) s += `<br>模式: <b style="color:${patColor(d.pattern)}">${patLabel(d.pattern)}</b>`
  if (d.banned) s += '<br><span style="color:#d4b87a">已封禁</span>'
  return s
}

const EARTH_URL = '/static/vendor/earth.jpg?v=20260910b'

let _earthImg: HTMLImageElement | null = null

/** Preload the earth texture ourselves — echarts-gl's internal image loader
 *  is unreliable under echarts 5.x (globe renders black); passing a decoded
 *  HTMLImageElement as baseTexture is the only path that renders reliably
 *  (canvas textures don't upload at all). If WebGL drops the texture under
 *  GPU memory pressure, the webglcontextlost handler rebuilds the chart and
 *  re-uploads from this cached element. */
async function preloadEarth(): Promise<HTMLImageElement | string> {
  if (_earthImg?.complete && _earthImg.naturalWidth > 0) return _earthImg
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => { _earthImg = img; resolve(img) }
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
        ambient: { intensity: 0.6 },
        main: { intensity: 1.5, shadow: false },
      },
      atmosphere: { show: true, offset: 4, color: '#4f7cd0', glowPower: 3, innerGlowPower: 2 },
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
    tooltip: { show: true, backgroundColor: 'rgba(11,15,26,0.92)', borderColor: 'rgba(79,124,208,0.35)', textStyle: { color: '#dbe4f5', fontSize: 12 } },
    series: [
      {
        // All attack arcs share one warm-red family — per-pattern colors
        // stay on the scatter points and legend, keeping the sky readable.
        type: 'lines3D', coordinateSystem: 'globe', blendMode: 'lighter',
        lineStyle: { width: 2.4, opacity: 0.8, color: '#ff4a30' },
        effect: { show: true, period: 4, trailWidth: 2.6, trailLength: 0.5, trailColor: '#ffa184' },
        data: L.attackLines,
      },
      {
        type: 'lines3D', coordinateSystem: 'globe', blendMode: 'lighter',
        lineStyle: { width: 1.6, opacity: 0.45, color: '#4fae7a' },
        effect: { show: true, period: 7, trailWidth: 1.6, trailLength: 0.35, trailColor: '#8fd8ab' },
        data: L.normalLines,
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
        type: 'scatter3D', coordinateSystem: 'globe', symbolSize: 14,
        itemStyle: { color: '#34d399', opacity: 1, borderColor: '#a7f3d0', borderWidth: 2.5 },
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
        const earth = await preloadEarth()
        if (disposed) return
        chart.setOption(buildGlobeOption(dataRef.current, earth))
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

  // Refresh series when data changes without re-creating the globe
  useEffect(() => {
    if (!chartRef.current || !data) return
    try {
      chartRef.current.setOption({ series: buildGlobeOption(data).series })
    } catch { /* chart may be mid-init */ }
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
        className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-white bg-black/40 hover:bg-black/60 disabled:opacity-40 transition-colors backdrop-blur-sm"
      >
        {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        AI 分析威胁
      </button>
      {aiTip && (
        <div className="absolute bottom-2 left-2 right-2 z-10 p-3 rounded-lg bg-black/70 backdrop-blur-sm border border-white/10 text-xs text-white/90 whitespace-pre-wrap max-h-48 overflow-y-auto">
          <div className="flex items-center gap-1 mb-1 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 分析</div>
          {aiTip}
        </div>
      )}
    </div>
  )
}
