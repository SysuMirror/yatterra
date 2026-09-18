/**
 * Page → required permission for the page-level AI assistant / insight panel.
 * Mirrors INSIGHT_PAGE_PERMS in web/api/ai.py — keep the two in sync.
 * Pages not listed here are denied on the backend, so the frontend hides
 * the assistant/insight UI for them too (returns null → hide).
 */
import { useAuth } from '@/hooks/useAuth'

// page → perm (null = login only)
export const PAGE_PERMS: Record<string, string | null> = {
  dashboard: 'infra.host',
  pod: 'group.view',
  gpu: 'infra.host',
  host: 'infra.host',
  infra: 'infra.host',
  storage: 'infra.storage.read',
  databases: 'infra.db.read',
  db: 'infra.db.read',
  proxy: 'infra.proxy',
  audit: 'ops.audit',
  ops: 'ops.audit',
  users: 'admin.users',
  'threat-map': 'ops.audit',
  mcp: 'dev.mcp',
  dev: 'dev.agent',
  harness: 'dev.harness',
  llm: 'dev.llm',
  shared: 'ops.shared.read',
  terminal: 'group.terminal',
  profile: null,
  docs: null,
}

/** True if the current user may use the AI assistant/insight on this page. */
export function usePageAiAllowed(page: string): boolean {
  const { hasPerm } = useAuth()
  if (!(page in PAGE_PERMS)) return false
  const perm = PAGE_PERMS[page]
  return perm === null || (typeof perm === 'string' && hasPerm(perm))
}
