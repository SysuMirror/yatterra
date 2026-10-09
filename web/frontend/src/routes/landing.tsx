import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useSpring } from 'framer-motion'
import { Link } from 'react-router'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useAuthStore } from '@/stores/auth'
import { ArrowDown, ArrowRight, Check, ChevronRight, Cpu, FileText, Globe2, Network, Orbit, Pause, Play, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import { ExplorerIllustration, GapIllustration, OrbitMark, LayerIllustration, NetworkIllustration, RootsIllustration, ScenarioIllustration, WorkflowIllustration } from './landing-illustrations'
import { LandingBackground } from './landing-background'
import { LANGS, setLandingLang, useLandingCopy, useLandingLang } from './landing.i18n'
import '../styles/landing.css'

/** 纯视觉元数据(图标/颜色),文案统一走 landing.i18n 的 COPY。 */
const constraintIcons = [Globe2, Cpu, Wrench]
const layerColors = ['#5c8bff', '#789bff', '#b56dff', '#f6c889']
const choiceIcons = [Globe2, Orbit, Wrench]
const stepMeta = [
  { color: '#f6c889', glyph: 'power' },
  { color: '#5c8bff', glyph: 'compute' },
  { color: '#789bff', glyph: 'cloud' },
  { color: '#b56dff', glyph: 'lock' },
] as const

/** 技术报告 / 白皮书 — 新增条目直接往这里加即可，href 填 PDF 或外链。报告本身为英文，不随首页语言切换。 */
const reports = [
  { label: 'TR-001 / INTERCONNECT', title: 'Aggregating Edge-Isolated GPUs into a Unified Scheduling Fabric', desc: 'We present an architecture for federating heterogeneous, NAT-resident compute nodes into a lightweight Kubernetes control plane, covering tunnel topology design, quantile-based resource estimation, and priority-tiered degradation under pressure.', tags: ['Edge Networking', 'GPU Scheduling', 'Resource Estimation'], date: '2026-10', href: '/reports' },
  { label: 'TR-002 / AGENTOPS', title: 'AI-Native Platform Operations: Assistant Architectures and Tool Governance', desc: 'An account of integrating language-model agents directly into an operational platform: multi-modal assistance, continuous code profiling, hybrid structural–semantic indexing, and permission-scoped tool access.', tags: ['LLM Agents', 'Code Indexing', 'Tool Governance'], date: '2026-10', href: '/reports' },
  { label: 'TR-003 / HARDENING', title: 'Reliability Engineering for Single-Administrator Infrastructure', desc: 'A systematic treatment of layered self-healing, automated deployment, push-based alerting, and federated identity — keeping small-scale platforms dependable without a dedicated operations team.', tags: ['Self-Healing', 'SSO', 'Hardening'], date: '2026-10', href: '/reports' },
]

function Reveal({ children, delay = 0, className = '', pop = false }: { children: ReactNode; delay?: number; className?: string; pop?: boolean }) {
  const reduce = useReducedMotion()
  const element = useRef<HTMLDivElement>(null)
  const visible = useInView(element, { once: true, margin: '-40px' })
  return (
    <motion.div
      ref={element}
      className={className}
      initial={reduce ? { opacity: 1, transform: 'none' } : { opacity: 0, transform: pop ? 'translateY(26px) scale(.965)' : 'translateY(18px)' }}
      animate={visible ? { opacity: 1, transform: reduce ? 'none' : 'translateY(0px) scale(1)' } : undefined}
      transition={{ duration: reduce ? .2 : .6, delay: reduce ? 0 : delay, ease: [.23, 1, .32, 1] }}
    >{children}</motion.div>
  )
}

/**
 * Per-character entrance for headings — a wave of lift.
 * 只动 opacity/transform(compositor 属性),不做逐字 blur:逐字 filter 会让每个字
 * 都走一次 paint,长标题在低端机上明显掉帧。
 */
function StaggerLine({ text, visible, reduce, delay = 0, className }: { text: string; visible: boolean; reduce: boolean | null; delay?: number; className?: string }) {
  if (reduce) return <span className={className}>{text}</span>
  return (
    <span className={className}>
      {[...text].map((char, index) =>
        // 空格不能进 inline-block 的 .terra-char(只含空白的 inline-block 宽度塌缩为 0,
        // 英文单词会全部粘连),直接作为普通文本节点输出,顺带保留换行能力。
        char === ' ' ? ' ' : (
          <motion.span
            key={index}
            className="terra-char"
            initial={{ opacity: 0, y: 16 }}
            animate={visible ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: .55, delay: delay + index * .028, ease: [.23, 1, .32, 1] }}
          >{char}</motion.span>
        )
      )}
    </span>
  )
}

/** Two-line heading that waves in on scroll. */
function StaggerHeading({ lines, reduce, delay = 0 }: { lines: string[]; reduce: boolean | null; delay?: number }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const visible = useInView(ref, { once: true, margin: '-60px' })
  return (
    <h2 ref={ref}>
      <StaggerLine text={lines[0]!} className="terra-line-lead" visible={visible} reduce={reduce} delay={delay} />
      <StaggerLine text={lines[1]!} className="terra-line-accent" visible={visible} reduce={reduce} delay={delay + lines[0]!.length * .028} />
    </h2>
  )
}

/** Eyebrow + two-line heading + blurb, choreographed as one entrance. */
function SectionIntro({ eyebrow, lines, desc, delay = 0 }: { eyebrow: string; lines: string[]; desc: string; delay?: number }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const visible = useInView(ref, { once: true, margin: '-60px' })
  return (
    <motion.div
      ref={ref}
      className="terra-section-intro"
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 14 }}
      animate={visible ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: reduce ? .2 : .55, delay: reduce ? 0 : delay, ease: [.23, 1, .32, 1] }}
    >
      <div>
        <motion.p
          className="terra-eyebrow"
          initial={reduce ? { opacity: 1 } : { opacity: 0, x: -12 }}
          animate={visible ? { opacity: 1, x: 0 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : delay, ease: [.23, 1, .32, 1] }}
        >{eyebrow}</motion.p>
        <StaggerHeading lines={lines} reduce={reduce} delay={delay + .08} />
      </div>
      <motion.p
        initial={reduce ? { opacity: 1 } : { opacity: 0, y: 12 }}
        animate={visible ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: .55, delay: reduce ? 0 : delay + .3, ease: [.23, 1, .32, 1] }}
      >{desc}</motion.p>
    </motion.div>
  )
}

/** Top-of-page scroll progress line. */
function ScrollProgress() {
  const { scrollYProgress } = useScroll()
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 28, mass: .3 })
  return <motion.div className="terra-scroll-progress" style={{ scaleX }} aria-hidden="true" />
}

/** Coalesce high-frequency pointer writes into one per frame. */
function useRafPointer(handler: (event: React.PointerEvent<HTMLElement>) => void) {
  const frame = useRef(0)
  const latest = useRef<React.PointerEvent<HTMLElement> | null>(null)
  const flush = () => {
    frame.current = 0
    if (latest.current) handler(latest.current)
  }
  return (event: React.PointerEvent<HTMLElement>) => {
    latest.current = event
    if (!frame.current) frame.current = requestAnimationFrame(flush)
  }
}

/** 3D tilt + cursor-tracking glow for cards. */
function TiltCard({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)

  const onPointerMove = useRafPointer((event) => {
    if (reduce || event.pointerType !== 'mouse') return
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width
    const py = (event.clientY - rect.top) / rect.height
    element.style.setProperty('--tilt-x', `${(0.5 - py) * 7}deg`)
    element.style.setProperty('--tilt-y', `${(px - 0.5) * 9}deg`)
    element.style.setProperty('--glow-x', `${px * 100}%`)
    element.style.setProperty('--glow-y', `${py * 100}%`)
  })

  const onPointerLeave = () => {
    const element = ref.current
    if (!element) return
    element.style.setProperty('--tilt-x', '0deg')
    element.style.setProperty('--tilt-y', '0deg')
    element.style.setProperty('--glow-x', '50%')
    element.style.setProperty('--glow-y', '50%')
  }

  return (
    <div
      ref={ref}
      className={`terra-tilt ${className}`}
      style={style}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  )
}

/** Character-wave hero heading entrance. */
function HeroTitle({ lines, reduce }: { lines: string[]; reduce: boolean | null }) {
  return (
    <h1>
      <StaggerLine text={lines[0]!} className="terra-line-lead" visible reduce={reduce} delay={.14} />
      <StaggerLine text={lines[1]!} className="terra-heading-accent" visible reduce={reduce} delay={.14 + lines[0]!.length * .03} />
    </h1>
  )
}

/** Buttons that pull gently toward the cursor + shine sweep on hover. */
function ShinyButton({ children, className = '', to, href }: {
  children: ReactNode; className?: string; to?: string; href?: string
}) {
  const reduce = useReducedMotion()

  const onPointerMove = useRafPointer((event) => {
    if (reduce || event.pointerType !== 'mouse') return
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    const dx = (event.clientX - (rect.left + rect.width / 2)) / rect.width
    const dy = (event.clientY - (rect.top + rect.height / 2)) / rect.height
    element.style.setProperty('--pull-x', `${dx * 10}px`)
    element.style.setProperty('--pull-y', `${dy * 7}px`)
    element.style.setProperty('--shine-x', `${((event.clientX - rect.left) / rect.width) * 100}%`)
  })

  const onPointerLeave = (event: React.PointerEvent<HTMLElement>) => {
    const element = event.currentTarget
    element.style.setProperty('--pull-x', '0px')
    element.style.setProperty('--pull-y', '0px')
  }

  const buttonClass = `terra-button ${className}`
  if (to) return <Link to={to} className={buttonClass} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>{children}</Link>
  return <a href={href} className={buttonClass} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>{children}</a>
}

function Architecture() {
  const c = useLandingCopy()
  const [active, setActive] = useState(0)
  const layer = { ...c.layers.layers[active]!, color: layerColors[active]! }
  return (
    <div className="terra-architecture">
      <div className="terra-diagram-heading"><span>{c.layers.stackHeading[0]}</span><span>{c.layers.stackHeading[1]}</span></div>
      <div className="terra-layer-grid">
        {c.layers.layers.map((item, index) => (
          <button key={item.number} type="button" className="terra-layer" aria-pressed={active === index} aria-controls="terra-layer-detail" onClick={() => setActive(index)}>
            {active === index && <motion.span layoutId="terra-layer-underline" className="terra-layer-underline" transition={{ type: 'spring', stiffness: 380, damping: 34 }} />}
            <div className="terra-layer-top"><span>{item.number}</span><span style={{ color: layerColors[index] }}>{item.english}</span></div>
            <LayerIllustration index={index} />
            <div className="terra-layer-bottom"><h3>{item.title}</h3><p>{item.description}</p><ChevronRight size={16} /></div>
          </button>
        ))}
      </div>
      <div className="terra-layer-detail" id="terra-layer-detail" aria-live="polite" aria-atomic="true">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={layer.number}
            className="terra-layer-detail-row"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: .3, ease: [.23, 1, .32, 1] }}
          >
            <div><span className="terra-detail-number" style={{ color: layer.color }}>{layer.number}</span><p>{layer.detail}</p></div>
            <div className="terra-tags">{layer.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="terra-control-rail"><ShieldCheck size={15} /><span>{c.layers.rail}</span><span className="terra-rail-label">SHARED CONTROL PLANE</span></div>
    </div>
  )
}

function UtilityGlyph({ glyph, color }: { glyph: 'power' | 'compute' | 'cloud' | 'lock'; color: string }) {
  if (glyph === 'power') return <path d="M2.5 -11 -6 1.5h5.5L-1.5 11 8 -1.5H2.5Z" fill={color} />
  if (glyph === 'compute') return (
    <g stroke={color} strokeWidth="1.6" fill="none" strokeLinejoin="round">
      <rect x="-6" y="-10" width="12" height="20" rx="3" />
      <path d="M-2.5 7h5" strokeLinecap="round" />
      <circle cx="0" cy="-1" r="3" fill={color} fillOpacity=".35" />
    </g>
  )
  if (glyph === 'cloud') return (
    <path d="M-8 4a5 5 0 0 1 1.2-9.8A7 7 0 0 1 6 -5a5.5 5.5 0 0 1 2 10.6Z" fill={color} fillOpacity=".3" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
  )
  return (
    <g stroke={color} strokeWidth="1.6" fill="none" strokeLinejoin="round">
      <rect x="-6" y="-1" width="12" height="9" rx="2" fill={color} fillOpacity=".2" />
      <path d="M-3.5 -1v-3.5a3.5 3.5 0 0 1 7 0V-1" />
      <circle cx="0" cy="4" r="1.4" fill={color} stroke="none" />
    </g>
  )
}

/** 窄屏竖排变体：阶梯从下往上爬，字号按 ~420px viewBox 设计，手机上仍可读。 */
function InfrastructureArcNarrowSvg({ shown, dots, reduce }: { shown: boolean; dots: boolean; reduce: boolean | null }) {
  const c = useLandingCopy()
  const ys = [860, 650, 440, 230]
  return (
    <svg viewBox="0 0 420 1005" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="terra-arc-path-n" x1="0" y1="940" x2="0" y2="150" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f6c889" /><stop offset=".5" stopColor="#5c8bff" /><stop offset="1" stopColor="#789bff" />
        </linearGradient>
        <linearGradient id="terra-arc-bar-n" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#ffffff" stopOpacity=".14" /><stop offset="1" stopColor="#ffffff" stopOpacity=".02" />
        </linearGradient>
        <filter id="terra-arc-glow-n" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <motion.g
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={shown ? { opacity: 1 } : undefined}
        transition={{ duration: .5, delay: reduce ? 0 : .12 }}
      >
        <path d="M40 60V940" stroke="#8fa5b0" strokeOpacity=".22" strokeWidth="1" />
        <path d="M40 64l-4 8h8ZM40 936l-4-8h8Z" fill="#8fa5b0" fillOpacity=".4" />
        <text transform="translate(22 790) rotate(-90)" textAnchor="middle" fill="#718792" fontSize="11" fontWeight="600" letterSpacing="2.5">{c.thesis.arcAxis.scarce}</text>
        <text transform="translate(22 300) rotate(-90)" textAnchor="middle" fill="#9debff" fontSize="11" fontWeight="600" letterSpacing="2.5">{c.thesis.arcAxis.universal}</text>
      </motion.g>

      <motion.path
        d="M70 940V250"
        stroke="url(#terra-arc-path-n)"
        strokeWidth="3.5"
        strokeLinecap="round"
        filter="url(#terra-arc-glow-n)"
        initial={reduce ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
        animate={shown ? { pathLength: 1, opacity: 1 } : undefined}
        transition={reduce ? { duration: 0 } : { pathLength: { duration: 1.3, delay: .3, ease: [.65, 0, .35, 1] }, opacity: { duration: .25, delay: .3 } }}
      />
      <motion.path
        d="M70 250V150"
        stroke="#b56dff" strokeOpacity=".55" strokeWidth="2.5" strokeDasharray="6 7" strokeLinecap="round"
        className="terra-march"
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={shown ? { opacity: 1 } : undefined}
        transition={{ duration: .5, delay: reduce ? 0 : 1.5 }}
      />

      {ys.map((y, index) => {
        const item = { ...c.thesis.steps[index]!, ...stepMeta[index]! }
        const done = index < 3
        return (
          <motion.g
            key={item.era}
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 16 }}
            animate={shown ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: reduce ? .2 : .5, delay: reduce ? 0 : .55 + index * .14, ease: [.23, 1, .32, 1] }}
          >
            <rect x="110" y={y - 11} width="280" height="22" rx="11" fill={done ? item.color : 'transparent'} fillOpacity={done ? '.22' : '0'} stroke={item.color} strokeOpacity={done ? '.75' : '.55'} strokeWidth="1.6" strokeDasharray={done ? undefined : '6 5'} />
            {done && <rect x="113" y={y - 8} width="274" height="6" rx="3" fill="url(#terra-arc-bar-n)" />}
            <g transform={`translate(70 ${y})`}>
              <circle r="24" fill={item.color} fillOpacity=".07" />
              <circle r="17" fill="#0f1830" stroke={item.color} strokeOpacity=".85" strokeWidth="1.6" style={{ filter: `drop-shadow(0 0 6px ${item.color}66)` }} />
              <UtilityGlyph glyph={item.glyph} color={item.color} />
            </g>
            <text x="110" y={y - 36} fill={item.color} fontSize="11.5" fontWeight="700" letterSpacing="1.6">{item.era}</text>
            <text x="110" y={y - 16} fill="#e4edea" fontSize="18" fontWeight="600">{item.title}</text>
            <text x="110" y={y + 36} fill={done ? '#718792' : item.color} fillOpacity={done ? '1' : '.9'} fontSize="13" fontWeight={done ? 400 : 600}>{item.note}</text>
            {done ? (
              <g transform={`translate(390 ${y})`}>
                <circle r="9" fill={item.color} fillOpacity=".18" stroke={item.color} strokeOpacity=".7" />
                <path d="M-3.5 0l2.5 2.5 4.5-5" stroke={item.color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ) : (
              <g transform={`translate(390 ${y})`}>
                <circle r="9" fill="#0f1830" stroke={item.color} strokeOpacity=".7" strokeDasharray="3 2" />
                <path d="M-3.5-2.5v-1.5a3.5 3.5 0 0 1 7 0v1.5" stroke={item.color} strokeWidth="1.4" fill="none" />
                <rect x="-4" y="-2.5" width="8" height="6.5" rx="1.5" fill={item.color} fillOpacity=".35" stroke={item.color} strokeWidth="1.2" />
              </g>
            )}
          </motion.g>
        )
      })}

      <g transform="translate(110 26)">
        <motion.g
          initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: .9 }}
          animate={shown ? { opacity: 1, scale: 1 } : undefined}
          transition={{ duration: reduce ? .2 : .55, delay: reduce ? 0 : 1.45, ease: [.23, 1, .32, 1] }}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        >
          <rect width="280" height="88" rx="14" fill="#b56dff" fillOpacity=".07" stroke="#b56dff" strokeOpacity=".55" strokeDasharray="6 5" />
          <path d="M18 20 27 15.5v9L18 29l-9-4.5v-9Z" fill="#b56dff" fillOpacity=".3" stroke="#b56dff" strokeWidth="1.3" />
          <text x="36" y="27" fill="#e8ecff" fontSize="15" fontWeight="700" letterSpacing=".4">YatTerra</text>
          <text x="14" y="55" fill="#b56dff" fontSize="13" fontWeight="600">{c.thesis.yatterraBox.title}</text>
          <text x="14" y="74" fill="#7d93a8" fontSize="11.5">{c.thesis.yatterraBox.note}</text>
        </motion.g>
      </g>

      <g transform="translate(70 140)">
        <motion.g
          initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: .55 }}
          animate={shown ? { opacity: 1, scale: 1 } : undefined}
          transition={{ duration: reduce ? .2 : .6, delay: reduce ? 0 : 1.3, ease: [.23, 1, .32, 1] }}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        >
          <circle r="27" fill="#b56dff" fillOpacity=".1" className="terra-pulse-ring" />
          <OrbitMark r={18} accent="#b56dff" />
        </motion.g>
      </g>

      {shown && dots && !reduce && (
        <motion.circle
          r="5"
          fill="#fff"
          initial={{ opacity: 0 }}
          animate={{ cx: [70, 70, 70], cy: [940, 250, 160], opacity: [0, 1, 0] }}
          transition={{ duration: 4.2, repeat: Infinity, ease: 'linear', delay: 1.65 }}
          filter="url(#terra-arc-glow-n)"
        />
      )}

      <motion.g
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={shown ? { opacity: 1 } : undefined}
        transition={{ duration: .5, delay: reduce ? 0 : .3 }}
      >
        <text x="60" y="992" fill="#718792" fontSize="10" fontWeight="600" letterSpacing="1.6">SCARCE CAPABILITY</text>
        <text x="390" y="14" textAnchor="end" fill="#9debff" fontSize="10" fontWeight="600" letterSpacing="1.6">UNIVERSAL UTILITY</text>
      </motion.g>
    </svg>
  )
}

function InfrastructureArc() {
  const c = useLandingCopy()
  const reduce = useReducedMotion()
  const arcRef = useRef<HTMLDivElement>(null)
  const shown = useInView(arcRef, { once: true, margin: '-90px' })
  // 流动光点只在图在视口内时挂载,滚走即卸载,避免离屏后 framer-motion 仍逐帧跑无限动画。
  const dots = useInView(arcRef, { once: false, margin: '80px' })
  const narrow = useMediaQuery('(max-width: 640px)')
  const steps = [
    { x: 60, w: 190, y: 260 },
    { x: 290, w: 190, y: 195 },
    { x: 520, w: 190, y: 130 },
    { x: 790, w: 180, y: 65 },
  ]
  return (
    <motion.div
      ref={arcRef}
      className="terra-history-art"
      role="img"
      aria-label={c.thesis.arcAria}
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 18 }}
      animate={shown ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: reduce ? .2 : .6, ease: [.23, 1, .32, 1] }}
    >
      {narrow ? <InfrastructureArcNarrowSvg shown={shown} dots={dots} reduce={reduce} /> : (
      <svg viewBox="0 0 1000 370" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="terra-arc-path" x1="60" y1="260" x2="710" y2="130" gradientUnits="userSpaceOnUse">
            <stop stopColor="#f6c889" /><stop offset=".5" stopColor="#5c8bff" /><stop offset="1" stopColor="#789bff" />
          </linearGradient>
          <linearGradient id="terra-arc-bar" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#ffffff" stopOpacity=".14" /><stop offset="1" stopColor="#ffffff" stopOpacity=".02" />
          </linearGradient>
          <linearGradient id="terra-arc-area" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#5c8bff" stopOpacity=".1" /><stop offset="1" stopColor="#5c8bff" stopOpacity="0" />
          </linearGradient>
          <filter id="terra-arc-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <motion.g
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : .12 }}
        >
          <path d="M60 344h910" stroke="#8fa5b0" strokeOpacity=".22" strokeWidth="1" />
          <path d="M44 344V40" stroke="#8fa5b0" strokeOpacity=".22" strokeWidth="1" />
          <path d="M44 44l-4 8h8ZM44 340l-4-8h8Z" fill="#8fa5b0" fillOpacity=".4" />
          <text transform="translate(30 250) rotate(-90)" textAnchor="middle" fill="#718792" fontSize="10.5" fontWeight="600" letterSpacing="2.5">{c.thesis.arcAxis.scarce}</text>
          <text transform="translate(30 160) rotate(-90)" textAnchor="middle" fill="#9debff" fontSize="10.5" fontWeight="600" letterSpacing="2.5">{c.thesis.arcAxis.universal}</text>
        </motion.g>

        <motion.path
          d="M60 344V260H250L290 195H480L520 130H710V344Z"
          fill="url(#terra-arc-area)"
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .8, delay: reduce ? 0 : 1.1 }}
        />
        <motion.path
          d="M60 260H250L290 195H480L520 130H710"
          stroke="url(#terra-arc-path)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#terra-arc-glow)"
          initial={reduce ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
          animate={shown ? { pathLength: 1, opacity: 1 } : undefined}
          transition={reduce ? { duration: 0 } : { pathLength: { duration: 1.3, delay: .3, ease: [.65, 0, .35, 1] }, opacity: { duration: .25, delay: .3 } }}
        />
        <motion.path
          d="M710 130L790 65"
          stroke="#b56dff" strokeOpacity=".55" strokeWidth="2.5" strokeDasharray="6 7" strokeLinecap="round"
          className="terra-march"
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : 1.5 }}
        />
        <motion.path
          d="M790 65H960"
          stroke="#b56dff" strokeOpacity=".45" strokeWidth="3" strokeDasharray="6 7" strokeLinecap="round"
          className="terra-march"
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : 1.62 }}
        />

        {steps.map((step, index) => {
          const item = { ...c.thesis.steps[index]!, ...stepMeta[index]! }
          const done = index < 3
          return (
            <motion.g
              key={item.era}
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 16 }}
              animate={shown ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: reduce ? .2 : .5, delay: reduce ? 0 : .55 + index * .14, ease: [.23, 1, .32, 1] }}
            >
              <path d={`M${step.x} ${step.y + 24}V344`} stroke={item.color} strokeOpacity=".16" strokeDasharray="3 7" />
              <rect x={step.x} y={step.y} width={step.w} height="22" rx="11" fill={done ? item.color : 'transparent'} fillOpacity={done ? '.22' : '0'} stroke={item.color} strokeOpacity={done ? '.75' : '.55'} strokeWidth="1.6" strokeDasharray={done ? undefined : '6 5'} />
              {done && <rect x={step.x + 3} y={step.y + 3} width={step.w - 6} height="6" rx="3" fill="url(#terra-arc-bar)" />}
              <g transform={`translate(${step.x} ${step.y + 11})`}>
                <circle r="24" fill={item.color} fillOpacity=".07" />
                <circle r="17" fill="#0f1830" stroke={item.color} strokeOpacity=".85" strokeWidth="1.6" style={{ filter: `drop-shadow(0 0 6px ${item.color}66)` }} />
                <UtilityGlyph glyph={item.glyph} color={item.color} />
              </g>
              <text x={step.x + 28} y={step.y - 30} fill={item.color} fontSize="11" fontWeight="700" letterSpacing="1.8">{item.era}</text>
              <text x={step.x + 28} y={step.y - 10} fill="#e4edea" fontSize="17" fontWeight="600">{item.title}</text>
              <text x={step.x} y={step.y + 46} fill={done ? '#718792' : item.color} fillOpacity={done ? '1' : '.9'} fontSize="12" fontWeight={done ? 400 : 600}>{item.note}</text>
              {done ? (
                <g transform={`translate(${step.x + step.w} ${step.y + 11})`}>
                  <circle r="9" fill={item.color} fillOpacity=".18" stroke={item.color} strokeOpacity=".7" />
                  <path d="M-3.5 0l2.5 2.5 4.5-5" stroke={item.color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              ) : (
                <g transform={`translate(${step.x + step.w} ${step.y + 11})`}>
                  <circle r="9" fill="#0f1830" stroke={item.color} strokeOpacity=".7" strokeDasharray="3 2" />
                  <path d="M-3.5-2.5v-1.5a3.5 3.5 0 0 1 7 0v1.5" stroke={item.color} strokeWidth="1.4" fill="none" />
                  <rect x="-4" y="-2.5" width="8" height="6.5" rx="1.5" fill={item.color} fillOpacity=".35" stroke={item.color} strokeWidth="1.2" />
                </g>
              )}
            </motion.g>
          )
        })}

        <g transform="translate(750 97)">
          <motion.g
            initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: .55 }}
            animate={shown ? { opacity: 1, scale: 1 } : undefined}
            transition={{ duration: reduce ? .2 : .6, delay: reduce ? 0 : 1.3, ease: [.23, 1, .32, 1] }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <circle r="27" fill="#b56dff" fillOpacity=".1" className="terra-pulse-ring" />
            <OrbitMark r={18} accent="#b56dff" />
          </motion.g>
        </g>

        {shown && dots && !reduce && (
          <>
            <motion.circle
              r="5"
              fill="#fff"
              initial={{ opacity: 0 }}
              animate={{ cx: [60, 250, 290, 480, 520, 710], cy: [260, 260, 195, 195, 130, 130], opacity: [0, 1, 1, 1, 1, 0] }}
              transition={{ duration: 4.2, repeat: Infinity, ease: 'linear', delay: 1.65 }}
              filter="url(#terra-arc-glow)"
            />
            <motion.circle
              r="4"
              fill="#b56dff"
              initial={{ opacity: 0 }}
              animate={{ cx: [712, 750, 790, 955], cy: [130, 97, 65, 65], opacity: [0, .9, .9, 0] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'linear', delay: 5.85 }}
            />
          </>
        )}

        <g transform="translate(790 210)">
          <motion.g
            initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: .9 }}
            animate={shown ? { opacity: 1, scale: 1 } : undefined}
            transition={{ duration: reduce ? .2 : .55, delay: reduce ? 0 : 1.45, ease: [.23, 1, .32, 1] }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <rect width="180" height="64" rx="14" fill="#b56dff" fillOpacity=".07" stroke="#b56dff" strokeOpacity=".55" strokeDasharray="6 5" />
            <path d="M18 16 27 11.5v9L18 25l-9-4.5v-9Z" fill="#b56dff" fillOpacity=".3" stroke="#b56dff" strokeWidth="1.3" />
            <text x="36" y="23" fill="#e8ecff" fontSize="13" fontWeight="700" letterSpacing=".4">YatTerra</text>
            <text x="14" y="45" fill="#b56dff" fontSize="11.5" fontWeight="600">{c.thesis.yatterraBox.title}</text>
            <text x="14" y="58" fill="#7d93a8" fontSize="10">{c.thesis.yatterraBox.note}</text>
          </motion.g>
        </g>

        <motion.g
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : .3 }}
        >
          <text x="60" y="362" fill="#718792" fontSize="10" fontWeight="600" letterSpacing="1.6">SCARCE CAPABILITY</text>
          <text x="960" y="362" textAnchor="end" fill="#9debff" fontSize="10" fontWeight="600" letterSpacing="1.6">UNIVERSAL UTILITY</text>
        </motion.g>
      </svg>
      )}
      <div className="terra-history-scale"><span>{c.thesis.scale.was}</span><span>{c.thesis.scale.goal}</span></div>
    </motion.div>
  )
}

const pointAccents: Record<string, string> = { device: '#5c8bff', network: '#789bff', idea: '#b56dff' }

function StartingPointExplorer() {
  const c = useLandingCopy()
  const [activeKey, setActiveKey] = useState(c.explorer.points[0]!.key)
  const active = c.explorer.points.find(item => item.key === activeKey) ?? c.explorer.points[0]!
  const accent = pointAccents[active.key]!
  const reduce = useReducedMotion()
  return (
    <div className="terra-explorer">
      <div className="terra-explorer-top"><div><p className="terra-eyebrow">TRY THE IDEA</p><h3>{c.explorer.title}</h3></div><span className="terra-explorer-status"><span /> {c.explorer.status}</span></div>
      <div className="terra-explorer-tabs" role="tablist" aria-label={c.explorer.tabsAria}>
        {c.explorer.points.map(item => (
          <button key={item.key} type="button" role="tab" aria-selected={activeKey === item.key} className={activeKey === item.key ? 'is-active' : ''} onClick={() => setActiveKey(item.key)}>
            {activeKey === item.key && <motion.span layoutId="terra-tab-glow" className="terra-tab-glow" transition={{ type: 'spring', stiffness: 400, damping: 36 }} />}
            <span className="terra-tab-label">{item.label}<small>{item.eyebrow}</small></span>
          </button>
        ))}
      </div>
      <div className="terra-explorer-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={active.key}
            className="terra-explorer-panel"
            initial={{ opacity: 0, x: reduce ? 0 : -18, scale: reduce ? 1 : .98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: reduce ? 0 : 14, scale: reduce ? 1 : .985 }}
            transition={{ duration: reduce ? .15 : .34, ease: [.23, 1, .32, 1] }}
          >
            <div className="terra-explorer-copy">
              <p className="terra-eyebrow" style={{ color: accent }}>{active.eyebrow}</p>
              <h4>{active.title}</h4>
              <p>{active.text}</p>
              <div className="terra-explorer-nodes">{active.nodes.map((node, index) => <span key={node}><b style={{ backgroundColor: accent }} />{node}{index < active.nodes.length - 1 && <ArrowRight size={13} />}</span>)}</div>
            </div>
            <ExplorerIllustration kind={active.key} accent={accent} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

export default function Landing() {
  const [paused, setPaused] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const reduce = useReducedMotion()
  const heroRef = useRef<HTMLElement>(null)
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const c = useLandingCopy()
  const lang = useLandingLang()

  useEffect(() => {
    document.documentElement.classList.add('landing-document')
    document.body.classList.add('landing-document')
    return () => {
      document.documentElement.classList.remove('landing-document')
      document.body.classList.remove('landing-document')
    }
  }, [])

  // 首页语言跟随切换;离开时还原(其余路由各自设置 lang)
  useEffect(() => {
    const prev = document.documentElement.lang
    document.documentElement.lang = lang
    return () => { document.documentElement.lang = prev }
  }, [lang])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const motionOff = paused || Boolean(reduce)

  // Hero visual parallax — the topology tilts gently toward the cursor.
  const onHeroMove = useRafPointer((event) => {
    if (motionOff || event.pointerType !== 'mouse' || !heroRef.current) return
    const rect = heroRef.current.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    heroRef.current.style.setProperty('--hero-px', `${px * 16}px`)
    heroRef.current.style.setProperty('--hero-py', `${py * 12}px`)
  })
  const onHeroLeave = () => {
    if (!heroRef.current) return
    heroRef.current.style.setProperty('--hero-px', '0px')
    heroRef.current.style.setProperty('--hero-py', '0px')
  }

  return (
    <div className="terra-landing landing-scroll" data-paused={motionOff}>
      <LandingBackground paused={motionOff} />
      <ScrollProgress />
      <header className={`terra-header${scrolled ? ' is-scrolled' : ''}`}>
        <div className="terra-container terra-header-inner">
          <Link to="/" className="terra-brand" aria-label={c.brandAria}><span className="terra-brand-mark"><Orbit size={24} /></span><span>YatTerra<small>INFRASTRUCTURE, RECONNECTED.</small></span></Link>
          <nav aria-label="Landing"><a href="#thesis">{c.nav.thesis}</a><a href="#why">{c.nav.why}</a><a href="#layers">{c.nav.layers}</a><a href="#scenarios">{c.nav.scenarios}</a><a href="#reports">{c.nav.reports}</a></nav>
          <div className="terra-header-side">
            <div className="terra-lang-switch" role="group" aria-label="Language / 语言">
              {LANGS.map(item => (
                <button key={item.id} type="button" aria-pressed={lang === item.id} title={item.label} className={lang === item.id ? 'is-active' : ''} onClick={() => setLandingLang(item.id)}>{item.short}</button>
              ))}
            </div>
            <Link to={isLoggedIn ? "/console" : "/login"} className="terra-header-login">{c.login} <ArrowRight size={15} /></Link>
          </div>
        </div>
      </header>
      <main id="terra-main" className="terra-main">
        <section ref={heroRef} className="terra-hero" onPointerMove={onHeroMove} onPointerLeave={onHeroLeave}>
          <div className="terra-hero-grid" aria-hidden="true" />
          <div className="terra-container terra-hero-layout">
            <div className="terra-hero-copy">
              <Reveal><div className="terra-eyebrow"><span className="terra-status-dot" /> {c.hero.eyebrow}</div></Reveal>
              <HeroTitle reduce={reduce} lines={c.hero.title} />
              <Reveal delay={.12}><p className="terra-hero-description">{c.hero.description}</p></Reveal>
              <Reveal delay={.18}><div className="terra-actions"><ShinyButton to={isLoggedIn ? "/console" : "/login"} className="terra-button-primary">{c.hero.primary} <ArrowRight size={17} /></ShinyButton><ShinyButton href="#thesis" className="terra-button-secondary">{c.hero.secondary} <ArrowDown size={16} /></ShinyButton></div></Reveal>
              <Reveal delay={.24}><div className="terra-promises">{c.hero.promises.map(promise => <span key={promise}><Check size={14} />{promise}</span>)}</div></Reveal>
            </div>
            <Reveal delay={.12} pop className="terra-hero-visual"><NetworkIllustration /></Reveal>
          </div>
          <div className="terra-container terra-hero-bottom"><span>{c.hero.bottom}</span><div><span>PRODUCTION POWER</span><span className="terra-bottom-line" /><span>EVERYWHERE</span></div><button type="button" className="terra-motion-toggle" aria-pressed={motionOff} disabled={Boolean(reduce)} onClick={() => setPaused(value => !value)}>{motionOff ? <Play size={12} /> : <Pause size={12} />}{reduce ? c.hero.motion.reduced : paused ? c.hero.motion.paused : c.hero.motion.playing}</button></div>
        </section>

        <section id="thesis" className="terra-section terra-section-tinted terra-thesis-section">
          <div className="terra-container">
            <SectionIntro
              eyebrow={c.thesis.eyebrow}
              lines={c.thesis.lines}
              desc={c.thesis.desc}
            />
            <InfrastructureArc />
            <Reveal delay={.06}><div className="terra-thesis-note"><span className="terra-thesis-mark">→</span><p>{c.thesis.noteLead}<strong>{c.thesis.noteStrong}</strong></p></div></Reveal>
          </div>
        </section>

        <section className="terra-section terra-explorer-section">
          <div className="terra-container">
            <Reveal><StartingPointExplorer /></Reveal>
          </div>
        </section>

        <section id="why" className="terra-section terra-section-tinted">
          <div className="terra-container">
            <SectionIntro
              eyebrow={c.why.eyebrow}
              lines={c.why.lines}
              desc={c.why.desc}
            />
            <div className="terra-constraint-grid">{c.why.constraints.map((item, index) => {
              const Icon = constraintIcons[index]!
              return (
                <Reveal key={item.label} delay={index * .07} pop>
                  <TiltCard className="terra-card-slot">
                    <article className="terra-constraint">
                      <div className="terra-constraint-heading"><Icon size={23} /><span>{item.label}</span></div>
                      <h3>{item.title}</h3>
                      <p>{item.description}</p>
                      <div className="terra-constraint-path">{item.detail}</div>
                    </article>
                  </TiltCard>
                </Reveal>
              )
            })}</div>
            <Reveal pop><div className="terra-gap-callout"><div><span className="terra-eyebrow">{c.why.gap.eyebrow}</span><h3>{c.why.gap.title}</h3></div><p>{c.why.gap.text}</p><GapIllustration /></div></Reveal>
          </div>
        </section>

        <section id="layers" className="terra-section">
          <div className="terra-container">
            <SectionIntro
              eyebrow={c.layers.eyebrow}
              lines={c.layers.lines}
              desc={c.layers.desc}
            />
            <Reveal><Architecture /></Reveal>
            <Reveal><div className="terra-workflow"><div className="terra-workflow-copy"><p className="terra-eyebrow">{c.layers.workflow.eyebrow}</p><h3>{c.layers.workflow.title[0]}<br />{c.layers.workflow.title[1]}</h3><p>{c.layers.workflow.text[0]}<br />{c.layers.workflow.text[1]}</p><div className="terra-tags"><span>{c.layers.workflow.tags[0]}</span><ArrowRight size={14} /><span>{c.layers.workflow.tags[1]}</span><ArrowRight size={14} /><span>{c.layers.workflow.tags[2]}</span></div></div><WorkflowIllustration /></div></Reveal>
          </div>
        </section>

        <section className="terra-section terra-section-tinted">
          <div className="terra-container">
            <SectionIntro
              eyebrow={c.thirdPath.eyebrow}
              lines={c.thirdPath.lines}
              desc={c.thirdPath.desc}
            />
            <div className="terra-choice-grid">
              {c.thirdPath.choices.map((item, index) => {
                const Icon = choiceIcons[index]!
                const featured = index === 1
                return (
                  <Reveal key={item.index} pop delay={index * .08}>
                    <TiltCard className="terra-card-slot">
                      <article className={`terra-choice${featured ? ' terra-choice-featured' : ''}`}>
                        <span className="terra-choice-index">{item.index}</span>
                        <Icon size={featured ? 32 : 30} />
                        <h3>{item.title}</h3>
                        <p>{item.text}</p>
                        <div className="terra-choice-foot">{featured && <Check size={14} />} {item.foot}</div>
                      </article>
                    </TiltCard>
                  </Reveal>
                )
              })}
            </div>
          </div>
        </section>

        <section id="scenarios" className="terra-section">
          <div className="terra-container">
            <SectionIntro
              eyebrow={c.scenarios.eyebrow}
              lines={c.scenarios.lines}
              desc={c.scenarios.desc}
            />
            <div className="terra-scenario-grid">{c.scenarios.items.map((item, index) => (
              <Reveal key={item.label} delay={index * .07} pop>
                <TiltCard className="terra-card-slot">
                  <article className="terra-scenario">
                    <div className="terra-scenario-label">{item.label}<span>↗</span></div>
                    <ScenarioIllustration index={index} />
                    <div className="terra-scenario-copy"><h3>{item.title}</h3><p>{item.description}</p><div className="terra-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div></div>
                  </article>
                </TiltCard>
              </Reveal>
            ))}</div>
          </div>
        </section>

        <section id="reports" className="terra-section terra-section-tinted">
          <div className="terra-container">
            <SectionIntro
              eyebrow={c.reportsSection.eyebrow}
              lines={c.reportsSection.lines}
              desc={c.reportsSection.desc}
            />
            <div className="terra-report-grid">{reports.map((item, index) => (
              <Reveal key={item.title} delay={index * .07} pop>
                <TiltCard className="terra-card-slot">
                  <a className="terra-report" href={item.href}>
                    <div className="terra-report-heading"><FileText size={22} /><span>{item.label}</span><span className="terra-report-date">{item.date}</span></div>
                    <h3>{item.title}</h3>
                    <p>{item.desc}</p>
                    <div className="terra-report-foot"><div className="terra-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div><span className="terra-report-more">{c.reportsSection.readMore} <ArrowRight size={14} /></span></div>
                  </a>
                </TiltCard>
              </Reveal>
            ))}</div>
          </div>
        </section>

        <section className="terra-closing">
          <div className="terra-container">
            <Reveal><div className="terra-closing-symbol" aria-hidden="true"><span /><span /><Orbit size={40} /></div></Reveal>
            <Reveal delay={.06}><RootsIllustration /></Reveal>
            <Reveal delay={.1}><p className="terra-eyebrow">{c.closing.eyebrow}</p></Reveal>
            <StaggerHeading lines={c.closing.lines} reduce={reduce} />
            <Reveal delay={.12}><p className="terra-closing-description">{c.closing.description}</p></Reveal>
            <Reveal delay={.18}><ShinyButton to={isLoggedIn ? "/console" : "/login"} className="terra-button-primary">{c.closing.primary} <ArrowRight size={17} /></ShinyButton></Reveal>
          </div>
        </section>
      </main>
      <footer className="terra-footer terra-container"><Link to="/" className="terra-brand"><Orbit size={21} /> YatTerra</Link><span>{c.footer}</span><span>© {new Date().getFullYear()} YatTerra</span></footer>
    </div>
  )
}
