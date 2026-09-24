import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useLocation } from 'react-router'
import { useAuthStore } from '@/stores/auth'
import { Portal } from '@/components/ui/Portal'

type Step = {
  target: string
  title: string
  description: string
  optional?: boolean
  lesson?: string
  fallbackTarget?: string
  // Completion is checked against a real rendered control/state marker when available.
  doneTarget?: string
}
const step = (target: string, title: string, description: string, optional = false, doneTarget?: string, fallbackTarget?: string, lesson?: string): Step => ({ target, title, description, optional, doneTarget, fallbackTarget, lesson })
const docs = (description: string, lesson = 'concepts') => step('page-docs', '打开对应文档', description, true, undefined, undefined, lesson)
const lessonHref = (lesson: string) => `/docs?lesson=${encodeURIComponent(lesson)}`

// A short, task-based path. Targets are real controls; optional items disappear when
// the current account or resource has no such capability.
const guides: Record<string, Step[]> = {
  '/console': [
    step('goto-/pods', '先找到 Pod', 'Pod 是你的开发环境。点击 Pod 卡片进入管理页面，查看已有环境或创建一个新的。', false, undefined, undefined, 'concepts'),
    step('goto-/infra', '查看基础设施', '基础设施页面展示主机、存储、数据库和代理映射的状态。从这里快速跳转到各管理子页面。', false, undefined, undefined, 'infra'),
    step('goto-/dev/harness', '探索开发工具', '开发工具提供 Harness 测试、MCP 管理和 LLM 配置。需要相关权限才能访问。', true, undefined, undefined, 'dev'),
    step('goto-/threat-map', '了解安全态势', '威胁地图展示实时的安全攻击事件。有 ops.threat 权限的用户可查看。', true, undefined, undefined, 'security'),
    step('page-assistant', '使用页面 AI 助手', '页面右上方显示 AI 助手入口。可以针对当前页面内容提问，获取用量洞察或操作建议。', true, undefined, undefined, 'dev'),
    step('goto-/profile', '管理个人账户', '点击右上角头像进入个人设置。可修改密码、查看角色和更新头像。', true, undefined, undefined, 'concepts'),
  ],
  '/pods': [
    step('pods-create', '选择并创建 Pod', 'Pod 是你的开发环境。填写名称和资源规格后提交；GPU、内存和存储按实际工作负载选择，创建结果会进入 Pod 详情。', false, 'pods-created', undefined, 'pod'),
    step('pods-search', '找到你的 Pod', '用名称搜索；状态筛选可定位运行中、等待中或失败的环境。列表为空时先清除筛选。', false, undefined, undefined, 'access'),
    step('pods-status', '确认状态与统计', '列表上方有运行、停止、失败数量的统计卡片。Pending 表示仍在调度，Failed 请打开详情查看日志或资源原因。', false, undefined, undefined, 'troubleshooting'),
    docs('Pod 列表上方还有 AI 集群洞察面板，可帮你快速了解所有 Pod 的健康概况。', 'access'),
    step('assistant', '使用 AI 助手', '页面右下角的 AI 助手悬浮按钮。选中后输入自然语言问题，获取 Pod 管理建议或排查指引。', true, undefined, undefined, 'dev'),
  ],
  '/pods/:name': [
    step('pod-tab-connect', '连接 Pod', '连接页会显示当前 Pod 已分配的 SSH 命令、密码和 Web 地址（如果提供）。只复制并使用界面显示的准确值；不要自行拼接主机、端口或其他端点。', false, undefined, undefined, 'connect'),
    step('pod-tab-monitor', '监控资源用量', '监控标签页显示 CPU、内存和 GPU 的实时及历史指标曲线。每 5 秒刷新，帮助判断资源是否充足。', false, undefined, undefined, 'monitoring'),
    step('pod-tab-terminal', '使用在线终端', '终端标签页提供浏览器内的 SSH 会话。无需额外工具即可在 Pod 内执行命令。确保 Pod 处于运行状态。', false, undefined, undefined, 'connect'),
    step('pod-tab-files', '管理文件', '文件页用于浏览、编辑或上传允许目录中的文件。只操作你有权限的路径；不要把密码或 Token 写进文件、截图或日志。', false, undefined, undefined, 'services'),
    step('pod-tab-logs', '查看容器日志', '日志标签页查看容器 stdout/stderr。部署卡片中的日志是该部署运行日志；两者来源不同，按对应时间和错误排查。', false, undefined, undefined, 'logs'),
    step('pod-tab-app-logs', '查看应用日志', '应用日志标签页查看服务输出。若没有日志，先确认应用确实启动并把输出写到平台读取的日志来源。', true, undefined, undefined, 'logs'),
    step('pod-tab-deploys', '先看模板或部署', '部署页管理应用部署。快速模板会立即创建并运行；自定义部署则先保存配置，再按需要启动。', false, undefined, undefined, 'first-app'),
    step('deploy-create', '创建部署', '点击「创建部署」打开表单。仓库来源填写必要仓库字段；本地来源只填写 deploy.sh 路径。私有仓库 Token 只填入密码字段，不要写进脚本或截图。', false, undefined, 'pod-tab-deploys', 'deploy'),
    step('deploy-script', '填写 deploy.sh', '打开部署表单后填写 deploy.sh 路径。它不是仓库来源的必填项；若当前账号不能管理部署，部署表单不会出现。', true, undefined, 'pod-tab-deploys', 'deploy'),
    step('deploy-submit', '保存部署配置', '这里只介绍提交前要核对的字段；新手指引不会替你点击「确认」或创建、启动部署。创建自定义部署后会保存，模板则会立即运行。', false, undefined, 'pod-tab-deploys', 'deploy'),
    step('pod-tab-creds', '管理数据库凭证', '凭证标签页管理 Pod 级别的数据库和 MinIO 访问凭证。点击「应用凭证」为当前 Pod 申请 MySQL、Redis、Qdrant 或 MinIO 的访问权限。', true, undefined, undefined, 'database'),
    step('pod-tab-domains', '配置子域名', '子域名标签页为 Pod 的公网端口绑定自定义前缀。添加后可通过 &lt;前缀&gt;.ssemarket.cn 直接访问你的应用。', true, undefined, undefined, 'proxy'),
    step('pod-tab-members', '管理团队成员', '成员标签页查看和邀请团队成员加入当前 Pod。owner 或 admin 可以审批加入申请、移除成员和调整角色。', true, undefined, undefined, 'collaboration'),
    step('pod-tab-settings', '配置环境变量与资源', '设置页可修改资源配置和环境变量。环境变量保存后会触发 Pod 重启；重启后要重新运行部署，才能刷新 supervisor 中已持久化的环境。', false, undefined, undefined, 'environment'),
    step('pod-resources', '查看资源规格', '设置页上方显示当前 Pod 的 CPU、内存、存储和 GPU 配额。owner 或 admin 可在此调整规格。', true, undefined, undefined, 'environment'),
    step('pod-env', '管理环境变量', '设置页的环境变量区。添加后保存并重启生效；不要把密钥、密码或 Token 直接写入日志或截图。', true, undefined, undefined, 'environment'),
    docs('多人协作时先确认 Pod 权限与共享边界；指引不会替你改变权限或发出邀请。', 'collaboration'),
    docs('部署失败或服务异常时，先按恢复清单定位问题；健康检查是可选的，只有配置时才会参与条件回滚。', 'recovery'),
    docs('Webhook 自动部署需要显式选择分支；切换分支本身不会完成切换，还需要管理员配置回调。全局 secret 不会在指引中展示。', 'webhook'),
  ],
  '/infra': [
    step('goto-/infra/host', '查看主机监控', '主机页面显示各节点的 CPU、内存、负载和 GPU 状态。快速了解集群整体健康度。', false, undefined, undefined, 'infra'),
    step('goto-/infra/gpu', '查看 GPU 详情', 'GPU 页面展示每块 GPU 的型号、显存和利用率。适合排查 GPU 分配和性能问题。', true, undefined, undefined, 'infra'),
    step('goto-/infra/fleet', '查看集群图表', '集群页面展示所有主机的历史指标图表，包括 CPU、内存、负载和 GPU 详细数据。', true, undefined, undefined, 'infra'),
    step('goto-/infra/storage', '管理对象存储', '存储页面管理 MinIO 桶和访问密钥。创建桶、生成端点密钥、管理共享策略。', false, undefined, undefined, 'storage'),
    step('goto-/infra/databases', '管理数据库凭证', '数据库页面管理 MySQL 等数据服务的连接凭证。先创建凭证，再复制连接串到你的应用中使用。', false, undefined, undefined, 'database'),
    step('goto-/infra/proxy', '管理代理映射', '代理页面管理公网到内网服务的端口映射。添加映射后即可通过公网地址访问内网服务。', true, undefined, undefined, 'proxy'),
  ],
  '/infra/host': [
    step('goto-/infra/fleet', '查看集群图表', '主机监控页面显示各节点的实时状态。切换到「集群」页面查看详细的历史指标图表和 GPU 数据。', false, undefined, undefined, 'infra'),
    step('goto-/infra/gpu', '查看 GPU 状态', '如果主机搭载了 GPU，可以切换到 GPU 页面查看每块 GPU 的详细使用情况。', true, undefined, undefined, 'infra'),
    docs('主机页面会列出所有节点的在线/离线状态，以及 CPU、内存、系统负载的实时数据。', 'infra'),
  ],
  '/infra/gpu': [
    step('goto-/infra/fleet', '查看 GPU 历史曲线', 'GPU 页面展示每块 GPU 的型号、驱动版本、显存总量和当前利用率。切换到「集群」页面查看 GPU 利用率、显存和温度的历史曲线。', false, undefined, undefined, 'infra'),
    step('goto-/infra/host', '返回主机列表', '了解 GPU 概览后，可以返回主机页面查看该节点整体的资源健康度。', true, undefined, undefined, 'infra'),
    docs('GPU 分配到 Pod 后，在 Pod 详情页的监控标签页可查看每块 GPU 的实时利用率。', 'infra'),
  ],
  '/infra/fleet': [
    step('fleet-host', '选择查看的主机', '点击卡片切换要查看的主机。选中的主机高亮显示，下方区域展示其详细指标。', false, undefined, undefined, 'infra'),
    step('fleet-view', '切换图表/表格', '在图表视图和表格视图之间切换。图表更直观，表格适合精确数值对比。', false, undefined, undefined, 'infra'),
    step('fleet-range', '调整时间范围', '选择历史数据的时间范围。范围越短数据越精细，范围越长越能观察趋势。', true, undefined, undefined, 'infra'),
    step('page-assistant', '查看 AI 集群洞察', '页面右侧的 AI 洞察面板会自动分析集群健康状态，给出异常检测和资源建议。', true, undefined, undefined, 'dev'),
    docs('GPU 详情区域可按单块 GPU 筛选查看利用率、显存和温度曲线。', 'infra'),
  ],
  '/infra/storage': [
    step('storage-create', '创建存储桶', '点击「创建桶」新建 MinIO 桶。桶用于存放文件和数据，创建后需要生成访问密钥才能使用。', false, undefined, undefined, 'storage'),
    step('storage-endpoint', '查看端点信息', '页面显示 MinIO 的访问端点和连接方式。应用通过这些信息连接到存储服务。', false, undefined, undefined, 'storage'),
    step('storage-key', '管理访问密钥', '为特定桶生成访问密钥（Access Key / Secret Key）。密钥只显示一次，创建后请立即保存。', true, undefined, undefined, 'storage'),
    docs('MinIO 桶可以通过 Pod 凭证标签页申请访问权限。应用中使用 S3 兼容 SDK 连接。', 'storage'),
  ],
  '/infra/databases': [
    step('db-create', '创建数据库凭证', '点击「创建凭证」生成新的数据库连接凭证。凭证包含用户名、密码和连接地址。', false, undefined, undefined, 'database'),
    step('db-copy', '复制连接串', '创建凭证后点击「复制连接串」将完整的数据库连接信息复制到剪贴板，粘贴到你的应用配置中。', false, undefined, undefined, 'database'),
    docs('数据库连接信息也可以在 Pod 详情页的凭证标签页中管理，权限按 Pod 隔离。', 'database'),
  ],
  '/infra/proxy': [
    step('proxy-create', '添加代理映射', '点击「添加映射」将内网服务端口映射到公网。填写目标内网地址和端口，系统分配公网入口。', false, undefined, undefined, 'proxy'),
    docs('已有的映射可以停用、编辑或删除。修改后需要等待 frp 重新加载配置。', 'proxy'),
  ],
  '/dev': [
    step('goto-/dev/harness', '使用测试工具', 'Harness 提供命令行和交互式测试环境。可以运行脚本、测试 API 和调试服务。', false, undefined, undefined, 'dev'),
    step('goto-/dev/mcp', '管理 MCP 服务', 'MCP 管理页面查看和配置已连接的 Model Context Protocol 服务。添加新服务或测试现有连接。', true, undefined, undefined, 'dev'),
    step('goto-/dev/llm', '配置 LLM 模型', 'LLM 页面管理可用的语言模型端点。添加模型提供方、配置 API key 和测试连通性。', true, undefined, undefined, 'dev'),
    step('assistant', '使用 AI 助手', '页面右下角的 AI 助手可以回答开发工具使用问题，辅助排查配置错误。', true, undefined, undefined, 'dev'),
  ],
  '/dev/harness': [
    step('harness-sessions', '查看会话列表', '会话列表显示所有已创建或正在运行的测试会话。点击可查看详情或重新连接。', false, undefined, undefined, 'dev'),
    step('harness-session', '新建会话', '点击「新建会话」启动一个新的测试环境。填写名称和配置参数后提交。', false, undefined, undefined, 'dev'),
    step('assistant', '获取运行帮助', '运行中遇到问题可使用 AI 助手获取帮助，解释错误输出或给出调试建议。', true, undefined, undefined, 'dev'),
  ],
  '/dev/mcp': [
    step('mcp-add', '添加 MCP 服务', '点击「添加」注册新的 MCP 服务。填写服务名称、端点和认证信息。', false, undefined, undefined, 'dev'),
    step('mcp-test', '测试 MCP 连接', '添加后点击「测试」验证 MCP 服务是否可达。测试结果会显示连接状态和响应时间。', true, undefined, undefined, 'dev'),
    docs('MCP 服务将 AI 能力与外部工具集成。配置后可在平台 AI 助手中调用。', 'dev'),
  ],
  '/dev/llm': [
    step('llm-add', '添加 LLM 端点', '点击「添加」配置新的 LLM 模型端点。填写提供商、模型名称和 API key。', false, undefined, undefined, 'dev'),
    step('llm-test', '测试 LLM 连接', '添加后点击「测试」验证 LLM 端点是否可用。测试会发送简单请求并检查响应。', true, undefined, undefined, 'dev'),
    docs('已配置的 LLM 端点可用于平台 AI 功能。API key 保存后不再明文显示。', 'dev'),
  ],
  '/ops': [
    step('goto-/ops/audit', '查看审计日志', '审计日志记录所有关键操作。用于追踪谁在什么时间做了什么变更。', false, undefined, undefined, 'ops'),
    step('goto-/ops/shared', '管理共享空间', '共享存储页面管理团队共享的文件和目录。可以创建目录、上传文件和设置权限。', true, undefined, undefined, 'ops'),
    step('assistant', '使用 AI 助手', 'AI 助手可帮助分析审计日志中的异常模式或解释共享空间的权限配置。', true, undefined, undefined, 'dev'),
  ],
  '/ops/audit': [
    step('audit-export', '筛选与导出审计日志', '页面提供按操作类型、时间范围和用户的筛选。点击「导出」将当前筛选结果导出为 CSV 文件。', false, undefined, undefined, 'ops'),
    docs('审计日志保留最近的操作记录。导出文件可用于离线审计和合规归档。', 'ops'),
  ],
  '/ops/shared': [
    step('shared-mkdir', '新建目录', '点击「新目录」在共享空间中创建文件夹，用于组织和管理团队文件。', false, undefined, undefined, 'ops'),
    step('shared-upload', '上传文件', '点击「上传」将本地文件上传到共享空间。上传的文件对团队内有权限的成员可见。', false, undefined, undefined, 'ops'),
    docs('共享空间中的文件对所有有 ops.shared.read 权限的成员可见。请勿上传敏感凭据。', 'ops'),
  ],
  '/users': [
    step('users-create', '创建用户', '点击「创建用户」添加新用户到平台。填写用户名、初始密码和角色后提交。', false, undefined, undefined, 'admin'),
    step('users-token', '管理 API Token', '点击「管理 Token」查看或撤销已有 API 令牌。Token 用于程序化访问平台 API。', true, undefined, undefined, 'admin'),
    docs('用户角色决定了可访问的页面和操作权限。创建后用户可自行修改密码。', 'admin'),
  ],
  '/profile': [
    step('profile-password', '修改密码', '点击「修改」更新你的登录密码。修改后下次登录请使用新密码。', false, undefined, undefined, 'concepts'),
    step('profile-update', '检查更新', '点击「检查更新」查看平台是否有新版本可用。有更新时会显示版本号和更新内容。', true, undefined, undefined, 'concepts'),
    docs('显示名称和头像由全局用户信息同步。如需修改请联系平台管理员。', 'concepts'),
  ],
  '/docs': [
    step('docs-section', '按任务打开文档', '展开快速开始、Pod、连接与部署章节，优先阅读与你当前页面对应的条目。', false, undefined, undefined, 'concepts'),
    step('docs-item', '核对页面实际能力', '文档不会承诺未在界面中暴露的连接、市场或云端操作；看到"未提供/未验证"时请按页面提示处理。', true, undefined, undefined, 'troubleshooting'),
    step('assistant', '使用 AI 助手辅助阅读', '阅读文档时遇到不明白的概念，可打开 AI 助手进一步解释。', true, undefined, undefined, 'dev'),
  ],
  '/threat-map': [
    step('goto-/ops/audit', '查看安全事件', '威胁地图展示实时攻击事件的地理分布和类型统计。不同颜色代表不同的威胁等级。', false, undefined, undefined, 'security'),
    step('goto-/ops/audit', '配合审计日志', '发现可疑事件后切换到审计日志页面查看详细的操作记录，追踪事件来源。', true, undefined, undefined, 'security'),
    docs('威胁地图需要 ops.threat 权限。数据来自平台安全监控模块。', 'security'),
  ],
}

const STORAGE_KEY = 'sseinfra_onboarding_v5'

function completed(user: string, page: string): boolean {
  try { return localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`) === 'done' } catch { return false }
}
function finish(user: string, page: string) {
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`, 'done') } catch { /* private browsing / quota */ }
}
function skippedIndex(user: string, page: string, length: number): number {
  try {
    const value = Number(localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`))
    return Number.isFinite(value) ? Math.min(length - 1, Math.max(0, Math.floor(value))) : 0
  } catch { return 0 }
}
function wasSkipped(user: string, page: string): boolean {
  try { return localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`) === '1' } catch { return false }
}
function restart(user: string, page: string) {
  try { localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`); localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`); localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`) } catch { /* private browsing / quota */ }
}
function saveIndex(user: string, page: string, index: number) {
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`, String(index)) } catch { /* private browsing / quota */ }
}
function skip(user: string, page: string, index: number) {
  // Closing or skipping is not completion: replay from the saved point later.
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`, '1'); localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`, String(index)) } catch { /* private browsing / quota */ }
}

function rendered(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
  }
  return true
}
function viewport() {
  const v = window.visualViewport
  return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight }
}
// Intersect overflow ancestors as well as the viewport (main and horizontal tabs scroll independently).
function visibleRect(el: HTMLElement) {
  const r = el.getBoundingClientRect(), v = viewport()
  let left = Math.max(r.left, v.left), right = Math.min(r.right, v.left + v.width)
  let top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.top + v.height)
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p), b = p.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right) }
    if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom) }
  }
  return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
type Geometry = { left: number; top: number; width: number; height: number; x: number; y: number; arrow: number; above: boolean; maxHeight: number }

export function OnboardingGuide() {
  const { pathname, key } = useLocation()
  const user = useAuthStore(s => s.user)
  const loggedIn = useAuthStore(s => s.isLoggedIn)
  const path = pathname.replace(/\/$/, '') || '/'
  const page = /^\/pods\/[^/]+$/.test(path) ? '/pods/:name' : path
  if (!loggedIn || !user || !guides[page]) return null
  // A keyed instance synchronously discards bubbles, timers and progress on navigation / identity change.
  return <PageGuide key={`${user}:${pathname}:${key}`} user={user} page={page} pathname={pathname} steps={guides[page]!} />
}

function PageGuide({ user, page, pathname, steps }: { user: string; page: string; pathname: string; steps: Step[] }) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(() => skippedIndex(user, page, steps.length))
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const scrollRequested = useRef(true)
  const current = steps[index]!
  const close = (completed = false) => {
    if (bubble.current?.contains(document.activeElement)) document.querySelector<HTMLButtonElement>('[data-onboarding-launcher]')?.focus({ preventScroll: true })
    if (completed) finish(user, page)
    else { skip(user, page, index); setOpen(false) }
    setOpen(false)
  }
  const advance = (next: number) => {
    saveIndex(user, page, next)
    scrollRequested.current = true
    setGeometry(null)
    setIndex(next)
  }

  useLayoutEffect(() => {
    let frame = 0, target: HTMLElement | null = null, missingSince = performance.now()
    let disposed = false
    const ro = new ResizeObserver(() => schedule())
    const update = () => {
      if (disposed) return
      const root = Array.from(document.querySelectorAll<HTMLElement>('[data-onboarding-page]')).find(el => el.dataset.onboardingPage === pathname)
      const suppressed = !!root?.querySelector('[data-onboarding-unavailable]')
      setUnavailable(suppressed)
      if (suppressed || !open) { setGeometry(prev => prev === null ? prev : null); return }
      const done = current.doneTarget && root?.querySelector(`[data-onboarding-state=\"${current.doneTarget}\"]`)
      if (done && rendered(done as HTMLElement)) {
        if (index < steps.length - 1) { scrollRequested.current = true; setIndex(index + 1) }
        else { finish(user, page); setOpen(false) }
        return
      }
      const targetRoot = current.target.startsWith('deploy-') ? document : (root || document)
      const candidates = Array.from(targetRoot.querySelectorAll<HTMLElement>(`[data-onboarding-target="${current.target}"]`)).filter(rendered)
      const fallbackCandidates = current.fallbackTarget
        ? Array.from((root || document).querySelectorAll<HTMLElement>(`[data-onboarding-target="${current.fallbackTarget}"]`)).filter(rendered)
        : []
      // Contextual controls mount only after their owning tab/modal is opened. While
      // absent, anchor the explanation to that real tab rather than hiding the bubble.
      const usable = candidates.length ? candidates : fallbackCandidates
      const next = usable.find(el => { const r = visibleRect(el); return r.width > 4 && r.height > 4 }) ?? usable[0] ?? null
      if (target !== next) {
        if (target) ro.unobserve(target)
        target = next
        if (target) ro.observe(target)
      }
      // Let dialogs, menus, drawers and the assistant own their interaction surface.
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="listbox"], [role="menu"], [data-onboarding-overlay]')).some(rendered)
      // The guide is below modal/popover layers; hide it while any overlay owns focus.
      if (!target || overlay) {
        setGeometry(prev => prev === null ? prev : null)
        if (!target && current.optional && performance.now() - missingSince > 2200) {
          if (index < steps.length - 1) {
            scrollRequested.current = true
            setIndex(index + 1)
          } else {
            finish(user, page)
            setOpen(false)
          }
        }
        return
      }
      missingSince = performance.now()
      let r = visibleRect(target)
      if (scrollRequested.current) {
        scrollRequested.current = false
        const full = target.getBoundingClientRect()
        if (r.width < full.width - 2 || r.height < full.height - 2) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        r = visibleRect(target)
      }
      if (r.width < 4 || r.height < 4) { setGeometry(prev => prev === null ? prev : null); return }
      const v = viewport(), margin = 12, gap = 14
      const width = Math.min(320, v.width - margin * 2)
      const below = v.top + v.height - margin - r.bottom - gap
      const aboveSpace = r.top - v.top - margin - gap
      const naturalHeight = (bubble.current?.lastElementChild?.scrollHeight ?? 0) + 2
      const above = below < naturalHeight && aboveSpace > below
      const maxHeight = Math.max(0, above ? aboveSpace : below)
      // If the keyboard / a giant target leaves no usable space, don't cover the control.
      if (maxHeight < 110) { setGeometry(prev => prev === null ? prev : null); return }
      const height = Math.min(naturalHeight, maxHeight)
      const x = Math.max(v.left + margin, Math.min(v.left + v.width - margin - width, r.left + r.width / 2 - width / 2))
      const y = above ? r.top - gap - height : r.bottom + gap
      const nextGeometry = { left: r.left, top: r.top, width: r.width, height: r.height, x, y, arrow: Math.max(14, Math.min(width - 14, r.left + r.width / 2 - x)), above, maxHeight }
      setGeometry(prev => prev && Object.keys(nextGeometry).every(k => prev[k as keyof Geometry] === nextGeometry[k as keyof Geometry]) ? prev : nextGeometry)
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    if (bubble.current) ro.observe(bubble.current)
    const mo = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-onboarding-ui]'))) schedule()
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-modal', 'aria-expanded'] })
    // A low-frequency check handles late mounts, CSS transitions and missing optional controls.
    const timer = open ? window.setInterval(schedule, 250) : undefined
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearInterval(timer); mo.disconnect(); ro.disconnect()
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, index, current, pathname, steps, user, page])

  useEffect(() => {
    const onToggle = () => {
      if (open) {
        // Treat the launcher as pause: persist the current point and resume later.
        close(false)
        return
      }
      // An explicit replay after completion starts from the beginning; a skipped
      // tour resumes its saved index rather than silently resetting it.
      if (completed(user, page)) { restart(user, page); setIndex(0) }
      setGeometry(null)
      scrollRequested.current = true
      setOpen(true)
    }
    window.addEventListener('yatterra:onboarding-toggle', onToggle)
    return () => window.removeEventListener('yatterra:onboarding-toggle', onToggle)
  }, [open, user, page])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // No global arrow shortcuts: inputs, terminals, selects and editors retain their keys.
      if (event.key !== 'Escape' || event.defaultPrevented || !geometry) return
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (unavailable) return null

  return <Portal>
    {open && <>
      {geometry && <div data-onboarding-ui aria-hidden="true" className="pointer-events-none fixed rounded-lg border-2 border-accent/70 shadow-[0_0_0_4px_rgba(10,132,255,0.12)]" style={{ zIndex: 'var(--z-popover)', left: geometry.left - 3, top: geometry.top - 3, width: geometry.width + 6, height: geometry.height + 6 }} />}
      <div ref={bubble} data-onboarding-ui data-onboarding-active-target={current.target} role="dialog" aria-modal="false" aria-labelledby="onboarding-title" aria-describedby="onboarding-description"
        className="fixed rounded-2xl border border-white/70 bg-white/80 text-ink shadow-[0_12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl"
        style={{ zIndex: 'var(--z-popover)', width: Math.min(320, viewport().width - 24), left: geometry?.x ?? 0, top: geometry?.y ?? 0, visibility: geometry ? 'visible' : 'hidden', pointerEvents: geometry ? 'auto' : 'none' }}>
        {geometry && <span data-onboarding-arrow aria-hidden="true" className="pointer-events-none absolute h-3 w-3 rotate-45 border-white/70 bg-white/80" style={{ left: geometry.arrow - 6, [geometry.above ? 'bottom' : 'top']: -7, borderWidth: geometry.above ? '0 1px 1px 0' : '1px 0 0 1px' }} />}
        <div className="relative overflow-y-auto p-4" style={{ maxHeight: geometry ? geometry.maxHeight - 2 : undefined }}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-accent">新手指引 · {index + 1} / {steps.length}</span>
            <button type="button" aria-label="关闭新手指引" onClick={() => close(false)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/5"><X size={15} /></button>
          </div>
          <div aria-live="polite" aria-atomic="true">
            <h2 id="onboarding-title" className="mt-1 text-base font-bold">{current.title}</h2>
            <p id="onboarding-description" className="mt-2 text-xs leading-5 text-ink-2">{current.description}</p>
            {current.lesson && <a href={lessonHref(current.lesson)} className="mt-2 inline-flex text-xs text-accent hover:underline">查看课程：{current.lesson}</a>}
          </div>
          {(current.target === 'pod-tab-deploys' || current.target.startsWith('deploy-')) && (
            <button type="button" onClick={() => {
              document.querySelector<HTMLElement>('[data-onboarding-target="pod-tab-deploys"]')?.click()
              if (current.target !== 'pod-tab-deploys') {
                const deadline = performance.now() + 2000
                const openForm = () => {
                  const create = document.querySelector<HTMLElement>('[data-onboarding-target="deploy-create"]')
                  if (create && rendered(create)) create.click()
                  else if (performance.now() < deadline) window.setTimeout(openForm, 50)
                }
                openForm()
              }
            }} className="mb-3 w-full rounded-lg border border-accent/30 px-2 py-2 text-xs text-accent hover:bg-accent/5">
              {current.target === 'pod-tab-deploys' ? '打开部署标签（不会提交）' : '打开部署表单（不会提交）'}
            </button>
          )}
          <button type="button" onClick={() => { restart(user, page); advance(0) }} className="mt-3 rounded-lg px-2 py-2 text-xs text-muted hover:bg-black/5">重新开始</button>
          <div className="mt-4 flex items-center justify-between gap-2">
            <button type="button" onClick={() => close(false)} className="rounded-lg px-2 py-2 text-xs text-muted">跳过本页</button>
            <div className="flex gap-1">
              {index > 0 && <button type="button" onClick={() => advance(index - 1)} className="rounded-lg px-2 py-2 text-xs hover:bg-black/5">上一步</button>}
              <button type="button" onClick={() => index === steps.length - 1 ? close(true) : advance(index + 1)} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white">{index === steps.length - 1 ? '已读' : '下一步'}</button>
            </div>
          </div>
        </div>
      </div>
    </>}
  </Portal>
}
