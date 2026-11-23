import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Server, MemoryStick, Monitor, Database, Globe, Container, ChevronRight, Activity, HardDriveDownload } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { CpuRequestPie, MemRequestPie } from '@/components/domain/CpuRequestPie'
import { CpuUsagePie, MemUsagePie } from '@/components/domain/LiveUsagePie'
import { api } from '@/api/client'
import InfraNav from '@/components/infra/InfraNav'
import { archLabel, fleetCards } from '@/lib/fleetMachines'

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

  const { data: clickhouse } = useQuery<any>({
    queryKey: ['infra-clickhouse'],
    queryFn: () => api.get('/infra/clickhouse').catch(() => null),
    staleTime: 30_000,
  })

  const { data: kafka } = useQuery<any>({
    queryKey: ['infra-kafka'],
    queryFn: () => api.get('/infra/kafka').catch(() => null),
    staleTime: 30_000,
  })

  const { data: proxy } = useQuery<any>({
    queryKey: ['infra-proxy'],
    queryFn: () => api.get('/infra/proxy').catch(() => null),
    staleTime: 30_000,
  })

  const { data: usage } = useQuery<any>({
    queryKey: ['infra-usage'],
    queryFn: () => api.get('/infra/usage').catch(() => null),
    staleTime: 10_000,
  })

  const { data: fleet } = useQuery<any>({
    queryKey: ['infra-fleet'],
    queryFn: () => api.get('/infra/fleet'),
    refetchInterval: 30_000,
  })
  const machineCards = fleetCards(fleet?.hosts ?? [])
  const disks: any[] = Array.isArray(host?.disk) ? host.disk : []
  const shownDisks = disks
  const storageOk = !!storage?.status?.ready
  const databasesOk = !!(databases?.status?.mysql?.ready && databases?.status?.redis?.ready && clickhouse?.status?.ready && kafka?.status?.ready)
  const proxyOk = !!proxy?.container_running
  const diskSummary = disks.map((d) => d.error ? `${d.mount} 不可用` : `${d.mount} ${(d.used_pct ?? 0).toFixed(1)}%`).join('，')
  const proxyMappings = proxy?.mappings ?? proxy?.items ?? []
  const accelCards = machineCards.filter((card) => !card.empty)
  const utilKnown = accelCards.filter((card) => card.util != null)
  const fleetAvgUtil = utilKnown.length ? Math.round(utilKnown.reduce((sum, card) => sum + (card.util ?? 0), 0) / utilKnown.length) : 0

  // live cgroup usage (actual, not reserved) — top groups by memory
  const liveTop = (usage?.groups ?? [])
    .slice(0, 5)
    .map((g: any) => `${g.name} CPU ${g.cpu_cores}核/内存 ${g.mem_gi}Gi`)
    .join(', ')
  const liveCtx = usage
    ? `, 实时占用: CPU ${usage.used_cores}/${usage.cores}核, 内存 ${usage.used_mem_gi}/${usage.mem_total_gi}Gi` +
      (liveTop ? `（${liveTop}）` : '')
    : ''

  return (
    <>
      <InfraNav />
      <PageHeader title="基础设施" description="查看每台机器的架构与硬件，进入机器、加速器或平台服务" doc={{ section: 'infra', item: 0, label: '基础设施文档' }}>
        <PageAiAssistant page="infra" context={host ? `基础设施概览: 主机 ${host.hostname ?? '?'}, CPU ${host.cpu?.cores ?? '?'}核, 内存 ${(host.mem?.used_pct ?? 0).toFixed(1)}%, 磁盘 ${diskSummary || '无'}, GPU ${host.nvidia?.count ?? 0}块, K3s ${host.k3s?.count ?? 0}节点, 存储桶 ${storage?.buckets?.length ?? 0}个, 代理映射 ${proxyMappings.length}条${liveCtx}` : '暂无基础设施数据'} />
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && host && (
        <div data-onboarding-target="infra-insight" className="mb-5">
        <AiInsightPanel
          page="infra"
          title="基础设施洞察"
          context={`基础设施概览: 主机 ${host.hostname ?? '?'}, CPU ${host.cpu?.cores ?? '?'}核, 内存 ${(host.mem?.used_pct ?? 0).toFixed(1)}%, 磁盘 ${diskSummary || '无'}, GPU ${host.nvidia?.count ?? 0}块, K3s ${host.k3s?.count ?? 0}节点, 存储桶 ${storage?.buckets?.length ?? 0}个, 代理映射 ${proxyMappings.length}条, FRP ${host.frpc?.running ?? 0}/${host.frpc?.total ?? 0}${liveCtx}`}
        />
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold">机器</h2>
        {(fleet?.hosts ?? []).length === 0 && <p className="text-sm text-muted">还没有机器采样</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(fleet?.hosts ?? []).map((item: any) => {
            const own = machineCards.filter((card) => card.hostId === item.id && !card.empty)
            const data = item.data ?? {}
            const diskList = Array.isArray(data.disks) ? data.disks : []
            return (
              <Link key={item.id} to={`/infra/host?machine=${encodeURIComponent(item.id)}`} className="glass-card rounded-2xl p-4 hover:bg-black/[0.02]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm">{item.name || item.id}</span>
                  <Badge variant={item.status === 'online' && !item.stale ? 'ok' : 'warn'} dot>{item.status || '未知'}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted">{archLabel(item.hardware?.arch)}{item.hardware?.cpu_model ? ` · ${item.hardware.cpu_model}` : ''}{item.hardware?.product ? ` · ${item.hardware.product}` : ''}</p>
                <p className="mt-1 text-xs">{own.length ? own.map((card) => card.name).join('、') : '无加速器'}</p>
                <p className="mt-2 text-xs text-muted">CPU {data.cpu?.usage_pct ?? '—'}% · 内存 {data.memory?.usage_pct ?? '—'}%{diskList.length ? ` · ${diskList.length} 块盘` : ''}</p>
              </Link>
            )
          })}
        </div>
      </section>

      {accelCards.length > 0 && (
        <Link
          data-onboarding-target="infra-gpu"
          to="/infra/gpu"
          className="glass-card rounded-2xl p-4 mb-6 flex items-center gap-4 hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group"
        >
          <div className="w-10 h-10 rounded-xl bg-warn/10 flex items-center justify-center text-warn flex-shrink-0">
            <Monitor size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold group-hover:text-accent transition-colors">加速器</span>
              <Badge variant="muted" className="text-[10px]">{accelCards.length} 块</Badge>
            </div>
            <p className="text-xs text-muted mt-0.5">
              每台机器的加速器分开看 · 已上报利用率的平均 {fleetAvgUtil}%
            </p>
          </div>
          <ChevronRight size={16} className="text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
        </Link>
      )}

      <h2 className="mb-3 text-sm font-semibold">平台服务</h2>
      {/* Service status grid */}
      <div data-onboarding-target="infra-services" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {/* Host */}
        <ServiceCard
          icon={<Server size={18} className="text-ok" />}
          title="本机"
          to="/infra/host"
          ok
        >
          <p className="text-xs text-muted">{host?.kernel_os?.nodename ?? '—'}</p>
          {shownDisks.map((d: any, i: number) => {
            const pct = d.used_pct ?? 0
            return (
              <div key={`${d.mount}-${i}`} className="mt-2">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-muted font-mono truncate">{d.mount}</span>
                  <span className="tnum">{d.error ? d.error : `${Math.round(pct)}%`}</span>
                </div>
                {!d.error && (
                  <Progress value={pct} size="sm" color={pct > 90 ? 'bad' : pct > 70 ? 'warn' : 'ok'} />
                )}
              </div>
            )
          })}
        </ServiceCard>

        {/* Storage */}
        <ServiceCard
          icon={<HardDriveDownload size={18} className={storage?.status?.ready ? 'text-ok' : 'text-muted'} />}
          title="存储"
          to="/infra/storage"
          ok={storageOk}
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
          ok={databasesOk}
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            {['mysql', 'redis', 'qdrant', 'postgres', 'clickhouse', 'kafka'].map(svc => {
              const info = svc === 'clickhouse' ? clickhouse?.status : svc === 'kafka' ? kafka?.status : databases?.status?.[svc]
              return (
                <Badge key={svc} variant={info?.ready ? 'ok' : info?.deployed ? 'warn' : 'bad'} dot className="text-[10px]">
                  {svc}
                </Badge>
              )
            })}
          </div>
          <p className="text-xs text-muted mt-1">
            {(databases?.creds?.length ?? 0) + (clickhouse?.creds?.length ?? 0) + (kafka?.creds?.length ?? 0)} 个凭证
          </p>
        </ServiceCard>

        {/* Proxy */}
        <ServiceCard
          icon={<Globe size={18} className="text-accent" />}
          title="子域名"
          to="/infra/proxy"
          ok={proxyOk}
        >
          <Badge variant={proxy?.container_running ? 'ok' : 'bad'} dot>
            反代 {proxy?.container_running ? '运行中' : '未运行'}
          </Badge>
          <p className="text-xs text-muted mt-1">{proxyMappings.length} 个映射</p>
        </ServiceCard>
      </div>

      {/* Quick actions */}
      {( !storageOk || !databasesOk || !proxyOk ) && (
      <section data-onboarding-target="infra-quick" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {!storageOk && (
          <QuickAction
            icon={<HardDriveDownload size={18} />}
            label="初始化存储"
            desc="部署 MinIO 服务"
            to="/infra/storage"
          />
        )}
        {!databasesOk && (
          <QuickAction
            icon={<Database size={18} />}
            label="初始化数据库"
            desc="部署 MySQL / Redis / Qdrant"
            to="/infra/databases"
          />
        )}
        {!proxyOk && (
          <QuickAction
            icon={<Globe size={18} />}
            label="添加反代映射"
            desc="配置子域名反向代理"
            to="/infra/proxy"
          />
        )}
      </section>
      )}

      <h2 data-ux="ux-infra-local-fold" className="mb-3 mt-6 text-sm font-semibold">本机平台</h2>
      <div data-onboarding-target="infra-stats" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<Activity size={15} />} label="负载 (1m)" value={(host?.load?.load1 ?? 0).toFixed(2)} />
            <MetricCard icon={<MemoryStick size={15} />} label="内存" value={Math.round(host?.mem?.used_pct ?? 0)} suffix="%" percent={host?.mem?.used_pct} />
            <MetricCard icon={<Monitor size={15} />} label="本机 GPU" value={host?.nvidia?.count ?? 0} suffix="块" />
            <MetricCard icon={<Server size={15} />} label="K3s 节点" value={host?.k3s?.count ?? 0} />
          </>
        )}
      </div>
      <div data-onboarding-target="infra-requests" className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <CpuRequestPie />
        <MemRequestPie />
      </div>
      <div data-onboarding-target="infra-live-usage" className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <CpuUsagePie />
        <MemUsagePie />
      </div>
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
      <ChevronRight size={14} className="ml-auto text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
    </Link>
  )
}
