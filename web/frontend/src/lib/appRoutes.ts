/**
 * 站内路由注册表 — 给 AI 助手的 browser_control 提供"任意站内导航"能力。
 * 与 App.tsx 的 RequirePerm 权限保持同步(改路由/权限时两边一起改)。
 * 标签沿用 Sidebar 的文案, 让模型能用自然语言匹配("攻防"→/threat-map)。
 */
import { useAuthStore } from '@/stores/auth'

export interface AppRoute {
  path: string
  label: string
  /** 满足任一即可访问; 空数组 = 登录即可 */
  perms: string[]
}

export const APP_ROUTES: AppRoute[] = [
  { path: '/console', label: '概览', perms: ['group.view'] },
  { path: '/pods', label: 'Pod 列表', perms: ['group.view'] },
  // 动态路由: /pods/<name> 详情页, 前缀匹配
  { path: '/pods/:name', label: 'Pod 详情', perms: ['group.view'] },
  { path: '/pods/:name/ide', label: 'Pod IDE', perms: ['group.view'] },
  { path: '/ide', label: 'IDE', perms: ['group.view'] },
  { path: '/infra', label: '基础设施总览', perms: ['infra.host', 'infra.storage', 'infra.db', 'infra.scheduler', 'infra.proxy'] },
  { path: '/infra/host', label: '主机', perms: ['infra.host'] },
  { path: '/infra/fleet', label: '集群', perms: ['infra.host'] },
  { path: '/infra/gpu', label: 'GPU', perms: ['infra.host'] },
  { path: '/infra/storage', label: '存储', perms: ['infra.storage'] },
  { path: '/infra/databases', label: '数据库', perms: ['infra.db'] },
  { path: '/infra/proxy', label: '子域名', perms: ['infra.proxy'] },
  { path: '/dev', label: '开发总览', perms: ['dev.harness', 'dev.mcp', 'dev.agent', 'dev.llm'] },
  { path: '/dev/harness', label: '编排', perms: ['dev.harness'] },
  { path: '/dev/mcp', label: 'MCP', perms: ['dev.mcp'] },
  { path: '/dev/llm', label: 'LLM', perms: ['dev.llm'] },
  { path: '/ops', label: '运维总览', perms: ['ops.audit', 'ops.shared.read', 'ops.shared.write'] },
  { path: '/ops/audit', label: '审计', perms: ['ops.audit'] },
  { path: '/ops/approvals', label: 'AI 审批', perms: ['infra.host', 'admin.users'] },
  { path: '/ops/shared', label: '共享', perms: ['ops.shared.read', 'ops.shared.write'] },
  { path: '/threat-map', label: '攻防(威胁地图)', perms: ['ops.threat'] },
  { path: '/users', label: '用户', perms: ['admin.users'] },
  { path: '/profile', label: '个人管理', perms: [] },
  { path: '/docs', label: '文档', perms: [] },
]

function hasAnyPerm(perms: Set<string>, required: string[]): boolean {
  if (perms.has('*')) return true
  if (!required.length) return true
  return required.some((p) => perms.has(p))
}

/** 按当前用户权限过滤出的可导航路由。 */
export function availableRoutes(): AppRoute[] {
  const { perms, isLoggedIn } = useAuthStore.getState()
  if (!isLoggedIn) return []
  return APP_ROUTES.filter((r) => hasAnyPerm(perms, r.perms))
}

/**
 * 校验并解析一个 route: 动作目标。
 * 返回匹配的路由(动态段原样保留, 如 /pods/:name 匹配 /pods/octop),
 * 非法或无权限返回 undefined。
 */
export function resolveRoute(pathRaw: string): AppRoute | undefined {
  const path = (pathRaw.split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/'
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return undefined
  const { perms, isLoggedIn } = useAuthStore.getState()
  if (!isLoggedIn) return undefined
  for (const r of APP_ROUTES) {
    if (!hasAnyPerm(perms, r.perms)) continue
    if (r.path === path) return r
    if (r.path.includes(':')) {
      // 动态段: /pods/:name ↔ /pods/<任意非空段>
      const pat = r.path.split('/').filter(Boolean)
      const seg = path.split('/').filter(Boolean)
      if (pat.length === seg.length && pat.every((p, i) => p.startsWith(':') || p === seg[i])) return r
    }
  }
  return undefined
}
