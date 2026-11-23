/**
 * Page → required permission for the page-level AI assistant / insight panel.
 * Mirrors INSIGHT_PAGE_PERMS in web/api/ai.py — keep the two in sync.
 * Pages not listed here are denied on the backend, so the frontend hides
 * the assistant/insight UI for them too (returns null → hide).
 */
import { useAuth } from '@/hooks/useAuth'

// page → perm (null = login only)
export const PAGE_PERMS: Record<string, string | null> = {
  // 平台级洞察 = admin-only（镜像 api/ai.py INSIGHT_PAGE_PERMS）。页面本身可能
  // 对 user 只读可见，但页内 AI 洞察只对 admin。
  dashboard: 'admin.users',
  pod: 'group.view',
  pod_ide: 'group.view',
  gpu: 'admin.users',
  host: 'admin.users',
  infra: 'admin.users',
  fleet: 'admin.users',
  storage: 'infra.storage.read',
  databases: 'infra.db.read',
  db: 'infra.db.read',
  proxy: 'infra.proxy',
  audit: 'ops.audit',
  billing: 'ops.audit',
  mybilling: 'billing.pay',
  pricing: 'billing.price',
  orders: 'billing.account',
  ops: 'ops.audit',
  users: 'admin.users',
  'threat-map': 'ops.audit',
  mcp: 'dev.mcp',
  dev: 'dev.agent',
  harness: 'dev.harness',
  llm: 'dev.llm',
  shared: 'ops.shared.read',
  scan: 'ops.scan.read',
  terminal: 'group.terminal',
  profile: null,
  docs: null,
}

/** True if the current user may use the AI assistant/insight on this page. */
export function usePageAiAllowed(page: string): boolean {
  const { hasPerm } = useAuth()
  // Dynamic per-pod keys ("pod:<name>") fall back to their base page ("pod").
  const base = page.split(':')[0] ?? page
  if (!(page in PAGE_PERMS) && !(base in PAGE_PERMS)) return false
  const perm = PAGE_PERMS[page] ?? PAGE_PERMS[base]
  return perm === null || (typeof perm === 'string' && hasPerm(perm))
}
