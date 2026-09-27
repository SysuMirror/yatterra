import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useSpring } from 'framer-motion'
import { Link } from 'react-router'
import { useAuthStore } from '@/stores/auth'
import { ArrowDown, ArrowRight, Check, ChevronRight, Cpu, Globe2, Network, Orbit, Pause, Play, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import { ExplorerIllustration, GapIllustration, LayerIllustration, NetworkIllustration, RootsIllustration, ScenarioIllustration, WorkflowIllustration } from './landing-illustrations'
import { LandingBackground } from './landing-background'
import '../styles/landing.css'

const constraints = [
  { icon: Globe2, title: '连接不该止步于内网', label: '01 / CONNECTIVITY', description: '校园网、家庭宽带、实验室网络。设备能运行，还需要一条清晰、可控的访问路径。', detail: '内网设备 → 统一入口 → 服务访问' },
  { icon: Cpu, title: '一块 GPU，也值得被编排', label: '02 / COMPUTE', description: '算力散落在不同设备、不同地点。让资源进入同一套工作流，才能被更多人真正使用。', detail: '独立设备 → 资源池 → 工作负载' },
  { icon: Wrench, title: '让维护成为共享的能力', label: '03 / OPERATIONS', description: '从网络到权限，从部署到观测。不必为每个新项目，重新搭建一整套基础设施。', detail: '重复配置 → 平台能力 → 持续运行' },
]

const layers = [
  { number: '01', title: '连接', english: 'CONNECT', description: '跨过网络边界', detail: '通过内网穿透与统一入口，为分散设备建立可控的访问路径。网络位置不再决定服务能被谁使用。', tags: ['内网穿透', '统一入口', '域名路由'], color: '#67e8d0' },
  { number: '02', title: '编排', english: 'ORCHESTRATE', description: '让设备成为资源', detail: '通过 Kubernetes / K3s 组织节点、容器与工作负载。让部署、调度和生命周期在同一个平台中被管理。', tags: ['K3s / Kubernetes', 'GPU 资源', '容器生命周期'], color: '#8ab4ec' },
  { number: '03', title: '智能', english: 'INFERENCE', description: '让模型参与工作', detail: '把 GPU、模型、Agent 和 MCP 工具连接起来。从一次模型调用，到能够持续运行的 AI 应用。', tags: ['模型服务', 'Agent 编排', 'MCP 工具'], color: '#c4b5fd' },
  { number: '04', title: '运维', english: 'OBSERVE', description: '让运行长期可靠', detail: '围绕工作负载组织权限、监控与审计。让资源如何使用、问题发生在哪里，都有清晰的记录与边界。', tags: ['访问权限', '运行观测', '操作审计'], color: '#f6c889' },
]

const scenarios = [
  { title: '校园与实验室', label: '01 / CAMPUS', description: '课程环境、科研任务与共享 GPU，在清晰的权限边界中协作，让设备资源服务更多人。', tags: ['共享 GPU', '科研环境', '课程项目'] },
  { title: '家庭与工作室', label: '02 / HOME LAB', description: '把手边的工作站变成自己的 AI 节点。模型、数据和计算留在身边，服务从这里连接出去。', tags: ['本地模型', '个人工作流', '可控访问'] },
  { title: '团队与研究项目', label: '03 / SMALL TEAMS', description: '从一个原型到持续运行的服务。把连接、部署和协作交给平台，让团队专注于想法本身。', tags: ['应用部署', '团队协作', 'Agent 服务'] },
]

const utilitySteps = [
  { era: '1880s — 1900s', title: '动力', note: '工厂的蒸汽机 → 走进每个插座', color: '#f6c889', glyph: 'power' },
  { era: '1970s — 2010s', title: '计算', note: '机构的大型机 → 口袋里的手机', color: '#67e8d0', glyph: 'compute' },
  { era: '2006 — 2020s', title: '容量', note: '自建的机房 → 按需租用的云', color: '#8ab4ec', glyph: 'cloud' },
  { era: 'NOW · 缺失的一级', title: '承载智能的一层', note: '模型人人可及，这一层还不是', color: '#c4b5fd', glyph: 'lock' },
] as const

const startingPoints = [
  { key: 'device', label: '一台设备', eyebrow: 'START WITH A DEVICE', title: '让一台闲置设备，重新成为生产力。', text: '从工作站、家庭服务器或实验室 GPU 开始，不需要先拥有完整的数据中心。', accent: '#67e8d0', nodes: ['本地 GPU', '内网服务', '你的项目'] },
  { key: 'network', label: '一组节点', eyebrow: 'START WITH A NETWORK', title: '把分散的算力，组织成一个整体。', text: '不同地点、不同配置的设备，也可以共享连接、调度和运行能力。', accent: '#8ab4ec', nodes: ['校园节点', '家庭节点', '共享资源'] },
  { key: 'idea', label: '一个想法', eyebrow: 'START WITH AN IDEA', title: '让一个想法拥有持续运行的环境。', text: '从模型、Agent 或应用开始，向下连接真实算力，向上形成可访问的服务。', accent: '#c4b5fd', nodes: ['模型 / Agent', '运行环境', '真实产出'] },
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

/** Per-character entrance for headings — a wave of lift + blur. */
function StaggerLine({ text, visible, reduce, delay = 0, className }: { text: string; visible: boolean; reduce: boolean | null; delay?: number; className?: string }) {
  if (reduce) return <span className={className}>{text}</span>
  return (
    <span className={className}>
      {[...text].map((char, index) => (
        <motion.span
          key={index}
          className="terra-char"
          initial={{ opacity: 0, y: 16, filter: 'blur(7px)' }}
          animate={visible ? { opacity: 1, y: 0, filter: 'blur(0px)' } : undefined}
          transition={{ duration: .55, delay: delay + index * .028, ease: [.23, 1, .32, 1] }}
        >{char === ' ' ? ' ' : char}</motion.span>
      ))}
    </span>
  )
}

/** Two-line heading that waves in on scroll. */
function StaggerHeading({ lines, reduce, delay = 0 }: { lines: [string, string]; reduce: boolean | null; delay?: number }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const visible = useInView(ref, { once: true, margin: '-60px' })
  return (
    <h2 ref={ref}>
      <StaggerLine text={lines[0]} className="terra-line-lead" visible={visible} reduce={reduce} delay={delay} />
      <StaggerLine text={lines[1]} className="terra-line-accent" visible={visible} reduce={reduce} delay={delay + lines[0].length * .028} />
    </h2>
  )
}

/** Eyebrow + two-line heading + blurb, choreographed as one entrance. */
function SectionIntro({ eyebrow, lines, desc, delay = 0 }: { eyebrow: string; lines: [string, string]; desc: string; delay?: number }) {
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

/** 3D tilt + cursor-tracking glow for cards. */
function TiltCard({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
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
  }

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

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (reduce || event.pointerType !== 'mouse') return
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    const dx = (event.clientX - (rect.left + rect.width / 2)) / rect.width
    const dy = (event.clientY - (rect.top + rect.height / 2)) / rect.height
    element.style.setProperty('--pull-x', `${dx * 10}px`)
    element.style.setProperty('--pull-y', `${dy * 7}px`)
    element.style.setProperty('--shine-x', `${((event.clientX - rect.left) / rect.width) * 100}%`)
  }

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
  const [active, setActive] = useState(0)
  const layer = layers[active]!
  return (
    <div className="terra-architecture">
      <div className="terra-diagram-heading"><span>THE INFRASTRUCTURE STACK</span><span>选择一层，探索它如何工作</span></div>
      <div className="terra-layer-grid">
        {layers.map((item, index) => (
          <button key={item.number} type="button" className="terra-layer" aria-pressed={active === index} aria-controls="terra-layer-detail" onClick={() => setActive(index)}>
            {active === index && <motion.span layoutId="terra-layer-underline" className="terra-layer-underline" transition={{ type: 'spring', stiffness: 380, damping: 34 }} />}
            <div className="terra-layer-top"><span>{item.number}</span><span style={{ color: item.color }}>{item.english}</span></div>
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
      <div className="terra-control-rail"><ShieldCheck size={15} /><span>统一的权限、观测与审计，贯穿每一层。</span><span className="terra-rail-label">SHARED CONTROL PLANE</span></div>
    </div>
  )
}

function UtilityGlyph({ glyph, color }: { glyph: typeof utilitySteps[number]['glyph']; color: string }) {
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

function InfrastructureArc() {
  const reduce = useReducedMotion()
  const arcRef = useRef<HTMLDivElement>(null)
  const shown = useInView(arcRef, { once: true, margin: '-90px' })
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
      aria-label="每一项能力从少数机构专属走向每个人可用的阶梯图；承载智能的一级仍然缺失，由 YatTerra 补上"
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 18 }}
      animate={shown ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: reduce ? .2 : .6, ease: [.23, 1, .32, 1] }}
    >
      <svg viewBox="0 0 1000 370" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="terra-arc-path" x1="60" y1="260" x2="710" y2="130" gradientUnits="userSpaceOnUse">
            <stop stopColor="#f6c889" /><stop offset=".5" stopColor="#67e8d0" /><stop offset="1" stopColor="#8ab4ec" />
          </linearGradient>
          <linearGradient id="terra-arc-bar" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#ffffff" stopOpacity=".14" /><stop offset="1" stopColor="#ffffff" stopOpacity=".02" />
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
          <text transform="translate(30 250) rotate(-90)" textAnchor="middle" fill="#718792" fontSize="10.5" fontWeight="600" letterSpacing="2.5">少数组织专属</text>
          <text transform="translate(30 160) rotate(-90)" textAnchor="middle" fill="#9aebd2" fontSize="10.5" fontWeight="600" letterSpacing="2.5">每一个人</text>
        </motion.g>

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
          stroke="#c4b5fd" strokeOpacity=".55" strokeWidth="2.5" strokeDasharray="6 7" strokeLinecap="round"
          className="terra-march"
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : 1.5 }}
        />
        <motion.path
          d="M790 65H960"
          stroke="#c4b5fd" strokeOpacity=".45" strokeWidth="3" strokeDasharray="6 7" strokeLinecap="round"
          className="terra-march"
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : 1.62 }}
        />

        {steps.map((step, index) => {
          const item = utilitySteps[index]!
          const done = index < 3
          return (
            <motion.g
              key={item.title}
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 16 }}
              animate={shown ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: reduce ? .2 : .5, delay: reduce ? 0 : .55 + index * .14, ease: [.23, 1, .32, 1] }}
            >
              <path d={`M${step.x} ${step.y + 24}V344`} stroke={item.color} strokeOpacity=".16" strokeDasharray="3 7" />
              <rect x={step.x} y={step.y} width={step.w} height="22" rx="11" fill={done ? item.color : 'transparent'} fillOpacity={done ? '.22' : '0'} stroke={item.color} strokeOpacity={done ? '.75' : '.55'} strokeWidth="1.6" strokeDasharray={done ? undefined : '6 5'} />
              {done && <rect x={step.x + 3} y={step.y + 3} width={step.w - 6} height="6" rx="3" fill="url(#terra-arc-bar)" />}
              <g transform={`translate(${step.x} ${step.y + 11})`}>
                <circle r="17" fill="#0c1723" stroke={item.color} strokeOpacity=".85" strokeWidth="1.6" />
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
                  <circle r="9" fill="#0c1723" stroke={item.color} strokeOpacity=".7" strokeDasharray="3 2" />
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
            <circle r="27" fill="#c4b5fd" fillOpacity=".1" className="terra-pulse-ring" />
            <path d="M0 -18 15.6 -9v18L0 18-15.6 9V-9Z" fill="#0e2436" stroke="#c4b5fd" strokeWidth="1.8" />
            <path d="M0 -18V0M0 0 15.6 -9M0 0-15.6 9" stroke="#c4b5fd" strokeOpacity=".4" />
            <text y="4" textAnchor="middle" fill="#e8ecff" fontSize="10.5" fontWeight="800">YT</text>
          </motion.g>
        </g>

        {shown && !reduce && (
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
              fill="#c4b5fd"
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
            <rect width="180" height="64" rx="14" fill="#c4b5fd" fillOpacity=".07" stroke="#c4b5fd" strokeOpacity=".55" strokeDasharray="6 5" />
            <path d="M18 16 27 11.5v9L18 25l-9-4.5v-9Z" fill="#c4b5fd" fillOpacity=".3" stroke="#c4b5fd" strokeWidth="1.3" />
            <text x="36" y="23" fill="#e8ecff" fontSize="13" fontWeight="700" letterSpacing=".4">YatTerra</text>
            <text x="14" y="45" fill="#c4b5fd" fontSize="11.5" fontWeight="600">把缺失的一级补上</text>
            <text x="14" y="58" fill="#7d93a8" fontSize="10">让承载智能的基础设施也普惠</text>
          </motion.g>
        </g>

        <motion.g
          initial={reduce ? { opacity: 1 } : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ duration: .5, delay: reduce ? 0 : .3 }}
        >
          <text x="60" y="362" fill="#718792" fontSize="10" fontWeight="600" letterSpacing="1.6">SCARCE CAPABILITY</text>
          <text x="960" y="362" textAnchor="end" fill="#9aebd2" fontSize="10" fontWeight="600" letterSpacing="1.6">UNIVERSAL UTILITY</text>
        </motion.g>
      </svg>
      <div className="terra-history-scale"><span>曾经：少数机构的能力</span><span>目标：每个人都能接上</span></div>
    </motion.div>
  )
}

function StartingPointExplorer() {
  const [activeKey, setActiveKey] = useState(startingPoints[0]!.key)
  const active = startingPoints.find(item => item.key === activeKey) ?? startingPoints[0]!
  const reduce = useReducedMotion()
  return (
    <div className="terra-explorer">
      <div className="terra-explorer-top"><div><p className="terra-eyebrow">TRY THE IDEA</p><h3>你从哪里开始？</h3></div><span className="terra-explorer-status"><span /> SYSTEM READY</span></div>
      <div className="terra-explorer-tabs" role="tablist" aria-label="选择基础设施起点">
        {startingPoints.map(item => (
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
              <p className="terra-eyebrow" style={{ color: active.accent }}>{active.eyebrow}</p>
              <h4>{active.title}</h4>
              <p>{active.text}</p>
              <div className="terra-explorer-nodes">{active.nodes.map((node, index) => <span key={node}><b style={{ backgroundColor: active.accent }} />{node}{index < active.nodes.length - 1 && <ArrowRight size={13} />}</span>)}</div>
            </div>
            <ExplorerIllustration kind={active.key} accent={active.accent} />
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

  useEffect(() => {
    document.documentElement.classList.add('landing-document')
    document.body.classList.add('landing-document')
    return () => {
      document.documentElement.classList.remove('landing-document')
      document.body.classList.remove('landing-document')
    }
  }, [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const motionOff = paused || Boolean(reduce)

  // Hero visual parallax — the topology tilts gently toward the cursor.
  const onHeroMove = (event: React.PointerEvent<HTMLElement>) => {
    if (motionOff || event.pointerType !== 'mouse' || !heroRef.current) return
    const rect = heroRef.current.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    heroRef.current.style.setProperty('--hero-px', `${px * 16}px`)
    heroRef.current.style.setProperty('--hero-py', `${py * 12}px`)
  }
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
          <Link to="/" className="terra-brand" aria-label="YatTerra 首页"><span className="terra-brand-mark"><Orbit size={24} /></span><span>YatTerra<small>INFRASTRUCTURE, RECONNECTED.</small></span></Link>
          <nav aria-label="公开页面导航"><a href="#thesis">为什么现在</a><a href="#why">断层</a><a href="#layers">怎么工作</a><a href="#scenarios">场景</a></nav>
          <Link to={isLoggedIn ? "/console" : "/login"} className="terra-header-login">进入控制台 <ArrowRight size={15} /></Link>
        </div>
      </header>
      <main id="terra-main" className="terra-main">
        <section ref={heroRef} className="terra-hero" onPointerMove={onHeroMove} onPointerLeave={onHeroLeave}>
          <div className="terra-hero-grid" aria-hidden="true" />
          <div className="terra-container terra-hero-layout">
            <div className="terra-hero-copy">
              <Reveal><div className="terra-eyebrow"><span className="terra-status-dot" /> BUILT FOR THE REAL WORLD</div></Reveal>
              <HeroTitle reduce={reduce} lines={['更高级的生产力，', '应该属于每一个人。']} />
              <Reveal delay={.12}><p className="terra-hero-description">蒸汽机、电力、计算机，都曾经只属于少数组织，后来成为每个人日常生活的一部分。AI 正在完成下一次普惠，而它需要一层新的基础设施。</p></Reveal>
              <Reveal delay={.18}><div className="terra-actions"><ShinyButton to={isLoggedIn ? "/console" : "/login"} className="terra-button-primary">进入 YatTerra <ArrowRight size={17} /></ShinyButton><ShinyButton href="#thesis" className="terra-button-secondary">理解这件事 <ArrowDown size={16} /></ShinyButton></div></Reveal>
              <Reveal delay={.24}><div className="terra-promises"><span><Check size={14} />普惠性的技术基础设施</span><span><Check size={14} />公有云与私有云之间</span></div></Reveal>
            </div>
            <Reveal delay={.12} pop className="terra-hero-visual"><NetworkIllustration /></Reveal>
          </div>
          <div className="terra-container terra-hero-bottom"><span>从少数人的机器，到每个人的基础设施。</span><div><span>PRODUCTION POWER</span><span className="terra-bottom-line" /><span>EVERYWHERE</span></div><button type="button" className="terra-motion-toggle" aria-pressed={motionOff} disabled={Boolean(reduce)} onClick={() => setPaused(value => !value)}>{motionOff ? <Play size={12} /> : <Pause size={12} />}{reduce ? '已减少动态' : paused ? '播放动效' : '暂停动效'}</button></div>
        </section>

        <section id="thesis" className="terra-section terra-section-tinted terra-thesis-section">
          <div className="terra-container">
            <SectionIntro
              eyebrow="00 — THE LONG ARC"
              lines={['每一项能力成为基础设施，', '都要走完同一段路。']}
              desc="从少数机构的专属能力，到每个人都能接上的公共设施。动力走完了，计算走完了，容量也走完了——智能的承载层，还没有。"
            />
            <InfrastructureArc />
            <Reveal delay={.06}><div className="terra-thesis-note"><span className="terra-thesis-mark">→</span><p>AI 的下一步，不只是让更多人调用模型。<strong>而是让更多人拥有承载模型、工作流与创造的基础设施。</strong></p></div></Reveal>
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
              eyebrow="01 — THE MISSING LAYER"
              lines={['AI 正在走向每一个人，', '基础设施却没有跟上。']}
              desc="传统公有云主要服务企业、政府、医院和研究机构，解决的是“非计算机专业客户如何不必考虑运维”。但 AI 时代的创新正在不可逆地碎片化、个人化。"
            />
            <div className="terra-constraint-grid">{constraints.map((item, index) => (
              <Reveal key={item.title} delay={index * .07} pop>
                <TiltCard className="terra-card-slot">
                  <article className="terra-constraint">
                    <div className="terra-constraint-heading"><item.icon size={23} /><span>{item.label}</span></div>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                    <div className="terra-constraint-path">{item.detail}</div>
                  </article>
                </TiltCard>
              </Reveal>
            ))}</div>
            <Reveal pop><div className="terra-gap-callout"><div><span className="terra-eyebrow">THE GAP</span><h3>云很贵，设备却在内网吃灰。</h3></div><p>OPC、初创公司、小实验室、兴趣团体与家庭用户正在遍地出现，却没有与他们的规模、预算和现实资源相匹配的云基础设施。</p><GapIllustration /></div></Reveal>
          </div>
        </section>

        <section id="layers" className="terra-section">
          <div className="terra-container">
            <SectionIntro
              eyebrow="02 — ONE COHERENT FABRIC"
              lines={['不是把云做小，', '而是把基础设施做普惠。']}
              desc="YatTerra 把连接、编排、AI 与运维组织成一层统一的技术土壤，让真实设备也能拥有平台化的可靠性。"
            />
            <Reveal><Architecture /></Reveal>
            <Reveal><div className="terra-workflow"><div className="terra-workflow-copy"><p className="terra-eyebrow">FROM IDEA TO SERVICE</p><h3>给想法一条<br />完整的落地路径。</h3><p>从代码、容器到模型服务，<br />把日常开发接进同一套基础设施。</p><div className="terra-tags"><span>开发</span><ArrowRight size={14} /><span>部署</span><ArrowRight size={14} /><span>运行</span></div></div><WorkflowIllustration /></div></Reveal>
          </div>
        </section>

        <section className="terra-section terra-section-tinted">
          <div className="terra-container">
            <SectionIntro
              eyebrow="03 — A THIRD PATH"
              lines={['不替代公有云，', '也不鼓励复杂自建。']}
              desc="公有云解决的是托管与规模，私有云解决的是控制与成本。YatTerra 在两者之间做 tradeoff：连接真实设备，复用平台能力，把可靠性带给更小、更分散的创造者。"
            />
            <div className="terra-choice-grid">
              <Reveal pop delay={0}><TiltCard className="terra-card-slot"><article className="terra-choice"><span className="terra-choice-index">01 / PUBLIC CLOUD</span><Globe2 size={30} /><h3>公有云</h3><p>能力完整、弹性强，默认用户拥有企业级预算、规模与运维需求。</p><div className="terra-choice-foot">规模化供给 · 长期账单</div></article></TiltCard></Reveal>
              <Reveal pop delay={.08}><TiltCard className="terra-card-slot"><article className="terra-choice terra-choice-featured"><span className="terra-choice-index">02 / THE MISSING MIDDLE</span><Orbit size={32} /><h3>YatTerra</h3><p>让内网设备、闲置算力与本地数据成为可靠服务，同时获得连接、编排和运维能力。</p><div className="terra-choice-foot"><Check size={14} /> 更低门槛 · 平台级可靠性</div></article></TiltCard></Reveal>
              <Reveal pop delay={.16}><TiltCard className="terra-card-slot"><article className="terra-choice"><span className="terra-choice-index">03 / PRIVATE CLOUD</span><Wrench size={29} /><h3>私有云 / 下云</h3><p>控制权更强，但需要自行承担网络、机房、集群与长期运维的全部复杂度。</p><div className="terra-choice-foot">自主控制 · 运维负担</div></article></TiltCard></Reveal>
            </div>
          </div>
        </section>

        <section id="scenarios" className="terra-section">
          <div className="terra-container">
            <SectionIntro
              eyebrow="04 — MANY PLACES, ONE PLATFORM"
              lines={['创新会发生在任何地方，', '基础设施也应该在那里。']}
              desc="校园、家庭、工作室、实验室与小团队，只是不同的起点。底层需要的是同一条连接资源、模型与人的路径。"
            />
            <div className="terra-scenario-grid">{scenarios.map((item, index) => (
              <Reveal key={item.title} delay={index * .07} pop>
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

        <section className="terra-closing">
          <div className="terra-container">
            <Reveal><div className="terra-closing-symbol" aria-hidden="true"><span /><span /><Orbit size={40} /></div></Reveal>
            <Reveal delay={.06}><RootsIllustration /></Reveal>
            <Reveal delay={.1}><p className="terra-eyebrow">YATTERRA — THE SOIL FOR AI</p></Reveal>
            <StaggerHeading lines={['让每一个想法，', '都能拥有自己的基础设施。']} reduce={reduce} />
            <Reveal delay={.12}><p className="terra-closing-description">Yat 来自 Sun Yat-sen University。Terra 是大地，是土壤，也是让万物生长的基础。我们不替代云，我们让更多创造拥有可以扎根的土壤。</p></Reveal>
            <Reveal delay={.18}><ShinyButton to={isLoggedIn ? "/console" : "/login"} className="terra-button-primary">进入 YatTerra <ArrowRight size={17} /></ShinyButton></Reveal>
          </div>
        </section>
      </main>
      <footer className="terra-footer terra-container"><Link to="/" className="terra-brand"><Orbit size={21} /> YatTerra</Link><span>为真实世界构建的 AI-native 基础设施</span><span>© {new Date().getFullYear()} YatTerra</span></footer>
    </div>
  )
}
