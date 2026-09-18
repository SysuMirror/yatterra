import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Activity, Cpu, HardDrive, Server, Box, Users, Plus, Bot, Swords, AlertTriangle, Shield, Settings, Plug, Workflow, FolderOpen, ChevronRight, Thermometer, Zap } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { MetricCard } from '@/components/domain/MetricCard'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Progress } from '@/components/ui/Progress'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { api } from '@/api/client'
import { useAuth } from '@/hooks/useAuth'
import { useToastStore } from '@/stores/toast'
import { formatBytes, podStatusLabel } from '@/lib/format'

interface GpuInfo {
  index: number
  name: string
  util: number
  mem_used: number
  mem_total: number
  temp: number
  power: number
  power_limit: number
  groups: string[]
}

interface PodRow {
  name: string
  type: string
  gpus: number[]
  status: string
  my_role: string | null
  cpu: string | number | null
  mem: string | number | null
}

interface DashboardData {
  pods: { total: number; running: number; stopped: number; failed: number }
  metrics: { cpu: number; mem: number; gpu: number; disk: number }
  k3s: { nodeCount: number; version: string } | null
  groupsCount: number
  agents: { total: number; running: number }
  mcp: { total: number; enabled: number }
  llm: { total: number }
  auditToday: number
  threat: { attacks: number; banned: number }
  gpuList: GpuInfo[]
  podList: PodRow[]
}

export default function Dashboard() {
  const toast = useToastStore((s) => s.add)
  const { hasPerm } = useAuth()
  const qc = useQueryClient()
  const [joinTarget, setJoinTarget] = useState<string | null>(null)
  const [joinReason, setJoinReason] = useState('')

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      try {
        const [pods, host, gpu, agents, mcp, llm, audit, threat] = await Promise.all([
          api.get<{ pods: any[]; total: number }>('/pods?per_page=200'),
          api.get<any>('/infra/host').catch(() => null),
          api.get<{ gpus: GpuInfo[]; count: number; error?: string }>('/infra/gpu').catch(() => ({ gpus: [], count: 0 })),
          api.get<any>('/agents').then(d => ({ total: (d.agents ?? d)?.length ?? 0, running: (d.agents ?? d)?.filter((a: any) => a.run_id)?.length ?? 0 })).catch(() => ({ total: 0, running: 0 })),
          hasPerm('dev.mcp')
            ? api.get<any>('/mcp').then(d => { const s = d.servers ?? d; return { total: s?.length ?? 0, enabled: s?.filter((x: any) => x.enabled !== false)?.length ?? 0 } }).catch(() => ({ total: 0, enabled: 0 }))
            : Promise.resolve({ total: 0, enabled: 0 }),
          api.get<any>('/llm/providers').then(d => ({ total: (d.providers ?? d)?.length ?? 0 })).catch(() => ({ total: 0 })),
          hasPerm('ops.audit')
            ? api.get<any>('/audit?per_page=1&since=' + new Date(new Date().setHours(0, 0, 0, 0)).toISOString()).then(d => ({ total: d.total ?? 0 })).catch(() => ({ total: 0 }))
            : Promise.resolve({ total: 0 }),
          api.get<any>('/threat-map?window=1d').then(d => ({ attacks: d?.stats?.total_attacks ?? d?.attacks?.length ?? 0, banned: d?.stats?.total_banned ?? 0 })).catch(() => ({ attacks: 0, banned: 0 })),
        ])
        const h = host as any
        const rootDisk = h?.disk?.find((d: any) => d.mount === '/') ?? h?.disk?.[0]
        const podList: PodRow[] = (pods.pods ?? []).map((p: any) => ({
          name: p.name,
          type: p.type ?? '',
          gpus: p.gpus ?? [],
          status: p.status,
          my_role: p.my_role ?? null,
          cpu: p.cpu ?? null,
          mem: p.mem ?? null,
        }))
        return {
          pods: {
            total: pods.total,
            running: pods.pods?.filter((p: any) => p.status === 'Running').length || 0,
            stopped: pods.pods?.filter((p: any) => p.status === 'Stopped').length || 0,
            failed: pods.pods?.filter((p: any) => p.status === 'Failed').length || 0,
          },
          metrics: {
            cpu: h?.load?.load1 ?? 0,
            mem: h?.mem?.used_pct ?? 0,
            gpu: gpu.count ?? h?.nvidia?.count ?? 0,
            disk: rootDisk?.used_pct ?? 0,
          },
          k3s: h?.k3s ? { nodeCount: h.k3s.count ?? (Array.isArray(h.k3s.nodes) ? h.k3s.nodes.length : 0), version: h.k3s.nodes?.[0]?.version ?? '' } : null,
          groupsCount: h?.groups_count?.count ?? 0,
          agents,
          mcp,
          llm,
          auditToday: audit.total,
          threat,
          gpuList: gpu.gpus ?? [],
          podList,
        }
      } catch {
        return { pods: { total: 0, running: 0, stopped: 0, failed: 0 }, metrics: { cpu: 0, mem: 0, gpu: 0, disk: 0 }, k3s: null, groupsCount: 0, agents: { total: 0, running: 0 }, mcp: { total: 0, enabled: 0 }, llm: { total: 0 }, auditToday: 0, threat: { attacks: 0, banned: 0 }, gpuList: [], podList: [] }
      }
    },
    staleTime: 10_000,
  })

  const d = data
  const hasAlert = (d?.pods.failed ?? 0) > 0 || (d?.metrics.disk ?? 0) > 90

  // Join pod handler
  const handleJoin = async (name: string) => {
    setJoinTarget(name)
    setJoinReason('')
  }
  ;(window as any).__joinPod = handleJoin

  const submitJoin = async () => {
    if (!joinTarget) return
    try {
      await api.post(`/pods/${joinTarget}/join`, { reason: joinReason })
      toast({ type: 'success', message: '已申请加入 ' + joinTarget })
      setJoinTarget(null)
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e: any) {
      toast({ type: 'error', message: e.message || '申请失败' })
    }
  }

  const aiContext = d
    ? `集群概览:\n` +
      `Pod: 总 ${d.pods.total}, 运行 ${d.pods.running}, 停止 ${d.pods.stopped}, 失败 ${d.pods.failed}\n` +
      `资源: CPU负载 ${d.metrics.cpu.toFixed(1)}, 内存 ${d.metrics.mem.toFixed(1)}%, 磁盘 ${d.metrics.disk.toFixed(1)}%, GPU ${d.metrics.gpu} 块\n` +
      `K3s: ${d.k3s ? `${d.k3s.nodeCount} 节点, ${d.k3s.version}` : '未检测'}\n` +
      `Agent: ${d.agents.total} 个 (${d.agents.running} 运行中), LLM: ${d.llm.total} 个\n` +
      (hasPerm('dev.mcp') ? `MCP: ${d.mcp.total} (${d.mcp.enabled} 启用)\n` : '') +
      (hasPerm('ops.audit') ? `今日审计: ${d.auditToday} 条, ` : '') +
      `威胁: ${d.threat.attacks} 次攻击, ${d.threat.banned} 个封禁\n` +
      (d.gpuList.length > 0 ? `GPU 详情:\n${d.gpuList.map(g => `  GPU ${g.index}: ${g.name}, 利用率 ${g.util}%, 显存 ${g.mem_used}/${g.mem_total}GB, ${g.temp}°C`).join('\n')}\n` : '') +
      (d.podList.length > 0 ? `Pod 列表:\n${d.podList.slice(0, 20).map(p => `  ${p.name} [${p.status}] CPU:${p.cpu} Mem:${p.mem} GPU:${p.gpus.join(',')}`).join('\n')}` : '')
    : ''

  return (
    <>
      <PageHeader title="概览" description="集群运行状态" doc={{ section: 'quickstart', item: 0, label: '总览文档' }}>
        <PageAiAssistant page="dashboard" context={aiContext} />
      </PageHeader>

      {/* AI Insight Panel */}
      {!isLoading && d && (
        <AiInsightPanel
          page="dashboard"
          context={aiContext}
          title="集群概览洞察"
          className="mb-5"
        />
      )}

      {/* Alert bar */}
      {hasAlert && !isLoading && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-bad/8 border border-bad/15 mb-5">
          <AlertTriangle size={16} className="text-bad flex-shrink-0" />
          <div className="flex items-center gap-3 flex-wrap text-sm">
            {(d?.pods.failed ?? 0) > 0 && (
              <span className="text-bad font-medium">{d!.pods.failed} 个 Pod 失败</span>
            )}
            {(d?.metrics.disk ?? 0) > 90 && (
              <span className="text-bad font-medium">磁盘使用 {Math.round(d!.metrics.disk)}%</span>
            )}
          </div>
          <Link to="/pods?status=Failed" className="ml-auto text-xs text-bad hover:underline flex items-center gap-1">
            查看详情 <ChevronRight size={12} />
          </Link>
        </div>
      )}

      {/* Stat strip */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<Box size={15} />} label="运行 Pod" value={d?.pods.running ?? 0} suffix={`/ ${d?.pods.total ?? 0}`} />
            <MetricCard icon={<Cpu size={15} />} label="CPU 负载 (1m)" value={(d?.metrics.cpu ?? 0).toFixed(2)} />
            <MetricCard icon={<HardDrive size={15} />} label="内存使用" value={Math.round(d?.metrics.mem ?? 0)} suffix="%" percent={d?.metrics.mem} />
            <MetricCard icon={<Activity size={15} />} label="磁盘使用 (/)" value={Math.round(d?.metrics.disk ?? 0)} suffix="%" percent={d?.metrics.disk} />
            <MetricCard icon={<Server size={15} />} label="GPU" value={d?.metrics.gpu ?? 0} suffix="块" />
          </>
        )}
      </div>

      {/* Cluster card */}
      <section className="glass-card rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-4">集群</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <Row label="运行 / 总计">
            <span className="tnum">
              <span className="font-semibold text-ink">{d?.pods.running ?? 0}</span>
              <span className="text-muted"> / {d?.pods.total ?? 0}</span>
            </span>
          </Row>
          <Row label="已停止">
            <span className="tnum text-muted">{d?.pods.stopped ?? 0}</span>
          </Row>
          {(d?.pods.failed ?? 0) > 0 && (
            <Row label="失败">
              <Badge variant="bad" dot>{d?.pods.failed}</Badge>
            </Row>
          )}
          <Row label="分组">
            <span className="tnum text-ink-2 flex items-center gap-1.5">
              <Users size={13} className="text-muted" />{d?.groupsCount ?? 0}
            </span>
          </Row>
          <Row label="K3s 节点">
            <span className="tnum text-ink-2">{d?.k3s?.nodeCount ?? '—'}</span>
          </Row>
          <Row label="K3s 版本">
            {d?.k3s?.version
              ? <span className="font-mono text-xs text-ink-2">{d.k3s.version}</span>
              : <span className="text-muted text-xs">不可用</span>}
          </Row>
        </dl>
      </section>

      {/* Module health strip */}
      <section className="glass-card rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-4">模块</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ModuleChip
            icon={<Server size={16} className="text-ok" />}
            label="基础设施"
            detail={d?.k3s?.nodeCount ? `${d.k3s.nodeCount} 节点` : '—'}
            ok
            to="/infra"
          />
          <ModuleChip
            icon={<Workflow size={16} className="text-accent" />}
            label="开发"
            detail={hasPerm('dev.mcp')
              ? `${d?.agents.total ?? 0} Agent · ${d?.mcp.enabled ?? 0} MCP`
              : `${d?.agents.total ?? 0} Agent`}
            ok={(d?.agents.total ?? 0) > 0}
            to="/dev"
          />
          {hasPerm('ops.audit') && (
            <ModuleChip
              icon={<Shield size={16} className="text-muted" />}
              label="运维"
              detail={`今日 ${d?.auditToday ?? 0} 事件`}
              ok
              to="/ops"
            />
          )}
          <ModuleChip
            icon={<Swords size={16} className="text-bad" />}
            label="攻防"
            detail={`${d?.threat.attacks ?? 0} 攻击 · ${d?.threat.banned ?? 0} 封禁`}
            ok={(d?.threat.attacks ?? 0) === 0}
            to="/threat-map"
          />
        </div>
      </section>

      {/* GPU overview */}
      {(d?.gpuList?.length ?? 0) > 0 && (
        <section className="glass-card rounded-2xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">GPU</h2>
            <span className="text-xs text-muted">{d!.gpuList.length} 块</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {d!.gpuList.map(g => {
              const memPct = g.mem_total > 0 ? (g.mem_used / g.mem_total) * 100 : 0
              const utilColor = g.util > 85 ? 'bad' : g.util >= 50 ? 'warn' : 'ok'
              const memColor = memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'accent'
              const tempColor = g.temp > 85 ? 'bad' : g.temp > 70 ? 'warn' : 'ok'
              return (
                <div key={g.index} className="p-3 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">GPU {g.index}</span>
                    <Badge variant={utilColor} dot>{g.util}%</Badge>
                  </div>
                  <div className="text-xs text-muted truncate" title={g.name}>{g.name}</div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">显存</span>
                      <span className="font-medium tnum">{formatBytes(g.mem_used * 1024 * 1024)} / {formatBytes(g.mem_total * 1024 * 1024)}</span>
                    </div>
                    <Progress value={memPct} size="sm" color={memColor} />
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted flex items-center gap-1"><Thermometer size={11} />温度</span>
                    <span className={`font-medium tnum ${tempColor === 'bad' ? 'text-bad' : tempColor === 'warn' ? 'text-warn' : 'text-ok'}`}>{g.temp} °C</span>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted flex items-center gap-1"><Zap size={11} />功耗</span>
                    <span className="font-medium tnum">{g.power.toFixed(0)} / {g.power_limit.toFixed(0)} W</span>
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {g.groups.length > 0 ? g.groups.map(gn => (
                      <Badge key={gn} variant="warn" dot>{gn}</Badge>
                    )) : (
                      <Badge variant="ok" dot>空闲</Badge>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Pod list */}
      {(d?.podList?.length ?? 0) > 0 && (
        <section className="glass-card rounded-2xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Pod 列表</h2>
            <span className="text-xs text-muted">{d!.podList.length} 个</span>
          </div>
          <DataTable
            columns={podColumns}
            data={d!.podList}
            keyFn={(r) => r.name}
            onRowClick={(r) => { window.location.href = `/pods/${r.name}` }}
            empty={<span className="text-sm text-muted">暂无 Pod</span>}
          />
        </section>
      )}

      {/* Quick actions */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <QuickAction icon={<Plus size={18} />} label="创建 Pod" desc="新建容器开发环境" to="/pods" />
        <QuickAction icon={<Bot size={18} />} label="AI 对话" desc="与助手交互" to="/dev/harness" />
        <QuickAction icon={<Swords size={18} />} label="查看攻防" desc="实时威胁态势" to="/threat-map" />
      </section>

      {/* Join pod dialog */}
      <Dialog
        open={!!joinTarget}
        onClose={() => setJoinTarget(null)}
        title={`申请加入 ${joinTarget}`}
      >
        <div className="space-y-4">
          <Input
            label="理由"
            placeholder="简要说明加入理由"
            value={joinReason}
            onChange={(e) => setJoinReason((e.target as HTMLInputElement).value)}
          />
          <div className="mt-1"><AiFormHelper type="general" partial={joinReason} context={`申请加入 Pod ${joinTarget} 的理由`} onApply={(v) => setJoinReason(v)} /></div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setJoinTarget(null)}>取消</Button>
            <Button variant="primary" size="sm" onClick={submitJoin}>提交</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}

/** Module health chip — clickable link to module summary page */
function ModuleChip({ icon, label, detail, ok, to }: { icon: React.ReactNode; label: string; detail: string; ok: boolean; to: string }) {
  return (
    <Link
      data-onboarding-target={`goto-${to}`}
      to={to}
      className="flex items-center gap-3 p-3 rounded-xl hover:bg-black/[0.03] active:bg-black/[0.05] transition-colors group"
    >
      <div className="flex-shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? 'bg-ok' : 'bg-warn'}`} />
        </div>
        <p className="text-xs text-muted truncate">{detail}</p>
      </div>
      <ChevronRight size={14} className="text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
    </Link>
  )
}

/** Quick action card */
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted text-[13px]">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/** Pod table columns */
const podColumns: Column<PodRow>[] = [
  {
    key: 'name',
    title: 'Pod 名',
    sortable: true,
    render: (r: PodRow) => <span className="font-medium">{r.name}</span>,
  },
  {
    key: 'type',
    title: '类型',
    width: '80px',
    render: (r: PodRow) => r.type ? <Badge variant="default">{r.type}</Badge> : <span className="text-muted">—</span>,
  },
  {
    key: 'gpus',
    title: 'GPU',
    width: '80px',
    render: (r: PodRow) => r.gpus.length > 0 ? <span className="tnum">{r.gpus.join(', ')}</span> : <span className="text-muted">—</span>,
  },
  {
    key: 'status',
    title: '状态',
    sortable: true,
    width: '100px',
    render: (r: PodRow) => {
      const v = r.status === 'Running' ? 'ok' : r.status === 'Failed' || r.status === 'Error' || r.status === 'CrashLoopBackOff' ? 'bad' : 'warn'
      return <Badge variant={v} dot>{podStatusLabel(r.status)}</Badge>
    },
  },
  {
    key: 'my_role',
    title: '我的角色',
    width: '90px',
    render: (r: PodRow) => {
      if (r.my_role === 'owner') return <Badge variant="ok">Owner</Badge>
      if (r.my_role === 'member') return <Badge variant="default">Member</Badge>
      return <span className="text-muted text-xs">—</span>
    },
  },
  {
    key: 'cpu',
    title: 'CPU / 内存',
    width: '100px',
    render: (r: PodRow) => <span className="tnum text-xs">{r.cpu ?? '—'} / {r.mem ?? '—'}</span>,
  },
  {
    key: 'action',
    title: '',
    width: '80px',
    render: (r: PodRow) => {
      if (r.my_role) return <Link to={`/pods/${r.name}`} className="text-xs text-accent hover:underline">详情</Link>
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => { e.stopPropagation(); (window as any).__joinPod?.(r.name) }}
        >
          申请加入
        </Button>
      )
    },
  },
]
