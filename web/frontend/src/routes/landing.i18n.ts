import { useSyncExternalStore } from 'react'

/**
 * 首页(landing)三语支持:en / zh-CN / zh-HK(粤语书面语)。
 * 字典以 zh-CN 为基准形状,en 与 zh-HK 必须保持同构(数组长度一致)。
 * 切换即写 localStorage 并同步 document.documentElement.lang。
 */
export type Lang = 'en' | 'zh-CN' | 'zh-HK'

export const LANGS: { id: Lang; short: string; label: string }[] = [
  { id: 'en', short: 'EN', label: 'English' },
  { id: 'zh-CN', short: '简', label: '简体中文' },
  { id: 'zh-HK', short: '粤', label: '廣東話' },
]

const STORAGE_KEY = 'yatterra_landing_lang'

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'zh-CN' || saved === 'zh-HK') return saved
    const nav = navigator.language || ''
    if (/^zh-(HK|TW|MO)/i.test(nav)) return 'zh-HK'
    if (/^zh/i.test(nav)) return 'zh-CN'
    if (/^en/i.test(nav)) return 'en'
  } catch { /* SSR / privacy mode */ }
  return 'zh-CN'
}

let current: Lang = detect()
const listeners = new Set<() => void>()

export function setLandingLang(lang: Lang) {
  current = lang
  try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* ignore */ }
  document.documentElement.lang = lang
  listeners.forEach(fn => fn())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function useLandingLang(): Lang {
  return useSyncExternalStore(subscribe, () => current, () => current)
}

export function useLandingCopy() {
  return COPY[useLandingLang()]
}

/* ────────────────────────── zh-CN(基准) ────────────────────────── */

const zhCN = {
  htmlLang: 'zh-CN' as Lang,
  nav: { thesis: '为什么现在', why: '断层', layers: '怎么工作', scenarios: '场景', reports: '技术报告' },
  login: '进入控制台',
  loginPage: {
    eyebrow: 'AI infrastructure, reimagined',
    heroTitle: ['让每一个', '想法落地。'],
    heroDesc: '连接集群、模型与工作负载。YatTerra 将复杂的基础设施，收敛成一个清晰而可靠的控制面。',
    healthChecking: '检查中…',
    healthOk: '所有系统运行正常',
    healthError: '部分服务异常',
    secure: '安全连接 · 私有部署',
    cardTitle: '登录 YatTerra',
    cardDesc: '登录控制台，开始管理你的集群、模型与工作负载。',
    userLabel: '用户名',
    userPlaceholder: '输入用户名',
    passLabel: '密码',
    passPlaceholder: '输入密码',
    submit: '登录控制台',
    submitting: '正在验证...',
    guest: '先看看，不注册',
    guestHint: '以游客身份进入控制台，无需账号。',
    noAccount: '还没有账号？请联系管理员开通，或先用游客身份体验。',
    otherMethods: '其他登录方式',
    backHome: '返回 YatTerra 项目首页',
    errLogin: '登录失败',
    errGuest: '游客登录失败',
    oauth: {
      ssemarket: 'SSE Market 授权失败',
      unisso: 'UniSSO 授权失败',
      missing_params: 'OAuth 回调参数缺失',
      invalid_state: 'OAuth state 验证失败，请重试',
      no_token: '未获取到授权令牌',
      generic: '授权失败',
    },
  },
  brandAria: 'YatTerra 首页',
  hero: {
    eyebrow: 'BUILT FOR THE REAL WORLD',
    title: ['更高级的生产力，', '应该属于每一个人。'],
    description: '蒸汽机、电力、计算机，都曾经只属于少数组织，后来成为每个人日常生活的一部分。AI 正在完成下一次普惠，而它需要一层新的基础设施。',
    primary: '进入 YatTerra',
    secondary: '理解这件事',
    promises: ['普惠性的技术基础设施', '公有云与私有云之间'],
    bottom: '从少数人的机器，到每个人的基础设施。',
    motion: { reduced: '已减少动态', paused: '播放动效', playing: '暂停动效' },
  },
  thesis: {
    eyebrow: '00 — THE LONG ARC',
    lines: ['每一项能力成为基础设施，', '都要走完同一段路。'],
    desc: '从少数机构的专属能力，到每个人都能接上的公共设施。动力走完了，计算走完了，容量也走完了——智能的承载层，还没有。',
    noteLead: 'AI 的下一步，不只是让更多人调用模型。',
    noteStrong: '而是让更多人拥有承载模型、工作流与创造的基础设施。',
    arcAria: '每一项能力从少数机构专属走向每个人可用的阶梯图；承载智能的一级仍然缺失，由 YatTerra 补上',
    arcAxis: { scarce: '少数组织专属', universal: '每一个人' },
    steps: [
      { era: '1880s — 1900s', title: '动力', note: '工厂的蒸汽机 → 走进每个插座' },
      { era: '1970s — 2010s', title: '计算', note: '机构的大型机 → 口袋里的手机' },
      { era: '2006 — 2020s', title: '容量', note: '自建的机房 → 按需租用的云' },
      { era: 'NOW · 缺失的一级', title: '承载智能的一层', note: '模型人人可及，这一层还不是' },
    ],
    yatterraBox: { title: '把缺失的一级补上', note: '让承载智能的基础设施也普惠' },
    scale: { was: '曾经：少数机构的能力', goal: '目标：每个人都能接上' },
  },
  explorer: {
    title: '你从哪里开始？',
    status: 'SYSTEM READY',
    tabsAria: '选择基础设施起点',
    points: [
      { key: 'device' as const, label: '一台设备', eyebrow: 'START WITH A DEVICE', title: '让一台闲置设备，重新成为生产力。', text: '从工作站、家庭服务器或实验室 GPU 开始，不需要先拥有完整的数据中心。', nodes: ['本地 GPU', '内网服务', '你的项目'] },
      { key: 'network' as const, label: '一组节点', eyebrow: 'START WITH A NETWORK', title: '把分散的算力，组织成一个整体。', text: '不同地点、不同配置的设备，也可以共享连接、调度和运行能力。', nodes: ['校园节点', '家庭节点', '共享资源'] },
      { key: 'idea' as const, label: '一个想法', eyebrow: 'START WITH AN IDEA', title: '让一个想法拥有持续运行的环境。', text: '从模型、Agent 或应用开始，向下连接真实算力，向上形成可访问的服务。', nodes: ['模型 / Agent', '运行环境', '真实产出'] },
    ],
    illusAria: {
      device: '一台设备：工作站上的 GPU 与本地服务，向外暴露可达入口',
      network: '一组节点：多地点设备织成一张网，统一调度',
      idea: '一个想法：从想法到运行时，再到在线服务',
    },
  },
  why: {
    eyebrow: '01 — THE MISSING LAYER',
    lines: ['AI 正在走向每一个人，', '基础设施却没有跟上。'],
    desc: '传统公有云主要服务企业、政府、医院和研究机构，解决的是“非计算机专业客户如何不必考虑运维”。但 AI 时代的创新正在不可逆地碎片化、个人化。',
    constraints: [
      { label: '01 / CONNECTIVITY', title: '连接不该止步于内网', description: '校园网、家庭宽带、实验室网络。设备能运行，还需要一条清晰、可控的访问路径。', detail: '内网设备 → 统一入口 → 服务访问' },
      { label: '02 / COMPUTE', title: '一块 GPU，也值得被编排', description: '算力散落在不同设备、不同地点。让资源进入同一套工作流，才能被更多人真正使用。', detail: '独立设备 → 资源池 → 工作负载' },
      { label: '03 / OPERATIONS', title: '让维护成为共享的能力', description: '从网络到权限，从部署到观测。不必为每个新项目，重新搭建一整套基础设施。', detail: '重复配置 → 平台能力 → 持续运行' },
    ],
    gap: { eyebrow: 'THE GAP', title: '云很贵，设备却在内网吃灰。', text: 'OPC、初创公司、小实验室、兴趣团体与家庭用户正在遍地出现，却没有与他们的规模、预算和现实资源相匹配的云基础设施。' },
  },
  layers: {
    eyebrow: '02 — ONE COHERENT FABRIC',
    lines: ['不是把云做小，', '而是把基础设施做普惠。'],
    desc: 'YatTerra 把连接、编排、AI 与运维组织成一层统一的技术土壤，让真实设备也能拥有平台化的可靠性。',
    stackHeading: ['THE INFRASTRUCTURE STACK', '选择一层，探索它如何工作'],
    layers: [
      { number: '01', english: 'CONNECT', title: '连接', description: '跨过网络边界', detail: '通过内网穿透与统一入口，为分散设备建立可控的访问路径。网络位置不再决定服务能被谁使用。', tags: ['内网穿透', '统一入口', '域名路由'] },
      { number: '02', english: 'ORCHESTRATE', title: '编排', description: '让设备成为资源', detail: '通过 Kubernetes / K3s 组织节点、容器与工作负载。让部署、调度和生命周期在同一个平台中被管理。', tags: ['K3s / Kubernetes', 'GPU 资源', '容器生命周期'] },
      { number: '03', english: 'INFERENCE', title: '智能', description: '让模型参与工作', detail: '把 GPU、模型、Agent 和 MCP 工具连接起来。从一次模型调用，到能够持续运行的 AI 应用。', tags: ['模型服务', 'Agent 编排', 'MCP 工具'] },
      { number: '04', english: 'OBSERVE', title: '运维', description: '让运行长期可靠', detail: '围绕工作负载组织权限、监控与审计。让资源如何使用、问题发生在哪里，都有清晰的记录与边界。', tags: ['访问权限', '运行观测', '操作审计'] },
    ],
    rail: '统一的权限、观测与审计，贯穿每一层。',
    layerAria: '四层架构示意：',
    workflow: {
      eyebrow: 'FROM IDEA TO SERVICE',
      title: ['给想法一条', '完整的落地路径。'],
      text: ['从代码、容器到模型服务，', '把日常开发接进同一套基础设施。'],
      tags: ['开发', '部署', '运行'],
    },
  },
  thirdPath: {
    eyebrow: '03 — A THIRD PATH',
    lines: ['不替代公有云，', '也不鼓励复杂自建。'],
    desc: '公有云解决的是托管与规模，私有云解决的是控制与成本。YatTerra 在两者之间做 tradeoff：连接真实设备，复用平台能力，把可靠性带给更小、更分散的创造者。',
    choices: [
      { index: '01 / PUBLIC CLOUD', title: '公有云', text: '能力完整、弹性强，默认用户拥有企业级预算、规模与运维需求。', foot: '规模化供给 · 长期账单' },
      { index: '02 / THE MISSING MIDDLE', title: 'YatTerra', text: '让内网设备、闲置算力与本地数据成为可靠服务，同时获得连接、编排和运维能力。', foot: '更低门槛 · 平台级可靠性' },
      { index: '03 / PRIVATE CLOUD', title: '私有云 / 下云', text: '控制权更强，但需要自行承担网络、机房、集群与长期运维的全部复杂度。', foot: '自主控制 · 运维负担' },
    ],
  },
  scenarios: {
    eyebrow: '04 — MANY PLACES, ONE PLATFORM',
    lines: ['创新会发生在任何地方，', '基础设施也应该在那里。'],
    desc: '校园、家庭、工作室、实验室与小团队，只是不同的起点。底层需要的是同一条连接资源、模型与人的路径。',
    items: [
      { label: '01 / CAMPUS', title: '校园与实验室', description: '课程环境、科研任务与共享 GPU，在清晰的权限边界中协作，让设备资源服务更多人。', tags: ['共享 GPU', '科研环境', '课程项目'], caption: '共享 GPU · 权限边界' },
      { label: '02 / HOME LAB', title: '家庭与工作室', description: '把手边的工作站变成自己的 AI 节点。模型、数据和计算留在身边，服务从这里连接出去。', tags: ['本地模型', '个人工作流', '可控访问'], caption: '本地模型 · 可控访问' },
      { label: '03 / SMALL TEAMS', title: '团队与研究项目', description: '从一个原型到持续运行的服务。把连接、部署和协作交给平台，让团队专注于想法本身。', tags: ['应用部署', '团队协作', 'Agent 服务'], caption: '部署 · 协作 · Agent' },
    ],
    ariaPrefix: '场景示意：',
  },
  reportsSection: {
    eyebrow: '05 — TECHNICAL REPORTS',
    lines: ['设计取舍与实现细节，', '都写成了公开的报告。'],
    desc: '我们把这些年搭建真实基础设施的经验沉淀成技术报告：架构、调度、可靠性。持续更新，欢迎取用与讨论。',
    readMore: '阅读报告',
  },
  closing: {
    eyebrow: 'YATTERRA — THE SOIL FOR AI',
    lines: ['让每一个想法，', '都能拥有自己的基础设施。'],
    description: 'Yat 来自 Sun Yat-sen University。Terra 是大地，是土壤，也是让万物生长的基础。我们不替代云，我们让更多创造拥有可以扎根的土壤。',
    primary: '进入 YatTerra',
  },
  footer: '为真实世界构建的 AI-native 基础设施',
  illus: {
    networkAria: 'YatTerra 网络拓扑示意：六类资源环绕中心编排核',
    onPremBody: '闲置 12×A100',
    workflowAria: '三步工作流：Connect、Deploy、Observe',
    workflowNotes: ['接入集群与数据源', '编排推理与批任务', '指标、追踪、告警'],
    gap: {
      aria: '现状对比：云端昂贵 vs 内网闲置，中间是 Yatterra 断层桥接',
      cloudTitle: '云端推理', cloudNote: '按 token 计费 · 排队',
      idleTitle: '内网闲置', idleNote: 'GPU 吃灰 · 无编排',
      bridge: '云 ↔ 内网 · 统一调度',
    },
    rootsAria: '土壤中的根系生长，向上抽出 Yatterra 枝叶',
  },
}

export type LandingCopy = typeof zhCN

/* ────────────────────────── en ────────────────────────── */

const en: LandingCopy = {
  htmlLang: 'en',
  nav: { thesis: 'Why now', why: 'The gap', layers: 'How it works', scenarios: 'Scenarios', reports: 'Reports' },
  login: 'Enter console',
  loginPage: {
    eyebrow: 'AI infrastructure, reimagined',
    heroTitle: ['Every idea,', 'made real.'],
    heroDesc: 'Connect clusters, models and workloads. YatTerra condenses complex infrastructure into one clear, dependable control plane.',
    healthChecking: 'Checking…',
    healthOk: 'All systems operational',
    healthError: 'Some services degraded',
    secure: 'Secure connection · Private deployment',
    cardTitle: 'Sign in to YatTerra',
    cardDesc: 'Sign in to the console and start managing your clusters, models and workloads.',
    userLabel: 'Username',
    userPlaceholder: 'Enter username',
    passLabel: 'Password',
    passPlaceholder: 'Enter password',
    submit: 'Sign in',
    submitting: 'Verifying…',
    guest: 'Just browsing, no account',
    guestHint: 'Enter the console as a guest — no account needed.',
    noAccount: 'No account yet? Ask an administrator to set one up, or try guest mode first.',
    otherMethods: 'Other sign-in methods',
    backHome: 'Back to YatTerra home',
    errLogin: 'Sign-in failed',
    errGuest: 'Guest sign-in failed',
    oauth: {
      ssemarket: 'SSE Market authorization failed',
      unisso: 'UniSSO authorization failed',
      missing_params: 'Missing OAuth callback parameters',
      invalid_state: 'OAuth state verification failed, please retry',
      no_token: 'No authorization token received',
      generic: 'Authorization failed',
    },
  },
  brandAria: 'YatTerra home',
  hero: {
    eyebrow: 'BUILT FOR THE REAL WORLD',
    title: ['Greater productivity', 'should belong to everyone.'],
    description: 'Steam engines, electricity, computing — each once belonged to a few organizations, then became part of everyone\'s daily life. AI is completing the next wave of universal access, and it needs a new layer of infrastructure.',
    primary: 'Enter YatTerra',
    secondary: 'Understand the idea',
    promises: ['Inclusive technical infrastructure', 'Between public and private cloud'],
    bottom: 'From the machines of the few, to the infrastructure of everyone.',
    motion: { reduced: 'Motion reduced', paused: 'Play motion', playing: 'Pause motion' },
  },
  thesis: {
    eyebrow: '00 — THE LONG ARC',
    lines: ['Every capability that becomes infrastructure', 'walks the same road.'],
    desc: 'From a capability reserved for a few institutions, to a public utility anyone can plug into. Power walked it, computing walked it, capacity walked it — the layer that carries intelligence has not.',
    noteLead: 'The next step for AI is not just letting more people call models.',
    noteStrong: 'It is letting more people own the infrastructure that carries models, workflows, and creation.',
    arcAria: 'A staircase of capabilities moving from a few institutions to everyone; the layer that carries intelligence is still missing — YatTerra fills it in',
    arcAxis: { scarce: 'A few institutions only', universal: 'Everyone' },
    steps: [
      { era: '1880s — 1900s', title: 'Power', note: 'Factory steam engines → every wall socket' },
      { era: '1970s — 2010s', title: 'Computing', note: 'Institutional mainframes → the phone in your pocket' },
      { era: '2006 — 2020s', title: 'Capacity', note: 'Self-built server rooms → cloud rented on demand' },
      { era: 'NOW · The missing layer', title: 'The layer that carries intelligence', note: 'Models are within everyone\'s reach — this layer is not yet' },
    ],
    yatterraBox: { title: 'Filling in the missing layer', note: 'Making intelligence-bearing infrastructure universal too' },
    scale: { was: 'Once: the capability of a few institutions', goal: 'Goal: everyone can plug in' },
  },
  explorer: {
    title: 'Where do you start?',
    status: 'SYSTEM READY',
    tabsAria: 'Choose an infrastructure starting point',
    points: [
      { key: 'device', label: 'A device', eyebrow: 'START WITH A DEVICE', title: 'Turn an idle machine back into productivity.', text: 'Start from a workstation, a home server, or a lab GPU — no full data center required.', nodes: ['Local GPU', 'Internal services', 'Your projects'] },
      { key: 'network', label: 'A network', eyebrow: 'START WITH A NETWORK', title: 'Organize scattered compute into one whole.', text: 'Devices in different places and configurations can share connectivity, scheduling, and runtime.', nodes: ['Campus nodes', 'Home nodes', 'Shared resources'] },
      { key: 'idea', label: 'An idea', eyebrow: 'START WITH AN IDEA', title: 'Give an idea a place to keep running.', text: 'Start from a model, an agent, or an app — connect real compute below, become an accessible service above.', nodes: ['Model / Agent', 'Runtime', 'Real output'] },
    ],
    illusAria: {
      device: 'A device: GPUs and local services on a workstation, exposed through a reachable entry',
      network: 'A network: multi-site devices woven into one mesh, scheduled together',
      idea: 'An idea: from idea to runtime to an online service',
    },
  },
  why: {
    eyebrow: '01 — THE MISSING LAYER',
    lines: ['AI is reaching everyone —', 'infrastructure has not kept up.'],
    desc: 'Traditional public clouds serve enterprises, governments, hospitals and research institutes, solving “how non-expert customers avoid operations”. But AI-era innovation is irreversibly fragmenting and personalizing.',
    constraints: [
      { label: '01 / CONNECTIVITY', title: 'Connectivity should not stop at the intranet', description: 'Campus networks, home broadband, lab networks. A device can run — it still needs a clear, controllable path of access.', detail: 'Intranet devices → unified entry → service access' },
      { label: '02 / COMPUTE', title: 'A single GPU deserves orchestration too', description: 'Compute is scattered across devices and places. Resources enter one workflow before they can truly serve more people.', detail: 'Standalone devices → resource pool → workloads' },
      { label: '03 / OPERATIONS', title: 'Make maintenance a shared capability', description: 'From network to permissions, from deployment to observability. No need to rebuild a full stack for every new project.', detail: 'Repeated setup → platform capability → continuous running' },
    ],
    gap: { eyebrow: 'THE GAP', title: 'Cloud is expensive while devices gather dust on the intranet.', text: 'OPCs, startups, small labs, interest groups and home users are appearing everywhere — without cloud infrastructure matching their scale, budget, and real resources.' },
  },
  layers: {
    eyebrow: '02 — ONE COHERENT FABRIC',
    lines: ['Not a smaller cloud —', 'universal infrastructure.'],
    desc: 'YatTerra organizes connectivity, orchestration, AI and operations into one coherent technical soil, giving real devices platform-grade reliability.',
    stackHeading: ['THE INFRASTRUCTURE STACK', 'Pick a layer to see how it works'],
    layers: [
      { number: '01', english: 'CONNECT', title: 'Connect', description: 'Across network boundaries', detail: 'Tunnels and a unified entry build controllable access paths for scattered devices. Network location no longer decides who can use a service.', tags: ['Intranet tunneling', 'Unified entry', 'Domain routing'] },
      { number: '02', english: 'ORCHESTRATE', title: 'Orchestrate', description: 'Devices become resources', detail: 'Kubernetes / K3s organizes nodes, containers and workloads. Deployment, scheduling and lifecycle are managed in one platform.', tags: ['K3s / Kubernetes', 'GPU resources', 'Container lifecycle'] },
      { number: '03', english: 'INFERENCE', title: 'Intelligence', description: 'Models join the work', detail: 'Connect GPUs, models, agents and MCP tools. From a single model call to AI applications that keep running.', tags: ['Model serving', 'Agent orchestration', 'MCP tools'] },
      { number: '04', english: 'OBSERVE', title: 'Operate', description: 'Keep it running reliably', detail: 'Permissions, monitoring and auditing around workloads. How resources are used and where problems happen stay recorded and bounded.', tags: ['Access control', 'Runtime observability', 'Operation audit'] },
    ],
    rail: 'Unified permissions, observability and auditing across every layer.',
    layerAria: 'Four-layer architecture: ',
    workflow: {
      eyebrow: 'FROM IDEA TO SERVICE',
      title: ['Give an idea a', 'complete path to production.'],
      text: ['From code and containers to model serving,', 'wire everyday development into the same infrastructure.'],
      tags: ['Develop', 'Deploy', 'Run'],
    },
  },
  thirdPath: {
    eyebrow: '03 — A THIRD PATH',
    lines: ['Not replacing public cloud —', 'nor encouraging complex self-hosting.'],
    desc: 'Public cloud solves hosting and scale; private cloud solves control and cost. YatTerra trades off between them: connect real devices, reuse platform capabilities, and bring reliability to smaller, more scattered creators.',
    choices: [
      { index: '01 / PUBLIC CLOUD', title: 'Public cloud', text: 'Complete capabilities and strong elasticity — assuming users have enterprise budgets, scale, and ops needs.', foot: 'Supply at scale · long-term bills' },
      { index: '02 / THE MISSING MIDDLE', title: 'YatTerra', text: 'Turn intranet devices, idle compute and local data into reliable services, with connectivity, orchestration and operations built in.', foot: 'Lower barrier · platform-grade reliability' },
      { index: '03 / PRIVATE CLOUD', title: 'Private cloud / leaving the cloud', text: 'More control — but you carry the full complexity of networking, server rooms, clusters and long-term operations.', foot: 'Self-managed control · operational burden' },
    ],
  },
  scenarios: {
    eyebrow: '04 — MANY PLACES, ONE PLATFORM',
    lines: ['Innovation happens anywhere —', 'infrastructure should be there too.'],
    desc: 'Campuses, homes, studios, labs and small teams are just different starting points. What the bottom layer needs is the same path connecting resources, models and people.',
    items: [
      { label: '01 / CAMPUS', title: 'Campus & labs', description: 'Course environments, research workloads and shared GPUs collaborate within clear permission boundaries, letting devices serve more people.', tags: ['Shared GPUs', 'Research environments', 'Course projects'], caption: 'Shared GPUs · permission boundaries' },
      { label: '02 / HOME LAB', title: 'Home & studios', description: 'Turn the workstation on your desk into your own AI node. Models, data and compute stay nearby; services connect outward from here.', tags: ['Local models', 'Personal workflows', 'Controlled access'], caption: 'Local models · controlled access' },
      { label: '03 / SMALL TEAMS', title: 'Teams & research projects', description: 'From a prototype to a continuously running service. Hand connectivity, deployment and collaboration to the platform, and focus on the idea itself.', tags: ['App deployment', 'Team collaboration', 'Agent services'], caption: 'Deploy · collaborate · agents' },
    ],
    ariaPrefix: 'Scenario: ',
  },
  reportsSection: {
    eyebrow: '05 — TECHNICAL REPORTS',
    lines: ['Design tradeoffs and implementation details,', 'written up as public reports.'],
    desc: 'We distill years of building real infrastructure into technical reports: architecture, scheduling, reliability. Continuously updated — take and discuss.',
    readMore: 'Read the report',
  },
  closing: {
    eyebrow: 'YATTERRA — THE SOIL FOR AI',
    lines: ['Let every idea', 'own its own infrastructure.'],
    description: 'Yat comes from Sun Yat-sen University. Terra is the earth — the soil where everything grows. We don\'t replace the cloud; we give more creators soil to take root in.',
    primary: 'Enter YatTerra',
  },
  footer: 'AI-native infrastructure built for the real world',
  illus: {
    networkAria: 'YatTerra network topology: six resource classes orbiting the central orchestration core',
    onPremBody: 'idle 12×A100',
    workflowAria: 'Three-step workflow: Connect, Deploy, Observe',
    workflowNotes: ['Connect clusters & data sources', 'Orchestrate inference & batch jobs', 'Metrics, tracing, alerts'],
    gap: {
      aria: 'Today: expensive cloud vs idle intranet — YatTerra bridges the gap',
      cloudTitle: 'Cloud inference', cloudNote: 'Pay per token · queuing',
      idleTitle: 'Idle on the intranet', idleNote: 'GPUs gathering dust · no orchestration',
      bridge: 'Cloud ↔ intranet · unified scheduling',
    },
    rootsAria: 'Roots growing in soil, sprouting YatTerra leaves upward',
  },
}

/* ────────────────────────── zh-HK(廣東話) ────────────────────────── */

const zhHK: LandingCopy = {
  htmlLang: 'zh-HK',
  nav: { thesis: '點解係而家', why: '斷層', layers: '點樣運作', scenarios: '場景', reports: '技術報告' },
  login: '入控制台',
  loginPage: {
    eyebrow: 'AI infrastructure, reimagined',
    heroTitle: ['令每一個', '諗頭落地。'],
    heroDesc: '連接集群、模型同工作負載。YatTerra 將複雜嘅基礎設施，收斂成一個清晰又可靠嘅控制面。',
    healthChecking: '檢查緊…',
    healthOk: '所有系統正常運行',
    healthError: '部分服務異常',
    secure: '安全連接 · 私有部署',
    cardTitle: '登入 YatTerra',
    cardDesc: '登入控制台，開始管理你嘅集群、模型同工作負載。',
    userLabel: '用戶名',
    userPlaceholder: '輸入用戶名',
    passLabel: '密碼',
    passPlaceholder: '輸入密碼',
    submit: '登入控制台',
    submitting: '驗證緊...',
    guest: '睇睇先，唔註冊',
    guestHint: '以遊客身份入控制台，唔使帳號。',
    noAccount: '仲未有用戶？搵管理員開通，或者先用遊客身份體驗。',
    otherMethods: '其他登入方式',
    backHome: '返 YatTerra 項目首頁',
    errLogin: '登入失敗',
    errGuest: '遊客登入失敗',
    oauth: {
      ssemarket: 'SSE Market 授權失敗',
      unisso: 'UniSSO 授權失敗',
      missing_params: 'OAuth 回調參數缺失',
      invalid_state: 'OAuth state 驗證失敗，請重試',
      no_token: '未攞到授權令牌',
      generic: '授權失敗',
    },
  },
  brandAria: 'YatTerra 首頁',
  hero: {
    eyebrow: 'BUILT FOR THE REAL WORLD',
    title: ['更高級嘅生產力，', '應該屬於每一個人。'],
    description: '蒸汽機、電力、電腦，以前都只係少數機構嘅嘢，後尾先變成每個人日常生活嘅一部分。AI 而家正做緊下一輪普惠，但佢需要一層新嘅基礎設施。',
    primary: '入嚟 YatTerra',
    secondary: '了解多啲',
    promises: ['普惠嘅技術基礎設施', '喺公有雲同私有雲之間'],
    bottom: '由少數人嘅機器，到每個人嘅基礎設施。',
    motion: { reduced: '已減少動態', paused: '播放動效', playing: '暫停動效' },
  },
  thesis: {
    eyebrow: '00 — THE LONG ARC',
    lines: ['每一種能力要變成基礎設施，', '都要行同一條路。'],
    desc: '由少數機構嘅專屬能力，到人人都用得嘅公共設施。動力行過，計算行過，容量又行過——到承載智能呢一層，仲未行完。',
    noteLead: 'AI 嘅下一步，唔止係畀更多人調用模型，',
    noteStrong: '仲係畀更多人擁有一套承載模型、工作流同創造嘅基礎設施。',
    arcAria: '每一種能力由少數機構專屬，行到人人都用得嘅階梯圖；承載智能嗰級仲未喺度，由 YatTerra 補上',
    arcAxis: { scarce: '少數機構專屬', universal: '每一個人' },
    steps: [
      { era: '1880s — 1900s', title: '動力', note: '工廠嘅蒸汽機 → 去到每個插座' },
      { era: '1970s — 2010s', title: '計算', note: '機構嘅大型主機 → 袋住嘅手機' },
      { era: '2006 — 2020s', title: '容量', note: '自己起嘅機房 → 要用先租嘅雲' },
      { era: 'NOW · 缺失嗰級', title: '承載智能嘅一層', note: '模型個個都用到，呢層就仲未' },
    ],
    yatterraBox: { title: '補返缺失嗰一級', note: '令承載智能嘅基礎設施一樣咁普惠' },
    scale: { was: '以前：少數機構嘅能力', goal: '目標：人人都接得上' },
  },
  explorer: {
    title: '你會由邊度開始？',
    status: 'SYSTEM READY',
    tabsAria: '揀一個基礎設施起點',
    points: [
      { key: 'device' as const, label: '一部設備', eyebrow: 'START WITH A DEVICE', title: '畀一部閒置機器，變返做生產力。', text: '由工作站、屋企伺服器或者實驗室 GPU 開始，唔使等到有齊成個數據中心先起步。', nodes: ['本地 GPU', '內網服務', '你嘅項目'] },
      { key: 'network' as const, label: '一組節點', eyebrow: 'START WITH A NETWORK', title: '將散落嘅算力，組織成一個整體。', text: '唔同地點、唔同配置嘅設備，一樣可以共享連接、調度同運行能力。', nodes: ['校園節點', '屋企節點', '共享資源'] },
      { key: 'idea' as const, label: '一個諗頭', eyebrow: 'START WITH AN IDEA', title: '畀一個諗頭一個可以持續運行嘅環境。', text: '由模型、Agent 或者應用開始，向下接真實算力，向上變成人人用得到嘅服務。', nodes: ['模型 / Agent', '運行環境', '真實產出'] },
    ],
    illusAria: {
      device: '一部設備：工作站上面嘅 GPU 同本地服務，對外開一個入得到嘅入口',
      network: '一組節點：多個地點嘅設備織成一張網，統一調度',
      idea: '一個諗頭：由諗頭到運行時，再到在線服務',
    },
  },
  why: {
    eyebrow: '01 — THE MISSING LAYER',
    lines: ['AI 就快去到每一個人手上，', '基礎設施仲未跟上。'],
    desc: '傳統公有雲主要服務企業、政府、醫院同研究機構，解決嘅係「非計算機專業客戶點樣唔使理運維」。但 AI 時代嘅創新，正不可逆咁走向碎片化、個人化。',
    constraints: [
      { label: '01 / CONNECTIVITY', title: '連接唔應該停喺內網', description: '校園網、屋企寬頻、實驗室網絡。部機行得，仲要有一條清晰、可控嘅訪問路徑。', detail: '內網設備 → 統一入口 → 服務訪問' },
      { label: '02 / COMPUTE', title: '一塊 GPU，都值得有人編排', description: '算力散落喺唔同設備、唔同地點。資源入到同一套工作流，先至真正幫到更多人。', detail: '獨立設備 → 資源池 → 工作負載' },
      { label: '03 / OPERATIONS', title: '令維護變成共享嘅能力', description: '由網絡到權限，由部署到觀測。唔使為每個新項目，由頭搭過成套基礎設施。', detail: '重複配置 → 平台能力 → 持續運行' },
    ],
    gap: { eyebrow: 'THE GAP', title: '雲好貴，設備就擺喺內網生塵。', text: 'OPC、初創、細實驗室、興趣小組同屋企用戶周街都係，但就冇一種啱佢哋規模、預算同手上資源嘅雲基礎設施。' },
  },
  layers: {
    eyebrow: '02 — ONE COHERENT FABRIC',
    lines: ['唔係將雲整細啲，', '而係令基礎設施更普惠。'],
    desc: 'YatTerra 將連接、編排、AI 同運維織成一層統一嘅技術土壤，令真實設備都有平台級嘅可靠性。',
    stackHeading: ['THE INFRASTRUCTURE STACK', '揀一層，睇下佢點運作'],
    layers: [
      { number: '01', english: 'CONNECT', title: '連接', description: '跨過網絡邊界', detail: '透過內網穿透同統一入口，為分散設備建立可控嘅訪問路徑。網絡位置唔再決定個服務畀邊個用。', tags: ['內網穿透', '統一入口', '域名路由'] },
      { number: '02', english: 'ORCHESTRATE', title: '編排', description: '令設備變做資源', detail: '透過 Kubernetes / K3s 組織節點、容器同工作負載。部署、調度同生命週期，喺同一個平台度管理。', tags: ['K3s / Kubernetes', 'GPU 資源', '容器生命週期'] },
      { number: '03', english: 'INFERENCE', title: '智能', description: '令模型參與工作', detail: '將 GPU、模型、Agent 同 MCP 工具駁埋一齊。由一次模型調用，到可以持續運行嘅 AI 應用。', tags: ['模型服務', 'Agent 編排', 'MCP 工具'] },
      { number: '04', english: 'OBSERVE', title: '運維', description: '令運行長期可靠', detail: '圍繞工作負載組織權限、監控同審計。資源點樣用、問題出喺邊，都有清晰嘅記錄同邊界。', tags: ['訪問權限', '運行觀測', '操作審計'] },
    ],
    rail: '統一嘅權限、觀測同審計，貫穿每一層。',
    layerAria: '四層架構示意：',
    workflow: {
      eyebrow: 'FROM IDEA TO SERVICE',
      title: ['畀每個諗頭一條', '完整嘅落地路徑。'],
      text: ['由代碼、容器到模型服務，', '將日常開發接駁入同一套基礎設施。'],
      tags: ['開發', '部署', '運行'],
    },
  },
  thirdPath: {
    eyebrow: '03 — A THIRD PATH',
    lines: ['唔替代公有雲，', '亦唔鼓勵複雜自建。'],
    desc: '公有雲解決託管同規模，私有雲解決控制同成本。YatTerra 就企喺兩者中間：連接真實設備，復用平台能力，將可靠性帶畀更細、更分散嘅創造者。',
    choices: [
      { index: '01 / PUBLIC CLOUD', title: '公有雲', text: '能力齊、彈性強，預咗用戶有企業級預算、規模同運維需求。', foot: '規模化供給 · 長期賬單' },
      { index: '02 / THE MISSING MIDDLE', title: 'YatTerra', text: '令內網設備、閒置算力同本地數據變做可靠服務，連接、編排同運維一應俱全。', foot: '更低門檻 · 平台級可靠性' },
      { index: '03 / PRIVATE CLOUD', title: '私有雲 / 下雲', text: '控制權更強，但要自己孭起網絡、機房、集群同長期運維嘅全部複雜度。', foot: '自主控制 · 運維負擔' },
    ],
  },
  scenarios: {
    eyebrow: '04 — MANY PLACES, ONE PLATFORM',
    lines: ['創新喺邊度發生，', '基礎設施就應該喺邊度。'],
    desc: '校園、屋企、工作室、實驗室同細團隊，只係唔同嘅起點。底層需要嘅，係同一條連接資源、模型同人嘅路徑。',
    items: [
      { label: '01 / CAMPUS', title: '校園同實驗室', description: '課程環境、科研任務同共享 GPU，喺清晰嘅權限邊界入面協作，令設備資源幫到更多人。', tags: ['共享 GPU', '科研環境', '課程項目'], caption: '共享 GPU · 權限邊界' },
      { label: '02 / HOME LAB', title: '屋企同工作室', description: '將手邊嘅工作站變做自己嘅 AI 節點。模型、數據同計算留喺身邊，服務由呢度連出去。', tags: ['本地模型', '個人工作流', '可控訪問'], caption: '本地模型 · 可控訪問' },
      { label: '03 / SMALL TEAMS', title: '團隊同研究項目', description: '由一個原型到持續運行嘅服務。將連接、部署同協作交畀平台，令團隊專注返喺個諗頭度。', tags: ['應用部署', '團隊協作', 'Agent 服務'], caption: '部署 · 協作 · Agent' },
    ],
    ariaPrefix: '場景示意：',
  },
  reportsSection: {
    eyebrow: '05 — TECHNICAL REPORTS',
    lines: ['設計取捨同實現細節，', '全部寫成公開報告。'],
    desc: '我哋將呢幾年搭建真實基礎設施嘅經驗，沉澱成技術報告：架構、調度、可靠性。持續更新，歡迎攞去用，亦歡迎一齊傾。',
    readMore: '睇報告',
  },
  closing: {
    eyebrow: 'YATTERRA — THE SOIL FOR AI',
    lines: ['令每一個諗頭，', '都擁有自己嘅基礎設施。'],
    description: 'Yat 來自 Sun Yat-sen University。Terra 係大地，係土壤，亦係令萬物生長嘅基礎。我哋唔替代雲；我哋做嘅，係畀更多創造扎根嘅土壤。',
    primary: '入嚟 YatTerra',
  },
  footer: '為真實世界構建嘅 AI-native 基礎設施',
  illus: {
    networkAria: 'YatTerra 網絡拓撲示意：六類資源圍住中心編排核',
    onPremBody: '閒置 12×A100',
    workflowAria: '三步工作流：Connect、Deploy、Observe',
    workflowNotes: ['接入集群同數據源', '編排推理同批次任務', '指標、追蹤、告警'],
    gap: {
      aria: '現狀對比：雲端貴 vs 內網閒置，中間係 Yatterra 做橋',
      cloudTitle: '雲端推理', cloudNote: '按 token 計費 · 排隊',
      idleTitle: '內網閒置', idleNote: 'GPU 生塵 · 冇編排',
      bridge: '雲 ↔ 內網 · 統一調度',
    },
    rootsAria: '土壤入面嘅根系生長，向上抽出 Yatterra 枝葉',
  },
}

export const COPY: Record<Lang, LandingCopy> = { en, 'zh-CN': zhCN, 'zh-HK': zhHK }
