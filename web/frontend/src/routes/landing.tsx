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

function StartingPointExplorer() {
  const [activeKey, setActiveKey] = useState(startingPoints[0]!.key)
  const active = startingPoints.find(item => item.key === activeKey) ?? startingPoints[0]!
  return (
    <div className="terra-explorer">
      <div className="terra-explorer-top"><div><p className="terra-eyebrow">TRY THE IDEA</p><h3>你从哪里开始？</h3></div><span className="terra-explorer-status"><span /> SYSTEM READY</span></div>
      <div className="terra-explorer-tabs" role="tablist" aria-label="选择基础设施起点">
        {startingPoints.map(item => <button key={item.key} type="button" role="tab" aria-selected={activeKey === item.key} className={activeKey === item.key ? 'is-active' : ''} onClick={() => setActiveKey(item.key)}>{item.label}<small>{item.eyebrow}</small></button>)}
      </div>
      <div className="terra-explorer-body">
        <div className="terra-explorer-copy"><h4>{active.title}</h4><p>{active.text}</p><div className="terra-explorer-nodes">{active.nodes.map((node, index) => <span key={node}><b style={{ backgroundColor: active.accent }} />{node}{index < active.nodes.length - 1 && <ArrowRight size={13} />}</span>)}</div></div>
        <StartingPointDiagram kind={active.key} />
      </div>
    </div>
  )
}

function GapIllustration() {
  return <svg className="terra-gap-art" viewBox="0 0 430 190" fill="none" role="img" aria-label="昂贵云资源和闲置内网设备之间缺少适配基础设施的示意图">
    <path d="M42 135H388" stroke="#56727f" strokeOpacity=".22" strokeDasharray="4 8" />
    <g transform="translate(24 42)">
      <rect width="112" height="86" rx="14" fill="#2a2430" stroke="#f6c889" strokeOpacity=".65" />
      <path d="M29 34c6-14 18-21 34-21 19 0 30 11 32 30 12 3 18 11 18 23 0 15-11 24-30 24H30C12 90 0 81 0 66c0-13 8-22 22-25 1-2 3-5 7-7Z" transform="translate(13 -5)" fill="#3b2d32" stroke="#f6c889" strokeOpacity=".6" />
      <text x="56" y="56" textAnchor="middle" fill="#f6d7ab" fontSize="13" fontWeight="600">Cloud</text>
      <text x="56" y="74" textAnchor="middle" fill="#b89b7b" fontSize="10">￥￥￥ / month</text>
      <path d="M31 108h50" stroke="#f6c889" strokeOpacity=".55" />
      <text x="56" y="126" textAnchor="middle" fill="#9d8370" fontSize="10">超出小团队预算</text>
    </g>
    <g transform="translate(162 48)">
      <path d="M22 38h42m22 0h42" stroke="#789198" strokeOpacity=".38" strokeDasharray="5 7" />
      <path d="M66 23 82 38 66 53" stroke="#789198" strokeOpacity=".5" />
      <path d="M65 55 84 22" stroke="#f6c889" strokeWidth="2" strokeLinecap="round" />
      <rect x="0" y="12" width="55" height="52" rx="10" fill="#102433" stroke="#67e8d0" strokeOpacity=".6" />
      <path d="M13 29h27m-27 10h20" stroke="#67e8d0" strokeOpacity=".7" />
      <circle cx="43" cy="22" r="3" fill="#67e8d0" className="terra-light" />
      <rect x="98" y="12" width="55" height="52" rx="10" fill="#102433" stroke="#67e8d0" strokeOpacity=".6" />
      <path d="M111 29h27m-27 10h20" stroke="#67e8d0" strokeOpacity=".7" />
      <circle cx="141" cy="22" r="3" fill="#67e8d0" className="terra-light" style={{ animationDelay: '-.8s' }} />
      <text x="76" y="93" textAnchor="middle" fill="#89a2ab" fontSize="10">设备在内网</text>
    </g>
    <g transform="translate(292 40)">
      <rect width="114" height="92" rx="18" fill="#102b37" stroke="#9aebd2" strokeOpacity=".7" />
      <circle cx="57" cy="40" r="23" fill="#9aebd2" fillOpacity=".08" stroke="#9aebd2" strokeOpacity=".65" />
      <path d="M45 40h24M57 28v24" stroke="#9aebd2" strokeWidth="2" strokeLinecap="round" />
      <text x="57" y="77" textAnchor="middle" fill="#d5fff1" fontSize="13" fontWeight="600">YatTerra</text>
      <text x="57" y="112" textAnchor="middle" fill="#8dbab1" fontSize="10">连接 · 编排 · 运行</text>
    </g>
    <path d="M112 93C156 123 225 123 313 92" stroke="#9aebd2" strokeOpacity=".38" strokeDasharray="5 8" />
    <motion.circle r="4" fill="#9aebd2" animate={{ cx: [112, 210, 313], cy: [93, 124, 92], opacity: [0, 1, 0] }} transition={{ duration: 2.9, repeat: Infinity, ease: 'easeInOut' }} />
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
              <Reveal delay={.12}><p className="terra-hero-description">技术突破创造新的能力，基础设施让更多人用得上它。今天，模型越来越容易获取；让自己的 AI 应用持续运行，仍需要连接、算力与运维。</p></Reveal>
              <Reveal delay={.18}><div className="terra-actions"><Link to="/login" className="terra-button terra-button-primary">进入 YatTerra <ArrowRight size={17} /></Link><a href="#thesis" className="terra-button terra-button-secondary">理解这件事 <ArrowDown size={16} /></a></div></Reveal>
              <Reveal delay={.24}><div className="terra-promises"><span><Check size={14} />普惠性的技术基础设施</span><span><Check size={14} />公有云与私有云之间</span></div></Reveal>
            </div>
            <Reveal delay={.12} className="terra-hero-visual"><NetworkIllustration /></Reveal>
          </div>
          <div className="terra-container terra-hero-bottom"><span>从少数人的机器，到每个人的基础设施。</span><div><span>PRODUCTION POWER</span><span className="terra-bottom-line" /><span>EVERYWHERE</span></div><button type="button" className="terra-motion-toggle" aria-pressed={paused || Boolean(reduce)} disabled={Boolean(reduce)} onClick={() => setPaused(value => !value)}>{paused || reduce ? <Play size={12} /> : <Pause size={12} />}{reduce ? '已减少动态' : paused ? '播放动效' : '暂停动效'}</button></div>
        </section>

        <section id="thesis" className="terra-section terra-section-tinted terra-thesis-section">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">00 — THE LONG ARC</p><h2>世界一直在做同一件事：<br /><span>把生产力带到日常生活。</span></h2></div><p>从动力到能源，再到计算，普及的关键不只是发明本身，更是把能力组织成可接入、可使用的基础设施。</p></div></Reveal>
            <Reveal><InfrastructureArc /></Reveal>
            <Reveal><div className="terra-thesis-note"><span className="terra-thesis-mark">→</span><p>下一步，让分散的算力成为可用的基础设施。<strong>YatTerra 连接设备、组织节点、承载应用，让更多创造者拥有持续运行 AI 的环境。</strong></p></div></Reveal>
          </div>
        </section>

        <section className="terra-section terra-explorer-section">
          <div className="terra-container">
            <Reveal><StartingPointExplorer /></Reveal>
          </div>
        </section>

        <section id="why" className="terra-section terra-section-tinted">
          <div className="terra-container">
            <Reveal><div className="terra-section-intro"><div><p className="terra-eyebrow">01 — THE MISSING LAYER</p><h2>AI 正在走向每一个人，<br /><span>基础设施却没有跟上。</span></h2></div><p>传统公有云主要服务企业、政府、医院和研究机构，解决的是“非计算机专业客户如何不必考虑运维”。但 AI 时代的创新正在不可逆地碎片化、个人化。</p></div></Reveal>
            <div className="terra-constraint-grid">{constraints.map((item, index) => <Reveal key={item.title} delay={index * .06}><article className="terra-constraint"><div className="terra-constraint-heading"><item.icon size={23} /><span>{item.label}</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="terra-constraint-path">{item.detail}</div></article></Reveal>)}</div>
            <Reveal><div className="terra-gap-callout"><div><span className="terra-eyebrow">THE GAP</span><h3>云很贵，设备却在内网吃灰。</h3></div><GapIllustration /><p>OPC、初创公司、小实验室、兴趣团体与家庭用户正在遍地出现，却没有与他们的规模、预算和现实资源相匹配的云基础设施。</p></div></Reveal>
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
