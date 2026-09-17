import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, LayoutGrid, Rows3, Box, AlertTriangle, Bot, Power, RotateCw, Trash2 } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PodCard } from '@/components/domain/PodCard'
import { MetricCard } from '@/components/domain/MetricCard'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { SearchBar } from '@/components/ui/SearchBar'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useIsDesktop, useMediaQuery } from '@/hooks/useMediaQuery'
import { formatSpec, podStatusLabel } from '@/lib/format'
import { cn } from '@/lib/cn'

interface Pod {
  name: string
  status: string
  cpu: string | number
  mem: string | number
  gpus: number[]
  storage: string | number
  owners: string[]
  members: string[]
  my_role: string
  type: string
  reason?: string
}

type ViewMode = 'table' | 'cards'

const ROLE_LABELS: Record<string, string> = {
  owner: '负责人',
  member: '成员',
  super: '管理员',
  admin: '管理员',
}

const statusOrder: Record<string, number> = { Failed: 0, Pending: 1, Running: 2, Stopped: 3, Succeeded: 4 }

export default function PodList() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Pod | null>(null)
  const navigate = useNavigate()
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const isDesktop = useIsDesktop()
  // Hide spec column below 900px; hide owner below 640px
  const showSpec = useMediaQuery('(min-width: 900px)')
  const showOwner = useMediaQuery('(min-width: 640px)')
  // Dense table on desktop by default; single-column cards on phones
  const [view, setView] = useState<ViewMode>(isDesktop ? 'table' : 'cards')

  const { data, isLoading } = useQuery<{ pods: Pod[]; total: number }>({
    queryKey: ['pods', { search, status: statusFilter }],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter) params.set('status', statusFilter)
      return api.get(`/pods?${params}`)
    },
    staleTime: 5_000,
  })

  const pods = (data?.pods ?? []).slice().sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || a.name.localeCompare(b.name),
  )

  const refresh = () => qc.invalidateQueries({ queryKey: ['pods'] })

  const act = (pod: Pod, action: 'start' | 'stop' | 'restart', label: string) =>
    api.post(`/pods/${pod.name}/${action}`)
      .then(() => { toast({ type: 'success', message: `${pod.name} ${label}` }); refresh() })
      .catch((e: any) => toast({ type: 'error', message: e?.message || `${label}失败` }))

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await api.del(`/pods/${deleteTarget.name}`)
      toast({ type: 'success', message: `${deleteTarget.name} 已删除` })
      setDeleteTarget(null)
      refresh()
    } catch (e: any) {
      toast({ type: 'error', message: e?.message || '删除失败' })
    }
  }

  const columns: Column<Pod>[] = [
    {
      key: 'status',
      title: '状态',
      width: '90px',
      render: (p) => <Badge variant={
        p.status === 'Running' ? 'ok' : p.status === 'Failed' ? 'bad'
        : p.status === 'Pending' ? 'warn' : 'muted'
      } dot>{podStatusLabel(p.status)}</Badge>,
    },
    {
      key: 'name',
      title: '名称',
      width: 'minmax(120px, 2fr)',
      sortable: true,
      render: (p) => (
        <span className="font-mono text-[13px] font-medium text-ink" title={p.name}>{p.name}</span>
      ),
    },
    ...(showSpec ? [{
      key: 'cpu',
      title: '规格',
      width: 'minmax(100px, 1.2fr)',
      render: (p: Pod) => (
        <span className="text-xs text-ink-2 tnum whitespace-nowrap">
          {formatSpec(p.cpu, p.mem, p.gpus?.length ?? 0, p.storage)}
        </span>
      ),
    }] : []),
    ...(showOwner ? [{
      key: 'owners',
      title: '负责人',
      width: 'minmax(80px, 1fr)',
      render: (p: Pod) => (
        <span className="text-xs text-ink-2 truncate block max-w-[160px]" title={p.owners?.join('、')}>
          {p.owners?.join('、') || '—'}
          {p.members?.length > 1 ? ` +${p.members.length - 1}` : ''}
        </span>
      ),
    }] : []),
    {
      key: 'my_role',
      title: '我的角色',
      width: '80px',
      render: (p) => (
        <span className={cn(
          'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium',
          p.my_role === 'owner' ? 'bg-ok/10 text-[#1a7f37]' :
          p.my_role === 'admin' || p.my_role === 'super' ? 'bg-accent/10 text-accent-dark' :
          'bg-black/[0.03] text-muted',
        )}>
          {ROLE_LABELS[p.my_role] ?? p.my_role ?? '—'}
        </span>
      ),
    },
    {
      key: '_actions',
      title: '',
      width: '140px',
      render: (p) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <ActionBtn
            icon={p.status === 'Running' ? <Power size={13} /> : <Power size={13} className="text-ok" />}
            label={p.status === 'Running' ? '停止' : '启动'}
            variant={p.status === 'Running' ? 'ghost' : 'start'}
            onClick={() => act(p, p.status === 'Running' ? 'stop' : 'start', p.status === 'Running' ? '停止中' : '启动中')}
          />
          <ActionBtn
            icon={<RotateCw size={13} />}
            label="重启"
            variant="ghost"
            onClick={() => act(p, 'restart', '重启中')}
          />
          <ActionBtn
            icon={<Trash2 size={13} />}
            label="删除"
            variant="danger"
            onClick={() => setDeleteTarget(p)}
          />
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader title="Pod" count={data?.total} description="容器开发环境" doc={{ section: 'pods', item: 0, label: 'Pod 文档' }}>
        <div className="flex items-center gap-2">
          {isDesktop && (
            <div className="flex items-center rounded-lg border-[0.5px] border-black/[0.08] overflow-hidden">
              <ViewBtn active={view === 'table'} onClick={() => setView('table')} label="列表" icon={<Rows3 size={14} />} />
              <ViewBtn active={view === 'cards'} onClick={() => setView('cards')} label="卡片" icon={<LayoutGrid size={14} />} />
            </div>
          )}
          <PageAiAssistant page="pod" context={pods.length > 0 ? `Pod 总数: ${pods.length}\n${pods.slice(0, 30).map(p => `  ${p.name} [${p.status}] CPU:${p.cpu} Mem:${p.mem}GB GPU:${p.gpus.join(',')} 类型:${p.type}`).join('\n')}` : '暂无 Pod'} />
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> 创建 Pod
          </Button>
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && pods.length > 0 && (
        <AiInsightPanel
          page="pod"
          title="Pod 集群洞察"
          className="mb-5"
          context={`Pod 总数: ${pods.length}, 运行 ${pods.filter(p => p.status === 'Running').length}, 停止 ${pods.filter(p => p.status === 'Stopped').length}, 失败 ${pods.filter(p => p.status === 'Failed').length}\n${pods.slice(0, 25).map(p => `  ${p.name} [${p.status}] CPU:${p.cpu} Mem:${p.mem}GB GPU:${p.gpus?.join(',')} 类型:${p.type} 负责人:${p.owners?.join(',') ?? '?'}`).join('\n')}`}
        />
      )}

      {/* Summary strip */}
      {!isLoading && data && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-5">
          <MetricCard icon={<Box size={15} className="text-ok" />} label="运行" value={pods.filter(p => p.status === 'Running').length} />
          <MetricCard icon={<Box size={15} className="text-muted" />} label="已停止" value={pods.filter(p => p.status === 'Stopped').length} />
          <MetricCard icon={<AlertTriangle size={15} className="text-bad" />} label="失败" value={pods.filter(p => p.status === 'Failed').length} />
          <MetricCard icon={<Box size={15} className="text-accent" />} label="我的" value={pods.filter(p => p.my_role === 'owner' || p.my_role === 'member').length} />
        </div>
      )}

      {/* AI diagnostic hint for failed pods */}
      {!isLoading && pods.some(p => p.status === 'Failed') && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/6 border border-accent/12 mb-5 text-sm">
          <Bot size={15} className="text-accent" />
          <span className="text-ink-2">有 Pod 失败，</span>
          <button
            className="text-accent font-medium hover:underline"
            onClick={() => setStatusFilter('Failed')}
          >
            查看失败 Pod → AI 诊断
          </button>
        </div>
      )}

      {/* Filters — wrap on narrow screens instead of squeezing */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <SearchBar value={search} onChange={setSearch} placeholder="搜索 Pod 名称..." className="flex-1 min-w-[180px] max-w-xs" />
        <Select
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: '', label: '全部状态' },
            { value: 'Running', label: '运行中' },
            { value: 'Stopped', label: '已停止' },
            { value: 'Pending', label: '等待中' },
            { value: 'Failed', label: '失败' },
          ]}
          className="w-[140px]"
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : pods.length === 0 ? (
        <EmptyState
          icon={<Plus size={24} />}
          title="暂无 Pod"
          description={search || statusFilter ? '没有匹配的环境，试试调整筛选条件' : '创建一个 Pod 开始开发'}
          action={<Button onClick={() => setCreateOpen(true)}><Plus size={16} /> 创建 Pod</Button>}
        />
      ) : view === 'table' ? (
        <div className="glass-card rounded-2xl">
          <DataTable
            columns={columns}
            data={pods}
            keyFn={(p) => p.name}
            onRowClick={(p) => navigate(`/pods/${p.name}`)}
          />
        </div>
      ) : (
        /* auto-fill + minmax: cards wrap to a new column instead of being
           crushed — never narrower than 260px, never stretched past 1fr */
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {pods.map((pod) => (
            <PodCard
              key={pod.name}
              name={pod.name}
              status={pod.status}
              cpu={typeof pod.cpu === 'string' ? parseInt(pod.cpu) || 0 : pod.cpu}
              mem={typeof pod.mem === 'string' ? parseInt(pod.mem) || 0 : pod.mem}
              gpus={pod.gpus?.length ?? 0}
              storage={typeof pod.storage === 'string' ? parseInt(pod.storage) || 0 : pod.storage}
              owner={pod.owners?.join('、') || pod.my_role || ''}
              members={pod.members?.length}
              role={pod.my_role}
              reason={pod.reason}
              onClick={() => navigate(`/pods/${pod.name}`)}
              onStart={() => act(pod, 'start', '启动中')}
              onStop={() => act(pod, 'stop', '停止中')}
              onRestart={() => act(pod, 'restart', '重启中')}
              onDelete={() => setDeleteTarget(pod)}
            />
          ))}
        </div>
      )}

      <CreatePodDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除 Pod"
        description={`确定删除 ${deleteTarget?.name ?? ''}？该操作不可撤销，环境内数据将丢失。`}
        width="max-w-sm"
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>取消</Button>
          <Button variant="danger" onClick={confirmDelete}>确认删除</Button>
        </div>
      </Dialog>
    </>
  )
}

function ViewBtn({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 px-3 h-9 text-xs font-medium transition-colors duration-100',
        active ? 'bg-black/[0.06] text-ink' : 'text-muted hover:text-ink',
      )}
    >
      {icon}{label}
    </button>
  )
}

/** Proper UI action button with icon + label, color-coded by variant. */
function ActionBtn({ icon, label, variant, onClick }: {
  icon: React.ReactNode
  label: string
  variant: 'ghost' | 'start' | 'danger'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-semibold transition-colors duration-100',
        variant === 'danger'
          ? 'text-muted hover:text-bad hover:bg-bad/10'
          : variant === 'start'
          ? 'text-ok hover:bg-ok/10'
          : 'text-muted hover:text-ink hover:bg-black/[0.05]',
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function CreatePodDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [cpu, setCpu] = useState('2')
  const [mem, setMem] = useState('4')
  const [gpus, setGpus] = useState('0')
  const [storage, setStorage] = useState('20')
  const [loading, setLoading] = useState(false)
  const toast = useToastStore((s) => s.add)
  const navigate = useNavigate()

  const handleCreate = async () => {
    setLoading(true)
    try {
      const res = await api.post<{ name?: string }>('/pods', { name, cpu: +cpu, mem: +mem, gpus: +gpus, storage: +storage })
      const finalName = res?.name || name
      toast({ type: 'success', message: `Pod ${finalName} 创建成功` })
      onClose()
      navigate(`/pods/${finalName}`)
    } catch (err: any) {
      toast({ type: 'error', message: err.message || '创建失败' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="创建 Pod" description="配置新的容器开发环境" width="max-w-md">
      <div className="space-y-4">
        <div>
          <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-pod" hint="小写字母、数字、连字符；大写自动转小写，下划线自动转连字符" />
          <div className="mt-1"><AiFormHelper type="pod" partial={name} onApply={setName} /></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="CPU (核)" type="number" value={cpu} onChange={(e) => setCpu(e.target.value)} />
          <Input label="内存 (GB)" type="number" value={mem} onChange={(e) => setMem(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="GPU" type="number" value={gpus} onChange={(e) => setGpus(e.target.value)} />
          <Input label="存储 (GB)" type="number" value={storage} onChange={(e) => setStorage(e.target.value)} />
        </div>
        <div className="mt-1"><AiFormHelper type="pod" partial={`${cpu}核/${mem}GB/${gpus}/${storage}GB`} context="CPU核/内存GB/GPU/存储GB" onApply={(v) => { const p = v.split(/[\/\s]+/).filter(Boolean); if (p.length >= 4) { setCpu((p[0] ?? '').replace(/\D/g, '')); setMem((p[1] ?? '').replace(/\D/g, '')); setGpus((p[2] ?? '').replace(/\D/g, '')); setStorage((p[3] ?? '').replace(/\D/g, '')); } }} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={handleCreate} loading={loading} disabled={!name.trim()}>创建</Button>
        </div>
      </div>
    </Dialog>
  )
}
