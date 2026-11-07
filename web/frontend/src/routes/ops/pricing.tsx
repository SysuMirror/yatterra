import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, Save, RefreshCw, Play, Info } from 'lucide-react'
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
import { billingMoneyApi, type BillingAccount, type WalletAccount } from '@/api/billing'

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
  const [bulkText, setBulkText] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
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

  const { data: walletData, refetch: refetchWallets } = useQuery({
    queryKey: ['billing-wallets'],
    queryFn: () => billingMoneyApi.adminWallets(),
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

  const setInternal = async (acct: BillingAccount, flag: boolean) => {
    try {
      await billingMoneyApi.bulkAccounts([acct.group_name], { internal: flag })
      toast({ type: 'success', message: `${acct.group_name} → ${flag ? '内部组(不计费)' : '外部组(计费)'}` })
      void refetchAccts()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    }
  }

  const runBulk = async (flag: boolean) => {
    const names = bulkText.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)
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
    { key: 'group_name', title: '组', width: 'minmax(120px, 2fr)' },
    { key: 'internal', title: '归属', width: '80px', render: (a) => (
      <button className={`text-xs hover:underline ${a.internal ? 'text-muted' : 'text-accent'}`}
              onClick={() => setInternal(a, !a.internal)}
              title={a.internal ? '平台内部组：不计费' : '外部组：按用量计费'}>
        {a.internal ? '内部' : '外部'}
      </button>
    ) },
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

      <Card padding="md" className="mb-5 bg-accent/[0.04] border-accent/20">
        <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-ink"><Info size={15} className="text-accent" /> 怎么用</div>
        <ul className="list-disc list-inside text-xs text-muted space-y-1 leading-relaxed">
          <li>① 设单价：填每种资源的「分 / 计量单位」，<b>0 表示该项不计费</b>。填完点保存，立即对下一次结算生效。</li>
          <li>② 看账户：结算或充值后每个组会自动建账，可在此查看余额、切换<b>归属（内部/外部）</b>、开关计费、人工调整余额。<b>默认全部组计费</b>；把平台自己的组标记为「内部」即免计费（不结算、不提醒）。</li>
          <li>③ 看钱包：用户的充值先进<b>个人钱包</b>（本页「用户钱包」表），再由用户/管理员<b>分配</b>给具体 Pod。可人工调整钱包余额、冻结钱包、或代用户给某 Pod 分配/收回额度。</li>
          <li>④ 跑结算：每小时结算一次（幂等，重复跑只补未结算的小时）。改动后可点「试算」预览不落账。</li>
        </ul>
      </Card>

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
        <div className="px-4 py-3 border-b border-black/[0.06]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-ink">组账户</span>
            <span className="text-xs text-muted">默认全部计费；「内部组」免计费（不结算、不提醒）。</span>
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <div className="w-64">
                <Input value={bulkText} onChange={(e) => setBulkText(e.target.value)}
                       placeholder="批量：组名，逗号/空格分隔" />
              </div>
              <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulk(true)}>设为内部</Button>
              <Button size="sm" variant="outline" loading={bulkBusy} onClick={() => runBulk(false)}>设为外部</Button>
            </div>
          </div>
        </div>
        <div className="p-2">
          <DataTable columns={acctCols} data={accounts} keyFn={(a) => a.group_name}
                     empty={<EmptyState icon={<Coins size={20} />} title="暂无账户" description="结算或首次充值后自动建账。" />} />
        </div>
      </Card>

      {/* 用户钱包 */}
      <Card padding="none" className="mt-5">
        <div className="px-4 py-3 border-b border-black/[0.06]">
          <div className="text-sm font-semibold text-ink">用户钱包</div>
          <div className="text-xs text-muted">充值的钱先进这里；用户把钱分配给它所属的 Pod，Pod 再独立扣费。可人工调整、冻结、或代分配/收回。</div>
        </div>
        <div className="p-2">
          <DataTable columns={walletCols} data={wallets} keyFn={(w) => w.username}
                     empty={<EmptyState icon={<Coins size={20} />} title="暂无钱包" description="用户首次充值或首次分配后自动建钱包。" />} />
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
