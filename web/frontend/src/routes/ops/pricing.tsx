import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, Save, RefreshCw, Play, Plus } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Dialog } from '@/components/ui/Dialog'
import { useToastStore } from '@/stores/toast'
import { billingMoneyApi, type BillingAccount } from '@/api/billing'

const yuan = (cents: number | null | undefined) => `¥${(((cents ?? 0) as number) / 100).toFixed(2)}`

/** 单价设置有几种「分/单位」的换算说明（1 核时 = 1 core-hours …）。 */
const UNIT_HINT: Record<string, string> = {
  cpu_core_hour: '每 CPU 核·小时',
  gpu_card_hour: '每算力卡·小时',
  gpu_mem_gib_hour: '每 GPU 显存 GiB·小时',
  mem_gib_hour: '每内存 GiB·小时',
  storage_home_gib_hour: '每（组目录）GiB·小时',
  storage_minio_gib_hour: '每（对象桶）GiB·小时',
  storage_quota_gib_hour: '每（配额）GiB·小时',
}

/** 单价 / 账户 / 结算 —— 计费资金层管理（管理员）。 */
export default function OpsPricing() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [adjustFor, setAdjustFor] = useState<BillingAccount | null>(null)
  const [adjustCents, setAdjustCents] = useState('')
  const [adjustNote, setAdjustNote] = useState('')
  const [settling, setSettling] = useState(false)

  const { data: priceData, isLoading: priceLoading, refetch: refetchPrices } = useQuery({
    queryKey: ['billing-prices'],
    queryFn: () => billingMoneyApi.prices(),
    staleTime: 30_000,
  })
  const keys = priceData?.keys ?? []
  const prices = priceData?.prices ?? {}
  const labels = priceData?.labels ?? {}
  const valueOf = (k: string) => (k in draft ? draft[k] : String(prices[k] ?? 0))

  const { data: acctData, refetch: refetchAccts } = useQuery({
    queryKey: ['billing-accounts'],
    queryFn: () => billingMoneyApi.accounts(),
    staleTime: 15_000,
  })
  const accounts: BillingAccount[] = acctData?.accounts ?? []

  const { data: incomeData, refetch: refetchIncome } = useQuery({
    queryKey: ['billing-income'],
    queryFn: () => billingMoneyApi.income(),
    staleTime: 30_000,
  })
  const byKind = incomeData?.by_kind ?? {}

  const [saving, setSaving] = useState(false)
  const savePrices = async () => {
    const payload: Record<string, number> = {}
    for (const k of keys) {
      const raw = draft[k]
      if (raw === undefined) continue
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) { toast({ type: 'error', message: `${labels[k] ?? k} 不是合法数值` }); return }
      payload[k] = n
    }
    if (!Object.keys(payload).length) { toast({ type: 'info', message: '没有改动' }); return }
    setSaving(true)
    try {
      await billingMoneyApi.setPrices(payload)
      setDraft({})
      toast({ type: 'success', message: '单价已保存' })
      void refetchPrices()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const runSettle = async (dryRun: boolean) => {
    setSettling(true)
    try {
      const r = await billingMoneyApi.settle({ dry_run: dryRun }) as any
      toast({ type: 'success', message: `结算完成：${r.hours} 小时 / ${r.groups} 组 / ${yuan(r.charged_cents)}${dryRun ? '（试算）' : ''}` })
      void refetchAccts()
      void refetchIncome()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '结算失败' })
    } finally {
      setSettling(false)
    }
  }

  const doAdjust = async () => {
    if (!adjustFor) return
    const cents = Math.round(Number(adjustCents) * 100)
    if (!Number.isFinite(cents) || cents === 0) { toast({ type: 'error', message: '请输入非零金额（元）' }); return }
    try {
      await billingMoneyApi.adjust(adjustFor.group_name, cents, adjustNote || '人工调整')
      toast({ type: 'success', message: `已调整 ${yuan(cents)}` })
      setAdjustFor(null); setAdjustCents(''); setAdjustNote('')
      void refetchAccts()
      void refetchIncome()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '调整失败' })
    }
  }

  const setStatus = async (acct: BillingAccount, status: string) => {
    try {
      await billingMoneyApi.setAccount(acct.group_name, { status: status as BillingAccount['status'] })
      toast({ type: 'success', message: `${acct.group_name} → ${status}` })
      void refetchAccts()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const acctCols: Column<BillingAccount>[] = [
    { key: 'group_name', title: '组', width: 'minmax(120px, 2fr)' },
    { key: 'balance_cents', title: '余额', width: '110px', render: (a) => (
      <span className={`tnum ${a.balance_cents <= 0 ? 'text-bad' : 'text-ink'}`}>{yuan(a.balance_cents)}</span>
    ) },
    { key: 'credit_limit_cents', title: '额度', width: '100px', render: (a) => <span className="tnum">{yuan(a.credit_limit_cents)}</span> },
    { key: 'status', title: '状态', width: '110px', render: (a) => (
      <Select
        className="w-24"
        value={a.status}
        onChange={(v) => setStatus(a, v)}
        options={[{ value: 'active', label: '正常' }, { value: 'suspended', label: '停用' }, { value: 'closed', label: '关闭' }]}
      />
    ) },
    { key: 'billable', title: '计费', width: '80px', render: (a) => (
      <button className="text-xs text-accent hover:underline"
              onClick={() => billingMoneyApi.setAccount(a.group_name, { billable: a.billable ? 0 : 1 }).then(() => refetchAccts())}>
        {a.billable ? '开' : '关'}
      </button>
    ) },
    { key: 'op', title: '操作', width: '80px', render: (a) => (
      <button className="text-xs text-accent hover:underline" onClick={() => setAdjustFor(a)}>调整</button>
    ) },
  ]

  const aiContext = `计费单价设置\n`
    + keys.map((k) => `  ${labels[k] ?? k}: ${prices[k] ?? 0} 分/单位`).join('\n')
    + `\n账户 ${accounts.length} 个；收支：` + Object.entries(byKind).map(([k, v]) => `${k} ${yuan(v.total_cents)}`).join('，')

  return (
    <>
      <PageHeader title="计费·定价" description="资源单价 / 组账户 / 结算与对账"
                  doc={{ section: 'ops', item: 3, label: '计费文档' }}>
        <Button variant="secondary" size="sm" onClick={() => { void refetchPrices(); void refetchAccts(); void refetchIncome() }}>
          <RefreshCw size={14} /> 刷新
        </Button>
        <PageAiAssistant page="pricing" context={aiContext} />
      </PageHeader>

      {priceLoading ? <SkeletonCard /> : (
        <Card padding="md" className="mb-5">
          <div className="flex items-center gap-2 mb-4">
            <Coins size={16} className="text-accent" />
            <span className="text-sm font-semibold text-ink">资源单价（单位：分 / 计量单位；0 = 不计费）</span>
            <Button size="sm" className="ml-auto" loading={saving} onClick={savePrices}><Save size={14} /> 保存</Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {keys.map((k) => (
              <Input
                key={k}
                label={labels[k] ?? k}
                hint={UNIT_HINT[k]}
                type="number" step="0.000001" min="0"
                value={valueOf(k)}
                onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              />
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Button size="sm" loading={settling} onClick={() => runSettle(false)}><Play size={14} /> 立即结算</Button>
        <Button size="sm" variant="outline" loading={settling} onClick={() => runSettle(true)}>试算</Button>
        <span className="text-xs text-muted">结算幂等：重复运行只补未结算的小时。</span>
      </div>

      {/* 收支概览 */}
      {Object.keys(byKind).length > 0 && (
        <Card padding="md" className="mb-5">
          <div className="text-sm font-semibold text-ink mb-3">台账收支（按类型）</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(byKind).map(([kind, v]) => (
              <div key={kind} className="rounded-lg bg-black/[0.03] px-3 py-2">
                <div className="text-xs text-muted">{kind}</div>
                <div className="text-lg font-bold tnum">{yuan(v.total_cents)}</div>
                <div className="text-[10px] text-muted tnum">{v.count} 笔</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card padding="none">
        <div className="px-4 py-3 text-sm font-semibold text-ink border-b border-black/[0.06]">组账户</div>
        <div className="p-2">
          <DataTable columns={acctCols} data={accounts} keyFn={(a) => a.group_name}
                     empty={<EmptyState icon={<Coins size={20} />} title="暂无账户" description="结算或首次充值后自动建账。" />} />
        </div>
      </Card>

      <Dialog
        open={!!adjustFor}
        onClose={() => setAdjustFor(null)}
        title={`调整余额 · ${adjustFor?.group_name ?? ''}`}
        width="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs text-muted">当前余额 {yuan(adjustFor?.balance_cents)}。正数增加、负数扣减（单位：元）。</p>
          <Input label="金额（元）" type="number" step="0.01" value={adjustCents}
                 onChange={(e) => setAdjustCents(e.target.value)} placeholder="如 10 或 -5.5" />
          <Input label="备注" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="原因" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAdjustFor(null)}>取消</Button>
            <Button onClick={doAdjust}>确认调整</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
