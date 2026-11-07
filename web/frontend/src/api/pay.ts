import { api } from './client'
import type { BillingAccount, LedgerRow } from './billing'

export interface PayAccount {
  group: string
  account: BillingAccount | null
  blocked: boolean
  ledger: LedgerRow[]
}

/** 学人汇「通用开放支付」充值接口（/api/billing/pay/*）。 */

export interface PayItem {
  item_key: string
  title: string
  amount_cents: number
  credit_cents: number
  description: string | null
  sort_order: number
  is_active: number
}

export interface PayOrder {
  out_trade_no: string
  fs_order_no: string | null
  item_key: string
  subject: string | null
  amount_cents: number
  credit_cents: number
  group_name: string
  username: string | null
  /** 'wallet' (记入个人钱包) | 'group' (legacy 组账户) */
  credit_target?: 'wallet' | 'group'
  status: string
  transaction_id: string | null
  paid_at: string | null
  created_at: string
}

export interface CreateResult {
  ok: boolean
  reused?: boolean
  out_trade_no: string
  amount_cents: number
  credit_cents: number
  currency: string
  subject: string
  short_url: string
  scheme_url: string
  order?: PayOrder
}

export interface PayStats {
  total: { orders: number; paid: number; amount_cents: number; credit_cents: number }
  today: { orders: number; paid: number; amount_cents: number; credit_cents: number }
  active_items: number
}

export const payApi = {
  items: (): Promise<{ items: PayItem[]; configured: boolean }> => api.get('/billing/pay/items'),
  /** 充值进**自己的钱包**(不再选组);group 仅为兼容旧调用保留、会被忽略。 */
  create: (itemKey: string, group?: string): Promise<CreateResult> =>
    api.post('/billing/pay/create', group ? { item_key: itemKey, group } : { item_key: itemKey }),
  order: (no: string): Promise<{ order: PayOrder }> =>
    api.get(`/billing/pay/order/${encodeURIComponent(no)}`),
  orders: (limit = 50): Promise<{ orders: PayOrder[] }> =>
    api.get(`/billing/pay/orders?limit=${limit}`),
  account: (group: string, limit = 50): Promise<PayAccount> =>
    api.get(`/billing/pay/account/${encodeURIComponent(group)}?limit=${limit}`),

  // admin
  adminItems: (): Promise<{ items: PayItem[] }> => api.get('/billing/pay/admin/items'),
  upsertItem: (body: Partial<PayItem> & { item_key: string; title: string; amount_cents: number }) =>
    api.post('/billing/pay/admin/items', body),
  deleteItem: (key: string) => api.post(`/billing/pay/admin/items/${encodeURIComponent(key)}/delete`),
  adminOrders: (limit = 50, group?: string): Promise<{ orders: PayOrder[] }> =>
    api.get(`/billing/pay/admin/orders?limit=${limit}${group ? `&group=${encodeURIComponent(group)}` : ''}`),
  adminStats: (): Promise<PayStats> => api.get('/billing/pay/admin/stats'),
  reconcile: (limit = 100) => api.get(`/billing/pay/admin/reconcile?limit=${limit}`),
}
