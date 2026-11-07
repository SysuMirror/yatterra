import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CreditCard, ExternalLink, Copy, RefreshCw, Wallet, AlertTriangle, Receipt } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToastStore } from '@/stores/toast'
import { podsApi } from '@/api/pods'
import { payApi, type PayOrder, type PayItem } from '@/api/pay'
import type { LedgerRow } from '@/api/billing'

const yuan = (cents: number | null | undefined) => `¥${(((cents ?? 0) as number) / 100).toFixed(2)}`

const KIND_LABEL: Record<string, string> = {
  charge: '用量扣费', topup: '充值', adjustment: '人工调整', refund: '退款',
}
const ORDER_STATUS: Record<string, string> = {
  pending: '待支付', paid: '已支付', closed: '已关闭', failed: '失败',
}

/** 我的充值 / 账单 —— 组选择、余额、充值下单、台账（成员可见自己组）。 */
export default function Billing() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [group, setGroup] = useState('')

  const { data: podData } = useQuery({
    queryKey: ['pods-for-billing'],
    queryFn: () => podsApi.list({ per_page: 200 }),
    staleTime: 60_000,
  })
  const groupOptions = useMemo(
    () => (podData?.items ?? []).map((p) => ({ value: p.name, label: p.name })),
    [podData],
  )
  // default to the first group once loaded
  const activeGroup = group || groupOptions[0]?.value || ''

  const { data: itemsData } = useQuery({
    queryKey: ['pay-items'],
    queryFn: () => payApi.items(),
    staleTime: 60_000,
  })
  const items = itemsData?.items ?? []
  const configured = itemsData?.configured ?? false

  const { data: acctData, isLoading: acctLoading, refetch: refetchAcct } = useQuery({
    queryKey: ['pay-account', activeGroup],
    queryFn: () => payApi.account(activeGroup, 50),
    enabled: !!activeGroup,
    staleTime: 15_000,
  })
  const account = acctData?.account
  const ledger: LedgerRow[] = acctData?.ledger ?? []
  const balance = account?.balance_cents ?? 0
  const blocked = acctData?.blocked ?? false

  const { data: ordersData, refetch: refetchOrders } = useQuery({
    queryKey: ['pay-orders', activeGroup],
    queryFn: () => payApi.orders(activeGroup, 50),
    enabled: !!activeGroup,
    staleTime: 10_000,
  })
  const orders: PayOrder[] = ordersData?.orders ?? []

  // 待支付订单每 4s 回源查单，付完自动刷新余额/台账
  const [pending, setPending] = useState<{ no: string; short_url: string; scheme_url: string } | null>(null)
  const pendingQuery = useQuery({
    queryKey: ['pay-order-poll', pending?.no],
    queryFn: async () => {
      const r = await payApi.order(pending!.no)
      return r.order
    },
    enabled: !!pending,
    refetchInterval: (q) => (q.state.data?.status === 'paid' ? false : 4000),
  })
  const polled = pendingQuery.data
  useEffect(() => {
    if (polled?.status === 'paid') {
      toast({ type: 'success', message: `充值成功：${yuan(polled.credit_cents)} 已到账` })
      setPending(null)
      void refetchAcct()
      void refetchOrders()
      void qc.invalidateQueries({ queryKey: ['pay-orders', activeGroup] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polled?.status])

  const [creating, setCreating] = useState('')
  const createOrder = async (item: PayItem) => {
    if (!activeGroup) { toast({ type: 'warning', message: '请先选择一个组' }); return }
    setCreating(item.item_key)
    try {
      const r = await payApi.create(item.item_key, activeGroup)
      setPending({ no: r.out_trade_no, short_url: r.short_url, scheme_url: r.scheme_url })
      toast({ type: 'info', message: '订单已创建，请在小程序内完成支付' })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '下单失败' })
    } finally {
      setCreating('')
    }
  }

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast({ type: 'success', message: '已复制' }),
      () => toast({ type: 'error', message: '复制失败' }),
    )
  }

  const orderCols: Column<PayOrder>[] = [
    { key: 'out_trade_no', title: '订单号', width: 'minmax(140px, 2fr)', render: (o) => <span className="tnum text-xs">{o.out_trade_no}</span> },
    { key: 'subject', title: '商品', width: 'minmax(100px, 2fr)' },
    { key: 'amount_cents', title: '金额', width: '90px', render: (o) => <span className="tnum">{yuan(o.amount_cents)}</span> },
    { key: 'credit_cents', title: '到账', width: '90px', render: (o) => <span className="tnum">{yuan(o.credit_cents)}</span> },
    { key: 'status', title: '状态', width: '80px', render: (o) => <span className={o.status === 'paid' ? 'text-ok' : 'text-muted'}>{ORDER_STATUS[o.status] ?? o.status}</span> },
    { key: 'created_at', title: '创建', width: 'minmax(120px, 1fr)', render: (o) => <span className="text-xs text-muted tnum">{o.created_at?.replace('T', ' ').slice(0, 19)}</span> },
  ]
  const ledgerCols: Column<LedgerRow>[] = [
    { key: 'created_at', title: '时间', width: 'minmax(120px, 1fr)', render: (r) => <span className="text-xs text-muted tnum">{r.created_at?.replace('T', ' ').slice(0, 19)}</span> },
    { key: 'kind', title: '类型', width: '90px', render: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { key: 'note', title: '摘要', width: 'minmax(140px, 3fr)', render: (r) => <span className="text-xs">{r.note || '—'}</span> },
    { key: 'amount_cents', title: '金额', width: '100px', render: (r) => (
      <span className={`tnum ${r.amount_cents < 0 ? 'text-bad' : 'text-ok'}`}>{r.amount_cents > 0 ? '+' : ''}{yuan(r.amount_cents)}</span>
    ) },
    { key: 'balance_after', title: '余额', width: '100px', render: (r: any) => <span className="tnum text-muted">{yuan(r.balance_after)}</span> },
  ]

  const aiContext = activeGroup
    ? `充值/账单 · 组 ${activeGroup}\n余额 ${yuan(balance)}${account?.credit_limit_cents ? ` / 额度 ${yuan(account.credit_limit_cents)}` : ''}`
      + `${blocked ? ' · 已欠费停用' : ''}\n待支付 ${orders.filter((o) => o.status === 'pending').length} 笔`
    : ''

  return (
    <>
      <PageHeader
        title="充值 / 账单"
        description="预付费余额：充值到组，按用量每小时扣减"
        count={activeGroup || undefined}
        doc={{ section: 'ops', item: 3, label: '计费文档' }}
      >
        <div className="w-44">
          <Select value={activeGroup} onChange={setGroup} options={groupOptions} placeholder="选择组" />
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void refetchAcct(); void refetchOrders() }} aria-label="刷新">
          <RefreshCw size={14} /> 刷新
        </Button>
        <PageAiAssistant page="mybilling" context={aiContext} />
      </PageHeader>

      {!activeGroup ? (
        <EmptyState icon={<Wallet size={24} />} title="还没有可管理的组" description="加入一个 Pod 后即可查看余额与充值。" />
      ) : acctLoading ? (
        <SkeletonCard />
      ) : (
        <>
          {/* 余额概览 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Card padding="md">
              <div className="text-xs text-muted mb-1 flex items-center gap-1"><Wallet size={13} /> 可用余额</div>
              <div className={`text-2xl font-bold tnum ${balance <= 0 ? 'text-bad' : 'text-ink'}`}>{yuan(balance)}</div>
            </Card>
            <Card padding="md">
              <div className="text-xs text-muted mb-1">信用额度</div>
              <div className="text-2xl font-bold tnum text-ink">{yuan(account?.credit_limit_cents)}</div>
            </Card>
            <Card padding="md">
              <div className="text-xs text-muted mb-1">计费状态</div>
              <div className={`text-2xl font-bold ${blocked ? 'text-bad' : 'text-ok'}`}>
                {blocked ? '已停用' : (account?.status === 'active' ? '正常' : account?.status ?? '正常')}
              </div>
            </Card>
            <Card padding="md">
              <div className="text-xs text-muted mb-1">待支付订单</div>
              <div className="text-2xl font-bold tnum text-ink">{orders.filter((o) => o.status === 'pending').length}</div>
            </Card>
          </div>

          {balance <= 0 && (
            <div className="mb-5 flex items-center gap-2 rounded-xl bg-bad/10 border border-bad/25 px-4 py-3 text-sm text-bad">
              <AlertTriangle size={16} /> 余额已耗尽，资源可能被降级或停机，请尽快充值。
            </div>
          )}

          {/* 待支付：小程序入口 */}
          {pending && (
            <Card padding="md" className="mb-5 border-accent/30">
              <div className="flex flex-wrap items-center gap-3">
                <CreditCard size={18} className="text-accent" />
                <div className="text-sm">
                  <div className="font-semibold text-ink">订单 {pending.no} 待支付</div>
                  <div className="text-xs text-muted">请复制下方链接或在微信小程序中打开完成支付；支付后本页自动刷新。</div>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  {(pending.scheme_url || pending.short_url) && (
                    <a href={pending.scheme_url || pending.short_url} target="_blank" rel="noreferrer">
                      <Button size="sm"><ExternalLink size={14} /> 打开支付</Button>
                    </a>
                  )}
                  <Button size="sm" variant="outline" onClick={() => copy(pending.scheme_url || pending.short_url)}>
                    <Copy size={14} /> 复制链接
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPending(null)}>取消</Button>
                </div>
              </div>
            </Card>
          )}

          {/* 充值商品 */}
          <h2 className="text-sm font-semibold text-ink mb-2">选择充值金额</h2>
          {!configured && (
            <div className="mb-5 rounded-xl bg-warn/10 border border-warn/25 px-4 py-3 text-sm text-[#9a6700]">
              支付未配置（缺少 PAY_APP_SECRET），暂时无法下单。
            </div>
          )}
          {items.length === 0 ? (
            <EmptyState icon={<Receipt size={24} />} title="暂无可充值的商品" description="请等待管理员上架充值商品。" />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-5">
              {items.map((it) => (
                <Card key={it.item_key} padding="md" hover className="flex flex-col">
                  <div className="text-lg font-bold text-ink tnum">{yuan(it.amount_cents)}</div>
                  <div className="text-xs text-muted mb-3">{it.title}{it.description ? ` · ${it.description}` : ''}</div>
                  <Button size="sm" className="mt-auto" loading={creating === it.item_key}
                          disabled={!configured} onClick={() => createOrder(it)}>
                    充值
                  </Button>
                </Card>
              ))}
            </div>
          )}

          {/* 订单 + 台账 */}
          <div className="space-y-5">
            <Card padding="none">
              <div className="px-4 py-3 text-sm font-semibold text-ink border-b border-black/[0.06]">充值订单</div>
              <div className="p-2">
                <DataTable columns={orderCols} data={orders} keyFn={(o) => o.out_trade_no}
                           empty={<EmptyState icon={<Receipt size={20} />} title="暂无订单" />} />
              </div>
            </Card>

            <Card padding="none">
              <div className="px-4 py-3 text-sm font-semibold text-ink border-b border-black/[0.06]">账单明细（台账）</div>
              <div className="p-2">
                <DataTable columns={ledgerCols} data={ledger as any} keyFn={(r: any) => String(r.id)}
                           empty={<EmptyState icon={<Receipt size={20} />} title="暂无账单" />} />
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  )
}
