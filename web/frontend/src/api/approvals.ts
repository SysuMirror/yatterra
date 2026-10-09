import { api } from './client'

export interface ApprovalRecord {
  id: string
  ts: string
  actor: string
  role?: string
  tool: string
  args: Record<string, any>
  runner: string
  pod?: string
  agent_id?: string
  run_id?: string
  reason: string
  /** Set when the record came from an automated proposer (e.g. "podwatch"). */
  origin?: string
  status: 'pending' | 'executed' | 'failed' | 'rejected'
  decided_ts?: string | null
  decided_by?: string | null
  executed_ts?: string | null
  exec_ok?: boolean | null
  exec_out?: string
  verify?: { cmd: string; status: string; ts?: string | null; out?: string } | null
}

export const approvalsApi = {
  list: (status: 'pending' | 'all' | 'done' = 'pending', limit = 50) =>
    api.get<{ approvals: ApprovalRecord[]; mode: string }>(`/agents/approvals?status=${status}&limit=${limit}`),
  approve: (id: string) => api.post<{ ok: boolean; message: string }>('/agents/approve', { id }),
  reject: (id: string, reason = '') => api.post<{ ok: boolean; message: string }>('/agents/reject', { id, reason }),
  verify: (limit = 5) => api.post<{ ok: boolean; checked: number; results: any[] }>('/agents/approvals/verify', { limit }),
}
