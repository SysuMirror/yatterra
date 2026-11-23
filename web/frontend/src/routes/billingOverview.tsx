import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Wallet, Receipt, CreditCard, Coins, Layers, AlertTriangle, ChevronRight,
  Ban, ShieldCheck, TrendingUp, PackageCheck, Building2, Activity, CheckCircle2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { ArrearsPolicyCard } from '@/components/billing/ArrearsPolicyCard'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { payApi } from '@/api/pay'
import { billingMoneyApi, billingScopeLabel, type BillingAccount, type GrantByTagResult } from '@/api/billing'
import { useToastStore } from '@/stores/toast'
import { useAuth } from '@/hooks/useAuth'

const yuan = (cents: number | null | undefined) => `¥${(((cents ?? 0) as number) / 100).toFixed(2)}`

/** 计费总览 —— 账户/充值/单价/平台账单的统一落地页(侧栏「计费」组标题指向这里)。 */
export default function BillingOverview() {
  const { hasPerm } = useAuth()
  const canPay = hasPerm('billing.pay')
  const canPrice = hasPerm('billing.price')
  const canAccount = hasPerm('billing.account')
  const canPlatform = hasPerm('ops.audit')
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [acctQuery, setAcctQuery] = useState('')
  const [acctView, setAcctView] = useState<'all' | 'internal' | 'external'>('all')
  const [byBalance, setByBalance] = useState(false)

  // 我的组 + 各组余额 —— 单请求聚合(替代逐组 /account/<name> 扇出)
  const { data: mineData, isLoading: acctLoading } = useQuery({
    queryKey: ['billing-overview-mine'],
    queryFn: () => billingMoneyApi.myAccounts(),
    staleTime: 30_000,
  })
  const groups = useMemo(() => (mineData?.accounts ?? []).map((m) => m.group), [mineData])
  const acct = useMemo(() => {
    if (!mineData) return undefined
    let balance = 0
    const alerts: { group: string; balance: number; blocked: boolean }[] = []
    for (const m of mineData.accounts) {
      balance += m.balance_cents
      if (m.blocked || m.balance_cents <= 0) alerts.push({ group: m.group, balance: m.balance_cents, blocked: m.blocked })
    }
    return { balance, alerts, count: mineData.accounts.length }
  }, [mineData])

  // 我的充值订单(含未付款)
  const { data: ordersData } = useQuery({
    queryKey: ['billing-overview-orders'],
    queryFn: () => payApi.orders(100),
    staleTime: 20_000,
  })
  const orders = ordersData?.orders ?? []
  const pendingCount = orders.filter((o) => o.status === 'pending').length

  // 平台充值统计(仅计费台账管理员)
  const { data: stats } = useQuery({
    queryKey: ['pay-admin-stats'],
    queryFn: () => payApi.adminStats(),
    enabled: canAccount,
    staleTime: 60_000,
    retry: false,
  })

  // 计费体检(仅计费台账管理员)—— 单价/结算/支付/账户四环自检
  const { data: health } = useQuery({
    queryKey: ['billing-health'],
    queryFn: () => billingMoneyApi.health(),
    enabled: canAccount,
    staleTime: 60_000,
    retry: false,
  })

  // 组计费归属(内部=免计费 / 外部=计费)+ 计费开关 —— 仅计费台账管理员
  const { data: acctsData } = useQuery({
    queryKey: ['billing-accounts'],
    queryFn: () => billingMoneyApi.accounts(),
    enabled: canAccount,
    staleTime: 30_000,
    retry: false,
  })
  const accts = acctsData?.accounts ?? []
  const internalCount = accts.filter((a) => a.internal).length
  const viewAccts = useMemo(() => {
    const rows = acctsData?.accounts ?? []
    const q = acctQuery.trim().toLowerCase()
    const filtered = rows.filter((a) => {
      if (acctView === 'internal' && !a.internal) return false
      if (acctView === 'external' && a.internal) return false
      if (!q) return true
      const id = String((a as BillingAccount & { id?: string | number }).id ?? '')
      return a.group_name.toLowerCase().includes(q) || id.toLowerCase().includes(q)
    })
    if (!byBalance) return filtered
    return [...filtered].sort((a, b) => b.balance_cents - a.balance_cents)
  }, [acctsData, acctQuery, acctView, byBalance])

  const refreshAccounts = () => {
    void qc.invalidateQueries({ queryKey: ['billing-accounts'] })
    void qc.invalidateQueries({ queryKey: ['billing-health'] })
  }
  const setInternal = async (a: BillingAccount, flag: boolean) => {
    try {
      await billingMoneyApi.bulkAccounts([a.group_name], { internal: flag })
      toast({
        type: 'success',
        message: flag
          ? `${a.group_name} → 平台内部，不结算、不提醒`
          : `${a.group_name} → 外部。计费开关不会自动打开；欠费限制关闭时也不会扣费`,
      })
      refreshAccounts()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }
  const setBillable = async (a: BillingAccount) => {
    try {
      await billingMoneyApi.setAccount(a.group_name, { billable: a.billable ? 0 : 1 })
      refreshAccounts()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const alerts = acct?.alerts ?? []
  const aiContext =
    `计费总览: 我的组 ${groups.length} 个, 余额合计 ${yuan(acct?.balance)}, ` +
    `欠费/停用 ${alerts.length} 个, 待支付订单 ${pendingCount}` +
    (stats ? `; 平台累计充值 ${yuan(stats.total.amount_cents)}, 今日充值 ${yuan(stats.today.amount_cents)}, 上架档位 ${stats.active_items}` : '') +
    (health ? `; 计费状态 ${health.ok ? '运行中' : '未启用'}（单价 ${health.prices.set}/${health.prices.keys}, 结算 ${health.settle.charges} 笔）` : '')

  return (
    <>
      <PageHeader
        title="计费总览"
        description="账户余额、充值、单价与平台核时账单的统一入口"
        doc={{ section: 'ops', item: 3, label: '计费说明' }}
      >
        <PageAiAssistant page="mybilling" context={aiContext} />
      </PageHeader>

      {canAccount && <ArrearsPolicyCard />}
      {canAccount && (
        <Card data-onboarding-target="billing-internal" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">计费归属</h2>
            <Badge variant="muted">平台内部 {internalCount} · 外部 {accts.length - internalCount}</Badge>
          </div>
          <p className="text-xs text-muted mb-3">
            「平台内部」不结算、不提醒，和集群内端口无关。改回外部不会自动打开计费开关。
            欠费限制关闭时，外部组也不扣费、不停机。
          </p>
          <AccountScopeTable
            accts={accts}
            view={acctView}
            shown={viewAccts}
            query={acctQuery}
            byBalance={byBalance}
            onView={setAcctView}
            onQuery={setAcctQuery}
            onBalance={setByBalance}
            onInternal={setInternal}
            onBillable={setBillable}
          />
        </Card>
      )}

      {/* 我的账户总览 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {acctLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<Layers size={15} className="text-accent" />} label="我的组" value={groups.length} suffix="个" />
            <MetricCard
              icon={<Wallet size={15} className="text-ok" />}
              label="余额合计"
              value={acctLoading ? '—' : yuan(acct?.balance)}
            />
            <MetricCard
              icon={<AlertTriangle size={15} className="text-warn" />}
              label="欠费/停用"
              value={acctLoading ? '—' : alerts.length}
              suffix="个"
              color={alerts.length > 0 ? 'warn' : undefined}
            />
            <MetricCard icon={<CreditCard size={15} className="text-accent" />} label="待支付订单" value={pendingCount} suffix="笔" />
          </>
        )}
      </div>

      {/* 平台充值统计 —— 仅计费台账管理员可见 */}
      {canAccount && stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <MetricCard icon={<TrendingUp size={15} className="text-accent" />} label="平台累计充值" value={yuan(stats.total.amount_cents)} />
          <MetricCard icon={<TrendingUp size={15} className="text-ok" />} label="今日充值" value={yuan(stats.today.amount_cents)} />
          <MetricCard icon={<Receipt size={15} className="text-accent" />} label="已支付订单" value={stats.total.paid} suffix="笔" />
          <MetricCard icon={<PackageCheck size={15} className="text-accent" />} label="上架档位" value={stats.active_items} suffix="个" />
        </div>
      )}

      {/* 计费体检 —— 让「为什么没扣费」一眼可见,仅计费台账管理员 */}
      {canAccount && health && (
        <Card data-onboarding-target="billing-health" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Activity size={16} className={health.ok ? 'text-ok' : 'text-warn'} />
            <h2 className="text-sm font-semibold">计费体检</h2>
            <Badge variant={health.ok ? 'ok' : 'warn'}>{health.ok ? '运行中' : '未启用'}</Badge>
          </div>
          <p className="text-xs text-muted mb-3">
            只读自检:单价 → 结算 → 支付 → 账户。任何一环没通,计费就不会真正发生。
          </p>
          <div className="space-y-1.5">
            <HealthRow
              ok={health.prices.set > 0}
              label="资源单价"
              detail={health.prices.set > 0
                ? `已设 ${health.prices.set}/${health.prices.keys} 项`
                : `全部为 0(${health.prices.keys} 项)—— 结算恒定 0,不会扣任何费`}
            />
            <HealthRow
              ok={health.settle.charges > 0}
              label="结算运行"
              detail={health.settle.charges > 0
                ? `累计 ${health.settle.charges} 笔 · ${yuan(health.settle.charged_cents)}`
                : '从未结算过 —— 结算守护没跑,或单价为 0 没有可扣的费'}
            />
            <HealthRow
              ok={health.pay.configured}
              label="支付网关"
              detail={health.pay.configured
                ? `已配置 · 订单 ${health.pay.orders} 单(已付 ${health.pay.paid})`
                : '未配置 —— 用户无法充值'}
            />
            <HealthRow
              ok={!!health.policy?.arrears_limit}
              label="欠费限制资源"
              detail={health.policy?.arrears_limit
                ? '已打开：欠费会提醒，持续欠费会停机'
                : '关闭：不扣费、不提醒、不限制任何资源'}
            />
            <HealthRow
              ok={health.accounts.billable > 0}
              label="计费组"
              detail={`计费中 ${health.accounts.billable} 个 · 平台内部 ${health.accounts.internal} 个 · 外部但计费关 ${health.accounts.external_off?.length ?? 0} 个`}
            />
            {(health.accounts.external_off?.length ?? 0) > 0 && (
              <HealthRow ok={false} label="外部但计费关" detail={health.accounts.external_off!.join('、')} />
            )}
            {health.accounts.arrears.length > 0 && (
              <HealthRow ok={false} label="欠费组" detail={health.accounts.arrears.join('、')} />
            )}
            {health.accounts.suspended.length > 0 && (
              <HealthRow ok={false} label="已停机组" detail={health.accounts.suspended.join('、')} />
            )}
            {health.accounts.zombies.length > 0 && (
              <HealthRow
                ok={false}
                label="遗留账户行"
                detail={`${health.accounts.zombies.join('、')}(组已不存在,已不再提醒/停机)`}
              />
            )}
          </div>
        </Card>
      )}

      {/* 余额告警 —— 欠费/停用的组可直接点进去充值 */}
      {alerts.length > 0 && (
        <Card data-onboarding-target="billing-alerts" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-warn" />
            <h2 className="text-sm font-semibold">需要关注的组</h2>
            <Badge variant="muted">{alerts.length}</Badge>
          </div>
          <div className="space-y-2">
            {alerts.slice(0, 8).map((a) => (
              <Link
                key={a.group}
                to={`/billing?group=${encodeURIComponent(a.group)}`}
                className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors group"
              >
                {a.blocked
                  ? <Ban size={15} className="text-bad flex-shrink-0" />
                  : <Wallet size={15} className="text-warn flex-shrink-0" />}
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{a.group}</span>
                <span className={`tnum text-xs ${a.balance <= 0 ? 'text-bad' : 'text-muted'}`}>{yuan(a.balance)}</span>
                <Badge variant={a.blocked ? 'bad' : 'warn'} className="text-[10px]">{a.blocked ? '已停用' : '余额不足'}</Badge>
                <ChevronRight size={14} className="text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* 按标签批量发额度（活动）—— 仅计费台账管理员 */}
      {canAccount && <GrantByTagCard />}

      {/* 操作入口 */}
      <section data-onboarding-target="billing-quick" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {canPay && (
          <QuickAction icon={<Wallet size={18} />} label="钱包与额度" desc="充进个人钱包，再分配给 Pod" to="/billing" />
        )}
        {canPrice && (
          <QuickAction icon={<Coins size={18} />} label="计费设置" desc="设定资源单价 · 账户与结算" to="/ops/pricing" />
        )}
        {canAccount && (
          <QuickAction icon={<CreditCard size={18} />} label="充值商品" desc="管理充值档位 · 订单与对账" to="/ops/orders" />
        )}
        {canPlatform && (
          <QuickAction icon={<ShieldCheck size={18} />} label="用量" desc="按核时 / 卡时看各组用量，不扣钱" to="/ops/billing" />
        )}
      </section>
    </>
  )
}

function AccountScopeTable({
  accts, view, shown, query, byBalance, onView, onQuery, onBalance, onInternal, onBillable,
}: {
  accts: BillingAccount[]
  view: 'all' | 'internal' | 'external'
  shown: BillingAccount[]
  query: string
  byBalance: boolean
  onView: (v: 'all' | 'internal' | 'external') => void
  onQuery: (v: string) => void
  onBalance: (fn: (v: boolean) => boolean) => void
  onInternal: (a: BillingAccount, flag: boolean) => void
  onBillable: (a: BillingAccount) => void
}) {
  const internalCount = accts.filter((a) => a.internal).length
  const cols: Column<BillingAccount>[] = [
    { key: 'group_name', title: '组', width: 'minmax(140px, 2fr)', sortable: true, render: (a) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="truncate">{a.group_name}</span>
        {a.synthetic && <span className="text-[10px] text-muted/70 flex-shrink-0" title="尚未建账">未建账</span>}
      </span>
    ) },
    { key: 'balance_cents', title: '余额', width: '110px', sortable: true, render: (a) => (
      <span className={`tnum ${a.balance_cents <= 0 ? 'text-bad' : 'text-ink'}`}>{yuan(a.balance_cents)}</span>
    ) },
    { key: 'internal', title: '归属', width: '150px', render: (a) => (
      <button
        type="button"
        onClick={() => onInternal(a, !a.internal)}
        title={a.internal ? '平台内部组，点击改为外部' : '外部组，点击改为平台内部'}
        className={`text-xs hover:underline ${a.internal ? 'text-muted' : 'text-accent'}`}
      >
        {billingScopeLabel(a)}
      </button>
    ) },
    { key: 'billable', title: '计费开关', width: '90px', render: (a) => (
      <button
        type="button"
        onClick={() => onBillable(a)}
        disabled={!!a.internal}
        title={a.internal ? '平台内部组不走这个开关' : '只对外部组生效。欠费限制关闭时仍然不扣费'}
        className={`text-xs ${a.internal ? 'text-muted/40 cursor-not-allowed' : 'text-accent hover:underline'}`}
      >
        {a.billable ? '开' : '关'}
      </button>
    ) },
  ]
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([
          ['all', `全部 ${accts.length}`],
          ['internal', `平台内部 ${internalCount}`],
          ['external', `外部 ${accts.length - internalCount}`],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => onView(k)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${view === k ? 'bg-accent/10 text-accent' : 'bg-black/[0.04] text-muted hover:bg-black/[0.07]'}`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          data-ux="ux-billov-sort"
          aria-pressed={byBalance}
          onClick={() => onBalance((v) => !v)}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${byBalance ? 'bg-accent/10 text-accent' : 'bg-black/[0.04] text-muted hover:bg-black/[0.07]'}`}
        >
          {byBalance ? '余额从高到低' : '原始顺序'}
        </button>
        <div className="w-full sm:w-44 sm:ml-auto">
          <Input data-ux="ux-billov-find" aria-label="筛选组名" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="筛选组名" />
        </div>
      </div>
      <DataTable
        columns={cols}
        data={shown}
        keyFn={(a) => a.group_name}
        empty={<EmptyState icon={<Building2 size={20} />} title={query || view !== 'all' ? '无匹配组' : '暂无组'} />}
      />
    </>
  )
}

function GrantByTagCard() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['billing-tags'],
    queryFn: () => billingMoneyApi.adminTags(),
    staleTime: 30_000,
    retry: false,
  })
  const tags = data?.tags ?? []
  const [tag, setTag] = useState('')
  const [amount, setAmount] = useState('10')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GrantByTagResult | null>(null)

  const picked = tags.find((t) => t.tag === tag.trim())
  const [confirming, setConfirming] = useState(false)

  const run = () => {
    const name = tag.trim()
    const cents = Math.round(parseFloat(amount) * 100)
    if (!name) { toast({ type: 'error', message: '请填写标签' }); return }
    if (!Number.isFinite(cents) || cents <= 0) { toast({ type: 'error', message: '金额需为正数' }); return }
    setConfirming(true)
  }

  const doGrant = async () => {
    const name = tag.trim()
    const cents = Math.round(parseFloat(amount) * 100)
    setConfirming(false)
    setBusy(true)
    try {
      const r = await billingMoneyApi.grantByTag(name, cents)
      setResult(r)
      toast({ type: 'success', message: `已发放 ${r.granted.length} 个 Pod，跳过 ${r.skipped.length} 个` })
      void qc.invalidateQueries({ queryKey: ['billing-tags'] })
      void qc.invalidateQueries({ queryKey: ['billing-overview-accounts-admin'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '发放失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-onboarding-target="billing-grant-tag" padding="lg" className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Coins size={16} className="text-accent" />
        <h2 className="text-sm font-semibold">按标签批量发额度</h2>
        <Badge variant="muted">{data?.count ?? 0} 个标签</Badge>
      </div>
      <p className="text-xs text-muted mb-3">
        给同一标签下的所有 Pod 各发一笔额度（活动发放）。只命中「标签匹配、非平台内部、计费开」的组；同一批重放不会重复加钱。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-48">
          <Input label="标签" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="活动X" />
        </div>
        <div className="w-32">
          <Input label="每个 (元)" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <Button size="sm" loading={busy} onClick={run}><Coins size={13} /> 发放</Button>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {tags.slice(0, 12).map((t) => (
            <button
              key={t.tag}
              type="button"
              onClick={() => setTag(t.tag)}
              className={`rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${tag.trim() === t.tag ? 'bg-accent/10 text-accent' : 'bg-black/[0.04] text-muted hover:bg-black/[0.07]'}`}
            >
              {t.tag} · {t.count}
            </button>
          ))}
        </div>
      )}

      {picked ? (
        <p className="text-xs text-muted mt-2">
          命中「{picked.tag}」：{picked.count} 个 Pod · 余额合计 {yuan(picked.balance_cents)}
          {picked.internal > 0 && ` · 含内部组 ${picked.internal}（会被跳过）`} · {picked.groups.join('、')}
        </p>
      ) : tag.trim() ? (
        <p className="text-xs text-warn mt-2">没有 Pod 使用这个标签。</p>
      ) : null}

      {result && (
        <div className="mt-3 text-xs space-y-1">
          <p className="text-ok font-medium">已发放 {result.granted.length} 个 · 跳过 {result.skipped.length} 个 · 批次 {result.batch}</p>
          {result.granted.map((g) => (
            <p key={g.group} className="text-muted">
              {g.group} → 余额 {yuan(g.balance_cents)}{g.reused && '（此批已发放过，未重复加钱）'}
            </p>
          ))}
          {result.skipped.map((s) => (
            <p key={s.group} className="text-muted">{s.group} — 跳过：{s.reason}</p>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={doGrant}
        title="按标签批量发额度"
        description={`给标签「${tag.trim()}」下 ${picked?.count || '?'} 个 Pod 各发 ${yuan(Math.round(parseFloat(amount) * 100) || 0)}？${(picked?.count ?? 0) === 0 ? '（未找到匹配 Pod，仍会尝试）' : ''}`}
        confirmText="确认发放"
      />
    </Card>
  )
}

function HealthRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2.5">
      {ok
        ? <CheckCircle2 size={14} className="text-ok mt-0.5 flex-shrink-0" />
        : <AlertTriangle size={14} className="text-warn mt-0.5 flex-shrink-0" />}
      <span className="text-xs font-medium w-20 flex-shrink-0">{label}</span>
      <span className="text-xs text-muted min-w-0 flex-1">{detail}</span>
    </div>
  )
}

function QuickAction({ icon, label, desc, to }: { icon: React.ReactNode; label: string; desc: string; to: string }) {
  return (
    <Link
      data-onboarding-target={`goto-${to}`}
      to={to}
      className="glass-card rounded-2xl p-4 flex items-center gap-4 hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group"
    >
      <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <span className="text-sm font-semibold group-hover:text-accent transition-colors">{label}</span>
        <p className="text-xs text-muted">{desc}</p>
      </div>
      <ChevronRight size={14} className="ml-auto text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
    </Link>
  )
}
