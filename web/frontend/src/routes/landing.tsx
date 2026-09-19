import { motion, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router'
import {
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  Cpu,
  Globe2,
  Home,
  Network,
  Orbit,
  School,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react'

const constraints = [
  {
    icon: <Globe2 size={21} />,
    eyebrow: '连接受限',
    title: '服务在内网，访问却在公网',
    description: '校园网、家庭宽带和实验室网络往往没有稳定的入站路径。设备能运行，不代表服务能被可靠地使用。',
  },
  {
    icon: <Cpu size={21} />,
    eyebrow: '资源分散',
    title: '一块 GPU，也值得被好好编排',
    description: 'AI 资源常常来自不同地点、不同设备。没有统一的编排和权限，算力很快变成一组难以协作的孤岛。',
  },
  {
    icon: <Wrench size={21} />,
    eyebrow: '维护复杂',
    title: '云账单与全链路自建之间',
    description: '把一切交给云端成本不低，从网络、集群到监控全部自建又需要长期维护。很多团队需要的是中间的选择。',
  },
]

const layers = [
  {
    number: '01',
    icon: <Network size={20} />,
    title: '连接层',
    label: '从受限网络出发',
    description: '通过内网穿透和统一入口，让本地设备拥有清晰、可控的访问路径，而不是把每个服务直接暴露在公网。',
    color: 'from-cyan-300 to-blue-500',
  },
  {
    number: '02',
    icon: <Boxes size={20} />,
    title: '编排层',
    label: '把设备组织成平台',
    description: '以 Kubernetes / K3s 统一承载工作负载、网络和生命周期，让零散的机器也能按服务被管理。',
    color: 'from-blue-400 to-violet-500',
  },
  {
    number: '03',
    icon: <Sparkles size={20} />,
    title: 'AI 层',
    label: '让模型成为基础设施的一部分',
    description: '把 GPU、模型、Agent 与 MCP 工具放进同一个可协作的运行环境，给 AI 应用一条稳定的落地路径。',
    color: 'from-violet-400 to-fuchsia-500',
  },
  {
    number: '04',
    icon: <ShieldCheck size={20} />,
    title: '运维层',
    label: '把复杂度留在平台内部',
    description: '权限、观测、审计与共享能力围绕工作负载组织，减少每个项目重复搭建基础能力的成本。',
    color: 'from-fuchsia-400 to-orange-400',
  },
]

const scenarios = [
  {
    icon: <School size={22} />,
    title: '学校与校园实验室',
    description: '为课程、研究和共享 GPU 提供统一的访问与权限边界，让设备资源服务更多人。',
  },
  {
    icon: <Home size={22} />,
    title: '家庭与个人工作室',
    description: '把家中的计算资源接入自己的 AI 工作流，不必为每个服务单独解决公网暴露问题。',
  },
  {
    icon: <TerminalSquare size={22} />,
    title: '小团队与研究项目',
    description: '在保留本地控制权的同时，获得接近平台化的编排、协作和运维体验。',
  },
]

const particles: Array<[number, number, number, number]> = [
  [8, 19, 2, 0], [17, 78, 1, 1.2], [26, 33, 2, 0.4], [34, 88, 1, 2],
  [44, 14, 1, 1.6], [52, 69, 2, 0.8], [61, 27, 1, 2.4], [70, 84, 2, 1.1],
  [78, 16, 1, 0.5], [88, 52, 2, 1.9], [94, 28, 1, 2.8], [91, 91, 1, 0.9],
]

function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 22 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.65, delay: reduceMotion ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

function AmbientField() {
  const reduceMotion = useReducedMotion()
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgba(34,211,238,.14),transparent_27%),radial-gradient(circle_at_83%_13%,rgba(139,92,246,.2),transparent_32%),linear-gradient(145deg,#070b17_0%,#0b1225_53%,#101025_100%)]" />
      <motion.div
        className="absolute -left-[12%] top-[7%] h-[520px] w-[520px] rounded-full bg-cyan-400/[0.07] blur-3xl"
        animate={reduceMotion ? undefined : { x: [0, 50, 0], y: [0, 28, 0], scale: [1, 1.08, 1] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -right-[16%] top-[18%] h-[620px] w-[620px] rounded-full bg-violet-500/[0.08] blur-3xl"
        animate={reduceMotion ? undefined : { x: [0, -45, 0], y: [0, -32, 0], scale: [1.05, 1, 1.05] }}
        transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute inset-x-0 top-0 h-[600px] opacity-[0.17] [mask-image:linear-gradient(to_bottom,black,transparent)]" style={{ backgroundImage: 'linear-gradient(rgba(148,163,184,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.16) 1px, transparent 1px)', backgroundSize: '56px 56px' }} />
      {particles.map(([left, top, size, delay], index) => (
        <motion.span
          key={index}
          className="absolute rounded-full bg-cyan-200/70 shadow-[0_0_12px_rgba(103,232,249,.75)]"
          style={{ left: `${left}%`, top: `${top}%`, width: size * 2, height: size * 2 }}
          animate={reduceMotion ? undefined : { opacity: [0.15, 0.8, 0.15], y: [0, -12, 0] }}
          transition={{ duration: 3.5 + delay, delay, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
    </div>
  )
}

function NetworkIllustration() {
  const reduceMotion = useReducedMotion()
  return (
    <div className="relative mx-auto h-[340px] w-full max-w-[560px] overflow-hidden rounded-[30px] border border-white/10 bg-slate-950/40 shadow-2xl shadow-blue-950/50 backdrop-blur-sm sm:h-[410px]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(96,165,250,.15),transparent_35%)]" />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 560 410" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="networkLineA" x1="80" y1="110" x2="478" y2="145" gradientUnits="userSpaceOnUse"><stop stopColor="#22d3ee" stopOpacity=".15" /><stop offset=".48" stopColor="#60a5fa" /><stop offset="1" stopColor="#c084fc" stopOpacity=".25" /></linearGradient>
          <linearGradient id="networkLineB" x1="80" y1="300" x2="478" y2="250" gradientUnits="userSpaceOnUse"><stop stopColor="#22d3ee" stopOpacity=".18" /><stop offset=".52" stopColor="#a78bfa" /><stop offset="1" stopColor="#fb923c" stopOpacity=".25" /></linearGradient>
          <filter id="nodeGlow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <path d="M94 113C165 157 172 221 278 205C362 192 366 116 466 142" stroke="url(#networkLineA)" strokeWidth="1.5" strokeDasharray="5 9" />
        <path d="M95 294C174 255 180 203 278 205C363 207 383 273 472 250" stroke="url(#networkLineB)" strokeWidth="1.5" strokeDasharray="5 9" />
        <path d="M278 205V96" stroke="#8b5cf6" strokeOpacity=".55" strokeWidth="1.5" strokeDasharray="4 8" />
        <path d="M278 205V342" stroke="#22d3ee" strokeOpacity=".3" strokeWidth="1.5" strokeDasharray="4 8" />
        <circle cx="278" cy="205" r="78" stroke="#60a5fa" strokeOpacity=".11" strokeWidth="1" />
        <circle cx="278" cy="205" r="112" stroke="#a78bfa" strokeOpacity=".09" strokeWidth="1" strokeDasharray="2 9" />
        <motion.circle cx="278" cy="205" r="4" fill="#67e8f9" filter="url(#nodeGlow)" animate={reduceMotion ? undefined : { r: [3, 7, 3], opacity: [0.55, 1, 0.55] }} transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }} />
        <motion.circle cx="278" cy="205" r="112" stroke="#c4b5fd" strokeOpacity=".4" strokeWidth="1" strokeDasharray="2 18" animate={reduceMotion ? undefined : { rotate: 360 }} transition={{ duration: 22, repeat: Infinity, ease: 'linear' }} style={{ transformOrigin: '278px 205px' }} />
        <motion.circle r="4" fill="#a5f3fc" animate={reduceMotion ? undefined : { cx: [94, 278, 466, 278, 94], cy: [113, 205, 142, 205, 113], opacity: [0, 1, 1, 1, 0] }} transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} />
        <motion.circle r="4" fill="#f0abfc" animate={reduceMotion ? undefined : { cx: [95, 278, 472, 278, 95], cy: [294, 205, 250, 205, 294], opacity: [0, 1, 1, 1, 0] }} transition={{ duration: 7, delay: 1.4, repeat: Infinity, ease: 'linear' }} />
      </svg>
      <div className="absolute left-[7%] top-[22%] flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-slate-950/80 px-3 py-2 text-xs text-cyan-100 shadow-lg shadow-cyan-950/20"><span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_10px_#67e8f9]" />校园网</div>
      <div className="absolute bottom-[20%] left-[8%] flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-slate-950/80 px-3 py-2 text-xs text-cyan-100 shadow-lg shadow-cyan-950/20"><span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_10px_#67e8f9]" />家庭节点</div>
      <motion.div className="absolute left-1/2 top-1/2 flex h-[92px] w-[92px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[28px] border border-blue-300/40 bg-blue-400/15 text-blue-100 shadow-[0_0_50px_rgba(96,165,250,.28)]" animate={reduceMotion ? undefined : { boxShadow: ['0 0 34px rgba(96,165,250,.18)', '0 0 70px rgba(167,139,250,.42)', '0 0 34px rgba(96,165,250,.18)'] }} transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}><Orbit size={35} /></motion.div>
      <div className="absolute right-[8%] top-[27%] flex items-center gap-2 rounded-2xl border border-violet-300/20 bg-slate-950/80 px-3 py-2 text-xs text-violet-100 shadow-lg shadow-violet-950/20"><span className="h-2 w-2 rounded-full bg-violet-300 shadow-[0_0_10px_#c4b5fd]" />K3s 集群</div>
      <div className="absolute bottom-[25%] right-[7%] flex items-center gap-2 rounded-2xl border border-orange-300/20 bg-slate-950/80 px-3 py-2 text-xs text-orange-100 shadow-lg shadow-orange-950/20"><span className="h-2 w-2 rounded-full bg-orange-300 shadow-[0_0_10px_#fdba74]" />AI 工作负载</div>
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] uppercase tracking-[0.28em] text-slate-400">one fabric · many places</div>
    </div>
  )
}

function FabricDiagram() {
  const reduceMotion = useReducedMotion()
  return (
    <div className="relative overflow-hidden rounded-[32px] border border-white/[0.1] bg-[#0b1327] p-5 shadow-2xl shadow-blue-950/20 sm:p-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(59,130,246,.13),transparent_42%)]" />
      <div className="relative flex flex-col gap-7 sm:gap-9">
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500"><span>local resources</span><span>one coherent fabric</span><span>ai workloads</span></div>
        <svg className="h-[170px] w-full" viewBox="0 0 900 170" fill="none" aria-hidden="true">
          <defs><linearGradient id="fabricLine" x1="100" y1="85" x2="800" y2="85" gradientUnits="userSpaceOnUse"><stop stopColor="#22d3ee" /><stop offset=".5" stopColor="#818cf8" /><stop offset="1" stopColor="#f0abfc" /></linearGradient></defs>
          <path d="M100 85H800" stroke="url(#fabricLine)" strokeOpacity=".22" strokeWidth="2" strokeDasharray="4 10" />
          <path d="M200 45C320 45 310 125 450 125C590 125 580 45 700 45" stroke="url(#fabricLine)" strokeOpacity=".35" strokeWidth="1.5" />
          <path d="M200 125C320 125 310 45 450 45C590 45 580 125 700 125" stroke="url(#fabricLine)" strokeOpacity=".35" strokeWidth="1.5" />
          {[200, 450, 700].map((x, index) => <g key={x}><circle cx={x} cy="85" r={index === 1 ? 28 : 18} fill={index === 1 ? '#312e81' : '#0e7490'} fillOpacity=".35" stroke={index === 1 ? '#a5b4fc' : '#67e8f9'} strokeOpacity=".7" /><circle cx={x} cy="85" r={index === 1 ? 7 : 5} fill={index === 1 ? '#ddd6fe' : '#a5f3fc'} /></g>)}
          <motion.circle r="4" fill="#fff" animate={reduceMotion ? undefined : { cx: [200, 450, 700, 450, 200], cy: [85, 85, 85, 85, 85], opacity: [0, 1, 1, 1, 0] }} transition={{ duration: 5, repeat: Infinity, ease: 'linear' }} />
        </svg>
        <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-2xl border border-cyan-200/10 bg-cyan-300/[0.05] p-4"><p className="text-xs font-semibold text-cyan-100">连接</p><p className="mt-2 text-xs leading-6 text-slate-400">穿过网络边界，保持访问可控。</p></div><div className="rounded-2xl border border-indigo-200/10 bg-indigo-300/[0.05] p-4"><p className="text-xs font-semibold text-indigo-100">编排</p><p className="mt-2 text-xs leading-6 text-slate-400">把分散设备变成统一资源。</p></div><div className="rounded-2xl border border-fuchsia-200/10 bg-fuchsia-300/[0.05] p-4"><p className="text-xs font-semibold text-fuchsia-100">运行</p><p className="mt-2 text-xs leading-6 text-slate-400">让模型和 Agent 持续工作。</p></div></div>
      </div>
    </div>
  )
}

export default function Landing() {
  return (
    <div className="min-h-screen overflow-y-auto bg-[#070b17] text-slate-100 selection:bg-cyan-300/30">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#070b17]/75 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-10">
          <Link to="/" className="group flex items-center gap-3" aria-label="YatTerra 首页"><span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,.15)] transition-transform duration-300 group-hover:rotate-12"><Orbit size={19} /></span><span><span className="block text-[15px] font-bold tracking-[0.18em] text-white">YatTerra</span><span className="hidden text-[10px] tracking-[0.22em] text-slate-400 sm:block">AI-NATIVE INFRASTRUCTURE</span></span></Link>
          <nav className="hidden items-center gap-8 text-sm text-slate-400 md:flex" aria-label="公开页面导航"><a href="#why" className="transition-colors hover:text-white">为什么</a><a href="#layers" className="transition-colors hover:text-white">怎么工作</a><a href="#scenarios" className="transition-colors hover:text-white">适用场景</a></nav>
          <Link to="/login" className="inline-flex min-h-10 items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-300/10 px-4 text-sm font-semibold text-cyan-100 transition duration-200 hover:border-cyan-200/60 hover:bg-cyan-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">登录 <ArrowRight size={15} /></Link>
        </div>
      </header>

      <main>
        <section className="relative isolate overflow-hidden px-5 pb-20 pt-36 sm:px-8 sm:pb-28 sm:pt-44 lg:px-10 lg:pt-48"><AmbientField /><div className="relative mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-[1.04fr_.96fr] lg:gap-16"><div><motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .6 }} className="mb-7 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200/80"><span className="h-px w-8 bg-cyan-300/70" />AI-native infrastructure</motion.div><motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .7, delay: .08 }} className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.045em] text-white sm:text-6xl lg:text-[4.65rem]">让受限网络里的<br /><span className="bg-gradient-to-r from-cyan-200 via-blue-300 to-violet-300 bg-clip-text text-transparent">AI 基础设施</span>，也能可靠地运行。</motion.h1><motion.p initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .7, delay: .16 }} className="mt-7 max-w-xl text-base leading-8 text-slate-300 sm:text-lg">YatTerra 把内网穿透、Kubernetes 与 AI 工作负载整合在一起，为学校、家庭和小型实验室提供一条不依赖单一云厂商的基础设施路径。</motion.p><motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .7, delay: .24 }} className="mt-9 flex flex-wrap items-center gap-3"><Link to="/login" className="group inline-flex min-h-12 items-center gap-2 rounded-full bg-cyan-200 px-6 text-sm font-bold text-slate-950 shadow-[0_0_30px_rgba(103,232,249,.18)] transition duration-200 hover:bg-cyan-100 hover:shadow-[0_0_42px_rgba(103,232,249,.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">进入控制台 <ArrowRight size={17} className="transition-transform duration-200 group-hover:translate-x-1" /></Link><a href="#why" className="inline-flex min-h-12 items-center gap-2 rounded-full border border-white/15 px-6 text-sm font-semibold text-slate-200 transition-colors duration-200 hover:border-white/35 hover:bg-white/[0.06]">了解 YatTerra <ChevronDown size={16} /></a></motion.div><div className="mt-12 flex flex-wrap gap-x-7 gap-y-3 text-xs text-slate-500"><span className="flex items-center gap-2"><Check size={14} className="text-cyan-300" />保留本地资源控制权</span><span className="flex items-center gap-2"><Check size={14} className="text-cyan-300" />减少重复运维工作</span></div></div><motion.div initial={{ opacity: 0, scale: .96, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: .9, delay: .2 }}><NetworkIllustration /></motion.div></div></section>

        <section id="why" className="scroll-mt-24 border-t border-white/[0.07] bg-[#0a1020] px-5 py-24 sm:px-8 sm:py-32 lg:px-10"><div className="mx-auto max-w-7xl"><Reveal><p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">The starting point</p><h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl">不是每个 AI 项目，<br /><span className="text-slate-400">都从一朵云开始。</span></h2><p className="mt-6 max-w-2xl text-base leading-8 text-slate-400">真实的算力往往已经存在：一台工作站、一组校园设备、一个家庭实验室。难的是让它们安全地连接、稳定地运行，并被更多人真正使用。</p></Reveal><div className="mt-14 grid gap-4 md:grid-cols-3">{constraints.map((item, index) => <Reveal key={item.title} delay={index * .08} className="h-full"><motion.article whileHover={{ y: -6 }} transition={{ duration: .2, ease: [0.23, 1, 0.32, 1] }} className="group h-full rounded-3xl border border-white/[0.09] bg-white/[0.035] p-7 transition-colors duration-300 hover:border-cyan-200/25 hover:bg-white/[0.06]"><div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-200/20 bg-cyan-300/10 text-cyan-200 transition-transform duration-300 group-hover:rotate-6 group-hover:scale-105">{item.icon}</div><p className="mt-8 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">{item.eyebrow}</p><h3 className="mt-3 text-xl font-semibold leading-snug text-white">{item.title}</h3><p className="mt-4 text-sm leading-7 text-slate-400">{item.description}</p></motion.article></Reveal>)}</div></div></section>

        <section id="layers" className="scroll-mt-24 border-t border-white/[0.07] bg-[#070b17] px-5 py-24 sm:px-8 sm:py-32 lg:px-10"><div className="mx-auto max-w-7xl"><Reveal><div className="max-w-2xl"><p className="text-xs font-semibold uppercase tracking-[0.28em] text-violet-300/80">One coherent fabric</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl">把“能跑”变成<br /><span className="text-slate-400">“能被持续使用”。</span></h2><p className="mt-6 text-base leading-8 text-slate-400">YatTerra 不是把技术名词堆在一起，而是把每一层基础能力接起来：从网络边界，到集群调度，再到 AI 应用和日常运维。</p></div></Reveal><div className="mt-14"><Reveal><FabricDiagram /></Reveal></div><div className="relative mt-6 grid gap-4 md:grid-cols-2">{layers.map((layer, index) => <Reveal key={layer.number} delay={index * .07} className="h-full"><motion.article whileHover={{ y: -5 }} transition={{ duration: .2, ease: [0.23, 1, 0.32, 1] }} className="relative h-full overflow-hidden rounded-3xl border border-white/[0.09] bg-[#0d1427] p-7"><div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${layer.color}`} /><div className="flex items-start justify-between"><div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/[0.07] text-slate-200">{layer.icon}</div><span className="font-mono text-xs tracking-[0.2em] text-slate-600">{layer.number}</span></div><p className="mt-8 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{layer.label}</p><h3 className="mt-2 text-2xl font-semibold text-white">{layer.title}</h3><p className="mt-4 max-w-lg text-sm leading-7 text-slate-400">{layer.description}</p></motion.article></Reveal>)}</div></div></section>

        <section className="border-t border-white/[0.07] bg-[#0a1020] px-5 py-24 sm:px-8 sm:py-32 lg:px-10"><div className="mx-auto max-w-7xl"><Reveal><div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr] lg:items-start"><div><p className="text-xs font-semibold uppercase tracking-[0.28em] text-orange-300/80">A third path</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl">不是云，<br />也不是孤岛。</h2><p className="mt-6 text-base leading-8 text-slate-400">YatTerra 让基础设施的选择不再只有两端。你可以继续使用手边的设备，同时把连接、编排和运维中最容易重复的部分交给平台。</p></div><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-6"><p className="text-xs font-semibold text-slate-500">大厂云服务</p><p className="mt-5 text-sm leading-7 text-slate-300">弹性很强，但持续账单、数据位置和资源闲置需要被认真管理。</p></div><div className="rounded-3xl border border-cyan-200/25 bg-cyan-300/[0.07] p-6 shadow-[0_0_35px_rgba(34,211,238,.07)]"><p className="text-xs font-semibold text-cyan-200">YatTerra</p><p className="mt-5 text-sm leading-7 text-slate-200">保留本地资源与控制权，减少公网接入、部署编排和重复维护的摩擦。</p></div><div className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-6"><p className="text-xs font-semibold text-slate-500">全链路自建</p><p className="mt-5 text-sm leading-7 text-slate-300">自由度很高，但网络、集群、权限、监控与可靠性都要长期自己负责。</p></div></div></div></Reveal></div></section>

        <section id="scenarios" className="scroll-mt-24 border-t border-white/[0.07] bg-[#070b17] px-5 py-24 sm:px-8 sm:py-32 lg:px-10"><div className="mx-auto max-w-7xl"><Reveal><p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">Made for constrained places</p><h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl">从身边的设备开始，<br /><span className="text-slate-400">把 AI 带到真正需要它的地方。</span></h2></Reveal><div className="mt-14 grid gap-4 md:grid-cols-3">{scenarios.map((item, index) => <Reveal key={item.title} delay={index * .08}><motion.article whileHover={{ y: -6 }} transition={{ duration: .2, ease: [0.23, 1, 0.32, 1] }} className="group rounded-3xl border border-white/[0.09] bg-white/[0.035] p-7 transition-colors duration-300 hover:border-violet-200/25 hover:bg-white/[0.06]"><div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-violet-200/20 bg-violet-300/10 text-violet-200 transition-transform duration-300 group-hover:rotate-6">{item.icon}</div><h3 className="mt-7 text-xl font-semibold text-white">{item.title}</h3><p className="mt-4 text-sm leading-7 text-slate-400">{item.description}</p></motion.article></Reveal>)}</div></div></section>

        <section className="relative isolate overflow-hidden border-t border-white/[0.07] px-5 py-24 text-center sm:px-8 sm:py-32 lg:px-10"><div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_20%,rgba(59,130,246,.2),transparent_45%),#0a1020]" /><Reveal><Orbit className="mx-auto text-cyan-200" size={32} /><h2 className="mx-auto mt-7 max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">基础设施不应该成为<br /><span className="text-cyan-200">AI 想法的边界。</span></h2><p className="mx-auto mt-6 max-w-xl text-base leading-8 text-slate-400">公开首页讲述 YatTerra 的方向。真正的资源、部署和运维能力，留在登录后的控制台里。</p><Link to="/login" className="mt-9 inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-6 text-sm font-bold text-slate-950 transition-colors duration-200 hover:bg-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">登录控制台 <ArrowRight size={17} /></Link></Reveal></section>
      </main>

      <footer className="border-t border-white/[0.08] bg-[#070b17] px-5 py-8 sm:px-8 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col gap-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between"><span className="font-semibold tracking-[0.18em] text-slate-300">YatTerra</span><span>为受限场景构建的 AI-native 基础设施</span><span>© {new Date().getFullYear()} YatTerra</span></div></footer>
    </div>
  )
}
