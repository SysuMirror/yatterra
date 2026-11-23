import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, Save, RefreshCw, Play } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Disclosure } from '@/components/ui/Disclosure'
import { Dialog } from '@/components/ui/Dialog'
import { useToastStore } from '@/stores/toast'
import { billingMoneyApi, billingScopeLabel, type BillingAccount, type WalletAccount } from '@/api/billing'
import { useAuth } from '@/hooks/useAuth'
import { ArrearsPolicyCard } from '@/components/billing/ArrearsPolicyCard'

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
  const { hasPerm } = useAuth()
  const canPrice = hasPerm('billing.price')
  const canAccount = hasPerm('billing.account')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [bulkText, setBulkText] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [acctFilter, setAcctFilter] = useState('')
  const [acctScope, setAcctScope] = useState<'all' | 'internal' | 'external'>('all')
  const [adjustFor, setAdjustFor] = useState<BillingAccount | null>(null)
  const [adjustCents, setAdjustCents] = useState('')
  const [adjustNote, setAdjustNote] = useState('')
  const [settling, setSettling] = useState(false)
  const [priceFind, setPriceFind] = useState('')

  const { data: priceData, isLoading: priceLoading, refetch: refetchPrices } = useQuery({
    queryKey: ['billing-prices'],
    queryFn: () => billingMoneyApi.prices(),
    staleTime: 30_000,
  })
  const keys = priceData?.keys ?? []
  const prices = priceData?.prices ?? {}
  const labels = priceData?.labels ?? {}
  const priceQuery = priceFind.trim().toLowerCase()
  const shownPriceKeys = keys.filter((k) => !priceQuery || k.toLowerCase().includes(priceQuery))
  const valueOf = (k: string) => (k in draft ? draft[k] : String(prices[k] ?? 0))

  const { data: acctData, refetch: refetchAccts } = useQuery({
    queryKey: ['billing-accounts'],
    queryFn: () => billingMoneyApi.accounts(),
    enabled: canAccount,
    staleTime: 15_000,
  })
  const accounts: BillingAccount[] = acctData?.accounts ?? []
  const internalCount = accounts.filter((a) => a.internal).length
  const acctQuery = acctFilter.trim().toLowerCase()
  const filteredAccts = useMemo(() => {
    const rows = acctData?.accounts ?? []
    return rows.filter((a) => {
      if (acctScope === 'internal' && !a.internal) return false
      if (acctScope === 'external' && a.internal) return false
      if (!acctQuery) return true
      return a.group_name.toLowerCase().includes(acctQuery)
    })
  }, [acctData, acctQuery, acctScope])
  const bulkNames = useMemo(
    () => bulkText.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean),
    [bulkText],
  )
  const unknownBulk = bulkNames.filter((n) => !accounts.some((a) => a.group_name === n))

  const { data: incomeData, refetch: refetchIncome } = useQuery({
    queryKey: ['billing-income'],
    queryFn: () => billingMoneyApi.income(),
    enabled: canAccount,
    staleTime: 30_000,
  })
  const byKind = incomeData?.by_kind ?? {}

  const { data: walletData, refetch: refetchWallets } = useQuery({
    queryKey: ['billing-wallets'],
    queryFn: () => billingMoneyApi.adminWallets(),
    enabled: canAccount,
    staleTime: 15_000,
  })
  const wallets: WalletAccount[] = walletData?.wallets ?? []
  const [walletAdjustFor, setWalletAdjustFor] = useState<WalletAccount | null>(null)
  const [walletAdjustYuan, setWalletAdjustYuan] = useState('')
  const [walletAdjustNote, setWalletAdjustNote] = useState('')
  const [allocWallet, setAllocWallet] = useState<WalletAccount | null>(null)
  const [allocGroup, setAllocGroup] = useState('')
  const [allocDir, setAllocDir] = useState<'in' | 'out'>('in')
  const [allocYuan, setAllocYuan] = useState('')

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
      const r = await billingMoneyApi.settle({ dry_run: dryRun }) as { hours: number; groups: number; charged_cents: number; skipped?: boolean }
      if (r.skipped) {
        toast({ type: 'info', message: '欠费限制未打开，这次没有扣费。试算仍可预览。' })
        return
      }
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

  const [restoring, setRestoring] = useState<string | null>(null)
  const restore = async (acct: BillingAccount) => {
    setRestoring(acct.group_name)
    try {
      const r = await billingMoneyApi.restoreAccount(acct.group_name, true)
      if (r.started) {
        toast({ type: 'success', message: `${acct.group_name} 已恢复并启动` })
      } else {
        // 账户解冻成功但 Pod 没起来 —— 多半是组不存在/节点无资源，如实报出来
        const err = (r.start_result as { error?: string } | null)?.error
        toast({ type: 'warning', message: `${acct.group_name} 账户已恢复，但 Pod 启动未成功${err ? `：${err}` : ''}` })
      }
      void refetchAccts()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '恢复失败' })
    } finally {
      setRestoring(null)
    }
  }

  const setInternal = async (acct: BillingAccount, flag: boolean) => {
    try {
      await billingMoneyApi.bulkAccounts([acct.group_name], { internal: flag })
      toast({
        type: 'success',
        message: flag
          ? `${acct.group_name} → 平台内部，不结算、不提醒`
          : `${acct.group_name} → 外部。计费开关不会自动打开；欠费限制关闭时也不会扣费`,
      })
      void refetchAccts()
      void qc.invalidateQueries({ queryKey: ['billing-health'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const setBillable = async (acct: BillingAccount) => {
    if (acct.internal) return
    try {
      await billingMoneyApi.setAccount(acct.group_name, { billable: acct.billable ? 0 : 1 })
      toast({ type: 'success', message: `${acct.group_name} 计费${acct.billable ? '关' : '开'}` })
      void refetchAccts()
      void qc.invalidateQueries({ queryKey: ['billing-health'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const runBulk = async (flag: boolean) => {
    const names = bulkNames
    if (!names.length) { toast({ type: 'info', message: '请先填写组名(逗号/空格分隔)' }); return }
    setBulkBusy(true)
    try {
      const r = await billingMoneyApi.bulkAccounts(names, { internal: flag })
      toast({
        type: r.errors.length ? 'warning' : 'success',
        message: `已设为${flag ? '内部' : '外部'} ${r.updated.length} 个${r.errors.length ? `，失败 ${r.errors.length} 个` : ''}`,
      })
      setBulkText('')
      void refetchAccts()
      void qc.invalidateQueries({ queryKey: ['billing-health'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '批量修改失败' })
    } finally {
      setBulkBusy(false)
    }
  }

  // ── 用户钱包（两层资金的个人层）──────────────────────────────────
  const doWalletAdjust = async () => {
    if (!walletAdjustFor) return
    const cents = Math.round(Number(walletAdjustYuan) * 100)
    if (!Number.isFinite(cents) || cents === 0) { toast({ type: 'error', message: '请输入非零金额（元）' }); return }
    try {
      await billingMoneyApi.adminWalletAdjust(walletAdjustFor.username, cents, walletAdjustNote || '人工调整')
      toast({ type: 'success', message: `已调整 ${walletAdjustFor.username} 钱包 ${yuan(cents)}` })
      setWalletAdjustFor(null); setWalletAdjustYuan(''); setWalletAdjustNote('')
      void refetchWallets()
      void refetchIncome()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '调整失败' })
    }
  }

  const setWalletStatus = async (w: WalletAccount, status: string) => {
    try {
      await billingMoneyApi.adminWalletSet(w.username, { status: status as WalletAccount['status'] })
      toast({ type: 'success', message: `${w.username} → ${status}` })
      void refetchWallets()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const doAdminAllocate = async () => {
    if (!allocWallet) return
    const group = allocGroup.trim()
    const cents = Math.round(Number(allocYuan) * 100)
    if (!group) { toast({ type: 'error', message: '请填写目标 Pod 名' }); return }
    if (!Number.isFinite(cents) || cents <= 0) { toast({ type: 'error', message: '请输入正的金额（元）' }); return }
    try {
      await billingMoneyApi.adminAllocate(allocWallet.username, group, cents, allocDir, '管理员代分配')
      toast({ type: 'success', message: `${allocDir === 'in' ? '分配' : '收回'} ${yuan(cents)} · ${allocWallet.username} ⇄ ${group}` })
      setAllocWallet(null); setAllocGroup(''); setAllocYuan('')
      void refetchWallets()
      void refetchAccts()
      void refetchIncome()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '操作失败' })
    }
  }

  const acctCols: Column<BillingAccount>[] = [
    { key: 'group_name', title: '组', width: 'minmax(120px, 2fr)', sortable: true, render: (a) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="truncate">{a.group_name}</span>
        {a.synthetic && (
          <Badge variant="muted" className="text-[10px] flex-shrink-0"
                 title="尚未建账：结算 / 充值 / 调整后自动建账，此处显示默认值">未建账</Badge>
        )}
      </span>
    ) },
    { key: 'internal', title: '归属', width: '150px', render: (a) => (
      <button className={`text-xs hover:underline ${a.internal ? 'text-muted' : 'text-accent'}`}
              onClick={() => setInternal(a, !a.internal)}
              title={a.internal ? '平台内部组，点击改为外部' : '外部组，点击改为平台内部'}>
        {billingScopeLabel(a)}
      </button>
    ) },
    { key: 'balance_cents', title: '余额', width: '110px', sortable: true, render: (a) => (
      <span className={`tnum ${a.balance_cents <= 0 ? 'text-bad' : 'text-ink'}`}>{yuan(a.balance_cents)}</span>
    ) },
    { key: 'credit_limit_cents', title: '额度', width: '100px', sortable: true, render: (a) => <span className="tnum">{yuan(a.credit_limit_cents)}</span> },
    { key: 'status', title: '状态', width: '110px', render: (a) => (
      <Select
        className="w-24"
        value={a.status}
        onChange={(v) => setStatus(a, v)}
        options={[{ value: 'active', label: '正常' }, { value: 'suspended', label: '停用' }, { value: 'closed', label: '关闭' }]}
      />
    ) },
    { key: 'billable', title: '计费开关', width: '90px', render: (a) => (
      <button className={`text-xs ${a.internal ? 'text-muted/40 cursor-not-allowed' : 'text-accent hover:underline'}`}
              disabled={!!a.internal}
              title={a.internal ? '平台内部组不走这个开关' : '只对外部组生效。欠费限制关闭时仍然不扣费'}
              onClick={() => setBillable(a)}>
        {a.billable ? '开' : '关'}
      </button>
    ) },
    { key: 'op', title: '操作', width: '130px', render: (a) => (
      <div className="flex items-center gap-2">
        <button className="text-xs text-accent hover:underline" onClick={() => setAdjustFor(a)}>调整</button>
        {a.status !== 'active' && (
          <button
            className="text-xs text-ok hover:underline disabled:opacity-50"
            disabled={restoring === a.group_name}
            title="解冻账户并把停机的 Pod 拉起来(停机是两步，恢复也一步到位)"
            onClick={() => restore(a)}
          >
            {restoring === a.group_name ? '启动中…' : '恢复并启动'}
          </button>
        )}
      </div>
    ) },
  ]

  const walletCols: Column<WalletAccount>[] = [
    { key: 'username', title: '用户', width: 'minmax(140px, 2fr)', render: (w) => (
      <span>{w.label || w.username}{w.label && w.label !== w.username ? <span className="text-muted text-xs"> ({w.username})</span> : null}</span>
    ) },
    { key: 'balance_cents', title: '钱包余额', width: '110px', render: (w) => (
      <span className={`tnum ${w.balance_cents <= 0 ? 'text-muted' : 'text-ink'}`}>{yuan(w.balance_cents)}</span>
    ) },
    { key: 'status', title: '状态', width: '110px', render: (w) => (
      <Select
        className="w-24"
        value={w.status}
        onChange={(v) => setWalletStatus(w, v)}
        options={[{ value: 'active', label: '正常' }, { value: 'suspended', label: '冻结' }, { value: 'closed', label: '关闭' }]}
      />
    ) },
    { key: 'op', title: '操作', width: '130px', render: (w) => (
      <div className="flex items-center gap-3">
        <button className="text-xs text-accent hover:underline" onClick={() => setWalletAdjustFor(w)}>调整</button>
        <button className="text-xs text-accent hover:underline" onClick={() => { setAllocWallet(w); setAllocGroup(''); setAllocYuan(''); setAllocDir('in') }}>代分配</button>
      </div>
    ) },
  ]

  const aiContext = `计费单价设置\n`
    + keys.map((k) => `  ${labels[k] ?? k}: ${prices[k] ?? 0} 分/单位`).join('\n')
    + `\n账户 ${accounts.length} 个；收支：` + Object.entries(byKind).map(([k, v]) => `${k} ${yuan(v.total_cents)}`).join('，')

  return (
    <>
      <PageHeader title="计费设置" description="单价 / 组账户 / 结算（管理员）"
                  doc={{ section: 'ops', item: 3, label: '计费说明' }}>
        <Button variant="secondary" size="sm" onClick={() => { void refetchPrices(); void refetchAccts(); void refetchWallets(); void refetchIncome() }}>
          <RefreshCw size={14} /> 刷新
        </Button>
        <PageAiAssistant page="pricing" context={aiContext} />
      </PageHeader>

      <div className="mb-5">
        <Disclosure title="怎么用：单价 / 欠费限制 / 账户 / 钱包 / 结算">
          <div className="px-4 pb-4 space-y-2 text-xs text-muted leading-relaxed">
            <p>① 设单价：填每种资源的「分 / 计量单位」，<b className="text-ink-2">0 表示该项不计费</b>。填完点保存，立即对下一次结算生效。</p>
            <p>② 欠费限制默认关闭：不扣费、不提醒、不限制资源。打开之后的小时才开始扣费。</p>
            <p>③ 看账户：切换平台内部 / 外部，再单独开关计费。改回外部不会自动打开计费。</p>
            <p>④ 看钱包：充值先进个人钱包，再分配给 Pod。可调整、冻结，或代分配 / 收回。</p>
            <p>⑤ 跑结算：欠费限制打开后每小时结算一次（幂等）。改动后可点「试算」预览不落账。</p>
          </div>
        </Disclosure>
      </div>

      {canAccount && <ArrearsPolicyCard />}

      {canPrice ? (priceLoading ? <SkeletonCard /> : (
        <Card padding="md" className="mb-5">
          <div className="flex items-center gap-2 mb-4">
            <Coins size={16} className="text-accent" />
            <span className="text-sm font-semibold text-ink">资源单价（单位：分 / 计量单位；0 = 不计费）</span>
            <Button size="sm" className="ml-auto" loading={saving} onClick={savePrices}><Save size={14} /> 保存</Button>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="w-full max-w-xs">
              <Input
                data-ux="ux-pricing-find"
                value={priceFind}
                onChange={(e) => setPriceFind(e.target.value)}
                placeholder="筛选单价 key"
                aria-label="筛选单价"
                className="h-9 py-1.5 text-xs"
              />
            </div>
          </div>
          {shownPriceKeys.length === 0 ? (
            <p className="text-sm text-muted py-4 text-center">{keys.length ? '无匹配单价' : '暂无单价'}</p>
          ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {shownPriceKeys.map((k) => (
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
          )}
        </Card>
      )) : (
        <Card padding="md" className="mb-5">
          <p className="text-sm text-muted">改单价需要「设置单价」权限。</p>
        </Card>
      )}

      {canAccount && (
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Button size="sm" loading={settling} onClick={() => runSettle(false)}><Play size={14} /> 立即结算</Button>
        <Button size="sm" variant="outline" loading={settling} onClick={() => runSettle(true)}>试算</Button>
        <span className="text-xs text-muted">欠费限制关闭时，立即结算不会扣费。试算只预览。</span>
      </div>
      )}

      {/* 收支概览 */}
      {canAccount && Object.keys(byKind).length > 0 && (
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

      {canAccount && (
      <Card padding="none">
        <div className="px-4 py-3 border-b border-black/[0.06] space-y-2">
          <div className="text-sm font-semibold text-ink">组账户</div>
          <p className="text-xs text-muted">
            未建账的组按默认值显示；平台内部 / 外部的计费差异见上方「怎么用」。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {([
              ['all', '全部'],
              ['internal', '平台内部'],
              ['external', '外部'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setAcctScope(k)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium ${acctScope === k ? 'bg-accent/10 text-accent' : 'bg-black/[0.04] text-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-64">
              <Input value={bulkText} onChange={(e) => setBulkText(e.target.value)}
                     placeholder="批量组名，逗号或空格分隔" />
            </div>
            <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulk(true)}>设为平台内部</Button>
            <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulk(false)}>设为外部</Button>
          </div>
          {bulkNames.length > 0 && (
            <p className="text-xs text-muted">
              将修改 {bulkNames.length} 个：{bulkNames.slice(0, 12).join('、')}{bulkNames.length > 12 ? '…' : ''}
              {unknownBulk.length > 0 ? `。其中 ${unknownBulk.slice(0, 8).join('、')} 不在组列表里` : ''}
            </p>
          )}
        </div>
        <div className="p-2">
          <div className="flex flex-wrap items-center gap-3 px-2 pb-2">
            <div className="w-full sm:w-56">
              <Input value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)} placeholder="筛选组名…" />
            </div>
            <span className="text-xs text-muted tnum">
              {acctQuery || acctScope !== 'all' ? `匹配 ${filteredAccts.length} / ${accounts.length}` : `共 ${accounts.length} 组`}
              {internalCount > 0 ? ` · 平台内部 ${internalCount}` : ''}
            </span>
          </div>
          <DataTable columns={acctCols} data={filteredAccts} keyFn={(a) => a.group_name}
                     empty={<EmptyState icon={<Coins size={20} />}
                                        title={acctQuery ? '无匹配组' : '暂无账户'}
                                        description={acctQuery ? '换个关键字试试。' : '结算或首次充值后自动建账。'} />} />
        </div>
      </Card>
      )}

      {/* 用户钱包 */}
      {canAccount && (
      <Card padding="none" className="mt-5">
        <div className="px-4 py-3 border-b border-black/[0.06]">
          <div className="text-sm font-semibold text-ink">用户钱包</div>
          <div className="text-xs text-muted">充值的钱先进这里，再由用户分配给所属 Pod 独立扣费；支持人工调整、冻结、代分配 / 收回。</div>
        </div>
        <div className="p-2">
          <DataTable columns={walletCols} data={wallets} keyFn={(w) => w.username}
                     empty={<EmptyState icon={<Coins size={20} />} title="暂无钱包" description="用户首次充值或首次分配后自动建钱包。" />} />
        </div>
      </Card>
      )}

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

      {/* 调整钱包余额 */}
      <Dialog
        open={!!walletAdjustFor}
        onClose={() => setWalletAdjustFor(null)}
        title={`调整钱包 · ${walletAdjustFor?.username ?? ''}`}
        width="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs text-muted">当前钱包余额 {yuan(walletAdjustFor?.balance_cents)}。正数增加、负数扣减（单位：元）。</p>
          <Input label="金额（元）" type="number" step="0.01" value={walletAdjustYuan}
                 onChange={(e) => setWalletAdjustYuan(e.target.value)} placeholder="如 100 或 -5.5" />
          <Input label="备注" value={walletAdjustNote} onChange={(e) => setWalletAdjustNote(e.target.value)} placeholder="原因" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setWalletAdjustFor(null)}>取消</Button>
            <Button onClick={doWalletAdjust}>确认调整</Button>
          </div>
        </div>
      </Dialog>

      {/* 代分配 / 收回 */}
      <Dialog
        open={!!allocWallet}
        onClose={() => setAllocWallet(null)}
        title={`代分配 · ${allocWallet?.username ?? ''}`}
        width="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs text-muted">以该用户钱包代向指定 Pod 分配额度（in），或从 Pod 收回退回其钱包（out）。</p>
          <Input label="目标 Pod 名" value={allocGroup} onChange={(e) => setAllocGroup(e.target.value)} placeholder="如 my-pod" />
          <div className="flex items-center gap-2">
            <Button size="sm" variant={allocDir === 'in' ? 'primary' : 'outline'} onClick={() => setAllocDir('in')}>分配进 Pod</Button>
            <Button size="sm" variant={allocDir === 'out' ? 'primary' : 'outline'} onClick={() => setAllocDir('out')}>从 Pod 收回</Button>
          </div>
          <Input label="金额（元）" type="number" step="0.01" value={allocYuan}
                 onChange={(e) => setAllocYuan(e.target.value)} placeholder="如 50" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAllocWallet(null)}>取消</Button>
            <Button onClick={doAdminAllocate}>确认</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
