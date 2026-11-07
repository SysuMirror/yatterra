import { api } from './client'

export type BillingRange = '24h' | '7d' | '30d'
export type BillingBucket = 'hour' | 'day'

/** One bucketed row — stored second-integrals plus derived core/card-hours. */
export interface UsageBucket {
  bucket_start: number
  n_samples: number
  cpu_core_seconds: number
  cpu_req_core_seconds: number
  mem_gib_seconds: number
  gpu_mem_gib_seconds: number
  gpu_compute_card_seconds: number
  storage_home_gib_seconds: number
  storage_minio_gib_seconds: number
  storage_quota_gib_seconds: number
  core_hours: number
  request_core_hours: number
  mem_gib_hours: number
  gpu_mem_gib_hours: number
  compute_card_hours: number
  storage_home_gib_hours: number
  storage_minio_gib_hours: number
  storage_quota_gib_hours: number
  cpu_utilization: number | null
}

export interface UsageTotals {
  core_hours: number
  request_core_hours: number
  gap_core_hours: number
  gpu_mem_gib_hours: number
  compute_card_hours: number
  mem_gib_hours: number
  storage_home_gib_hours: number
  storage_minio_gib_hours: number
  storage_quota_gib_hours: number
  cpu_utilization: number | null
}

export interface PodUsage {
  group: string
  range: BillingRange
  bucket: BillingBucket
  since: number
  until: number
  partial: boolean
  series: UsageBucket[]
  totals: UsageTotals
}

export interface GroupUsage extends UsageBucket {
  group_name: string
  gap_core_hours: number
}

export interface PlatformSummary {
  range: BillingRange
  bucket: BillingBucket
  since: number
  until: number
  series: UsageBucket[]
  per_group: GroupUsage[]
  totals: UsageTotals
}

function qs(range: BillingRange, bucket: BillingBucket) {
  return `?range=${range}&bucket=${bucket}`
}

export const billingApi = {
  pod: (name: string, range: BillingRange = '7d', bucket: BillingBucket = 'hour'): Promise<PodUsage> =>
    api.get(`/billing/pods/${encodeURIComponent(name)}${qs(range, bucket)}`),
  summary: (range: BillingRange = '7d', bucket: BillingBucket = 'day'): Promise<PlatformSummary> =>
    api.get(`/billing/summary${qs(range, bucket)}`),
}

// ── 资金层：单价 / 账户 / 台账（/api/billing/*）─────────────────────
export interface ResourcePrice {
  [resourceKey: string]: number
}

export interface BillingAccount {
  group_name: string
  balance_cents: number
  credit_limit_cents: number
  status: 'active' | 'suspended' | 'closed'
  billable: number
  warn_ratio: number
  updated_at?: string
}

export interface LedgerRow {
  id: number
  kind: 'charge' | 'topup' | 'adjustment' | 'refund'
  amount_cents: number
  resource_key: string | null
  units: number | null
  unit_price_cents: number | null
  period_start: number | null
  period_end: number | null
  out_trade_no: string | null
  note: string
  actor: string
  created_at: string
}

export interface PricesResponse {
  prices: ResourcePrice
  labels: Record<string, string>
  keys: string[]
}

export interface GroupAccount {
  group: string
  account: BillingAccount
  balance_ratio: number | null
  blocked: boolean
  ledger: LedgerRow[]
}

export const billingMoneyApi = {
  prices: (): Promise<PricesResponse> => api.get('/billing/prices'),
  account: (group: string, limit = 50): Promise<GroupAccount> =>
    api.get(`/billing/account/${encodeURIComponent(group)}?limit=${limit}`),
  setPrices: (prices: ResourcePrice): Promise<{ ok: boolean; prices: ResourcePrice }> =>
    api.post('/billing/admin/prices', { prices }),
  accounts: (): Promise<{ accounts: BillingAccount[] }> => api.get('/billing/admin/accounts'),
  setAccount: (group: string, body: Partial<Pick<BillingAccount, 'status' | 'billable' | 'credit_limit_cents'>>) =>
    api.post(`/billing/admin/accounts/${encodeURIComponent(group)}`, body),
  adjust: (group: string, amountCents: number, note = '') =>
    api.post('/billing/admin/adjust', { group, amount_cents: amountCents, note }),
  settle: (body: { since?: number; until?: number; dry_run?: boolean } = {}) =>
    api.post('/billing/admin/settle', body),
  income: (since?: number): Promise<{ by_kind: Record<string, { count: number; total_cents: number }> }> =>
    api.get(`/billing/admin/income${since ? `?since=${since}` : ''}`),
}

