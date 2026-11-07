import { useMemo } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Wallet, Receipt, CreditCard, Coins, Layers, AlertTriangle, ChevronRight,
  Ban, ShieldCheck, TrendingUp, PackageCheck, Building2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { podsApi } from '@/api/pods'
import { payApi } from '@/api/pay'
import { billingMoneyApi, type BillingAccount } from '@/api/billing'
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

  // 我的组 + 各组余额(聚合)
  const { data: podsData, isLoading: podsLoading } = useQuery({
    queryKey: ['billing-overview-pods'],
    queryFn: () => podsApi.list({ per_page: 100 }),
    staleTime: 60_000,
  })
  const groups = useMemo(() => (podsData?.pods ?? []).map((p) => p.name), [podsData])

  const { data: acct, isLoading: acctLoading } = useQuery({
    queryKey: ['billing-overview-accounts', groups],
    queryFn: async () => {
      const rs = await Promise.all(groups.map((g) => payApi.account(g, 1).catch(() => null)))
      let balance = 0
      const alerts: { group: string; balance: number; blocked: boolean }[] = []
      groups.forEach((g, i) => {
        const row = rs[i]
        const bal = row?.account?.balance_cents ?? 0
        const blocked = !!row?.blocked || row?.account?.status === 'suspended'
        balance += bal
        if (blocked || bal <= 0) alerts.push({ group: g, balance: bal, blocked })
      })
      return { balance, alerts, count: groups.length }
    },
    enabled: groups.length > 0,
    staleTime: 30_000,
  })

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

  // 组计费归属(内部=免计费 / 外部=计费)+ 计费开关 —— 仅计费台账管理员
  const { data: acctsData } = useQuery({
    queryKey: ['billing-overview-accounts-admin'],
    queryFn: () => billingMoneyApi.accounts(),
    enabled: canAccount,
    staleTime: 30_000,
    retry: false,
  })
  const accts = acctsData?.accounts ?? []
  const internalCount = accts.filter((a) => a.internal).length

  const setInternal = async (a: BillingAccount, flag: boolean) => {
    try {
      await billingMoneyApi.bulkAccounts([a.group_name], { internal: flag })
      toast({
        type: 'success',
        message: `${a.group_name} → ${flag ? '内部组(免计费)' : '外部组(计费)'}` +
          (flag ? '' : '（计费开关需另行打开）'),
      })
      void qc.invalidateQueries({ queryKey: ['billing-overview-accounts-admin'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }
  const setBillable = async (a: BillingAccount) => {
    try {
      await billingMoneyApi.setAccount(a.group_name, { billable: a.billable ? 0 : 1 })
      void qc.invalidateQueries({ queryKey: ['billing-overview-accounts-admin'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const alerts = acct?.alerts ?? []
  const aiContext =
    `计费总览: 我的组 ${groups.length} 个, 余额合计 ${yuan(acct?.balance)}, ` +
    `欠费/停用 ${alerts.length} 个, 待支付订单 ${pendingCount}` +
    (stats ? `; 平台累计充值 ${yuan(stats.total.amount_cents)}, 今日充值 ${yuan(stats.today.amount_cents)}, 上架档位 ${stats.active_items}` : '')

  return (
    <>
      <PageHeader
        title="计费总览"
        description="账户余额、充值、单价与平台核时账单的统一入口"
        doc={{ section: 'ops', item: 3, label: '计费说明' }}
      >
        <PageAiAssistant page="mybilling" context={aiContext} />
      </PageHeader>

      {/* 我的账户总览 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {podsLoading ? (
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

      {/* 组计费归属 —— 内部(免计费)/外部(计费)切换,仅计费台账管理员 */}
      {canAccount && (
        <Card data-onboarding-target="billing-internal" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">计费归属</h2>
            <Badge variant="muted">内部 {internalCount} · 外部 {accts.length - internalCount}</Badge>
          </div>
          <p className="text-xs text-muted mb-3">
            列出全部组(未建账的按默认值显示,标「未建账」)。「内部」= 平台自己的组,免计费(不结算、不提醒、不参与额度分配)。
            把「外部」设回不会自动恢复计费,需再打开右侧「计费」开关。
          </p>
          {accts.length === 0 ? (
            <p className="text-sm text-muted py-4 text-center">暂无组</p>
          ) : (
            <div className="space-y-1">
              {accts.map((a) => (
                <div key={a.group_name} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors">
                  <span className="text-sm font-medium flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="truncate">{a.group_name}</span>
                    {a.synthetic && (
                      <span className="text-[10px] text-muted/70 flex-shrink-0"
                            title="尚未建账：结算 / 充值 / 调整后自动建账">未建账</span>
                    )}
                  </span>
                  <span className={`tnum text-xs ${a.balance_cents <= 0 ? 'text-bad' : 'text-muted'}`}>{yuan(a.balance_cents)}</span>
                  <button
                    type="button"
                    onClick={() => setInternal(a, !a.internal)}
                    title={a.internal ? '平台内部组：不计费（点击改为外部）' : '外部组：按用量计费（点击改为内部）'}
                    className={`rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${a.internal ? 'bg-black/[0.05] text-muted hover:bg-black/[0.08]' : 'bg-accent/10 text-accent hover:bg-accent/20'}`}
                  >
                    {a.internal ? '内部 · 免计费' : '外部 · 计费'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBillable(a)}
                    title="单独开关该组的计费"
                    disabled={a.internal}
                    className={`rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${a.internal ? 'text-muted/40 cursor-not-allowed' : a.billable ? 'bg-ok/10 text-ok hover:bg-ok/20' : 'bg-bad/10 text-bad hover:bg-bad/20'}`}
                  >
                    计费{a.billable ? '开' : '关'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* 操作入口 */}
      <section data-onboarding-target="billing-quick" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {canPay && (
          <QuickAction icon={<Wallet size={18} />} label="账户与充值" desc="查看组余额 · 微信小程序充值" to="/billing" />
        )}
        {canPrice && (
          <QuickAction icon={<Coins size={18} />} label="计费设置" desc="设定资源单价 · 账户与结算" to="/ops/pricing" />
        )}
        {canAccount && (
          <QuickAction icon={<CreditCard size={18} />} label="充值商品" desc="管理充值档位 · 订单与对账" to="/ops/orders" />
        )}
        {canPlatform && (
          <QuickAction icon={<ShieldCheck size={18} />} label="平台核时账单" desc="按核时/卡时统计各组用量" to="/ops/billing" />
        )}
      </section>
    </>
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
