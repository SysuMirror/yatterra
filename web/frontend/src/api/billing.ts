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
  /** 平台内部组（不计费）— 由 /admin/accounts join groups.json 得出 */
  internal?: boolean
  /** 尚未建账（无 billing_accounts 行）—— 列表为覆盖全部组而合成的默认行 */
  synthetic?: boolean
  updated_at?: string | null
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

// ── 个人钱包 + Pod 额度分配（两层资金）─────────────────────────
export interface WalletAccount {
  username: string
  balance_cents: number
  credit_limit_cents: number
  status: 'active' | 'suspended' | 'closed'
  warn_ratio: number
  updated_at?: string
  /** /admin/wallets join users 得到 */
  label?: string
}

export interface WalletLedgerRow {
  id: number
  kind: 'topup' | 'allocate' | 'deallocate' | 'adjustment' | 'refund'
  amount_cents: number
  group_name: string | null
  balance_after: number | null
  out_trade_no: string | null
  transfer_token: string | null
  note: string
  actor: string
  created_at: string
}

/** 一个可分配的 Pod（调用者是其 owner/member；管理员看全部计费组）。 */
export interface WalletPod {
  name: string
  my_role: 'owner' | 'member'
  balance_cents: number
  status: string | null
  billable: number
}

export interface WalletResponse {
  username: string
  account: WalletAccount
  balance_ratio: number | null
  ledger: WalletLedgerRow[]
  pods: WalletPod[]
}

export interface TransferResult {
  ok: boolean
  balance_cents: number | null
  reused: boolean
}

export interface MyGroupAccount {
  group: string
  balance_cents: number
  credit_limit_cents: number
  status: 'active' | 'suspended' | 'closed'
  billable: number
  internal: boolean
  blocked: boolean
}

/** 计费运行自检 —— 「为什么没扣费」一眼可见(只读, 仅计费台账管理员)。 */
export interface BillingHealth {
  prices: { keys: number; set: number; nonzero: Record<string, number> }
  settle: { last_period_end: number | null; charges: number; charged_cents: number }
  pay: { configured: boolean; orders: number; paid: number; credit_cents: number }
  accounts: {
    total: number
    internal: number
    billable: number
    suspended: string[]
    arrears: string[]
    zombies: string[]
    /** 外部组里计费开关是关的 */
    external_off?: string[]
  }
  policy?: BillingPolicy
  /** 单价 > 0、结算出过账、且欠费限制已打开 */
  ok: boolean
}

export interface BillingPolicy {
  arrears_limit: boolean
  settle_from: number | null
  updated_by: string
  /** 环境允许欠费后缩到 0 副本。关掉时，打开欠费限制也只扣费和提醒。 */
  auto_suspend?: boolean
}

/** 归属按钮上的字。外部且计费关不能写成「计费」。 */
export function billingScopeLabel(a: { internal?: boolean; billable?: number }) {
  if (a.internal) return '平台内部 · 免计费'
  return a.billable ? '外部 · 计费开' : '外部 · 计费关'
}

export const billingMoneyApi = {
  prices: (): Promise<PricesResponse> => api.get('/billing/prices'),
  /** 计费体检：单价/结算/支付/账户四环自检。 */
  health: (): Promise<BillingHealth> => api.get('/billing/admin/health'),
  policy: (): Promise<BillingPolicy> => api.get('/billing/admin/policy'),
  setPolicy: (arrearsLimit: boolean): Promise<{ ok: boolean; policy: BillingPolicy }> =>
    api.post('/billing/admin/policy', { arrears_limit: arrearsLimit }),
  /** 调用者可见的各组余额/状态 —— 一次请求（替代逐组 /account/<name> 扇出）。 */
  myAccounts: (): Promise<{ accounts: MyGroupAccount[]; count: number }> =>
    api.get('/billing/accounts/mine'),
  account: (group: string, limit = 50): Promise<GroupAccount> =>
    api.get(`/billing/account/${encodeURIComponent(group)}?limit=${limit}`),
  setPrices: (prices: ResourcePrice): Promise<{ ok: boolean; prices: ResourcePrice }> =>
    api.post('/billing/admin/prices', { prices }),
  accounts: (): Promise<{ accounts: BillingAccount[] }> => api.get('/billing/admin/accounts'),
  setAccount: (group: string, body: Partial<Pick<BillingAccount, 'status' | 'billable' | 'credit_limit_cents'>>) =>
    api.post(`/billing/admin/accounts/${encodeURIComponent(group)}`, body),
  /** 一键「恢复并启动」：解冻账户 + 把被停机的 Pod 拉起来。 */
  restoreAccount: (group: string, start = true): Promise<{ ok: boolean; started: boolean; account: BillingAccount; start_result: unknown }> =>
    api.post(`/billing/admin/accounts/${encodeURIComponent(group)}/restore`, { start }),
  bulkAccounts: (groups: string[], body: { internal?: boolean; billable?: number }): Promise<{ ok: boolean; updated: string[]; errors: { group: string; error: string }[] }> =>
    api.post('/billing/admin/accounts/bulk', { groups, ...body }),
  adjust: (group: string, amountCents: number, note = '') =>
    api.post('/billing/admin/adjust', { group, amount_cents: amountCents, note }),
  settle: (body: { since?: number; until?: number; dry_run?: boolean } = {}) =>
    api.post('/billing/admin/settle', body),
  income: (since?: number): Promise<{ by_kind: Record<string, { count: number; total_cents: number }> }> =>
    api.get(`/billing/admin/income${since ? `?since=${since}` : ''}`),

  // ── 个人钱包 + 分配 ────────────────────────────────────────────
  /** 调用者本人钱包 + 可分配的 Pod 列表（无路径参数，不怕越权）。 */
  wallet: (limit = 50): Promise<WalletResponse> => api.get(`/billing/wallet?limit=${limit}`),
  /** 从本人钱包分配额度给某 Pod（owner/member 均可，花自己的钱）。 */
  allocate: (group: string, amountCents: number, note = '', token?: string): Promise<TransferResult> =>
    api.post('/billing/allocate', { group, amount_cents: amountCents, note, token }),
  /** 管理员收回：把某 Pod 未用完的额度退回指定用户钱包。 */
  deallocate: (username: string, group: string, amountCents: number, note = ''): Promise<TransferResult> =>
    api.post('/billing/deallocate', { username, group, amount_cents: amountCents, note }),

  // ── 管理端钱包 ────────────────────────────────────────────────
  adminWallets: (): Promise<{ wallets: WalletAccount[] }> => api.get('/billing/admin/wallets'),
  adminWalletSet: (username: string, body: Partial<Pick<WalletAccount, 'status' | 'credit_limit_cents'>>) =>
    api.post(`/billing/admin/wallets/${encodeURIComponent(username)}`, body),
  adminWalletAdjust: (username: string, amountCents: number, note = '') =>
    api.post('/billing/admin/wallet/adjust', { username, amount_cents: amountCents, note }),
  adminAllocate: (username: string, group: string, amountCents: number, direction: 'in' | 'out' = 'in', note = '') =>
    api.post('/billing/admin/allocate', { username, group, amount_cents: amountCents, direction, note }),

  // ── 活动：按 tag 给 Pod 发额度 ─────────────────────────────────
  /** 按标签聚合各组（预览「某 tag 下有哪些 Pod、余额合计」）。 */
  adminTags: (): Promise<TagsResponse> => api.get('/billing/admin/tags'),
  /** 按 tag 给一批 Pod 发放额度（幂等；同 batch 重放不重复加钱）。 */
  grantByTag: (tag: string, amountCents: number, opts: { note?: string; batch?: string } = {}): Promise<GrantByTagResult> =>
    api.post('/billing/admin/grant-by-tag', { tag, amount_cents: amountCents, ...opts }),
}

export interface TagBucket {
  tag: string
  count: number
  balance_cents: number
  internal: number
  groups: string[]
}

export interface TagsResponse {
  tags: TagBucket[]
  untagged: number
  count: number
}

export interface GrantByTagResult {
  ok: boolean
  tag: string
  amount_cents: number
  batch: string
  granted: { group: string; balance_cents: number | null; reused: boolean }[]
  skipped: { group: string; reason: string }[]
}

