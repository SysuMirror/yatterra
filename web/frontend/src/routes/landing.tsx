import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useInView, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowDown, ArrowRight, Check, ChevronRight, Cpu, Globe2, Network, Orbit, Pause, Play, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import { LayerIllustration, NetworkIllustration, ScenarioIllustration, WorkflowIllustration } from './landing-illustrations'
import { StartingPointDiagram } from './landing-starting-points'
import '../styles/landing.css'
import '../styles/landing-story.css'

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

const infrastructureMilestones = [
  { period: 'POWER', title: '蒸汽动力', infrastructure: '工厂与机械化生产', text: '让生产不再只依靠人力。', color: '#f6c889' },
  { period: 'ENERGY', title: '电力', infrastructure: '电网', text: '让能源可以按需接入。', color: '#67e8d0' },
  { period: 'COMPUTE', title: '计算', infrastructure: '网络与云', text: '让计算成为可调用的服务。', color: '#8ab4ec' },
]

const startingPoints = [
  { key: 'device', label: '一台设备', eyebrow: 'START WITH A DEVICE', title: '让一台闲置设备，重新成为生产力。', text: '从工作站、家庭服务器或实验室 GPU 开始，不需要先拥有完整的数据中心。', accent: '#67e8d0', nodes: ['本地 GPU', '内网服务', '你的项目'] },
  { key: 'network', label: '一组节点', eyebrow: 'START WITH A NETWORK', title: '把分散的算力，组织成一个整体。', text: '不同地点、不同配置的设备，也可以共享连接、调度和运行能力。', accent: '#8ab4ec', nodes: ['校园节点', '家庭节点', '共享资源'] },
  { key: 'idea', label: '一个想法', eyebrow: 'START WITH AN IDEA', title: '让一个想法，成为持续可访问的服务。', text: '从模型、Agent 或应用开始，向下连接真实算力，向上形成可访问的服务。', accent: '#c4b5fd', nodes: ['模型 / Agent', '运行环境', '可访问服务'] },
]

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion()
  const element = useRef<HTMLDivElement>(null)
  const visible = useInView(element, { once: true, margin: '-40px' })
  return (
    <motion.div
      ref={element}
      className={className}
      initial={{ opacity: 0, transform: reduce ? 'none' : 'translateY(18px)' }}
      animate={visible ? { opacity: 1, transform: reduce ? 'none' : 'translateY(0px)' } : undefined}
      transition={{ duration: reduce ? .2 : .6, delay: reduce ? 0 : delay, ease: [.23, 1, .32, 1] }}
    >{children}</motion.div>
  )
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
            <div className="terra-layer-top"><span>{item.number}</span><span style={{ color: item.color }}>{item.english}</span></div>
            <LayerIllustration index={index} />
            <div className="terra-layer-bottom"><h3>{item.title}</h3><p>{item.description}</p><ChevronRight size={16} /></div>
          </button>
        ))}
      </div>
      <div className="terra-layer-detail" id="terra-layer-detail" aria-live="polite" aria-atomic="true">
        <div><span className="terra-detail-number" style={{ color: layer.color }}>{layer.number}</span><p>{layer.detail}</p></div>
        <div className="terra-tags">{layer.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      </div>
      <div className="terra-control-rail"><ShieldCheck size={15} /><span>统一的权限、观测与审计，贯穿每一层。</span><span className="terra-rail-label">SHARED CONTROL PLANE</span></div>
    </div>
  )
}

function InfrastructureArc() {
  return <div className="terra-history-comparison">
    {infrastructureMilestones.map(item => <article key={item.period} style={{ borderTopColor: item.color }}>
      <p className="terra-eyebrow" style={{ color: item.color }}>{item.period}</p>
      <span>能力的突破</span><h3>{item.title}</h3>
      <ArrowDown size={20} aria-hidden="true" />
      <span>走向普及的基础设施</span><h4>{item.infrastructure}</h4>
      <p>{item.text}</p>
    </article>)}
  </div>
}

function StartingPointExplorer({ paused }: { paused: boolean }) {
  const [activeKey, setActiveKey] = useState(startingPoints[0]!.key)
  const active = startingPoints.find(item => item.key === activeKey) ?? startingPoints[0]!
  return (
    <div className="terra-explorer">
      <div className="terra-explorer-top"><div><p className="terra-eyebrow">TRY THE IDEA</p><h3>你从哪里开始？</h3><p className="terra-explorer-lede">不必先拥有一座机房，从你已经拥有的东西开始。</p></div><span className="terra-explorer-status"><span /> SYSTEM READY</span></div>
      <div className="terra-explorer-tabs" role="tablist" aria-label="选择基础设施起点">
        {startingPoints.map(item => <button key={item.key} type="button" role="tab" aria-selected={activeKey === item.key} className={activeKey === item.key ? 'is-active' : ''} onClick={() => setActiveKey(item.key)}>{item.label}<small>{item.eyebrow}</small></button>)}
      </div>
      <div className="terra-explorer-body">
        <div className="terra-explorer-copy"><h4>{active.title}</h4><p>{active.text}</p><div className="terra-explorer-nodes">{active.nodes.map((node, index) => <span key={node}><b style={{ backgroundColor: active.accent }} />{node}{index < active.nodes.length - 1 && <ArrowRight size={13} />}</span>)}</div></div>
        <StartingPointDiagram kind={active.key} paused={paused} />
      </div>
    </div>
  )
}

function GapIllustration({ paused }: { paused: boolean }) {
  const fabricRows = [
    { label: '连接', color: '#67e8d0', text: '#a9d7ce' },
    { label: '编排', color: '#8ab4ec', text: '#b7cbe8' },
    { label: '运行', color: '#f6c889', text: '#f2d9b4' },
  ]
  // cubic M136 129 C170 20 234 20 268 91, sampled at t = 0 / .25 / .5 / .75 / 1
  const packetX = [136, 166.2, 202, 237.8, 268]
  const packetY = [129, 67.1, 42.5, 51.7, 91]
  return <svg className="terra-gap-art" viewBox="0 0 430 190" fill="none" role="img" aria-label="左侧是昂贵的公有云与闲置的内网设备，中间缺少适配层，YatTerra 以连接、编排、运行补上这一层的示意图">
    <defs>
      <linearGradient id="terra-gap-bridge" x1="136" y1="129" x2="268" y2="91" gradientUnits="userSpaceOnUse">
        <stop stopColor="#f6c889" stopOpacity=".7" />
        <stop offset=".5" stopColor="#9aebd2" />
        <stop offset="1" stopColor="#8ab4ec" stopOpacity=".85" />
      </linearGradient>
      <linearGradient id="terra-gap-cloud" x1="0" y1="0" x2="0" y2="1">
        <stop stopColor="#2f2537" />
        <stop offset="1" stopColor="#1b1723" />
      </linearGradient>
      <linearGradient id="terra-gap-device" x1="0" y1="0" x2="0" y2="1">
        <stop stopColor="#12293a" />
        <stop offset="1" stopColor="#0a1b26" />
      </linearGradient>
      <linearGradient id="terra-gap-fabric" x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#123542" />
        <stop offset="1" stopColor="#0b202c" />
      </linearGradient>
      <linearGradient id="terra-gap-void" x1="0" y1="28" x2="0" y2="154" gradientUnits="userSpaceOnUse">
        <stop stopColor="#08111a" stopOpacity=".9" />
        <stop offset="1" stopColor="#08111a" stopOpacity=".15" />
      </linearGradient>
      <linearGradient id="terra-gap-sheen" x1="0" y1="16" x2="0" y2="86" gradientUnits="userSpaceOnUse">
        <stop stopColor="#ffffff" stopOpacity=".05" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
      <pattern id="terra-gap-grid" width="22" height="22" patternUnits="userSpaceOnUse">
        <path d="M22 0H0V22" stroke="#8fa5b0" strokeOpacity=".06" />
      </pattern>
      <pattern id="terra-gap-grid-fine" width="11" height="11" patternUnits="userSpaceOnUse">
        <path d="M11 0H0V11" stroke="#8fa5b0" strokeOpacity=".03" />
      </pattern>
      <radialGradient id="terra-gap-halo" cx="335" cy="80" r="96" gradientUnits="userSpaceOnUse">
        <stop stopColor="#9aebd2" stopOpacity=".16" />
        <stop offset="1" stopColor="#9aebd2" stopOpacity="0" />
      </radialGradient>
      <filter id="terra-gap-shadow" x="-30%" y="-30%" width="160%" height="175%">
        <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#020a10" floodOpacity=".55" />
      </filter>
    </defs>

    {/* stage */}
    <rect x="14" y="16" width="402" height="158" rx="18" fill="#0b1723" stroke="#5f7a87" strokeOpacity=".18" />
    <rect x="14" y="16" width="402" height="158" rx="18" fill="url(#terra-gap-grid-fine)" />
    <rect x="14" y="16" width="402" height="158" rx="18" fill="url(#terra-gap-grid)" />
    <rect x="14" y="16" width="402" height="158" rx="18" fill="url(#terra-gap-halo)" />
    <rect x="14" y="16" width="402" height="158" rx="18" fill="url(#terra-gap-sheen)" />

    {/* left-top · expensive public cloud */}
    <g transform="translate(28 28)">
      <rect width="108" height="54" rx="10" fill="url(#terra-gap-cloud)" stroke="#f6c889" strokeOpacity=".42" filter="url(#terra-gap-shadow)" />
      <rect x=".5" y=".5" width="107" height="53" rx="9.5" stroke="#f6c889" strokeOpacity=".12" />
      <text x="11" y="15" fill="#f6d7ab" fontSize="6.6" letterSpacing="1.3">PUBLIC CLOUD</text>
      <text x="11" y="40" fill="#f6c889" fontSize="16" fontWeight="600">￥￥￥</text>
      <path d="M74 44h30" stroke="#f6c889" strokeOpacity=".18" strokeLinecap="round" />
      <rect x="75" y="34" width="5" height="10" rx="1.5" fill="#f6c889" fillOpacity=".26" />
      <rect x="84" y="28" width="5" height="16" rx="1.5" fill="#f6c889" fillOpacity=".5" />
      <rect x="93" y="21" width="5" height="23" rx="1.5" fill="#f6c889" fillOpacity=".78" />
      <path d="M74 24l9-5 9-4 6-3" stroke="#f6c889" strokeOpacity=".34" strokeLinecap="round" strokeDasharray="2 3" />
    </g>
    <text x="82" y="95" textAnchor="middle" fill="#8b7569" fontSize="8">账单随规模增长</text>

    {/* left-bottom · idle in-network devices */}
    <g transform="translate(28 104)">
      <rect width="108" height="50" rx="10" fill="url(#terra-gap-device)" stroke="#67e8d0" strokeOpacity=".3" filter="url(#terra-gap-shadow)" />
      <rect x=".5" y=".5" width="107" height="49" rx="9.5" stroke="#67e8d0" strokeOpacity=".1" />
      {[0, 1, 2].map(index => <g key={index} transform={`translate(${9 + index * 32} 9)`}>
        <rect width="26" height="26" rx="5" fill="#0d1f2b" stroke="#67e8d0" strokeOpacity={index === 1 ? '.16' : '.42'} />
        <path d="M6 10h14M6 15h9" stroke="#67e8d0" strokeOpacity={index === 1 ? '.18' : '.5'} strokeLinecap="round" />
        <circle cx="20" cy="20" r="1.7" fill="#67e8d0" className="terra-light" style={{ animationDelay: `${index * -.8}s` }} opacity={index === 1 ? .22 : undefined} />
      </g>)}
      <rect x="9" y="40" width="90" height="3" rx="1.5" fill="#67e8d0" fillOpacity=".09" />
      <rect x="9" y="40" width="15" height="3" rx="1.5" fill="#67e8d0" fillOpacity=".42" />
    </g>
    <text x="82" y="168" textAnchor="middle" fill="#7ea09f" fontSize="8">内网设备 · 闲置</text>

    {/* middle · the missing layer */}
    <rect x="152" y="28" width="100" height="126" rx="14" fill="url(#terra-gap-void)" stroke="#789198" strokeOpacity=".22" strokeDasharray="4 6" />
    <path d="M202 40v100" stroke="#789198" strokeOpacity=".1" strokeDasharray="2 5" />
    <g transform="translate(202 92)">
      <circle cx="0" cy="0" r="15" fill="#0b1723" stroke="#789198" strokeOpacity=".26" />
      <path d="M-6-6l12 12M-6 6l12-12" stroke="#f6c889" strokeWidth="1.6" strokeLinecap="round" strokeOpacity=".85" />
    </g>
    <text x="202" y="126" textAnchor="middle" fill="#778f99" fontSize="8.5">缺少适配层</text>
    <text x="202" y="140" textAnchor="middle" fill="#5c7480" fontSize="6.4" letterSpacing="1.1">NO ADAPTER</text>
    <text x="202" y="168" textAnchor="middle" fill="#607984" fontSize="8" letterSpacing="1">THE MISSING MIDDLE</text>

    {/* right · YatTerra fabric */}
    <g transform="translate(268 28)">
      <rect width="134" height="126" rx="14" fill="url(#terra-gap-fabric)" stroke="#9aebd2" strokeOpacity=".55" filter="url(#terra-gap-shadow)" />
      <rect x="1" y="1" width="132" height="124" rx="13" stroke="#9aebd2" strokeOpacity=".1" />
      <circle cx="14" cy="16" r="2.6" fill="#9aebd2" className="terra-light" />
      <text x="22" y="19" fill="#a9d7ce" fontSize="6.6" letterSpacing="1.3">YATTERRA FABRIC</text>
      <path d="M12 26h110" stroke="#9aebd2" strokeOpacity=".12" />
      {fabricRows.map((row, index) => <g key={row.label} transform={`translate(12 ${34 + index * 30})`}>
        <rect width="110" height="24" rx="7" fill="#0d2230" stroke={row.color} strokeOpacity=".3" />
        <circle cx="12" cy="12" r="2.8" fill={row.color} fillOpacity=".85" className="terra-light" style={{ animationDelay: `${index * -.6}s` }} />
        <text x="22" y="15" fill={row.text} fontSize="9">{row.label}</text>
        <path d="M52 12h36" stroke={row.color} strokeOpacity=".26" strokeLinecap="round" />
        <circle cx="94" cy="12" r="2.2" fill={row.color} className="terra-light" style={{ animationDelay: `${index * -.6 - .3}s` }} />
      </g>)}
    </g>
    <text x="335" y="168" textAnchor="middle" fill="#a9d7ce" fontSize="8.5" letterSpacing="1.4">连接 · 编排 · 运行</text>

    {/* the bridge over the gap */}
    <path d="M136 129C170 20 234 20 268 91" stroke="#9aebd2" strokeOpacity=".07" strokeWidth="10" strokeLinecap="round" />
    <path d="M136 129C170 20 234 20 268 91" stroke="url(#terra-gap-bridge)" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="136" cy="129" r="3.4" fill="#0b1723" stroke="#f6c889" strokeOpacity=".8" />
    <circle cx="268" cy="91" r="3.4" fill="#0b1723" stroke="#8ab4ec" strokeOpacity=".8" />
    <motion.circle r="3.4" fill="#9aebd2" initial={false} animate={paused ? { cx: 202, cy: 42.5, opacity: .4 } : { cx: packetX, cy: packetY, opacity: [0, 1, 1, 1, 0] }} transition={paused ? { duration: .2 } : { duration: 3.6, repeat: Infinity, ease: 'easeInOut' }} />
    <motion.circle r="2.2" fill="#f6c889" initial={false} animate={paused ? { cx: 166.2, cy: 67.1, opacity: .3 } : { cx: packetX, cy: packetY, opacity: [0, .9, .9, .9, 0] }} transition={paused ? { duration: .2 } : { duration: 3.6, repeat: Infinity, ease: 'easeInOut', delay: 1.8 }} />
  </svg>
}

export default function Landing() {
  const [paused, setPaused] = useState(false)
  const reduce = useReducedMotion()

  useEffect(() => {
    document.documentElement.classList.add('landing-document')
    document.body.classList.add('landing-document')
    return () => {
      document.documentElement.classList.remove('landing-document')
      document.body.classList.remove('landing-document')
    }
  }, [])

  return (
    <div className="terra-landing landing-scroll" data-paused={paused || Boolean(reduce)}>
      <header className="terra-header">
        <div className="terra-container terra-header-inner">
          <Link to="/" className="terra-brand" aria-label="YatTerra 首页"><span className="terra-brand-mark"><Orbit size={24} /></span><span>YatTerra<small>INFRASTRUCTURE, RECONNECTED.</small></span></Link>
          <nav aria-label="公开页面导航"><a href="#thesis">为什么现在</a><a href="#why">断层</a><a href="#layers">怎么工作</a><a href="#scenarios">场景</a></nav>
          <Link to="/login" className="terra-header-login">进入控制台 <ArrowRight size={15} /></Link>
        </div>
      </header>
      <main id="terra-main" className="terra-main">
        <section className="terra-hero">
          <div className="terra-hero-grid" aria-hidden="true" />
          <div className="terra-container terra-hero-layout">
            <div className="terra-hero-copy">
              <Reveal><div className="terra-eyebrow"><span className="terra-status-dot" /> BUILT FOR THE REAL WORLD</div></Reveal>
              <Reveal delay={.06}><h1>更高级的生产力，<br /><span className="terra-heading-accent">应该属于每一个人。</span></h1></Reveal>
              <Reveal delay={.12}><p className="terra-hero-description">每一代基础设施，都把曾经只属于少数人的能力交还给日常生活。AI 已经可以被调用，下一步是让更多人拥有把它变成作品、并让作品持续运行的条件。</p></Reveal>
              <Reveal delay={.18}><div className="terra-actions"><Link to="/login" className="terra-button terra-button-primary">进入 YatTerra <ArrowRight size={17} /></Link><a href="#thesis" className="terra-button terra-button-secondary">理解这件事 <ArrowDown size={16} /></a></div></Reveal>
              <Reveal delay={.24}><div className="terra-promises"><span><Check size={14} />普惠性的技术基础设施</span><span><Check size={14} />公有云与私有云之间</span></div></Reveal>
            </div>
            <Reveal delay={.12} className="terra-hero-visual"><NetworkIllustration /></Reveal>
          </div>
          <div className="terra-container terra-hero-bottom"><span>从少数人的机器，到每个人的基础设施。</span><div><span>PRODUCTION POWER</span><span className="terra-bottom-line" /><span>EVERYWHERE</span></div><button type="button" className="terra-motion-toggle" aria-pressed={paused || Boolean(reduce)} disabled={Boolean(reduce)} onClick={() => setPaused(value => !value)}>{paused || reduce ? <Play size={12} /> : <Pause size={12} />}{reduce ? '已减少动态' : paused ? '播放动效' : '暂停动效'}</button></div>
        </section>

        <section id="thesis" className="terra-section terra-section-tinted terra-thesis-section">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">00 — THE LONG ARC</p><h2>每一次普及，<br /><span>都始于一层新的基础设施。</span></h2></div><p>蒸汽动力改变生产，电网改变能源，网络与云改变计算。它们做的不是替人创造，而是让创造不必先获得一座工厂、一张电网或一间机房。</p></div></Reveal>
            <Reveal><InfrastructureArc /></Reveal>
            <Reveal><div className="terra-thesis-note"><span className="terra-thesis-mark">→</span><p>AI 的问题不再只是“能不能用”，而是“谁能把它变成自己的东西”。<strong>YatTerra 连接设备、组织节点、承载应用，让创造拥有持续运行的地方。</strong></p></div></Reveal>
          </div>
        </section>

        <section className="terra-section terra-explorer-section">
          <div className="terra-container">
            <Reveal><StartingPointExplorer paused={paused || Boolean(reduce)} /></Reveal>
          </div>
        </section>

        <section id="why" className="terra-section terra-section-tinted">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">01 — THE MISSING LAYER</p><h2>AI 正在走向每一个人，<br /><span>基础设施却没有跟上。</span></h2></div><p>传统公有云主要服务企业、政府、医院和研究机构，解决的是“非计算机专业客户如何不必考虑运维”。但 AI 时代的创新正在不可逆地碎片化、个人化。</p></div></Reveal>
            <div className="terra-constraint-grid">{constraints.map((item, index) => <Reveal key={item.title} delay={index * .06}><article className="terra-constraint"><div className="terra-constraint-heading"><item.icon size={23} /><span>{item.label}</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="terra-constraint-path">{item.detail}</div></article></Reveal>)}</div>
            <Reveal><div className="terra-gap-callout"><div><span className="terra-eyebrow">THE GAP</span><h3>云很贵，设备却在内网吃灰。</h3></div><GapIllustration paused={paused || Boolean(reduce)} /><p>OPC、初创公司、小实验室、兴趣团体与家庭用户正在遍地出现，却没有与他们的规模、预算和现实资源相匹配的云基础设施。</p></div></Reveal>
          </div>
        </section>

        <section id="layers" className="terra-section">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">02 — ONE COHERENT FABRIC</p><h2>不是把云做小，<br /><span>而是把基础设施做普惠。</span></h2></div><p>YatTerra 把连接、编排、AI 与运维组织成一层统一的技术土壤，让真实设备也能拥有平台化的可靠性。</p></div></Reveal>
            <Reveal><Architecture /></Reveal>
            <Reveal><div className="terra-workflow"><div className="terra-workflow-copy"><p className="terra-eyebrow">FROM IDEA TO SERVICE</p><h3>给想法一条<br />完整的落地路径。</h3><p>从代码、容器到模型服务，<br />把日常开发接进同一套基础设施。</p><div className="terra-tags"><span>开发</span><ArrowRight size={14} /><span>部署</span><ArrowRight size={14} /><span>运行</span></div></div><WorkflowIllustration /></div></Reveal>
          </div>
        </section>

        <section className="terra-section terra-section-tinted">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">03 — A THIRD PATH</p><h2>不替代公有云，<br /><span>也不鼓励复杂自建。</span></h2></div><p>公有云解决的是托管与规模，私有云解决的是控制与成本。YatTerra 在两者之间做 tradeoff：连接真实设备，复用平台能力，把可靠性带给更小、更分散的创造者。</p></div></Reveal>
            <Reveal><div className="terra-choice-grid">
              <article className="terra-choice"><span className="terra-choice-index">01 / PUBLIC CLOUD</span><Globe2 size={30} /><h3>公有云</h3><p>能力完整、弹性强，默认用户拥有企业级预算、规模与运维需求。</p><div className="terra-choice-foot">规模化供给 · 长期账单</div></article>
              <article className="terra-choice terra-choice-featured"><span className="terra-choice-index">02 / THE MISSING MIDDLE</span><Orbit size={32} /><h3>YatTerra</h3><p>让内网设备、闲置算力与本地数据成为可靠服务，同时获得连接、编排和运维能力。</p><div className="terra-choice-foot"><Check size={14} /> 更低门槛 · 平台级可靠性</div></article>
              <article className="terra-choice"><span className="terra-choice-index">03 / PRIVATE CLOUD</span><Wrench size={29} /><h3>私有云 / 下云</h3><p>控制权更强，但需要自行承担网络、机房、集群与长期运维的全部复杂度。</p><div className="terra-choice-foot">自主控制 · 运维负担</div></article>
            </div></Reveal>
          </div>
        </section>

        <section id="scenarios" className="terra-section">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">04 — MANY PLACES, ONE PLATFORM</p><h2>创新会发生在任何地方，<br /><span>基础设施也应该在那里。</span></h2></div><p>校园、家庭、工作室、实验室与小团队，只是不同的起点。底层需要的是同一条连接资源、模型与人的路径。</p></div></Reveal>
            <div className="terra-scenario-grid">{scenarios.map((item, index) => <Reveal key={item.title} delay={index * .06}><article className="terra-scenario"><div className="terra-scenario-label">{item.label}<span>↗</span></div><ScenarioIllustration index={index} /><div className="terra-scenario-copy"><h3>{item.title}</h3><p>{item.description}</p><div className="terra-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div></div></article></Reveal>)}</div>
          </div>
        </section>

        <section className="terra-closing">
          <div className="terra-container">
            <Reveal><div className="terra-closing-symbol" aria-hidden="true"><span /><span /><Orbit size={40} /></div><p className="terra-eyebrow">YATTERRA — THE SOIL FOR AI</p><h2>让每一个想法，<br /><span>都能拥有自己的基础设施。</span></h2><p className="terra-closing-description">Yat 来自 Sun Yat-sen University。Terra 是大地，是土壤，也是让万物生长的基础。我们不替代云，我们让更多创造拥有可以扎根的土壤。</p><Link to="/login" className="terra-button terra-button-primary">进入 YatTerra <ArrowRight size={17} /></Link></Reveal>
          </div>
        </section>
      </main>
      <footer className="terra-footer terra-container"><Link to="/" className="terra-brand"><Orbit size={21} /> YatTerra</Link><span>为真实世界构建的 AI-native 基础设施</span><span>© {new Date().getFullYear()} YatTerra</span></footer>
    </div>
  )
}
