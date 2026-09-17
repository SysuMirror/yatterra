import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, FolderOpen, Swords, ChevronRight, AlertTriangle, Ban, Crosshair, Server, HardDrive, Database, Bot, Activity } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { api } from '@/api/client'
import { formatDatetime } from '@/lib/format'

function actionVariant(action: string): 'bad' | 'ok' | 'accent' | 'muted' {
  const a = action.toLowerCase()
  if (a.includes('fail') || a.includes('delete') || a.includes('remove')) return 'bad'
  if (a.includes('create') || a.includes('start') || a.includes('mkdir')) return 'ok'
  if (a.includes('login') || a.includes('update') || a.includes('stop')) return 'accent'
  return 'muted'
}

export default function OpsOverview() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const { data: audit, isLoading: auditLoading } = useQuery<any>({
    queryKey: ['audit-recent'],
    queryFn: () => api.get(`/audit?per_page=5&since=${today.toISOString()}`),
    staleTime: 10_000,
  })

  const { data: threat } = useQuery<any>({
    queryKey: ['threat-summary'],
    queryFn: () => api.get<any>('/threat-map?window=1d').then((d: any) => ({
      attacks: d?.stats?.total_attacks ?? d?.attacks?.length ?? 0,
      banned: d?.stats?.total_banned ?? 0,
      normal: d?.stats?.total_normal ?? 0,
    })).catch(() => ({ attacks: 0, banned: 0, normal: 0 })),
    staleTime: 30_000,
  })

  const { data: shared } = useQuery<any>({
    queryKey: ['shared-root'],
    queryFn: () => api.get('/shared?path=/').catch(() => null),
    staleTime: 30_000,
  })

  // System health
  const { data: host } = useQuery<any>({
    queryKey: ['infra-host'],
    queryFn: () => api.get('/infra/host'),
    staleTime: 10_000,
  })

  // Service status
  const { data: storage } = useQuery<any>({
    queryKey: ['infra-storage'],
    queryFn: () => api.get('/infra/storage').catch(() => null),
    staleTime: 30_000,
  })

  const { data: databases } = useQuery<any>({
    queryKey: ['infra-databases'],
    queryFn: () => api.get('/infra/databases').catch(() => null),
    staleTime: 30_000,
  })

  // LLM usage
  const { data: llmUsage } = useQuery<any>({
    queryKey: ['llm-usage-summary'],
    queryFn: () => api.get('/llm/usage/summary').catch(() => null),
    staleTime: 30_000,
  })

  const auditEntries = audit?.entries ?? []
  const auditTotal = audit?.total ?? 0
  const sharedFiles = shared?.entries ?? (Array.isArray(shared) ? shared : [])

  const k3sReady = host?.k3s?.nodes?.every((n: any) => n.ready) ?? false
  const rootDisk = host?.disk?.find((d: any) => d.mount === '/') ?? host?.disk?.[0]

  return (
    <>
      <PageHeader title="运维" description="审计、共享与安全概览" doc={{ section: 'ops', item: 0, label: '运维文档' }}>
        <PageAiAssistant page="ops" context={`运维概览: 今日审计 ${audit?.total ?? 0} 条, 威胁攻击 ${threat?.stats?.total_attacks ?? 0} 次, 封禁 ${threat?.stats?.total_banned ?? 0} 个, K3s ${k3sReady ? '正常' : '异常'}, 磁盘 ${(rootDisk?.used_pct ?? 0).toFixed(1)}%`} />
      </PageHeader>

      {/* AI Insight */}
      {!auditLoading && (
        <AiInsightPanel
          page="ops"
          title="运维概览洞察"
          className="mb-5"
          context={`运维概览: 今日审计 ${(audit?.total ?? 0)} 条, 威胁 ${threat?.attacks ?? 0} 次攻击/${threat?.banned ?? 0} 封禁, 主机负载 ${host?.load?.load1 ?? '?'}\n最近审计:\n${(audit?.entries ?? []).slice(0, 10).map((r: any) => `  ${r.time ?? r.ts ?? ''} ${r.actor ?? '?'} ${r.action ?? ''}`).join('\n')}`}
        />
      )}

      {/* Core metrics */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {auditLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<ShieldCheck size={15} className="text-accent" />} label="今日事件" value={auditTotal} />
            <MetricCard icon={<FolderOpen size={15} className="text-ok" />} label="共享文件" value={sharedFiles.length} />
            <MetricCard icon={<Crosshair size={15} className="text-bad" />} label="攻击源" value={threat?.attacks ?? 0} />
            <MetricCard icon={<Ban size={15} className="text-warn" />} label="已封禁" value={threat?.banned ?? 0} />
          </>
        )}
      </div>

      {/* System health */}
      {host && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Server size={16} className="text-ok" />
              <h2 className="text-sm font-semibold">系统健康</h2>
            </div>
            <Link to="/infra/host" className="text-xs text-accent hover:underline flex items-center gap-1">
              查看详情 <ChevronRight size={12} />
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted mb-1">K3s 集群</p>
              <Badge variant={k3sReady ? 'ok' : 'bad'} dot>{k3sReady ? '正常' : '异常'}</Badge>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">内存</p>
              <div className="flex items-center gap-1">
                <Progress value={host.mem?.used_pct ?? 0} size="sm" color={host.mem?.used_pct > 90 ? 'bad' : host.mem?.used_pct > 70 ? 'warn' : 'ok'} />
                <span className="tnum text-xs">{Math.round(host.mem?.used_pct ?? 0)}%</span>
              </div>
            </div>
            {rootDisk && (
              <div>
                <p className="text-xs text-muted mb-1">磁盘 /</p>
                <div className="flex items-center gap-1">
                  <Progress value={rootDisk.used_pct ?? 0} size="sm" color={rootDisk.used_pct > 90 ? 'bad' : rootDisk.used_pct > 70 ? 'warn' : 'ok'} />
                  <span className="tnum text-xs">{Math.round(rootDisk.used_pct ?? 0)}%</span>
                </div>
              </div>
            )}
            <div>
              <p className="text-xs text-muted mb-1">负载</p>
              <p className="font-medium tnum">{host.load?.load1?.toFixed(2) ?? '—'}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Service status */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-accent" />
          <h2 className="text-sm font-semibold">服务状态</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ServiceBadge name="MinIO" ready={storage?.status?.ready} deployed={storage?.status?.deployed} />
          <ServiceBadge name="MySQL" ready={databases?.status?.mysql?.ready} deployed={databases?.status?.mysql?.deployed} />
          <ServiceBadge name="Redis" ready={databases?.status?.redis?.ready} deployed={databases?.status?.redis?.deployed} />
          <ServiceBadge name="Qdrant" ready={databases?.status?.qdrant?.ready} deployed={databases?.status?.qdrant?.deployed} />
        </div>
      </Card>

      {/* LLM usage summary */}
      {llmUsage && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Bot size={16} className="text-accent" />
              <h2 className="text-sm font-semibold">LLM 用量</h2>
            </div>
            <Link to="/dev/llm" className="text-xs text-accent hover:underline flex items-center gap-1">
              查看详情 <ChevronRight size={12} />
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted mb-1">总 Token</p>
              <p className="font-medium tnum">{(llmUsage.total_tokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">Prompt</p>
              <p className="font-medium tnum">{(llmUsage.prompt_tokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">Completion</p>
              <p className="font-medium tnum">{(llmUsage.completion_tokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">总费用</p>
              <p className="font-medium tnum">¥{(llmUsage.total_cost ?? 0).toFixed(2)}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Recent audit */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">最近审计</h2>
            <Badge variant="muted">今日 {auditTotal} 条</Badge>
          </div>
          <Link to="/ops/audit" className="text-xs text-accent hover:underline flex items-center gap-1">
            查看全部 <ChevronRight size={12} />
          </Link>
        </div>
        {auditEntries.length > 0 ? (
          <div className="space-y-2">
            {auditEntries.map((entry: any, i: number) => (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors">
                <span className="text-xs text-muted tnum w-[140px] flex-shrink-0">
                  {formatDatetime(entry.ts || entry.time)}
                </span>
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{entry.actor || entry.user}</span>
                <Badge variant={actionVariant(entry.action || entry.type)} className="text-[10px]">
                  {entry.action || entry.type}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted py-4 text-center">今日暂无审计事件</p>
        )}
      </Card>

      {/* Threat summary */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Swords size={16} className="text-bad" />
            <h2 className="text-sm font-semibold">攻防态势</h2>
          </div>
          <Link to="/threat-map" className="text-xs text-accent hover:underline flex items-center gap-1">
            查看地图 <ChevronRight size={12} />
          </Link>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <Row label="攻击连接">{threat?.attacks ?? 0}</Row>
          <Row label="正常访问">{threat?.normal ?? 0}</Row>
          <Row label="已封禁">{threat?.banned ?? 0}</Row>
          <Row label="威胁等级">
            <Badge variant={(threat?.attacks ?? 0) > 100 ? 'bad' : (threat?.attacks ?? 0) > 10 ? 'warn' : 'ok'}>
              {(threat?.attacks ?? 0) > 100 ? '高' : (threat?.attacks ?? 0) > 10 ? '中' : '低'}
            </Badge>
          </Row>
        </dl>
      </Card>

      {/* Quick actions */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <QuickAction icon={<ShieldCheck size={18} />} label="查看审计" desc="完整操作审计日志" to="/ops/audit" />
        <QuickAction icon={<FolderOpen size={18} />} label="浏览共享" desc="跨 Pod 共享文件" to="/ops/shared" />
        <QuickAction icon={<Swords size={18} />} label="攻防地图" desc="实时威胁态势" to="/threat-map" />
      </section>
    </>
  )
}

function ServiceBadge({ name, ready, deployed }: { name: string; ready?: boolean; deployed?: boolean }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-xl bg-black/[0.02]">
      <Badge variant={ready ? 'ok' : deployed ? 'warn' : 'bad'} dot className="text-[10px]">
        {name}
      </Badge>
      <span className="text-xs text-muted">
        {ready ? '运行中' : deployed ? '启动中' : '未部署'}
      </span>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="text-sm font-medium tnum">{children}</dd>
    </div>
  )
}

function QuickAction({ icon, label, desc, to }: { icon: React.ReactNode; label: string; desc: string; to: string }) {
  return (
    <Link
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
