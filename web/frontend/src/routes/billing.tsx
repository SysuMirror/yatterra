import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CreditCard, ExternalLink, Copy, RefreshCw, Wallet, AlertTriangle, Receipt, Info, Layers, ArrowRightLeft } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Dialog } from '@/components/ui/Dialog'
import { useToastStore } from '@/stores/toast'
import { useAuth } from '@/hooks/useAuth'
import { payApi, type PayOrder, type PayItem } from '@/api/pay'
import {
  billingMoneyApi,
  type BillingAccount, type LedgerRow,
  type WalletPod, type WalletLedgerRow,
} from '@/api/billing'

const yuan = (cents: number | null | undefined) => `¥${(((cents ?? 0) as number) / 100).toFixed(2)}`

const KIND_LABEL: Record<string, string> = {
  topup: '充值到账', allocate: '分配额度', deallocate: '收回归还', adjustment: '人工调整', refund: '退款',
  charge: '用量扣费', allocation: '分配到本 Pod', deallocation: '收回出账',
}
const ORDER_STATUS: Record<string, string> = {
  pending: '待支付', paid: '已支付', closed: '已关闭', failed: '失败',
}
const POD_STATUS: Record<string, string> = {
  active: '正常', suspended: '已停用', closed: '已关闭',
}

/** 三步说明 —— 让「钱怎么走」一眼看明白。 */
const STEPS = [
  { n: 1, t: '充值进钱包', d: '选一个金额档位下单，用微信小程序付款，付完钱进你自己的钱包（不用先挑组）。' },
  { n: 2, t: '分配给 Pod', d: '在「我的 Pod 额度」把你钱包里的钱分配给你所属的某个 Pod；未分配的钱留着不动。' },
  { n: 3, t: 'Pod 独立扣费', d: '平台按 CPU/GPU/内存/存储用量，每小时从该 Pod 的额度扣一次；额度耗尽会提醒并停机。' },
]

/** 钱包与额度 —— 个人钱包（充值入口）+ 给 Pod 分配额度。 */
export default function Billing() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const { hasPerm } = useAuth()
  const isAdmin = hasPerm('billing.account')
  // 通知深链 /billing?group=<name> 落地即打开该 Pod 的额度明细。
  const [searchParams] = useSearchParams()
  const [openPod, setOpenPod] = useState<string | null>(searchParams.get('group') || null)

  // ── 钱包 + 可分配的 Pod ─────────────────────────────────────────
  const { data: walletData, isLoading: walletLoading, refetch: refetchWallet } = useQuery({
    queryKey: ['billing-wallet'],
    queryFn: () => billingMoneyApi.wallet(50),
    staleTime: 15_000,
  })
  const account = walletData?.account
  const balance = account?.balance_cents ?? 0
  const wLedger: WalletLedgerRow[] = walletData?.ledger ?? []
  const pods: WalletPod[] = walletData?.pods ?? []
  const allocated = useMemo(() => pods.reduce((s, p) => s + Math.max(p.balance_cents, 0), 0), [pods])

  // ── 充值档位 / 我的充值单 ───────────────────────────────────────
  const { data: itemsData } = useQuery({
    queryKey: ['pay-items'],
    queryFn: () => payApi.items(),
    staleTime: 60_000,
  })
  const items = itemsData?.items ?? []
  const configured = itemsData?.configured ?? false

  const { data: ordersData, refetch: refetchOrders } = useQuery({
    queryKey: ['pay-orders'],
    queryFn: () => payApi.orders(50),
    staleTime: 10_000,
  })
  const orders: PayOrder[] = ordersData?.orders ?? []
  const pendingCount = orders.filter((o) => o.status === 'pending').length

  // 待支付订单每 4s 回源查单，付完自动刷新钱包/流水
  const [pending, setPending] = useState<{ no: string; short_url: string; scheme_url: string } | null>(null)
  const pendingQuery = useQuery({
    queryKey: ['pay-order-poll', pending?.no],
    queryFn: async () => (await payApi.order(pending!.no)).order,
    enabled: !!pending,
    refetchInterval: (q) => (q.state.data?.status === 'paid' ? false : 4000),
  })
  const polled = pendingQuery.data
  useEffect(() => {
    if (polled?.status === 'paid') {
      toast({ type: 'success', message: `充值成功：${yuan(polled.credit_cents)} 已进钱包` })
      setPending(null)
      void refetchWallet()
      void refetchOrders()
      void qc.invalidateQueries({ queryKey: ['billing-wallet'] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polled?.status])

  const [creating, setCreating] = useState('')
  const [payStep, setPayStep] = useState(0)

  const jumpPayStep = (index: number) => {
    if (index < payStep) setPayStep(index)
  }
  const createOrder = async (item: PayItem) => {
    setCreating(item.item_key)
    try {
      const r = await payApi.create(item.item_key)
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

  // ── 分配 / 收回 ─────────────────────────────────────────────────
  const [allocFor, setAllocFor] = useState<WalletPod | null>(null)
  const [allocYuan, setAllocYuan] = useState('')
  const [allocNote, setAllocNote] = useState('')
  const [busy, setBusy] = useState(false)

  const doAllocate = async () => {
    if (!allocFor) return
    const cents = Math.round(Number(allocYuan) * 100)
    if (!Number.isFinite(cents) || cents <= 0) { toast({ type: 'error', message: '请输入正的分配金额（元）' }); return }
    if (cents > balance) { toast({ type: 'error', message: '钱包余额不足' }); return }
    setBusy(true)
    try {
      await billingMoneyApi.allocate(allocFor.name, cents, allocNote || '分配额度')
      toast({ type: 'success', message: `已向 ${allocFor.name} 分配 ${yuan(cents)}` })
      setAllocFor(null); setAllocYuan(''); setAllocNote('')
      void refetchWallet()
      void qc.invalidateQueries({ queryKey: ['pod-account', allocFor.name] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '分配失败' })
    } finally {
      setBusy(false)
    }
  }

  const [reclaimFor, setReclaimFor] = useState<WalletPod | null>(null)
  const [reclaimUser, setReclaimUser] = useState('')
  const [reclaimYuan, setReclaimYuan] = useState('')
  const doReclaim = async () => {
    if (!reclaimFor) return
    const cents = Math.round(Number(reclaimYuan) * 100)
    if (!reclaimUser.trim()) { toast({ type: 'error', message: '请填写退回的用户名' }); return }
    if (!Number.isFinite(cents) || cents <= 0) { toast({ type: 'error', message: '请输入正的收回金额（元）' }); return }
    setBusy(true)
    try {
      await billingMoneyApi.deallocate(reclaimUser.trim(), reclaimFor.name, cents, '管理员收回')
      toast({ type: 'success', message: `已从 ${reclaimFor.name} 收回 ${yuan(cents)}` })
      setReclaimFor(null); setReclaimUser(''); setReclaimYuan('')
      void refetchWallet()
      void qc.invalidateQueries({ queryKey: ['pod-account', reclaimFor.name] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '收回失败' })
    } finally {
      setBusy(false)
    }
  }

  // ── 选中 Pod 的额度明细 ────────────────────────────────────────
  const { data: podAcct, isLoading: podLoading } = useQuery({
    queryKey: ['pod-account', openPod],
    queryFn: () => billingMoneyApi.account(openPod as string, 50),
    enabled: !!openPod,
    staleTime: 15_000,
  })
  const podAccount: BillingAccount | undefined = podAcct?.account
  const podLedger: LedgerRow[] = podAcct?.ledger ?? []

  // ── 表格列 ─────────────────────────────────────────────────────
  const podCols: Column<WalletPod>[] = [
    { key: 'name', title: 'Pod', width: 'minmax(120px, 2fr)', render: (p) => (
      <button className="text-left text-accent hover:underline" onClick={() => setOpenPod(p.name)}>{p.name}</button>
    ) },
    { key: 'my_role', title: '我的角色', width: '90px', render: (p) => <span className="text-xs text-muted">{p.my_role === 'owner' ? '创建者' : '成员'}</span> },
    { key: 'balance_cents', title: 'Pod 额度', width: '110px', render: (p) => (
      <span className={`tnum ${p.balance_cents <= 0 ? 'text-bad' : 'text-ink'}`}>{yuan(p.balance_cents)}</span>
    ) },
    { key: 'status', title: '状态', width: '90px', render: (p) => (
      <span className={p.status === 'active' || !p.status ? 'text-ok' : 'text-bad'}>{POD_STATUS[p.status ?? 'active'] ?? p.status}</span>
    ) },
    { key: 'op', title: '操作', width: '150px', render: (p) => (
      <div className="flex items-center gap-3">
        <button className="text-xs text-accent hover:underline" onClick={() => { setAllocFor(p); setAllocYuan('') }}>分配额度</button>
        {isAdmin && (
          <button className="text-xs text-muted hover:underline" onClick={() => { setReclaimFor(p); setReclaimYuan('') }}>收回</button>
        )}
      </div>
    ) },
  ]

  const wLedgerCols: Column<WalletLedgerRow>[] = [
    { key: 'created_at', title: '时间', width: 'minmax(130px, 1fr)', render: (r) => <span className="text-xs text-muted tnum">{r.created_at?.replace('T', ' ').slice(0, 16)}</span> },
    { key: 'kind', title: '类型', width: '110px', render: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { key: 'note', title: '摘要', width: 'minmax(140px, 3fr)', render: (r) => (
      <span className="text-xs">{r.note || (r.group_name ? `→ ${r.group_name}` : '—')}</span>
    ) },
    { key: 'amount_cents', title: '金额', width: '100px', render: (r) => (
      <span className={`tnum ${r.amount_cents < 0 ? 'text-bad' : 'text-ok'}`}>{r.amount_cents > 0 ? '+' : ''}{yuan(r.amount_cents)}</span>
    ) },
    { key: 'balance_after', title: '变动后余额', width: '110px', render: (r) => <span className="tnum text-muted">{r.balance_after == null ? '—' : yuan(r.balance_after)}</span> },
  ]

  const podLedgerCols: Column<LedgerRow>[] = [
    { key: 'created_at', title: '时间', width: 'minmax(130px, 1fr)', render: (r) => <span className="text-xs text-muted tnum">{r.created_at?.replace('T', ' ').slice(0, 16)}</span> },
    { key: 'kind', title: '类型', width: '120px', render: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { key: 'note', title: '摘要', width: 'minmax(140px, 3fr)', render: (r) => <span className="text-xs">{r.note || '—'}</span> },
    { key: 'amount_cents', title: '金额', width: '100px', render: (r) => (
      <span className={`tnum ${r.amount_cents < 0 ? 'text-bad' : 'text-ok'}`}>{r.amount_cents > 0 ? '+' : ''}{yuan(r.amount_cents)}</span>
    ) },
    { key: 'balance_after', title: '变动后余额', width: '110px', render: (r: any) => <span className="tnum text-muted">{r.balance_after == null ? '—' : yuan(r.balance_after)}</span> },
  ]

  const orderCols: Column<PayOrder>[] = [
    { key: 'out_trade_no', title: '订单号', width: 'minmax(140px, 2fr)', render: (o) => <span className="tnum text-xs">{o.out_trade_no}</span> },
    { key: 'subject', title: '商品', width: 'minmax(100px, 2fr)' },
    { key: 'amount_cents', title: '支付', width: '90px', render: (o) => <span className="tnum">{yuan(o.amount_cents)}</span> },
    { key: 'credit_cents', title: '到账', width: '90px', render: (o) => <span className="tnum">{yuan(o.credit_cents)}</span> },
    { key: 'status', title: '状态', width: '80px', render: (o) => <span className={o.status === 'paid' ? 'text-ok' : 'text-muted'}>{ORDER_STATUS[o.status] ?? o.status}</span> },
    { key: 'created_at', title: '下单时间', width: 'minmax(130px, 1fr)', render: (o) => <span className="text-xs text-muted tnum">{o.created_at?.replace('T', ' ').slice(0, 16)}</span> },
  ]

  const aiContext = `钱包与额度\n钱包余额 ${yuan(balance)}，已分配到 Pod ${yuan(allocated)}`
    + `\n可分配 Pod：${pods.map((p) => `${p.name}(${yuan(p.balance_cents)})`).join('、') || '无'}`
    + `\n待支付 ${pendingCount} 笔`

  return (
    <>
      <PageHeader
        title="钱包与额度"
        description="充进个人钱包，再分配给各个 Pod 独立扣费"
        doc={{ section: 'ops', item: 3, label: '计费说明' }}
      >
        <Button variant="secondary" size="sm" onClick={() => { void refetchWallet(); void refetchOrders() }} aria-label="刷新">
          <RefreshCw size={14} /> 刷新
        </Button>
        <PageAiAssistant page="mybilling" context={aiContext} />
      </PageHeader>

      {/* 怎么用 —— 三步 */}
      <Card padding="md" className="mb-5 bg-accent/[0.04] border-accent/20">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-ink"><Info size={15} className="text-accent" /> 怎么用</div>
        <div data-ux="ux-billing-step-jump" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {STEPS.map((s, i) => {
            const done = i < payStep
            const current = i === payStep
            return (
              <button
                key={s.n}
                type="button"
                aria-current={current ? 'step' : undefined}
                onClick={() => jumpPayStep(i)}
                className={`flex gap-2 text-left rounded-lg p-1 transition-colors ${current ? 'bg-white/70 ring-1 ring-accent/30' : done ? 'hover:bg-white/60' : 'cursor-default'}`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${current || done ? 'bg-accent' : 'bg-black/25'}`}>{s.n}</span>
                <span>
                  <span className="block text-sm font-medium text-ink">{s.t}</span>
                  <span className="block text-xs text-muted leading-relaxed">{s.d}</span>
                </span>
              </button>
            )
          })}
        </div>

      </Card>

      {walletLoading ? <SkeletonCard /> : (
        <>
          {/* 钱包概览 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Card padding="md">
              <div className="text-xs text-muted mb-1 flex items-center gap-1"><Wallet size={13} /> 钱包余额</div>
              <div className={`text-2xl font-bold tnum ${balance <= 0 ? 'text-bad' : 'text-ink'}`}>{yuan(balance)}</div>
              <div className="text-[10px] text-muted mt-0.5">已充值、尚未分配的钱</div>
            </Card>
            <Card padding="md">
              <div className="text-xs text-muted mb-1 flex items-center gap-1"><Layers size={13} /> 已分配到 Pod</div>
              <div className="text-2xl font-bold tnum text-ink">{yuan(allocated)}</div>
              <div className="text-[10px] text-muted mt-0.5">各 Pod 当前额度合计</div>
            </Card>
            <Card padding="md">
              <div className="text-xs text-muted mb-1">可分配 Pod</div>
              <div className="text-2xl font-bold tnum text-ink">{pods.length}</div>
              <div className="text-[10px] text-muted mt-0.5">你是其创建者或成员</div>
            </Card>
            <Card padding="md">
              <div className="text-xs text-muted mb-1">待支付订单</div>
              <div className="text-2xl font-bold tnum text-ink">{pendingCount}</div>
              <div className="text-[10px] text-muted mt-0.5">下单后未付款的数量</div>
            </Card>
          </div>

          {account?.status && account.status !== 'active' && (
            <div className="mb-5 flex items-center gap-2 rounded-xl bg-bad/10 border border-bad/25 px-4 py-3 text-sm text-bad">
              <AlertTriangle size={16} /> 你的钱包已被{account.status === 'suspended' ? '冻结' : '关闭'}，暂不能分配额度。请联系管理员。
            </div>
          )}

          {/* 待支付：小程序入口 */}
          {pending && (
            <Card padding="md" className="mb-5 border-accent/30">
              <div className="flex flex-wrap items-center gap-3">
                <CreditCard size={18} className="text-accent" />
                <div className="text-sm">
                  <div className="font-semibold text-ink">订单 {pending.no} 待支付</div>
                  <div className="text-xs text-muted">用微信小程序打开下方链接完成付款；支付成功后本页会自动刷新并进钱包。</div>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  {(pending.scheme_url || pending.short_url) && (
                    <a href={pending.scheme_url || pending.short_url} target="_blank" rel="noreferrer">
                      <Button size="sm"><ExternalLink size={14} /> 去支付</Button>
                    </a>
                  )}
                  <Button size="sm" variant="outline" onClick={() => copy(pending.scheme_url || pending.short_url)}>
                    <Copy size={14} /> 复制链接
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPending(null)}>关闭</Button>
                </div>
              </div>
            </Card>
          )}

          {/* 充值 */}
          <h2 className="text-sm font-semibold text-ink mb-1">给钱包充值</h2>
          <p className="text-xs text-muted mb-2">点击「充值」生成一个微信支付订单，付款成功后金额进入你的钱包（不再选择组）。</p>
          {!configured && (
            <div className="mb-5 rounded-xl bg-warn/10 border border-warn/25 px-4 py-3 text-sm text-warn">
              支付功能尚未配置（缺少 PAY_APP_SECRET），暂时无法下单充值。请联系管理员。
            </div>
          )}
          {items.length === 0 ? (
            <EmptyState icon={<Receipt size={24} />} title="暂无可充值的金额档位" description="请等待管理员上架充值商品。" />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-5">
              {items.map((it) => (
                <Card key={it.item_key} padding="md" hover className="flex flex-col">
                  <div data-ux="ux-billing-amount" className="flex items-baseline gap-2">
                    <span className="text-lg font-bold text-ink tnum">{yuan(it.credit_cents || it.amount_cents)}</span>
                    <span className="text-[10px] text-muted">到账</span>
                  </div>
                  <div className="text-xs text-muted mb-3">
                    {it.title}
                    {it.credit_cents && it.credit_cents !== it.amount_cents
                      ? `（支付 ${yuan(it.amount_cents)}）` : ''}
                  </div>
                  <Button size="sm" className="mt-auto" loading={creating === it.item_key}
                          disabled={!configured} onClick={() => createOrder(it)}>
                    充值
                  </Button>
                </Card>
              ))}
            </div>
          )}

          {/* 我的 Pod 额度 */}
          <Card padding="none" className="mb-5">
            <div className="px-4 py-3 border-b border-black/[0.06]">
              <div className="text-sm font-semibold text-ink">我的 Pod 额度</div>
              <div className="text-xs text-muted">把你钱包的钱分配给你所属的 Pod，各 Pod 独立扣费、互不影响。分配需是 Pod 的创建者或成员。</div>
            </div>
            <div className="p-2">
              <DataTable columns={podCols} data={pods} keyFn={(p) => p.name}
                         empty={<EmptyState icon={<Layers size={20} />} title="还没有可分配的 Pod"
                                            description="你目前不是任何 Pod 的成员（或尚未创建）。加入或创建一个 Pod 后即可在这里分配额度。" />} />
            </div>
          </Card>

          {/* 选中 Pod 的额度明细 */}
          {openPod && (
            <Card padding="none" className="mb-5 border-accent/30">
              <div className="px-4 py-3 border-b border-black/[0.06] flex flex-wrap items-center gap-3">
                <div>
                  <div className="text-sm font-semibold text-ink">Pod「{openPod}」额度明细</div>
                  <div className="text-xs text-muted">
                    当前额度 {podLoading ? '…' : yuan(podAccount?.balance_cents ?? 0)}
                    {podAccount?.status && podAccount.status !== 'active' ? ` · ${POD_STATUS[podAccount.status] ?? podAccount.status}` : ''}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setOpenPod(null)}>收起</Button>
                </div>
              </div>
              <div className="p-2">
                <DataTable columns={podLedgerCols} data={podLedger as any} keyFn={(r: any) => String(r.id)}
                           empty={<EmptyState icon={<Receipt size={20} />} title="暂无记录" description="分配额度或产生用量后这里会出现记录。" />} />
              </div>
            </Card>
          )}

          {/* 钱包流水 + 充值订单 */}
          <div className="space-y-5">
            <Card padding="none">
              <div className="px-4 py-3 border-b border-black/[0.06]">
                <div className="text-sm font-semibold text-ink">钱包流水</div>
                <div className="text-xs text-muted">充值入账、分配出去、收回退回的记录；负数为分配给 Pod，正数为充值/退回。</div>
              </div>
              <div className="p-2">
                <DataTable columns={wLedgerCols} data={wLedger as any} keyFn={(r: any) => String(r.id)}
                           empty={<EmptyState icon={<Receipt size={20} />} title="暂无流水" description="充值或分配后这里会出现记录。" />} />
              </div>
            </Card>

            <Card padding="none">
              <div className="px-4 py-3 border-b border-black/[0.06]">
                <div className="text-sm font-semibold text-ink">充值订单</div>
                <div className="text-xs text-muted">你为钱包下的所有充值单（含未付款的）。</div>
              </div>
              <div className="p-2">
                <DataTable columns={orderCols} data={orders} keyFn={(o) => o.out_trade_no}
                           empty={<EmptyState icon={<Receipt size={20} />} title="暂无订单" description="点击上方金额档位即可下单。" />} />
              </div>
            </Card>
          </div>
        </>
      )}

      {/* 分配额度 */}
      <Dialog open={!!allocFor} onClose={() => setAllocFor(null)}
              title={`分配额度 · ${allocFor?.name ?? ''}`} width="max-w-sm">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            钱包余额 {yuan(balance)}。分配会把钱从你的钱包转入该 Pod 的独立额度，Pod 从中按用量扣费。
          </p>
          <Input label="分配金额（元）" type="number" step="0.01" value={allocYuan}
                 onChange={(e) => setAllocYuan(e.target.value)} placeholder="如 50" />
          <Input label="备注" value={allocNote} onChange={(e) => setAllocNote(e.target.value)} placeholder="可选" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAllocFor(null)}>取消</Button>
            <Button loading={busy} onClick={doAllocate}><ArrowRightLeft size={14} /> 确认分配</Button>
          </div>
        </div>
      </Dialog>

      {/* 管理员收回 */}
      <Dialog open={!!reclaimFor} onClose={() => setReclaimFor(null)}
              title={`收回归还 · ${reclaimFor?.name ?? ''}`} width="max-w-sm">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            把该 Pod 未用完的额度退回指定用户的钱包（仅管理员）。金额以 Pod 当前余额为上限。
          </p>
          <Input label="退回到的用户名" value={reclaimUser} onChange={(e) => setReclaimUser(e.target.value)} placeholder="如 alice" />
          <Input label="收回金额（元）" type="number" step="0.01" value={reclaimYuan}
                 onChange={(e) => setReclaimYuan(e.target.value)} placeholder="如 20" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setReclaimFor(null)}>取消</Button>
            <Button loading={busy} onClick={doReclaim}>确认收回</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
