import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useInView } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useLandingCopy } from './landing.i18n'

type Point = [number, number]

/** Polished Yatterra orbit mark — glowing disc with the lucide "orbit" glyph (arcs + satellite dots). */
export function OrbitMark({ r = 24, accent = '#5c8bff', bright = false, className, style, filter }: { r?: number; accent?: string; bright?: boolean; className?: string; style?: CSSProperties; filter?: string }) {
  const uid = useId().replace(/:/g, '')
  const s = r / 12
  return (
    <g className={className} style={style} filter={filter}>
      <defs>
        <radialGradient id={`${uid}-f`} cx=".5" cy=".42" r=".65">
          <stop offset="0" stopColor={bright ? '#eafffa' : '#1d5568'} />
          <stop offset=".55" stopColor={bright ? accent : '#0e2436'} />
          <stop offset="1" stopColor={bright ? '#5c8bff' : '#0a1a29'} />
        </radialGradient>
      </defs>
      <circle r={r} fill={`url(#${uid}-f)`} stroke={bright ? '#b7fff0' : accent} strokeWidth={Math.max(1.2, r * .07)} />
      <g transform={`translate(${-12 * s} ${-12 * s}) scale(${s})`} fill="none" stroke={bright ? '#04131c' : '#eafffa'} strokeWidth="1.7" strokeLinecap="round">
        <path d="M20.341 6.484A10 10 0 0 1 10.266 21.85" />
        <path d="M3.659 17.516A10 10 0 0 1 13.74 2.152" />
        <circle cx="12" cy="12" r="3" fill={bright ? '#04131c' : '#eafffa'} stroke="none" />
        <circle cx="19" cy="5" r="2" fill={bright ? '#04131c' : accent} stroke="none" />
        <circle cx="5" cy="19" r="2" fill={bright ? '#04131c' : accent} stroke="none" />
      </g>
    </g>
  )
}

export function AnimatedScene({ children, className = '', label }: { children: ReactNode; className?: string; label: string }) {
  const scene = useRef<HTMLDivElement>(null)
  const inView = useInView(scene, { margin: '80px' })
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return <div ref={scene} className={`terra-scene ${className}`} data-running={inView && visible} role="img" aria-label={label}>{children}</div>
}

/** Animated data packet travelling along a polyline, with a glowing trail. */
function Flow({ points, color = '#5c8bff', delay = 0, dashed = false, glow = true }: { points: Point[]; color?: string; delay?: number; dashed?: boolean; glow?: boolean }) {
  const uid = useId().replace(/:/g, '')
  const animation = `terra-flow-${uid}`
  const distances = points.map((point, index) => {
    const previous = points[index - 1] ?? point
    return Math.hypot(point[0] - previous[0], point[1] - previous[1])
  })
  const total = distances.reduce((sum, distance) => sum + distance, 0) || 1
  let travelled = 0
  const frames = points.map(([horizontal, vertical], index) => {
    travelled += distances[index] ?? 0
    return `${travelled / total * 100}%{transform:translate(${horizontal}px,${vertical}px)}`
  }).join('')
  const path = points.map(([horizontal, vertical], index) => `${index ? 'L' : 'M'}${horizontal} ${vertical}`).join(' ')
  const ends = points.filter((_, index) => index === 0 || index === points.length - 1)

  return (
    <g fill="none">
      <defs>
        <filter id={`${uid}-fg`} x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {glow && <path d={path} stroke={color} strokeOpacity=".1" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${uid}-fg)`} />}
      {glow && <path d={path} stroke={color} strokeOpacity=".14" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
      <path d={path} stroke={color} strokeOpacity={dashed ? '.4' : '.42'} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dashed ? '5 7' : undefined} className={dashed ? 'terra-march' : undefined} style={dashed ? { animationDelay: `${delay}s` } : undefined} />
      <style>{`@keyframes ${animation}{${frames}}`}</style>
      <circle cx="0" cy="0" r="2" fill={color} fillOpacity=".55" className="terra-packet" style={{ animationName: animation, animationDelay: `${delay + .22}s` }} />
      <circle cx="0" cy="0" r="3.4" fill={color} className="terra-packet" style={{ animationName: animation, animationDelay: `${delay}s`, filter: `drop-shadow(0 0 5px ${color})` }} />
      {ends.map(([horizontal, vertical], index) => (
        <g key={index}>
          <circle cx={horizontal} cy={vertical} r="6.5" fill={color} fillOpacity=".12" />
          <circle cx={horizontal} cy={vertical} r="3" fill="#0b1725" stroke={color} strokeWidth="1.5" />
        </g>
      ))}
    </g>
  )
}

function Rack({ horizontal = 0, vertical = 0, scale = 1, color = '#5c8bff' }: { horizontal?: number; vertical?: number; scale?: number; color?: string }) {
  const uid = useId().replace(/:/g, '')
  return (
    <g transform={`translate(${horizontal} ${vertical}) scale(${scale})`} strokeLinejoin="round">
      <defs>
        <linearGradient id={`${uid}-t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a4c5e" /><stop offset=".45" stopColor="#22404f" /><stop offset="1" stopColor="#152c3c" />
        </linearGradient>
        <linearGradient id={`${uid}-l`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#16303f" /><stop offset=".5" stopColor="#122637" /><stop offset="1" stopColor="#0a1926" />
        </linearGradient>
        <linearGradient id={`${uid}-r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#143650" /><stop offset=".5" stopColor="#102536" /><stop offset="1" stopColor="#091724" />
        </linearGradient>
        <linearGradient id={`${uid}-slot`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0a1622" /><stop offset=".55" stopColor="#0f2130" /><stop offset="1" stopColor="#0d1b2a" />
        </linearGradient>
        <radialGradient id={`${uid}-s`}>
          <stop offset="0" stopColor="#02070d" stopOpacity=".65" /><stop offset="1" stopColor="#02070d" stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}-g`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="1.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <ellipse cx="47" cy="142" rx="60" ry="12" fill={`url(#${uid}-s)`} />
      <path d="M0 10 55 -7 94 10 39 28Z" fill={`url(#${uid}-t)`} stroke={color} strokeOpacity=".55" />
      <path d="M5 9 55 -5 87 10" stroke="#ffffff" strokeOpacity=".22" strokeLinecap="round" />
      <path d="M5 10.5 55 -3.5 86 10.5" stroke="#ffffff" strokeOpacity=".08" strokeLinecap="round" />
      <path d="M0 10 39 28V137L0 117Z" fill={`url(#${uid}-l)`} stroke={color} strokeOpacity=".42" />
      <path d="M39 28 94 10V118L39 137Z" fill={`url(#${uid}-r)`} stroke={color} strokeOpacity=".32" />
      <path d="M2 13 39 29" stroke="#ffffff" strokeOpacity=".07" />
      {[0, 1, 2, 3].map(slot => (
        <g key={slot} transform={`translate(0 ${slot * 25})`}>
          <path d="M45 35 88 20V37L45 52Z" fill={`url(#${uid}-slot)`} stroke={color} strokeOpacity=".3" />
          <path d="M45 35 88 20V24L45 39Z" fill="#ffffff" fillOpacity=".05" />
          <path d="M51 37 72 30M51 42 66 37" stroke={color} strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M51 47 60 43.5" stroke={color} strokeOpacity=".3" strokeWidth="1" strokeLinecap="round" />
          <circle cx="81" cy="31" r="2.2" fill={color} className="terra-light" style={{ animationDelay: `${slot * -.7}s`, filter: `drop-shadow(0 0 3px ${color})` }} />
          <circle cx="76.5" cy="33" r="1.4" fill={color} fillOpacity=".5" />
          <path d="M8 25 29 35M8 29 29 39M8 33 29 43" stroke="#315063" strokeOpacity=".9" strokeLinecap="round" />
        </g>
      ))}
      <path d="M45 128 86 114" stroke={color} strokeWidth="2.2" strokeOpacity=".75" filter={`url(#${uid}-g)`} />
      <path d="M45 131 86 117" stroke={color} strokeWidth="1" strokeOpacity=".25" />
    </g>
  )
}

function Chip({ horizontal = 0, vertical = 0, scale = 1, label = 'GPU', color = '#90a8ff' }: { horizontal?: number; vertical?: number; scale?: number; label?: string; color?: string }) {
  const uid = useId().replace(/:/g, '')
  return (
    <g transform={`translate(${horizontal} ${vertical}) scale(${scale})`} strokeLinejoin="round">
      <defs>
        <linearGradient id={`${uid}-t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22405a" /><stop offset=".5" stopColor="#1a3145" /><stop offset="1" stopColor="#101f30" />
        </linearGradient>
        <linearGradient id={`${uid}-d`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".65" /><stop offset=".6" stopColor={color} stopOpacity=".35" /><stop offset="1" stopColor={color} stopOpacity=".2" />
        </linearGradient>
        <linearGradient id={`${uid}-side`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d1e2e" /><stop offset="1" stopColor="#081420" />
        </linearGradient>
        <radialGradient id={`${uid}-s`}>
          <stop offset="0" stopColor="#02070d" stopOpacity=".65" /><stop offset="1" stopColor="#02070d" stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}-g`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <ellipse cx="76" cy="52" rx="88" ry="15" fill={`url(#${uid}-s)`} />
      <path d="M0 0 76 -39 153 0 76 40Z" fill={`url(#${uid}-t)`} stroke={color} strokeOpacity=".55" />
      <path d="M8 -1 76 -35 146 -1" stroke="#ffffff" strokeOpacity=".18" strokeLinecap="round" />
      <path d="M0 0V12L76 53 153 12V0L76 40Z" fill={`url(#${uid}-side)`} stroke={color} strokeOpacity=".42" />
      <path d="M39 -2 76 -21 114 -2 76 18Z" fill={`url(#${uid}-d)`} stroke={color} />
      <path d="M39 -2V7L76 27 114 7V-2L76 18Z" fill="#0c1d2d" stroke={color} strokeOpacity=".65" />
      <path d="M42 -3 76 -20 111 -3" stroke="#ffffff" strokeOpacity=".25" strokeLinecap="round" />
      <path d="M76 -21V18" stroke="#ffffff" strokeOpacity=".16" />
      {[0, 1, 2, 3].map(pin => <g key={pin} stroke={color} strokeOpacity=".6" strokeLinecap="round"><path d={`M${23 + pin * 10} ${-7 - pin * 5}l-10 -6M${95 + pin * 10} ${17 - pin * 5}l10 5M${25 + pin * 10} ${14 + pin * 5}l-8 5`} /></g>)}
      <text x="76" y="1" textAnchor="middle" fill={color} fontSize="13" fontWeight="700" letterSpacing=".5" filter={`url(#${uid}-g)`}>{label}</text>
    </g>
  )
}

function Building({ home = false }: { home?: boolean }) {
  const uid = useId().replace(/:/g, '')
  return (
    <g strokeLinejoin="round">
      <defs>
        <linearGradient id={`${uid}-t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#265062" /><stop offset=".5" stopColor="#1c3a4a" /><stop offset="1" stopColor="#152e3c" />
        </linearGradient>
        <linearGradient id={`${uid}-l`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#14303f" /><stop offset="1" stopColor="#0b1a27" />
        </linearGradient>
        <linearGradient id={`${uid}-r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a4050" /><stop offset="1" stopColor="#0d2231" />
        </linearGradient>
        <linearGradient id={`${uid}-win`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b7fff0" /><stop offset="1" stopColor="#5c8bff" />
        </linearGradient>
        <radialGradient id={`${uid}-s`}>
          <stop offset="0" stopColor="#02070d" stopOpacity=".65" /><stop offset="1" stopColor="#02070d" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="58" cy="130" rx="76" ry="14" fill={`url(#${uid}-s)`} />
      <path d="M0 26 66 3 116 28 51 53Z" fill={`url(#${uid}-t)`} stroke="#5c8bff" strokeOpacity=".55" />
      <path d="M0 26V98L51 126V53Z" fill={`url(#${uid}-l)`} stroke="#5c8bff" strokeOpacity=".45" />
      <path d="M51 53 116 28V101L51 126Z" fill={`url(#${uid}-r)`} stroke="#5c8bff" strokeOpacity=".4" />
      {home && <path d="M-8 28 32 -17 73 7 124 28 57 55 32 16Z" fill="#1f4450" stroke="#9debff" strokeOpacity=".65" />}
      {[0, 1, 2].map(column => [0, 1].map(row => (
        <g key={`${column}-${row}`}>
          <path
            d={`M${61 + column * 17} ${62 + row * 22 - column * 6}l10 -4v13l-10 4Z`}
            fill={`url(#${uid}-win)`}
            fillOpacity={row === column ? '.7' : '.16'}
            className={row === column ? 'terra-light' : undefined}
            style={row === column ? { animationDelay: `${(column - row) * -.9}s`, filter: 'drop-shadow(0 0 4px #5c8bff)' } : undefined}
          />
          <path d={`M${61 + column * 17} ${62 + row * 22 - column * 6}l10 -4`} stroke="#ffffff" strokeOpacity=".25" />
        </g>
      )))}
      <path d="M12 49 22 54V68L12 63ZM30 59 40 64V78L30 73ZM12 75 22 80V94L12 89ZM30 85 40 90V104L30 99Z" fill="#5c8bff" fillOpacity=".2" />
      <path d="M4 27 66 6 112 28" stroke="#ffffff" strokeOpacity=".16" />
      <path d="M3 28.5 66 7.5" stroke="#ffffff" strokeOpacity=".07" />
      <path d="M51 53v73" stroke="#ffffff" strokeOpacity=".06" />
    </g>
  )
}

function NodeCluster({ x, y, accent, label, body, glyph }: { x: number; y: number; accent: string; label: string; body: string; glyph: ReactNode }) {
  const uid = useId().replace(/:/g, '')
  return (
    <g transform={`translate(${x} ${y})`} strokeLinejoin="round">
      <defs>
        <linearGradient id={`${uid}-c`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1b3a4e" /><stop offset=".5" stopColor="#163041" /><stop offset="1" stopColor="#0e2132" />
        </linearGradient>
        <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".1" /><stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${uid}-aura`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor={accent} stopOpacity=".14" /><stop offset="1" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}-g`} x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="-14" y="-12" width="176" height="92" rx="22" fill={`url(#${uid}-aura)`} />
      <rect x="0" y="0" width="148" height="64" rx="14" fill={`url(#${uid}-c)`} stroke={accent} strokeOpacity=".55" />
      <rect x="1.5" y="1.5" width="145" height="61" rx="12.5" fill={`url(#${uid}-sheen)`} />
      <rect x="1" y="1" width="146" height="28" rx="13" fill={accent} fillOpacity=".06" />
      <rect x="10" y="10" width="30" height="30" rx="9" fill={accent} fillOpacity=".14" stroke={accent} strokeOpacity=".5" />
      <rect x="11.5" y="11.5" width="27" height="13" rx="7" fill="#ffffff" fillOpacity=".07" />
      <g transform="translate(17 17)" color={accent} filter={`url(#${uid}-g)`}>{glyph}</g>
      <text x="48" y="26" fill="#d9fff4" fontSize="13.5" fontWeight="700" letterSpacing=".4">{label}</text>
      <text x="48" y="44" fill={accent} fillOpacity=".85" fontSize="10.5" fontWeight="600" letterSpacing=".6">{body}</text>
      <circle cx="134" cy="20" r="3" fill={accent} className="terra-light" style={{ filter: `drop-shadow(0 0 4px ${accent})` }} />
    </g>
  )
}

function PacketGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 5.2 8 2l6 3.2v5.6L8 14l-6-3.2V5.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 5.2 8 8.4l6-3.2M8 8.4V14" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".7" />
    </svg>
  )
}

function GearGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ChipGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PulseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8h3l1.6-3.4L9.2 12l1.6-4H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function NetworkIllustration() {
  const c = useLandingCopy()
  const uid = useId().replace(/:/g, '')
  const metrics = ['99.9% uptime', '<12ms p95', '3 regions live']
  const ring = [
    { x: 286, y: 56, accent: '#5c8bff', label: 'Edge Gateway', body: 'ingress · wss', glyph: <PacketGlyph /> },
    { x: 498, y: 146, accent: '#789bff', label: 'GPU Pool', body: '48×H100', glyph: <ChipGlyph /> },
    { x: 498, y: 316, accent: '#b56dff', label: 'Cloud Burst', body: 'burst · $/hr', glyph: <PacketGlyph /> },
    { x: 286, y: 406, accent: '#90a8ff', label: 'Control Plane', body: 'schedule · observe', glyph: <GearGlyph /> },
    { x: 74, y: 316, accent: '#f6c889', label: 'Telemetry', body: 'otel · logs', glyph: <PulseGlyph /> },
    { x: 74, y: 146, accent: '#5c8bff', label: 'On-prem Lab', body: c.illus.onPremBody, glyph: <ChipGlyph /> },
  ]
  return (
    <AnimatedScene className="terra-network" label={c.illus.networkAria}>
      <svg viewBox="0 0 720 600" width="100%" height="100%" fill="none" aria-hidden="true">
        <defs>
          <radialGradient id={`${uid}-bg`} cx=".5" cy=".45" r=".7">
            <stop offset="0" stopColor="#113040" stopOpacity=".6" />
            <stop offset=".6" stopColor="#0b2432" stopOpacity=".35" />
            <stop offset="1" stopColor="#061018" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-bg2`} cx=".5" cy=".42" r=".42">
            <stop offset="0" stopColor="#5c8bff" stopOpacity=".1" />
            <stop offset="1" stopColor="#5c8bff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-vig`} cx=".5" cy=".5" r=".75">
            <stop offset=".7" stopColor="#02070d" stopOpacity="0" />
            <stop offset="1" stopColor="#02070d" stopOpacity=".4" />
          </radialGradient>
          <linearGradient id={`${uid}-orbit`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#5c8bff" stopOpacity=".05" />
            <stop offset=".5" stopColor="#789bff" stopOpacity=".4" />
            <stop offset="1" stopColor="#b56dff" stopOpacity=".08" />
          </linearGradient>
          <radialGradient id={`${uid}-core`} cx=".5" cy=".5" r=".5">
            <stop offset="0" stopColor="#d9fff6" />
            <stop offset=".4" stopColor="#5c8bff" />
            <stop offset="1" stopColor="#1a5f56" />
          </radialGradient>
          <radialGradient id={`${uid}-halo2`} cx=".5" cy=".5" r=".5">
            <stop offset="0" stopColor="#5c8bff" stopOpacity=".28" />
            <stop offset="1" stopColor="#5c8bff" stopOpacity="0" />
          </radialGradient>
          <pattern id={`${uid}-grid`} width="36" height="36" patternUnits="userSpaceOnUse">
            <path d="M36 0H0V36" stroke="#5c8bff" strokeOpacity=".04" />
            <path d="M18 0V36M0 18h36" stroke="#5c8bff" strokeOpacity=".018" />
          </pattern>
          <filter id={`${uid}-halo`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="8" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width="720" height="600" rx="24" fill={`url(#${uid}-bg)`} />
        <rect width="720" height="600" rx="24" fill={`url(#${uid}-bg2)`} />
        <rect width="720" height="600" rx="24" fill={`url(#${uid}-grid)`} />
        <ellipse cx="360" cy="265" rx="272" ry="196" stroke={`url(#${uid}-orbit)`} strokeWidth="1.2" strokeDasharray="7 9" className="terra-spin" style={{ animationDuration: '46s' }} />
        <ellipse cx="360" cy="265" rx="214" ry="238" stroke="#90a8ff" strokeOpacity=".13" strokeWidth="1" strokeDasharray="3 11" className="terra-spin" style={{ animationDuration: '64s', animationDirection: 'reverse' }} />
        <path d="M40 60h26M40 60v26M680 60h-26M680 60v26M40 540h26M40 540v-26M680 540h-26M680 540v-26" stroke="#5c8bff" strokeOpacity=".3" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="360" cy="265" r="150" fill={`url(#${uid}-halo2)`} />
        <Flow points={[[360, 120], [346, 156], [356, 192]]} color="#5c8bff" delay={0} />
        <Flow points={[[498, 178], [458, 196], [426, 222]]} color="#789bff" delay={.5} />
        <Flow points={[[498, 348], [460, 332], [426, 308]]} color="#b56dff" delay={1} />
        <Flow points={[[360, 400], [374, 370], [362, 342]]} color="#90a8ff" delay={1.5} />
        <Flow points={[[222, 348], [260, 332], [294, 308]]} color="#f6c889" delay={.7} />
        <Flow points={[[222, 178], [260, 196], [294, 222]]} color="#5c8bff" delay={1.2} />
        <Flow points={[[148, 214], [148, 265], [148, 314]]} color="#f6c889" delay={.4} dashed glow={false} />
        <Flow points={[[572, 214], [572, 265], [572, 314]]} color="#789bff" delay={.9} dashed glow={false} />
        {ring.map(node => <NodeCluster key={node.label} x={node.x} y={node.y} accent={node.accent} label={node.label} body={node.body} glyph={node.glyph} />)}
        <g transform="translate(360 265)">
          <circle r="86" stroke="#5c8bff" strokeOpacity=".16" strokeWidth="1.2" className="terra-pulse-ring" />
          <circle r="86" stroke="#789bff" strokeOpacity=".12" strokeWidth="1.2" className="terra-pulse-ring" style={{ animationDelay: '-2s' }} />
          <circle r="60" fill="#5c8bff" fillOpacity=".06" stroke="#5c8bff" strokeOpacity=".32" />
          <circle r="60" fill="none" stroke="#5c8bff" strokeOpacity=".18" strokeDasharray="4 8" className="terra-spin" style={{ animationDuration: '24s' }} />
          <g className="terra-float" filter={`url(#${uid}-halo)`}>
            <circle r="44" fill={`url(#${uid}-core)`} stroke="#b7fff0" strokeWidth="1.5" />
            {/* lucide "orbit" mark, scaled 4x, drawn as a dark monogram on the glowing core */}
            <g transform="translate(-48 -48) scale(4)" fill="none" stroke="#04131c" strokeWidth="1.7" strokeLinecap="round">
              <path d="M20.341 6.484A10 10 0 0 1 10.266 21.85" />
              <path d="M3.659 17.516A10 10 0 0 1 13.74 2.152" />
              <circle cx="12" cy="12" r="3" fill="#04131c" stroke="none" />
              <circle cx="19" cy="5" r="2" fill="#04131c" stroke="none" />
              <circle cx="5" cy="19" r="2" fill="#04131c" stroke="none" />
            </g>
          </g>
        </g>
        <g className="terra-spin" style={{ transformBox: 'view-box', transformOrigin: '360px 265px', animationDuration: '20s' }}>
          <circle cx="434" cy="265" r="3" fill="#b7fff0" style={{ filter: 'drop-shadow(0 0 5px #5c8bff)' }} />
          <circle cx="300" cy="318" r="2.2" fill="#90a8ff" style={{ filter: 'drop-shadow(0 0 4px #90a8ff)' }} />
        </g>
        <g>
          {metrics.map((metric, index) => (
            <g key={metric} transform={`translate(${105 + index * 172} 508)`}>
              <rect width="156" height="30" rx="15" fill="#0b1725" fillOpacity=".9" stroke="#5c8bff" strokeOpacity=".32" />
              <circle cx="16" cy="15" r="3.5" fill={index === 2 ? '#789bff' : '#5c8bff'} className="terra-light" style={{ animationDelay: `${index * -.6}s` }} />
              <text x="30" y="19" fill="#b7e7ff" fontSize="12.5" fontWeight="600">{metric}</text>
            </g>
          ))}
        </g>
        {[[150, 80], [580, 90], [250, 545], [560, 545], [640, 300], [80, 90]].map(([cx, cy], index) => (
          <circle key={index} cx={cx} cy={cy} r={index % 2 ? 2 : 2.6} fill={index % 3 ? '#5c8bff' : '#90a8ff'} fillOpacity=".5" className="terra-float" style={{ animationDelay: `${index * -.8}s` }} />
        ))}
        <rect width="720" height="600" rx="24" fill={`url(#${uid}-vig)`} />
      </svg>
    </AnimatedScene>
  )
}

function LayerPanel({ x, y, w, h, accent, title, children }: { x: number; y: number; w: number; h: number; accent: string; title: string; children?: ReactNode }) {
  const uid = useId().replace(/:/g, '')
  return (
    <g transform={`translate(${x} ${y})`} strokeLinejoin="round">
      <defs>
        <linearGradient id={`${uid}-p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#142c3d" stopOpacity=".95" /><stop offset="1" stopColor="#0d1d2c" stopOpacity=".95" />
        </linearGradient>
        <filter id={`${uid}-g`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect width={w} height={h} rx="14" fill={`url(#${uid}-p)`} stroke={accent} strokeOpacity=".55" />
      <rect x="1" y="1" width={w - 2} height="22" rx="13" fill={accent} fillOpacity=".08" />
      <text x="12" y="15" fill={accent} fontSize="9.5" fontWeight="700" letterSpacing="1.4" filter={`url(#${uid}-g)`}>{title}</text>
      {children}
    </g>
  )
}

const layerScenes = [
  {
    tag: 'CONNECT',
    accent: '#5c8bff',
    detail: 'SDK · gRPC · Webhooks',
    render: (accent: string) => (
      <g>
        <rect x="18" y="40" width="46" height="58" rx="8" fill="#0b1725" stroke={accent} strokeOpacity=".45" />
        <path d="M28 56h26M28 68h20M28 80h24" stroke={accent} strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
        <Flow points={[[70, 70], [96, 70], [110, 70]]} color={accent} delay={.1} />
        <rect x="118" y="44" width="52" height="50" rx="9" fill="#101f30" stroke={accent} strokeOpacity=".5" />
        <rect x="130" y="56" width="28" height="26" rx="5" fill={accent} fillOpacity=".18" stroke={accent} />
        <text x="144" y="73" textAnchor="middle" fill={accent} fontSize="9" fontWeight="700">API</text>
        <circle cx="178" cy="70" r="5" fill={accent} className="terra-light" style={{ filter: `drop-shadow(0 0 4px ${accent})` }} />
      </g>
    ),
  },
  {
    tag: 'ORCHESTRATE',
    accent: '#789bff',
    detail: 'queue · rate-limit · fanout',
    render: (accent: string) => (
      <g>
        <rect x="16" y="38" width="40" height="64" rx="8" fill="#0b1725" stroke={accent} strokeOpacity=".45" />
        {[0, 1, 2].map(i => <rect key={i} x="24" y={48 + i * 16} width="24" height="8" rx="3" fill={accent} fillOpacity={i === 1 ? '.55' : '.2'} className={i === 1 ? 'terra-light' : undefined} />)}
        <path d="M62 70h28" stroke={accent} strokeWidth="1.5" strokeDasharray="4 5" className="terra-march" />
        <circle cx="108" cy="70" r="22" fill="#0d1f2e" stroke={accent} strokeOpacity=".55" />
        <path d="M108 54v32M94 70h28M98 60l20 20M118 60l-20 20" stroke={accent} strokeOpacity=".7" strokeWidth="1.3" className="terra-spin" style={{ transformBox: 'view-box', transformOrigin: '108px 70px', animationDuration: '8s' }} />
        <circle cx="108" cy="70" r="7" fill={accent} fillOpacity=".5" />
        <path d="M134 70h20" stroke={accent} strokeWidth="1.5" strokeDasharray="4 5" className="terra-march" style={{ animationDelay: '-.4s' }} />
        <rect x="158" y="50" width="30" height="40" rx="7" fill="#101f30" stroke={accent} strokeOpacity=".5" />
        <path d="M166 62h14M166 72h10M166 82h14" stroke={accent} strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    ),
  },
  {
    tag: 'INFERENCE',
    accent: '#90a8ff',
    detail: 'vLLM · LoRA · batch',
    render: (accent: string) => (
      <g>
        <rect x="14" y="36" width="70" height="70" rx="10" fill="#0b1725" stroke={accent} strokeOpacity=".45" />
        <circle cx="34" cy="56" r="5" fill={accent} fillOpacity=".7" /><circle cx="54" cy="56" r="5" fill={accent} fillOpacity=".45" /><circle cx="74" cy="56" r="5" fill={accent} fillOpacity=".7" />
        <circle cx="44" cy="78" r="5" fill={accent} fillOpacity=".5" /><circle cx="64" cy="78" r="5" fill={accent} fillOpacity=".7" />
        <path d="M34 56h20M54 56h20M34 56l10 22M54 56l10 22M74 56 64 78" stroke={accent} strokeOpacity=".4" strokeWidth="1.2" className="terra-march" style={{ animationDelay: '-.8s' }} />
        <Flow points={[[92, 70], [120, 70]]} color={accent} delay={.2} />
        <rect x="128" y="40" width="58" height="62" rx="10" fill="#101f30" stroke={accent} strokeOpacity=".55" />
        <rect x="140" y="52" width="34" height="24" rx="4" fill={accent} fillOpacity=".2" stroke={accent} strokeOpacity=".7" />
        <path d="M146 60h22M146 68h16" stroke={accent} strokeOpacity=".8" strokeWidth="1.5" strokeLinecap="round" />
        <text x="157" y="90" textAnchor="middle" fill={accent} fontSize="9" fontWeight="700">GPU</text>
      </g>
    ),
  },
  {
    tag: 'OBSERVE',
    accent: '#f6c889',
    detail: 'metrics · traces · alerts',
    render: (accent: string) => (
      <g>
        <rect x="16" y="36" width="76" height="70" rx="10" fill="#0b1725" stroke={accent} strokeOpacity=".45" />
        <path d="M26 90l16-20 12 10 14-24 14 16" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="terra-march" style={{ animationDelay: '-1.2s' }} />
        <circle cx="54" cy="80" r="3.5" fill={accent} className="terra-light" style={{ filter: `drop-shadow(0 0 4px ${accent})` }} />
        <circle cx="148" cy="70" r="34" fill="#0d1f2e" stroke={accent} strokeOpacity=".4" />
        <circle cx="148" cy="70" r="34" fill="none" stroke={accent} strokeOpacity=".55" strokeWidth="3" strokeDasharray="40 174" className="terra-spin" style={{ animationDuration: '4s' }} />
        <circle cx="148" cy="70" r="22" fill="none" stroke={accent} strokeOpacity=".25" strokeDasharray="3 6" className="terra-spin" style={{ animationDuration: '9s', animationDirection: 'reverse' }} />
        <circle cx="148" cy="70" r="5" fill={accent} fillOpacity=".7" />
        <path d="M100 70h14" stroke={accent} strokeWidth="1.5" strokeDasharray="3 4" className="terra-march" />
      </g>
    ),
  },
]

export function LayerIllustration({ index = 0 }: { index?: number }) {
  const c = useLandingCopy()
  const scene = layerScenes[Math.max(0, Math.min(index, layerScenes.length - 1))] ?? layerScenes[0]!
  return (
    <AnimatedScene className="terra-layer-art" label={`${c.layers.layerAria}${scene.tag}`}>
      <svg viewBox="0 0 300 205" width="100%" height="100%" fill="none" aria-hidden="true" key={scene.tag}>
        <defs>
          <radialGradient id="layer-glow" cx=".5" cy=".5" r=".6">
            <stop offset="0" stopColor={scene.accent} stopOpacity=".16" />
            <stop offset="1" stopColor={scene.accent} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="300" height="205" rx="16" fill="#0a1520" />
        <rect width="300" height="205" rx="16" fill="url(#layer-glow)" />
        <path d="M12 12h18M12 12v18M288 12h-18M288 12v18M12 193h18M12 193v-18M288 193h-18M288 193v-18" stroke={scene.accent} strokeOpacity=".35" strokeWidth="1.4" strokeLinecap="round" />
        <LayerPanel x={16} y={20} w={130} h={28} accent={scene.accent} title={scene.tag} />
        <text x={156} y={39} fill="#7d93a8" fontSize="10" fontWeight="600" letterSpacing=".3">{scene.detail}</text>
        {scene.render(scene.accent)}
        <g transform="translate(16 158)">
          {[0, 1, 2, 3].map(i => (
            <g key={i} transform={`translate(${i * 68} 0)`}>
              <rect width="58" height="28" rx="8" fill="#0d1f2e" fillOpacity=".8" stroke={layerScenes[i]?.accent} strokeOpacity={i === index ? '.7' : '.22'} />
              <text x="29" y="18" textAnchor="middle" fill={layerScenes[i]?.accent} fillOpacity={i === index ? '1' : '.45'} fontSize="8.5" fontWeight="700" letterSpacing=".5">{layerScenes[i]?.tag}</text>
            </g>
          ))}
        </g>
      </svg>
    </AnimatedScene>
  )
}

const scenarioMeta = [
  { nodes: 3, accent: '#5c8bff' },
  { nodes: 2, accent: '#789bff' },
  { nodes: 4, accent: '#b56dff' },
]

/** 01 Campus: lab building + shared GPU behind a permission gate, student nodes connect in. */
function CampusScene({ accent, uid }: { accent: string; uid: string }) {
  return (
    <g>
      <defs>
        <pattern id={`${uid}-lawn`} width="14" height="14" patternUnits="userSpaceOnUse">
          <path d="M0 14 14 0" stroke={accent} strokeOpacity=".08" />
        </pattern>
        <radialGradient id={`${uid}-glow`}>
          <stop offset="0" stopColor={accent} stopOpacity=".3" /><stop offset="1" stopColor={accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M20 190h320" stroke={accent} strokeOpacity=".25" strokeDasharray="2 6" />
      <path d="M40 150h280v50H40Z" fill={`url(#${uid}-lawn)`} stroke={accent} strokeOpacity=".2" />
      <path d="M40 170h100v30H40ZM200 170h120v30H200Z" fill={accent} fillOpacity=".05" />
      <g transform="translate(48 78) scale(.72)">
        <Building home />
      </g>
      <text x="96" y="184" textAnchor="middle" fill={accent} fillOpacity=".8" fontSize="9" fontWeight="700" letterSpacing=".8">LAB BUILDING</text>
      <g transform="translate(214 74) scale(.78)">
        <Rack color={accent} />
      </g>
      <circle cx="258" cy="86" r="16" fill={`url(#${uid}-glow)`} />
      <path d="M258 74l10 4v9c0 7-5 12-10 14-5-2-10-7-10-14v-9Z" fill="#0d1f2e" stroke={accent} strokeWidth="1.4" />
      <path d="M254 87l3 3 6-7" stroke={accent} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <text x="258" y="184" textAnchor="middle" fill={accent} fillOpacity=".8" fontSize="9" fontWeight="700" letterSpacing=".8">SHARED GPU</text>
      <Flow points={[[144, 120], [180, 118], [210, 116]]} color={accent} delay={.1} />
      {[{ x: 64, y: 208, d: 0 }, { x: 150, y: 214, d: .7 }, { x: 300, y: 210, d: 1.3 }].map(node => (
        <g key={node.x}>
          <rect x={node.x - 26} y={node.y - 11} width="52" height="20" rx="10" fill="#0d1f2e" stroke={accent} strokeOpacity=".45" />
          <circle cx={node.x - 14} cy={node.y - 1} r="3" fill={accent} className="terra-light" style={{ animationDelay: `${node.d}s` }} />
          <text x={node.x + 6} y={node.y + 3} textAnchor="middle" fill="#b7d9d4" fontSize="8.5" fontWeight="600">node</text>
          <path d={`M${node.x} ${node.y - 11}C${node.x} ${node.y - 40} ${node.x < 200 ? 200 : 258} ${node.y - 30} ${node.x < 200 ? 214 : 258} ${node.y - 70}`} stroke={accent} strokeOpacity=".4" strokeWidth="1.2" strokeDasharray="3 5" className="terra-march" fill="none" style={{ animationDelay: `${node.d}s` }} />
        </g>
      ))}
      {[{ x: 30, y: 50 }, { x: 330, y: 60 }, { x: 180, y: 40 }].map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r="2.4" fill={accent} fillOpacity=".5" className="terra-float" style={{ animationDelay: `${i * -.8}s` }} />
      ))}
    </g>
  )
}

/** 02 Home lab: desk with workstation + local model, one controlled wire out the window. */
function HomeLabScene({ accent, uid }: { accent: string; uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#10202e" /><stop offset="1" stopColor="#0a1622" />
        </linearGradient>
        <linearGradient id={`${uid}-lamp`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6c889" stopOpacity=".35" /><stop offset="1" stopColor="#f6c889" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${uid}-screen`}>
          <stop offset="0" stopColor={accent} stopOpacity=".5" /><stop offset="1" stopColor={accent} stopOpacity=".08" />
        </radialGradient>
      </defs>
      <path d="M0 40h360v150H0Z" fill={`url(#${uid}-wall)`} />
      <path d="M0 190h360" stroke={accent} strokeOpacity=".3" />
      <path d="M250 56h70v66h-70Z" fill="#0c1a28" stroke={accent} strokeOpacity=".4" />
      <path d="M285 56v66M250 89h70" stroke={accent} strokeOpacity=".3" />
      <path d="M250 56h70v66" stroke="#ffffff" strokeOpacity=".08" />
      <path d="M36 150h180l16 40H20Z" fill="#153040" stroke={accent} strokeOpacity=".5" />
      <path d="M36 150h180" stroke="#ffffff" strokeOpacity=".12" />
      <path d="M74 150V86h64v64" fill="#0e2130" stroke={accent} strokeOpacity=".55" />
      <path d="M82 96h48v34H82Z" fill={`url(#${uid}-screen)`} stroke={accent} strokeOpacity=".6" />
      <path d="M88 104h30M88 112h22M88 120h34" stroke={accent} strokeOpacity=".75" strokeWidth="1.5" strokeLinecap="round" className="terra-march" />
      <circle cx="134" cy="140" r="3" fill={accent} className="terra-light" style={{ filter: `drop-shadow(0 0 4px ${accent})` }} />
      <g transform="translate(154 108) scale(.42)">
        <Chip label="AI" color={accent} />
      </g>
      <path d="M40 60h40l8 26H32Z" fill="#1a3345" stroke="#f6c889" strokeOpacity=".55" />
      <path d="M60 86 96 150" stroke={`url(#${uid}-lamp)`} strokeWidth="26" strokeLinecap="round" />
      <circle cx="60" cy="86" r="4" fill="#f6c889" className="terra-light" style={{ animationDelay: '-1s', filter: 'drop-shadow(0 0 6px #f6c889)' }} />
      <rect x="44" y="132" width="26" height="18" rx="4" fill="#0d1f2e" stroke={accent} strokeOpacity=".5" />
      <text x="57" y="144" textAnchor="middle" fill={accent} fontSize="8" fontWeight="700">LLM</text>
      <Flow points={[[170, 128], [210, 118], [244, 104]]} color={accent} delay={.3} />
      <path d="M320 90c14-2 22-10 24-24" stroke={accent} strokeOpacity=".55" strokeWidth="1.5" strokeDasharray="4 5" className="terra-march" fill="none" />
      <g transform="translate(318 44)">
        <rect width="34" height="24" rx="8" fill="#0d1f2e" stroke={accent} strokeOpacity=".6" />
        <path d="M10 14h14M17 7v14" stroke={accent} strokeWidth="1.4" strokeLinecap="round" />
      </g>
      <text x="336" y="132" textAnchor="middle" fill={accent} fillOpacity=".75" fontSize="8" fontWeight="700">OUT</text>
      <text x="57" y="208" textAnchor="middle" fill="#7d93a8" fontSize="9" fontWeight="600" letterSpacing=".6">WORKSTATION</text>
      <text x="176" y="208" textAnchor="middle" fill={accent} fillOpacity=".8" fontSize="9" fontWeight="700" letterSpacing=".6">LOCAL MODEL</text>
      {[{ x: 20, y: 70 }, { x: 200, y: 52 }].map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r="2.2" fill="#f6c889" fillOpacity=".45" className="terra-float" style={{ animationDelay: `${i * -1.1}s` }} />
      ))}
    </g>
  )
}

/** 03 Small teams: prototype card → deploy pods → running agent service, team above. */
function TeamScene({ accent, uid }: { accent: string; uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-ok`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={accent} stopOpacity=".1" /><stop offset="1" stopColor={accent} stopOpacity=".35" />
        </linearGradient>
      </defs>
      <path d="M16 196h328" stroke={accent} strokeOpacity=".22" strokeDasharray="2 7" />
      <g transform="translate(16 56)">
        <rect width="88" height="64" rx="10" fill="#0d1f2e" stroke={accent} strokeOpacity=".5" />
        <rect x="10" y="10" width="36" height="10" rx="3" fill={accent} fillOpacity=".35" />
        <rect x="10" y="26" width="58" height="6" rx="3" fill={accent} fillOpacity=".18" />
        <rect x="10" y="38" width="46" height="6" rx="3" fill={accent} fillOpacity=".18" />
        <rect x="10" y="50" width="30" height="6" rx="3" fill={accent} fillOpacity=".12" />
        <path d="M66 44l8 8 12-16" stroke={accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <text x="44" y="80" textAnchor="middle" fill="#7d93a8" fontSize="9" fontWeight="700" letterSpacing=".8">PROTOTYPE</text>
      </g>
      <Flow points={[[112, 88], [136, 88], [158, 88]]} color={accent} delay={.2} />
      <g transform="translate(164 48)">
        <rect width="76" height="80" rx="12" fill="#0e2130" stroke={accent} strokeOpacity=".5" />
        {[0, 1, 2].map(i => (
          <g key={i} transform={`translate(12 ${10 + i * 24})`}>
            <rect width="52" height="18" rx="6" fill="#13293a" stroke={accent} strokeOpacity={i === 1 ? '.7' : '.35'} />
            <circle cx="9" cy="9" r="3" fill={accent} fillOpacity={i === 1 ? '1' : '.4'} className={i === 1 ? 'terra-light' : undefined} />
            <text x="30" y="13" textAnchor="middle" fill="#b7d9d4" fontSize="8" fontWeight="600">pod-{i + 1}</text>
          </g>
        ))}
        <text x="38" y="96" textAnchor="middle" fill="#7d93a8" fontSize="9" fontWeight="700" letterSpacing=".8">DEPLOY</text>
      </g>
      <Flow points={[[248, 88], [270, 88], [290, 88]]} color={accent} delay={.7} />
      <g transform="translate(296 56)">
        <rect width="52" height="64" rx="12" fill={`url(#${uid}-ok)`} stroke={accent} strokeOpacity=".7" />
        <circle cx="26" cy="24" r="10" fill={accent} fillOpacity=".2" stroke={accent} />
        <path d="M22 24l3 3 6-7" stroke={accent} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <text x="26" y="48" textAnchor="middle" fill={accent} fontSize="9" fontWeight="800">LIVE</text>
        <text x="26" y="80" textAnchor="middle" fill="#7d93a8" fontSize="9" fontWeight="700" letterSpacing=".8">SERVICE</text>
      </g>
      <g transform="translate(132 20)">
        {[0, 1, 2].map(i => (
          <g key={i} transform={`translate(${i * 22} 0)`}>
            <circle cx="12" cy="12" r="11" fill="#0d1f2e" stroke={accent} strokeOpacity={i === 2 ? '.7' : '.4'} />
            <circle cx="12" cy="9" r="3.5" fill={accent} fillOpacity=".55" />
            <path d="M5.5 19c1.5-4 4-5.5 6.5-5.5s5 1.5 6.5 5.5" fill={accent} fillOpacity=".35" />
          </g>
        ))}
        <path d="M66 12h30" stroke={accent} strokeOpacity=".4" strokeWidth="1.2" strokeDasharray="3 4" className="terra-march" />
        <rect x="100" y="2" width="58" height="20" rx="8" fill="#0d1f2e" stroke={accent} strokeOpacity=".45" />
        <text x="129" y="16" textAnchor="middle" fill={accent} fontSize="8.5" fontWeight="700">3 teammates</text>
      </g>
      <path d="M296 148h52M296 156h52M296 164h52" stroke={accent} strokeOpacity=".2" strokeWidth="3" strokeLinecap="round" />
      <path d="M296 164l14-8 12 5 14-12 12 4" stroke={accent} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="terra-march" style={{ animationDelay: '-.9s' }} fill="none" />
      <text x="322" y="184" textAnchor="middle" fill={accent} fillOpacity=".7" fontSize="8" fontWeight="700">SLO 99.9%</text>
      {[{ x: 34, y: 40 }, { x: 330, y: 36 }].map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r="2.3" fill={accent} fillOpacity=".5" className="terra-float" style={{ animationDelay: `${i * -1.3}s` }} />
      ))}
    </g>
  )
}

const scenarioScenes = [CampusScene, HomeLabScene, TeamScene]

export function ScenarioIllustration({ index = 0 }: { index?: number }) {
  const c = useLandingCopy()
  const uid = useId().replace(/:/g, '')
  const safe = Math.max(0, Math.min(index, scenarioMeta.length - 1))
  const meta = scenarioMeta[safe]!
  const copy = c.scenarios.items[safe]!
  const Scene = scenarioScenes[safe] ?? scenarioScenes[0]!
  return (
    <AnimatedScene className="terra-scenario-art" label={`${c.scenarios.ariaPrefix}${copy.title}`}>
      <svg viewBox="0 0 360 230" width="100%" height="100%" fill="none" aria-hidden="true" key={copy.label}>
        <rect width="360" height="230" rx="16" fill="#0a1520" />
        <path d="M12 12h16M12 12v16M348 12h-16M348 12v16M12 218h16M12 218v-16M348 218h-16M348 218v-16" stroke={meta.accent} strokeOpacity=".3" strokeWidth="1.3" strokeLinecap="round" />
        <Scene accent={meta.accent} uid={uid} />
        <g transform="translate(16 14)">
          <rect width="170" height="34" rx="9" fill="#0d1f2e" fillOpacity=".92" stroke={meta.accent} strokeOpacity=".5" />
          <text x="12" y="15" fill="#e7fff8" fontSize="11.5" fontWeight="700">{copy.title}</text>
          <text x="12" y="27" fill={meta.accent} fontSize="8.5" fontWeight="600" letterSpacing=".5">{copy.caption}</text>
        </g>
        <g transform="translate(300 14)">
          <rect width="44" height="34" rx="9" fill="#0d1f2e" fillOpacity=".92" stroke={meta.accent} strokeOpacity=".4" />
          <text x="22" y="16" textAnchor="middle" fill={meta.accent} fontSize="12" fontWeight="800">{meta.nodes}</text>
          <text x="22" y="27" textAnchor="middle" fill="#7d93a8" fontSize="7" fontWeight="700">NODES</text>
        </g>
      </svg>
    </AnimatedScene>
  )
}

const workflowSteps = [
  { title: 'Connect', accent: '#5c8bff' },
  { title: 'Deploy', accent: '#789bff' },
  { title: 'Observe', accent: '#90a8ff' },
]

/** 单个步骤的平台图形 + 编号 + 标题卡，宽窄两种排布共用。 */
function WorkflowStepArt({ step, note, index, uid }: { step: typeof workflowSteps[number]; note: string; index: number; uid: string }) {
  return (
    <g>
      <ellipse cx="70" cy="92" rx="86" ry="16" fill={`url(#${uid}-s)`} />
      <path d="M0 40 70 8l78 34-70 34Z" fill={`url(#${uid}-plat)`} stroke={step.accent} strokeOpacity=".55" />
      <path d="M0 40v18l78 34V76Z" fill="#0b1a27" stroke={step.accent} strokeOpacity=".4" />
      <path d="M78 76v18l70-34V42Z" fill="#102536" stroke={step.accent} strokeOpacity=".35" />
      <path d="M8 42 70 14l62 28" stroke="#ffffff" strokeOpacity=".1" />
      <g transform="translate(40 20) scale(.7)">
        {index === 0 && <Rack color={step.accent} />}
        {index === 1 && <Chip label="GPU" color={step.accent} />}
        {index === 2 && (
          <g>
            <rect width="90" height="64" rx="10" fill="#0d1f2e" stroke={step.accent} strokeOpacity=".5" />
            <rect x="10" y="12" width="70" height="30" rx="5" fill={step.accent} fillOpacity=".12" />
            <path d="M18 24h30M18 34h44" stroke={step.accent} strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" />
            <text x="45" y="56" textAnchor="middle" fill={step.accent} fontSize="9" fontWeight="700">trace</text>
          </g>
        )}
      </g>
      <g transform="translate(-4 -8)">
        <rect width="30" height="30" rx="10" fill={step.accent} fillOpacity=".18" stroke={step.accent} />
        <text x="15" y="20" textAnchor="middle" fill={step.accent} fontSize="13" fontWeight="800">0{index + 1}</text>
      </g>
      <g transform="translate(16 118)">
        <rect width="120" height="40" rx="10" fill="#0d1f2e" fillOpacity=".92" stroke={step.accent} strokeOpacity=".45" />
        <text x="60" y="17" textAnchor="middle" fill="#e7fff8" fontSize="12" fontWeight="700">{step.title}</text>
        <text x="60" y="31" textAnchor="middle" fill={step.accent} fontSize="9.5" fontWeight="600">{note}</text>
      </g>
    </g>
  )
}

export function WorkflowIllustration() {
  const c = useLandingCopy()
  const uid = useId().replace(/:/g, '')
  const narrow = useMediaQuery('(max-width: 640px)')
  const defs = (
    <defs>
      <linearGradient id={`${uid}-plat`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#163244" /><stop offset="1" stopColor="#0e2232" />
      </linearGradient>
      <radialGradient id={`${uid}-s`}>
        <stop offset="0" stopColor="#02070d" stopOpacity=".5" /><stop offset="1" stopColor="#02070d" stopOpacity="0" />
      </radialGradient>
      <pattern id={`${uid}-grid`} width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="skewX(-30)">
        <path d="M20 0H0V20" stroke="#5c8bff" strokeOpacity=".07" />
      </pattern>
    </defs>
  )
  return (
    <AnimatedScene className="terra-workflow-art" label={c.illus.workflowAria}>
      {narrow ? (
        <svg viewBox="0 0 360 660" width="100%" height="100%" fill="none" aria-hidden="true">
          {defs}
          <rect width="360" height="660" rx="18" fill="#0a1520" />
          {workflowSteps.map((step, index) => (
            <g key={step.title} transform={`translate(106 ${30 + index * 230})`}>
              <WorkflowStepArt step={step} note={c.illus.workflowNotes[index]!} index={index} uid={uid} />
            </g>
          ))}
          <Flow points={[[180, 196], [180, 226], [180, 254]]} color="#789bff" delay={.3} />
          <Flow points={[[180, 426], [180, 456], [180, 484]]} color="#90a8ff" delay={.9} />
          <circle cx="40" cy="60" r="3" fill="#5c8bff" className="terra-light" style={{ filter: 'drop-shadow(0 0 4px #5c8bff)' }} />
          <circle cx="322" cy="620" r="3" fill="#90a8ff" className="terra-light" style={{ animationDelay: '-1s', filter: 'drop-shadow(0 0 4px #90a8ff)' }} />
        </svg>
      ) : (
        <svg viewBox="0 0 620 280" width="100%" height="100%" fill="none" aria-hidden="true">
          {defs}
          <rect width="620" height="280" rx="18" fill="#0a1520" />
          <path d="M40 200 310 70l270 110-270 80Z" fill={`url(#${uid}-grid)`} />
          {workflowSteps.map((step, index) => (
            <g key={step.title} transform={`translate(${70 + index * 175} ${130 - (index === 1 ? 24 : 0)})`}>
              <WorkflowStepArt step={step} note={c.illus.workflowNotes[index]!} index={index} uid={uid} />
            </g>
          ))}
          <Flow points={[[240, 150], [270, 138], [300, 128]]} color="#5c8bff" delay={.3} />
          <Flow points={[[415, 138], [445, 126], [475, 116]]} color="#789bff" delay={.9} />
          <path d="M540 48h24M552 36v24" stroke="#b56dff" strokeOpacity=".4" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="70" cy="52" r="3" fill="#5c8bff" className="terra-light" style={{ filter: 'drop-shadow(0 0 4px #5c8bff)' }} />
          <circle cx="560" cy="220" r="3" fill="#90a8ff" className="terra-light" style={{ animationDelay: '-1s', filter: 'drop-shadow(0 0 4px #90a8ff)' }} />
        </svg>
      )}
    </AnimatedScene>
  )
}

export function GapIllustration() {
  const c = useLandingCopy()
  const uid = useId().replace(/:/g, '')
  const narrow = useMediaQuery('(max-width: 640px)')
  const defs = (
    <defs>
      <linearGradient id={`${uid}-left`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2a1a28" /><stop offset="1" stopColor="#160e16" />
      </linearGradient>
      <linearGradient id={`${uid}-right`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#14303a" /><stop offset="1" stopColor="#0c1c26" />
      </linearGradient>
      <linearGradient id={`${uid}-bridge`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#5c8bff" stopOpacity=".2" />
        <stop offset=".5" stopColor="#5c8bff" stopOpacity=".9" />
        <stop offset="1" stopColor="#90a8ff" stopOpacity=".35" />
      </linearGradient>
      <radialGradient id={`${uid}-hole`} cx=".5" cy="0" r=".8">
        <stop offset="0" stopColor="#02070d" stopOpacity=".9" />
        <stop offset="1" stopColor="#02070d" stopOpacity="0" />
      </radialGradient>
      <filter id={`${uid}-g`} x="-70%" y="-70%" width="240%" height="240%">
        <feGaussianBlur stdDeviation="2.4" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
  )
  return (
    <AnimatedScene className="terra-gap-art" label={c.illus.gap.aria}>
      {narrow ? (
        <svg viewBox="0 0 360 512" width="100%" height="100%" fill="none" aria-hidden="true">
          {defs}
          <rect width="360" height="512" rx="16" fill="#0a1520" />
          <g transform="translate(16 16)">
            <rect width="328" height="144" rx="14" fill={`url(#${uid}-left)`} stroke="#f0a0b0" strokeOpacity=".35" />
            <text x="16" y="26" fill="#ffb0c0" fontSize="12" fontWeight="700">{c.illus.gap.cloudTitle}</text>
            <text x="16" y="44" fill="#f0a0b0" fillOpacity=".7" fontSize="10" fontWeight="600">{c.illus.gap.cloudNote}</text>
            {[0, 1, 2].map(i => (
              <g key={i} transform={`translate(16 ${64 + i * 26})`}>
                <rect width="296" height="18" rx="6" fill="#1a1018" stroke="#f0a0b0" strokeOpacity=".25" />
                <rect width={120 - i * 28} height="18" rx="6" fill="#f0a0b0" fillOpacity={.25 - i * .06} />
                <text x={128 - i * 28} y="13" fill="#ffb0c0" fontSize="9" fontWeight="700">${(i + 1) * 420}/mo</text>
              </g>
            ))}
          </g>
          <path d="M180 168v40" stroke={`url(#${uid}-bridge)`} strokeWidth="3" strokeLinecap="round" />
          <path d="M180 304v40" stroke={`url(#${uid}-bridge)`} strokeWidth="3" strokeLinecap="round" />
          <path d="M148 200c-16 16-16 56 0 72M212 200c16 16 16 56 0 72" stroke="#5c8bff" strokeOpacity=".45" strokeWidth="1.5" strokeDasharray="5 6" className="terra-march" style={{ animationDelay: '-.6s' }} />
          <g transform="translate(144 212)">
            <rect width="72" height="56" rx="14" fill="#0d1f2e" stroke="#5c8bff" strokeOpacity=".7" filter={`url(#${uid}-g)`} />
            <g transform="translate(36 26)">
              <OrbitMark r={15} accent="#5c8bff" className="terra-float" />
            </g>
            <text x="36" y="70" textAnchor="middle" fill="#9debff" fontSize="9.5" fontWeight="700" letterSpacing=".5">Yatterra</text>
          </g>
          <circle cx="180" cy="240" r="52" fill={`url(#${uid}-hole)`} />
          <g transform="translate(16 344)">
            <rect width="328" height="144" rx="14" fill={`url(#${uid}-right)`} stroke="#5c8bff" strokeOpacity=".35" />
            <text x="16" y="26" fill="#9debff" fontSize="12" fontWeight="700">{c.illus.gap.idleTitle}</text>
            <text x="16" y="44" fill="#5c8bff" fillOpacity=".7" fontSize="10" fontWeight="600">{c.illus.gap.idleNote}</text>
            <g transform="translate(36 58)">
              <Rack scale={.55} />
            </g>
            <g transform="translate(230 70) scale(.45)">
              <Chip label="A100" color="#5c8bff" />
            </g>
            <text x="16" y="138" fill="#5c8bff" fillOpacity=".75" fontSize="9.5" fontWeight="700">util 12%</text>
            <text x="170" y="138" fill="#5c8bff" fillOpacity=".75" fontSize="9.5" fontWeight="700">util 8%</text>
            <rect x="16" y="118" width="296" height="8" rx="4" fill="#0b1725" stroke="#5c8bff" strokeOpacity=".25" />
            <rect x="16" y="118" width="24" height="8" rx="4" fill="#5c8bff" fillOpacity=".55" className="terra-light" style={{ animationDelay: '-.4s' }} />
          </g>
          <text x="180" y="500" textAnchor="middle" fill="#7d93a8" fontSize="10" fontWeight="600" letterSpacing=".4">{c.illus.gap.bridge}</text>
        </svg>
      ) : (
        <svg viewBox="0 0 560 180" width="100%" height="100%" fill="none" aria-hidden="true">
          {defs}
          <rect width="560" height="180" rx="16" fill="#0a1520" />
          <g transform="translate(16 18)">
            <rect width="200" height="144" rx="14" fill={`url(#${uid}-left)`} stroke="#f0a0b0" strokeOpacity=".35" />
            <text x="16" y="26" fill="#ffb0c0" fontSize="12" fontWeight="700">{c.illus.gap.cloudTitle}</text>
            <text x="16" y="44" fill="#f0a0b0" fillOpacity=".7" fontSize="10" fontWeight="600">{c.illus.gap.cloudNote}</text>
            {[0, 1, 2].map(i => (
              <g key={i} transform={`translate(16 ${64 + i * 26})`}>
                <rect width="168" height="18" rx="6" fill="#1a1018" stroke="#f0a0b0" strokeOpacity=".25" />
                <rect width={120 - i * 28} height="18" rx="6" fill="#f0a0b0" fillOpacity={.25 - i * .06} />
                <text x={128 - i * 28} y="13" fill="#ffb0c0" fontSize="9" fontWeight="700">${(i + 1) * 420}/mo</text>
              </g>
            ))}
            <path d="M16 146h168" stroke="#f0a0b0" strokeOpacity=".3" strokeDasharray="4 5" className="terra-march" />
          </g>
          <g transform="translate(344 18)">
            <rect width="200" height="144" rx="14" fill={`url(#${uid}-right)`} stroke="#5c8bff" strokeOpacity=".35" />
            <text x="16" y="26" fill="#9debff" fontSize="12" fontWeight="700">{c.illus.gap.idleTitle}</text>
            <text x="16" y="44" fill="#5c8bff" fillOpacity=".7" fontSize="10" fontWeight="600">{c.illus.gap.idleNote}</text>
            <g transform="translate(24 58)">
              <Rack scale={.55} />
            </g>
            <g transform="translate(110 70) scale(.45)">
              <Chip label="A100" color="#5c8bff" />
            </g>
            {[0, 1].map(i => (
              <text key={i} x={16 + i * 96} y={i === 0 ? 138 : 138} fill="#5c8bff" fillOpacity=".75" fontSize="9.5" fontWeight="700">{i === 0 ? 'util 12%' : 'util 8%'}</text>
            ))}
            <rect x="16" y="118" width="168" height="8" rx="4" fill="#0b1725" stroke="#5c8bff" strokeOpacity=".25" />
            <rect x="16" y="118" width="24" height="8" rx="4" fill="#5c8bff" fillOpacity=".55" className="terra-light" style={{ animationDelay: '-.4s' }} />
          </g>
          <path d="M216 90h36" stroke={`url(#${uid}-bridge)`} strokeWidth="3" strokeLinecap="round" />
          <path d="M308 90h36" stroke={`url(#${uid}-bridge)`} strokeWidth="3" strokeLinecap="round" />
          <path d="M226 90c14-34 48-34 62 0M272 90c14 34 48 34 62 0" stroke="#5c8bff" strokeOpacity=".45" strokeWidth="1.5" strokeDasharray="5 6" className="terra-march" style={{ animationDelay: '-.6s' }} />
          <g transform="translate(244 62)">
            <rect width="72" height="56" rx="14" fill="#0d1f2e" stroke="#5c8bff" strokeOpacity=".7" filter={`url(#${uid}-g)`} />
            <g transform="translate(36 30)">
              <OrbitMark r={15} accent="#5c8bff" className="terra-float" />
            </g>
            <text x="36" y="70" textAnchor="middle" fill="#9debff" fontSize="9.5" fontWeight="700" letterSpacing=".5">Yatterra</text>
          </g>
          <circle cx="280" cy="90" r="40" fill={`url(#${uid}-hole)`} />
          <text x="280" y="164" textAnchor="middle" fill="#7d93a8" fontSize="10" fontWeight="600" letterSpacing=".4">{c.illus.gap.bridge}</text>
        </svg>
      )}
    </AnimatedScene>
  )
}

export function RootsIllustration() {
  const c = useLandingCopy()
  const uid = useId().replace(/:/g, '')
  const sprouts = [
    { x: 150, h: 56, accent: '#5c8bff' },
    { x: 240, h: 78, accent: '#789bff' },
    { x: 330, h: 64, accent: '#90a8ff' },
    { x: 420, h: 48, accent: '#f6c889' },
  ]
  return (
    <AnimatedScene className="terra-roots-art" label={c.illus.rootsAria}>
      <svg viewBox="0 0 560 240" width="100%" height="100%" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0d2436" stopOpacity=".5" />
            <stop offset="1" stopColor="#08131e" stopOpacity=".9" />
          </linearGradient>
          <linearGradient id={`${uid}-soil`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1a2e28" /><stop offset="1" stopColor="#0a1412" />
          </linearGradient>
          <radialGradient id={`${uid}-glow`} cx=".5" cy=".4" r=".6">
            <stop offset="0" stopColor="#5c8bff" stopOpacity=".2" />
            <stop offset="1" stopColor="#5c8bff" stopOpacity="0" />
          </radialGradient>
          <filter id={`${uid}-g`} x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width="560" height="240" rx="16" fill="#0a1520" />
        <rect width="560" height="240" rx="16" fill={`url(#${uid}-sky)`} />
        <rect y="140" width="560" height="100" fill={`url(#${uid}-soil)`} />
        <path d="M0 140c60-10 120 8 180 2s120-14 180-6 120 14 200 4v10H0Z" fill="#12261f" stroke="#5c8bff" strokeOpacity=".25" />
        <ellipse cx="280" cy="150" rx="200" ry="50" fill={`url(#${uid}-glow)`} />
        <path d="M280 140v96M280 168c-40 8-70 30-88 58M280 168c40 8 70 30 88 58M280 196c-26 6-44 20-56 40M280 196c26 6 44 20 56 40" stroke="#5c8bff" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" className="terra-march" />
        <path d="M280 168c-18-10-34-10-50-2M280 186c18-8 36-6 52 4M280 210c-14-8-30-8-44 0" stroke="#789bff" strokeOpacity=".45" strokeWidth="1.5" strokeLinecap="round" className="terra-march" style={{ animationDelay: '-1s' }} />
        {sprouts.map((sprout, index) => (
          <g key={sprout.x} transform={`translate(${sprout.x} 140)`}>
            <path d={`M0 0c${index % 2 ? '-' : ''}${12 + index * 4} ${-sprout.h / 3} ${index % 2 ? '-' : ''}${8 + index * 3} ${-sprout.h * .7} 0 ${-sprout.h}`} stroke={sprout.accent} strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" className="terra-float" style={{ animationDelay: `${index * -.8}s` }} />
            <ellipse cx={index % 2 ? -10 : 10} cy={-sprout.h - 6} rx="14" ry="8" fill={sprout.accent} fillOpacity=".35" stroke={sprout.accent} strokeOpacity=".7" transform={`rotate(${index % 2 ? 24 : -24} ${index % 2 ? -10 : 10} ${-sprout.h - 6})`} />
            <ellipse cx={index % 2 ? 12 : -12} cy={-sprout.h + 4} rx="11" ry="6.5" fill={sprout.accent} fillOpacity=".25" stroke={sprout.accent} strokeOpacity=".55" transform={`rotate(${index % 2 ? -18 : 18} ${index % 2 ? 12 : -12} ${-sprout.h + 4})`} />
            <circle cx="0" cy={-sprout.h} r="4" fill={sprout.accent} className="terra-light" style={{ animationDelay: `${index * -.5}s`, filter: `drop-shadow(0 0 5px ${sprout.accent})` }} />
          </g>
        ))}
        <g transform="translate(248 118)">
          <g transform="translate(32 30)">
            <OrbitMark r={28} accent="#5c8bff" filter={`url(#${uid}-g)`} className="terra-float" />
          </g>
        </g>
        {[{ x: 80, y: 60 }, { x: 480, y: 48 }, { x: 120, y: 100 }, { x: 460, y: 96 }].map((mote, index) => (
          <circle key={index} cx={mote.x} cy={mote.y} r={index % 2 ? 2 : 2.6} fill={index % 2 ? '#90a8ff' : '#5c8bff'} fillOpacity=".5" className="terra-float" style={{ animationDelay: `${index * -.9}s` }} />
        ))}
        <text x="280" y="28" textAnchor="middle" fill="#9debff" fontSize="11" fontWeight="700" letterSpacing="2">FROM IDLE METAL TO RUNNING MODELS</text>
      </svg>
    </AnimatedScene>
  )
}

export type ExplorerKind = 'device' | 'network' | 'idea'

/** START WITH A DEVICE — one workstation becomes a reachable AI node. */
function DeviceScene({ accent, uid }: { accent: string; uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-tower`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#173243" /><stop offset="1" stopColor="#0e2233" />
        </linearGradient>
        <linearGradient id={`${uid}-beam`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={accent} stopOpacity=".55" /><stop offset="1" stopColor="#f6c889" stopOpacity=".35" />
        </linearGradient>
        <radialGradient id={`${uid}-shadow`}>
          <stop offset="0" stopColor="#02070d" stopOpacity=".55" /><stop offset="1" stopColor="#02070d" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="110" cy="206" rx="96" ry="14" fill={`url(#${uid}-shadow)`} />
      <g transform="translate(48 34)" strokeLinejoin="round">
        <rect width="124" height="164" rx="16" fill={`url(#${uid}-tower)`} stroke={accent} strokeOpacity=".55" />
        <rect x="10" y="12" width="104" height="104" rx="10" fill="#0a1826" stroke={accent} strokeOpacity=".4" />
        <rect x="24" y="34" width="76" height="52" rx="8" fill={accent} fillOpacity=".16" stroke={accent} strokeOpacity=".8" />
        <text x="62" y="65" textAnchor="middle" fill={accent} fontSize="13" fontWeight="800" letterSpacing=".5">GPU</text>
        <path d="M24 34h76M24 86h76" stroke="#ffffff" strokeOpacity=".1" />
        {[0, 1, 2].map(i => (
          <rect key={i} x="22" y={126 + i * 11} width="80" height="5" rx="2.5" fill={accent} fillOpacity={i === 0 ? '.5' : '.18'} className={i === 0 ? 'terra-light' : undefined} style={i === 0 ? { animationDelay: '-.8s' } : undefined} />
        ))}
        <circle cx="106" cy="152" r="4" fill={accent} className="terra-light" style={{ filter: `drop-shadow(0 0 5px ${accent})` }} />
        <path d="M62 12v-8" stroke={accent} strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
        <circle cx="62" cy="0" r="3" fill={accent} className="terra-light" style={{ animationDelay: '-1.4s', filter: `drop-shadow(0 0 5px ${accent})` }} />
      </g>
      <text x="110" y="224" textAnchor="middle" fill="#7d93a8" fontSize="9.5" fontWeight="700" letterSpacing="1.4">WORKSTATION</text>
      <Flow points={[[178, 116], [214, 116], [246, 116]]} color={accent} delay={.15} />
      {['model', 'api', 'tool'].map((name, i) => (
        <g key={name} transform={`translate(252 ${54 + i * 52})`} strokeLinejoin="round">
          <rect width="116" height="42" rx="11" fill="#0d1f2e" stroke={accent} strokeOpacity={i === 0 ? '.65' : '.4'} />
          <circle cx="18" cy="21" r="4.5" fill={accent} fillOpacity={i === 0 ? '1' : '.45'} className={i === 0 ? 'terra-light' : undefined} style={{ animationDelay: `${i * -.7}s` }} />
          <text x="34" y="25" fill="#cfe8e4" fontSize="12" fontWeight="600" letterSpacing=".4">{name}</text>
        </g>
      ))}
      <Flow points={[[374, 116], [408, 116], [436, 116]]} color={accent} delay={.7} />
      <g transform="translate(444 66)" strokeLinejoin="round">
        <rect width="96" height="100" rx="18" fill="#0d1f2e" stroke="#f6c889" strokeOpacity=".6" />
        <circle cx="48" cy="40" r="22" fill="#f6c889" fillOpacity=".1" stroke="#f6c889" strokeOpacity=".7" />
        <path d="M26 40h44M48 18c8 8 8 36 0 44M48 18c-8 8-8 36 0 44" stroke="#f6c889" strokeOpacity=".8" strokeWidth="1.3" />
        <path d="M48 18a22 22 0 0 1 0 44" fill="#f6c889" fillOpacity=".18" />
        <text x="48" y="76" textAnchor="middle" fill="#f6c889" fontSize="11" fontWeight="700">service</text>
        <text x="48" y="90" textAnchor="middle" fill="#a1b1b7" fontSize="8.5" fontWeight="600">wss · public</text>
      </g>
      {[{ x: 40, y: 52 }, { x: 470, y: 40 }, { x: 530, y: 190 }].map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r="2.3" fill={accent} fillOpacity=".5" className="terra-float" style={{ animationDelay: `${i * -1}s` }} />
      ))}
      <rect x="430" y="186" width="76" height="24" rx="10" fill="#0b1725" stroke="#f6c889" strokeOpacity=".4" />
      <circle cx="444" cy="198" r="3" fill="#f6c889" className="terra-light" />
      <text x="456" y="202" fill="#f6c889" fontSize="9.5" fontWeight="700" letterSpacing=".6">REACHABLE</text>
    </g>
  )
}

/** START WITH A NETWORK — scattered sites snap into one mesh. */
function NetworkNodesScene({ accent, uid }: { accent: string; uid: string }) {
  const places = [
    { x: 24, y: 26, name: 'Campus', sub: 'GPU ×4' },
    { x: 24, y: 130, name: 'Home', sub: 'RTX ×1' },
    { x: 400, y: 26, name: 'Lab', sub: 'A100 ×8' },
    { x: 400, y: 130, name: 'Studio', sub: 'nodes ×2' },
  ]
  return (
    <g>
      <defs>
        <radialGradient id={`${uid}-hub`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor={accent} stopOpacity=".3" /><stop offset="1" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <pattern id={`${uid}-mesh`} width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" stroke={accent} strokeOpacity=".06" />
        </pattern>
      </defs>
      <rect width="560" height="230" rx="14" fill={`url(#${uid}-mesh)`} />
      <Flow points={[[164, 58], [200, 76], [232, 96]]} color={accent} delay={0} />
      <Flow points={[[164, 162], [200, 146], [232, 128]]} color={accent} delay={.5} />
      <Flow points={[[400, 58], [364, 76], [332, 96]]} color={accent} delay={.25} />
      <Flow points={[[400, 162], [364, 146], [332, 128]]} color={accent} delay={.75} />
      <path d="M280 46v28M280 156v28" stroke={accent} strokeOpacity=".35" strokeWidth="1.3" strokeDasharray="3 6" className="terra-march" />
      <circle cx="280" cy="115" r="70" fill={`url(#${uid}-hub)`} className="terra-pulse-ring" />
      <g transform="translate(232 70)" strokeLinejoin="round">
        <path d="M48 0 96 27v54L48 108 0 81V27Z" fill="#0e2436" stroke={accent} strokeWidth="1.6" />
        <path d="M48 0v54M48 54 96 27M48 54 0 27" stroke={accent} strokeOpacity=".35" />
        <circle cx="48" cy="54" r="18" fill={accent} fillOpacity=".15" stroke={accent} />
        <path d="M40 54h16M48 46v16" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
        <text x="48" y="128" textAnchor="middle" fill={accent} fontSize="10" fontWeight="800" letterSpacing="2">ONE MESH</text>
      </g>
      {places.map((place, index) => (
        <g key={place.name} transform={`translate(${place.x} ${place.y})`} strokeLinejoin="round">
          <rect width="140" height="64" rx="13" fill="#0d1f2e" stroke={accent} strokeOpacity=".5" />
          <rect x="1" y="1" width="138" height="24" rx="12" fill={accent} fillOpacity=".07" />
          <circle cx="18" cy="14" r="3.5" fill={accent} className="terra-light" style={{ animationDelay: `${index * -.5}s` }} />
          <text x="30" y="18" fill="#e7fff8" fontSize="11.5" fontWeight="700">{place.name}</text>
          <text x="14" y="42" fill={accent} fontSize="10.5" fontWeight="600">{place.sub}</text>
          <g transform="translate(14 48)">
            <rect width="52" height="10" rx="4" fill="#0b1725" />
            <rect width={20 + index * 8} height="10" rx="4" fill={accent} fillOpacity=".55" />
          </g>
        </g>
      ))}
      <g transform="translate(196 200)">
        <rect width="168" height="24" rx="11" fill="#0b1725" stroke={accent} strokeOpacity=".4" />
        <text x="84" y="16" textAnchor="middle" fill="#b7e7ff" fontSize="10.5" fontWeight="600">4 sites · 15 GPUs · one control</text>
      </g>
    </g>
  )
}

/** START WITH AN IDEA — idea → runtime → live service. */
function IdeaScene({ accent, uid }: { accent: string; uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-bulb`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6c889" stopOpacity=".9" /><stop offset="1" stopColor="#f6c889" stopOpacity=".35" />
        </linearGradient>
        <linearGradient id={`${uid}-wave`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={accent} /><stop offset="1" stopColor="#f6c889" stopOpacity=".7" />
        </linearGradient>
      </defs>
      <path d="M0 200h560" stroke={accent} strokeOpacity=".18" strokeDasharray="2 8" />
      <g transform="translate(30 40)" strokeLinejoin="round">
        <rect width="124" height="140" rx="16" fill="#101f2e" stroke="#f6c889" strokeOpacity=".5" />
        <path d="M62 24a24 24 0 0 1 14 43v10H48V67a24 24 0 0 1 14-43Z" fill={`url(#${uid}-bulb)`} stroke="#f6c889" strokeWidth="1.5" className="terra-float" />
        <path d="M52 85h20M54 93h16M57 101h10" stroke="#f6c889" strokeOpacity=".8" strokeWidth="2" strokeLinecap="round" />
        <path d="M30 46l-10-6M94 46l10-6M62 14V6M36 24l-6-8M88 24l6-8" stroke="#f6c889" strokeOpacity=".65" strokeWidth="1.6" strokeLinecap="round" className="terra-light" />
        <text x="62" y="126" textAnchor="middle" fill="#f6c889" fontSize="12" fontWeight="800" letterSpacing="1.5">IDEA</text>
      </g>
      <Flow points={[[160, 110], [196, 110], [228, 110]]} color="#f6c889" delay={.2} />
      <g transform="translate(236 30)" strokeLinejoin="round">
        <rect width="118" height="160" rx="16" fill="#0e2436" stroke={accent} strokeOpacity=".6" />
        <rect x="1" y="1" width="116" height="30" rx="15" fill={accent} fillOpacity=".08" />
        <text x="16" y="21" fill={accent} fontSize="9.5" fontWeight="800" letterSpacing="1.6">RUNTIME</text>
        {[['vLLM', 46], ['Agent', 84], ['queue', 122]].map(([name, y], i) => (
          <g key={name as string} transform={`translate(14 ${y as number})`}>
            <rect width="90" height="30" rx="8" fill="#13293a" stroke={accent} strokeOpacity={i === 1 ? '.7' : '.35'} />
            <circle cx="14" cy="15" r="3.5" fill={accent} fillOpacity={i === 1 ? '1' : '.4'} className={i === 1 ? 'terra-light' : undefined} style={{ animationDelay: `${i * -.6}s` }} />
            <text x="26" y="19" fill="#cfe8e4" fontSize="10.5" fontWeight="600">{name as string}</text>
          </g>
        ))}
      </g>
      <Flow points={[[360, 110], [396, 110], [426, 110]]} color={accent} delay={.7} />
      <g transform="translate(434 46)" strokeLinejoin="round">
        <rect width="106" height="128" rx="16" fill={`url(#${uid}-wave)`} fillOpacity=".1" stroke={accent} strokeOpacity=".7" />
        <circle cx="24" cy="24" r="7" fill={accent} className="terra-light" style={{ filter: `drop-shadow(0 0 5px ${accent})` }} />
        <text x="40" y="28" fill={accent} fontSize="11" fontWeight="800" letterSpacing="1.2">LIVE</text>
        <path d="M14 68h10l6-16 8 30 7-20 6 12h14" stroke={`url(#${uid}-wave)`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="terra-march" fill="none" />
        <path d="M14 96h78M14 110h58" stroke={accent} strokeOpacity=".28" strokeWidth="3" strokeLinecap="round" />
        <text x="53" y="124" textAnchor="middle" fill="#7d93a8" fontSize="9" fontWeight="700" letterSpacing=".8">SERVICE</text>
      </g>
      <text x="92" y="216" textAnchor="middle" fill="#7d93a8" fontSize="9" fontWeight="700" letterSpacing="1.2">THINK</text>
      <text x="295" y="216" textAnchor="middle" fill={accent} fillOpacity=".8" fontSize="9" fontWeight="700" letterSpacing="1.2">BUILD</text>
      <text x="487" y="216" textAnchor="middle" fill="#f6c889" fillOpacity=".85" fontSize="9" fontWeight="700" letterSpacing="1.2">SERVE</text>
      {[{ x: 200, y: 30 }, { x: 400, y: 26 }, { x: 530, y: 196 }].map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r="2.3" fill={i === 1 ? '#f6c889' : accent} fillOpacity=".5" className="terra-float" style={{ animationDelay: `${i * -1.2}s` }} />
      ))}
    </g>
  )
}

const explorerScenes: Record<ExplorerKind, (props: { accent: string; uid: string }) => ReactNode> = {
  device: DeviceScene,
  network: NetworkNodesScene,
  idea: IdeaScene,
}

export function ExplorerIllustration({ kind, accent }: { kind: string; accent: string }) {
  const c = useLandingCopy()
  const uid = useId().replace(/:/g, '')
  const safe = (kind === 'network' || kind === 'idea' ? kind : 'device') as ExplorerKind
  const Scene = explorerScenes[safe]
  return (
    <AnimatedScene className="terra-explorer-art" label={c.explorer.illusAria[safe]}>
      <svg viewBox="0 0 560 230" fill="none" role="img" aria-hidden="true" key={safe}>
        <rect width="560" height="230" rx="14" fill="#0a1520" />
        <path d="M12 12h14M12 12v14M548 12h-14M548 12v14M12 218h14M12 218v-14M548 218h-14M548 218v-14" stroke={accent} strokeOpacity=".3" strokeWidth="1.3" strokeLinecap="round" />
        <Scene accent={accent} uid={uid} />
      </svg>
    </AnimatedScene>
  )
}
