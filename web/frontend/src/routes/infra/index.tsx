import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Server, Cpu, HardDrive, Monitor, Database, Globe, Container, ChevronRight, Activity, HardDriveDownload } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { CpuRequestPie } from '@/components/domain/CpuRequestPie'
import { api } from '@/api/client'

export default function InfraOverview() {
  const { data: host, isLoading } = useQuery<any>({
    queryKey: ['infra-host'],
    queryFn: () => api.get('/infra/host'),
    staleTime: 10_000,
  })

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

  const { data: proxy } = useQuery<any>({
    queryKey: ['infra-proxy'],
    queryFn: () => api.get('/infra/proxy').catch(() => null),
    staleTime: 30_000,
  })

  const rootDisk = host?.disk?.find((d: any) => d.mount === '/') ?? host?.disk?.[0]
  const proxyMappings = proxy?.mappings ?? proxy?.items ?? []

  return (
    <>
      <PageHeader title="基础设施" description="集群基础设施概览" doc={{ section: 'infra', item: 0, label: '基础设施文档' }}>
        <PageAiAssistant page="infra" context={host ? `基础设施概览: 主机 ${host.hostname ?? '?'}, CPU ${host.cpu?.cores ?? '?'}核, 内存 ${(host.mem?.used_pct ?? 0).toFixed(1)}%, 磁盘 ${(rootDisk?.used_pct ?? 0).toFixed(1)}%, GPU ${host.nvidia?.count ?? 0}块, K3s ${host.k3s?.count ?? 0}节点, 存储桶 ${storage?.buckets?.length ?? 0}个, 代理映射 ${proxyMappings.length}条` : '暂无基础设施数据'} />
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && host && (
        <AiInsightPanel
          page="infra"
          title="基础设施洞察"
          className="mb-5"
          context={`基础设施概览: 主机 ${host.hostname ?? '?'}, CPU ${host.cpu?.cores ?? '?'}核, 内存 ${(host.mem?.used_pct ?? 0).toFixed(1)}%, 磁盘 ${(rootDisk?.used_pct ?? 0).toFixed(1)}%, GPU ${host.nvidia?.count ?? 0}块, K3s ${host.k3s?.count ?? 0}节点, 存储桶 ${storage?.buckets?.length ?? 0}个, 代理映射 ${proxyMappings.length}条, FRP ${host.frpc?.running ?? 0}/${host.frpc?.total ?? 0}`}
        />
      )}

      {/* Core metrics */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<Cpu size={15} />} label="负载 (1m)" value={(host?.load?.load1 ?? 0).toFixed(2)} />
            <MetricCard icon={<HardDrive size={15} />} label="内存" value={Math.round(host?.mem?.used_pct ?? 0)} suffix="%" percent={host?.mem?.used_pct} />
            <MetricCard icon={<Monitor size={15} />} label="GPU" value={host?.nvidia?.count ?? 0} suffix="块" />
            <MetricCard icon={<Server size={15} />} label="K3s 节点" value={host?.k3s?.count ?? 0} />
          </>
        )}
      </div>

      {/* CPU request pie chart */}
      <CpuRequestPie />

      {/* Service status grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {/* Host */}
        <ServiceCard
          icon={<Server size={18} className="text-ok" />}
          title="主机"
          to="/infra/host"
          ok
        >
          <p className="text-xs text-muted">{host?.kernel_os?.nodename ?? '—'}</p>
          {rootDisk && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted">磁盘 /</span>
                <span className="tnum">{Math.round(rootDisk.used_pct ?? 0)}%</span>
              </div>
              <Progress value={rootDisk.used_pct ?? 0} size="sm" color={rootDisk.used_pct > 90 ? 'bad' : rootDisk.used_pct > 70 ? 'warn' : 'ok'} />
            </div>
          )}
        </ServiceCard>

        {/* Storage */}
        <ServiceCard
          icon={<HardDriveDownload size={18} className={storage?.status?.ready ? 'text-ok' : 'text-muted'} />}
          title="存储"
          to="/infra/storage"
          ok={storage?.status?.ready}
        >
          <div className="flex items-center gap-2">
            <Badge variant={storage?.status?.ready ? 'ok' : storage?.status?.deployed ? 'warn' : 'bad'} dot>
              {storage?.status?.deployed ? (storage?.status?.ready ? 'MinIO 运行中' : '启动中') : '未部署'}
            </Badge>
          </div>
          <p className="text-xs text-muted mt-1">{storage?.buckets?.length ?? 0} 个桶</p>
        </ServiceCard>

        {/* Databases */}
        <ServiceCard
          icon={<Database size={18} className="text-accent" />}
          title="数据库"
          to="/infra/databases"
          ok={databases?.status?.mysql?.ready && databases?.status?.redis?.ready}
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            {['mysql', 'redis', 'qdrant'].map(svc => {
              const info = databases?.status?.[svc]
              return (
                <Badge key={svc} variant={info?.ready ? 'ok' : info?.deployed ? 'warn' : 'bad'} dot className="text-[10px]">
                  {svc}
                </Badge>
              )
            })}
          </div>
          <p className="text-xs text-muted mt-1">{databases?.creds?.length ?? 0} 个凭证</p>
        </ServiceCard>

        {/* Proxy */}
        <ServiceCard
          icon={<Globe size={18} className="text-accent" />}
          title="子域名"
          to="/infra/proxy"
          ok={proxy?.container_running}
        >
          <Badge variant={proxy?.container_running ? 'ok' : 'bad'} dot>
            反代 {proxy?.container_running ? '运行中' : '未运行'}
          </Badge>
          <p className="text-xs text-muted mt-1">{proxyMappings.length} 个映射</p>
        </ServiceCard>
      </div>

      {/* GPU summary */}
      {host?.nvidia?.gpus?.length > 0 && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Monitor size={16} className="text-warn" />
            <h2 className="text-sm font-semibold">GPU 摘要</h2>
            <Badge variant="warn" className="ml-auto">驱动 {host.nvidia.driver_version}</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {host.nvidia.gpus.map((g: any, i: number) => (
              <div key={i} className="p-3 rounded-xl bg-black/[0.02]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">#{g.index} {g.name}</span>
                  <Badge variant={g.temp > 80 ? 'bad' : g.temp > 65 ? 'warn' : 'ok'} className="text-[10px]">{g.temp}°C</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-muted mb-1">利用率</p>
                    <Progress value={g.util ?? 0} size="sm" color={g.util > 90 ? 'bad' : g.util > 70 ? 'warn' : 'ok'} />
                  </div>
                  <div>
                    <p className="text-[11px] text-muted mb-1">显存</p>
                    <Progress value={g.mem_total ? (parseFloat(g.mem_used) / parseFloat(g.mem_total)) * 100 : 0} size="sm" color="accent" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Quick actions */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <QuickAction
          icon={<HardDriveDownload size={18} />}
          label="初始化存储"
          desc="部署 MinIO 服务"
          to="/infra/storage"
        />
        <QuickAction
          icon={<Database size={18} />}
          label="初始化数据库"
          desc="部署 MySQL / Redis / Qdrant"
          to="/infra/databases"
        />
        <QuickAction
          icon={<Globe size={18} />}
          label="添加反代映射"
          desc="配置子域名反向代理"
          to="/infra/proxy"
        />
      </section>
    </>
  )
}

function ServiceCard({ icon, title, to, ok, children }: {
  icon: React.ReactNode
  title: string
  to: string
  ok: boolean
  children: React.ReactNode
}) {
  return (
    <Link data-onboarding-target={`goto-${to}`} to={to} className="glass-card rounded-2xl p-4 hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group flex flex-col">
      <div className="flex items-center gap-3 mb-3">
        {icon}
        <span className="text-sm font-semibold">{title}</span>
        <span className={`w-2 h-2 rounded-full ${ok ? 'bg-ok' : 'bg-warn'}`} />
        <ChevronRight size={14} className="ml-auto text-muted/40 group-hover:text-muted transition-colors" />
      </div>
      <div className="flex-1">{children}</div>
    </Link>
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
      <ChevronRight size={14} className="ml-auto text-muted/40 group-hover:text/transition-colors flex-shrink-0" />
    </Link>
  )
}
