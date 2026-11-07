import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CreditCard, RefreshCw, Wand2, PackagePlus, Trash2 } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToastStore } from '@/stores/toast'
import { payApi, type PayOrder, type PayItem } from '@/api/pay'

const yuan = (cents: number | null | undefined) => `¥${(((cents ?? 0) as number) / 100).toFixed(2)}`
const ORDER_STATUS: Record<string, string> = {
  pending: '待支付', paid: '已支付', closed: '已关闭', failed: '失败',
}

/** 充值订单 / 商品 —— 支付管理（管理员）。 */
export default function OpsOrders() {
  const toast = useToastStore((s) => s.add)
  const [edit, setEdit] = useState<Partial<PayItem> | null>(null)

  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ['pay-stats'], queryFn: () => payApi.adminStats(), staleTime: 20_000,
  })
  const { data: ordersData, refetch: refetchOrders } = useQuery({
    queryKey: ['pay-admin-orders'], queryFn: () => payApi.adminOrders(100), staleTime: 15_000,
  })
  const { data: itemsData, refetch: refetchItems } = useQuery({
    queryKey: ['pay-admin-items'], queryFn: () => payApi.adminItems(), staleTime: 30_000,
  })
  const orders: PayOrder[] = ordersData?.orders ?? []
  const items: PayItem[] = itemsData?.items ?? []

  const refresh = () => { void refetchStats(); void refetchOrders(); void refetchItems() }

  const [reconciling, setReconciling] = useState(false)
  const reconcile = async () => {
    setReconciling(true)
    try {
      const r = await payApi.reconcile(100) as any
      toast({ type: 'success', message: `对账：扫描 ${r.pending} 单 / 回源 ${r.checked} / 补结算 ${r.settled.length} / 失败 ${r.errors}` })
      refresh()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '对账失败' })
    } finally {
      setReconciling(false)
    }
  }

  const saveItem = async () => {
    if (!edit) return
    try {
      await payApi.upsertItem({
        item_key: edit.item_key ?? '',
        title: edit.title ?? '',
        amount_cents: Math.round(Number(edit.amount_cents) || 0),
        credit_cents: Math.round(Number(edit.credit_cents ?? edit.amount_cents) || 0),
        description: edit.description ?? null,
        sort_order: Number(edit.sort_order ?? 0),
        is_active: (edit.is_active ?? 1) ? 1 : 0,
      })
      toast({ type: 'success', message: '商品已保存' })
      setEdit(null); refresh()
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '保存失败' })
    }
  }

  const orderCols: Column<PayOrder>[] = [
    { key: 'out_trade_no', title: '订单号', width: 'minmax(140px, 2fr)', render: (o) => <span className="tnum text-xs">{o.out_trade_no}</span> },
    { key: 'group_name', title: '组', width: 'minmax(100px, 1fr)' },
    { key: 'username', title: '用户', width: 'minmax(80px, 1fr)', render: (o) => <span className="text-xs">{o.username || '—'}</span> },
    { key: 'subject', title: '商品', width: 'minmax(100px, 2fr)' },
    { key: 'amount_cents', title: '金额', width: '90px', render: (o) => <span className="tnum">{yuan(o.amount_cents)}</span> },
    { key: 'status', title: '状态', width: '80px', render: (o) => <span className={o.status === 'paid' ? 'text-ok' : 'text-muted'}>{ORDER_STATUS[o.status] ?? o.status}</span> },
    { key: 'created_at', title: '创建', width: 'minmax(120px, 1fr)', render: (o) => <span className="text-xs text-muted tnum">{o.created_at?.replace('T', ' ').slice(0, 19)}</span> },
  ]
  const itemCols: Column<PayItem>[] = [
    { key: 'item_key', title: 'Key', width: 'minmax(100px, 1fr)' },
    { key: 'title', title: '标题', width: 'minmax(120px, 2fr)' },
    { key: 'amount_cents', title: '售价', width: '90px', render: (i) => <span className="tnum">{yuan(i.amount_cents)}</span> },
    { key: 'credit_cents', title: '到账', width: '90px', render: (i) => <span className="tnum">{yuan(i.credit_cents)}</span> },
    { key: 'is_active', title: '状态', width: '70px', render: (i) => <span className={i.is_active ? 'text-ok' : 'text-muted'}>{i.is_active ? '上架' : '下架'}</span> },
    { key: 'op', title: '操作', width: '110px', render: (i) => (
      <div className="flex gap-2">
        <button className="text-xs text-accent hover:underline" onClick={() => setEdit({ ...i })}>编辑</button>
        {i.is_active ? (
          <button className="text-xs text-bad hover:underline"
                  onClick={() => payApi.deleteItem(i.item_key).then(() => { toast({ type: 'success', message: '已下架' }); refresh() })}>下架</button>
        ) : null}
      </div>
    ) },
  ]

  return (
    <>
      <PageHeader title="充值订单" description="商品与订单、回调对账"
                  doc={{ section: 'ops', item: 3, label: '计费文档' }}>
        <Button variant="secondary" size="sm" onClick={refresh}><RefreshCw size={14} /> 刷新</Button>
        <Button size="sm" variant="outline" loading={reconciling} onClick={reconcile}><Wand2 size={14} /> 对账</Button>
        <Button size="sm" onClick={() => setEdit({ is_active: 1, credit_cents: 0 })}><PackagePlus size={14} /> 新增商品</Button>
        <PageAiAssistant page="orders" context={stats ? `充值订单\n累计 ${stats.total.orders} 单 / 已付 ${stats.total.paid} / 金额 ${yuan(stats.total.amount_cents)}\n今日 ${stats.today.orders} 单 / ${yuan(stats.today.amount_cents)}；上架商品 ${stats.active_items}` : ''} />
      </PageHeader>

      {!stats ? <SkeletonCard /> : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <Card padding="md">
            <div className="text-xs text-muted mb-1 flex items-center gap-1"><CreditCard size={13} /> 累计订单</div>
            <div className="text-2xl font-bold tnum text-ink">{stats.total.orders}</div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-muted mb-1">已支付</div>
            <div className="text-2xl font-bold tnum text-ok">{stats.total.paid}</div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-muted mb-1">累计金额</div>
            <div className="text-2xl font-bold tnum text-ink">{yuan(stats.total.amount_cents)}</div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-muted mb-1">今日</div>
            <div className="text-2xl font-bold tnum text-ink">{yuan(stats.today.amount_cents)}</div>
            <div className="text-[10px] text-muted">{stats.today.orders} 单</div>
          </Card>
        </div>
      )}

      <div className="space-y-5">
        <Card padding="none">
          <div className="px-4 py-3 text-sm font-semibold text-ink border-b border-black/[0.06]">充值商品</div>
          <div className="p-2">
            <DataTable columns={itemCols} data={items} keyFn={(i) => i.item_key}
                       empty={<EmptyState icon={<PackagePlus size={20} />} title="暂无商品" description="新增充值金额档位。" />} />
          </div>
        </Card>

        <Card padding="none">
          <div className="px-4 py-3 text-sm font-semibold text-ink border-b border-black/[0.06]">最近订单</div>
          <div className="p-2">
            <DataTable columns={orderCols} data={orders} keyFn={(o) => o.out_trade_no}
                       empty={<EmptyState icon={<CreditCard size={20} />} title="暂无订单" />} />
          </div>
        </Card>
      </div>

      <Dialog open={!!edit} onClose={() => setEdit(null)} title="充值商品" width="max-w-md">
        {edit && (
          <div className="space-y-3">
            <Input label="Key（字母数字 _ . -）" value={edit.item_key ?? ''} disabled={!!edit.title && items.some((i) => i.item_key === edit.item_key)}
                   onChange={(e) => setEdit({ ...edit, item_key: e.target.value })} placeholder="topup_10" />
            <Input label="标题" value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="充值 ¥10" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="售价（分）" type="number" value={String(edit.amount_cents ?? '')} onChange={(e) => setEdit({ ...edit, amount_cents: Number(e.target.value) })} placeholder="1000" />
              <Input label="到账（分）" type="number" value={String(edit.credit_cents ?? '')} onChange={(e) => setEdit({ ...edit, credit_cents: Number(e.target.value) })} placeholder="留空=同售价" />
            </div>
            <Input label="描述（可选）" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={!!edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked ? 1 : 0 })} /> 上架
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEdit(null)}>取消</Button>
              <Button onClick={saveItem}><Trash2 size={14} className="hidden" /> 保存</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  )
}
