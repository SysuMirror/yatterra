import { motion } from 'framer-motion'
import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Server, Cpu, HardDrive, Monitor, Info, HardDriveDownload, MemoryStick, Container, ChevronRight, Clock, Activity, AlertTriangle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { Skeleton } from '@/components/ui/Skeleton'
import { CodeChip } from '@/components/ui/CodeChip'
import { Button } from '@/components/ui/Button'
import { api } from '@/api/client'
import { formatBytes } from '@/lib/format'
import InfraNav from '@/components/infra/InfraNav'
import { archLabel, fleetCards } from '@/lib/fleetMachines'
import { machineVitals } from '@/lib/machineVitals'
import { hostHistorySeries } from '@/lib/hostCharts'
import { ClusterMetrics, type ClusterMetricsData } from '@/components/domain/ClusterMetrics'

function bytesRate(value: number | null) {
  return value == null ? '未上报' : `${formatBytes(value)}/s`
}

export default function InfraHost() {
  const [params] = useSearchParams()
  const machine = params.get('machine') || 'local'
  const fleet = useQuery<any>({
    queryKey: ['infra-fleet'],
    queryFn: () => api.get('/infra/fleet'),
    refetchInterval: 30_000,
  })
  const fleetHosts = fleet.data?.hosts ?? []
  const picked = fleetHosts.find((item: any) => item.id === machine) || (machine === 'local' ? fleetHosts.find((item: any) => item.id === 'local') : null)
  const { data: host, isLoading, error: hostError, refetch: refetchHost } = useQuery<any>({
    queryKey: ['infra-host'],
    queryFn: () => api.get('/infra/host'),
    refetchInterval: 10_000,
  })

  const { data: remoteHosts } = useQuery<any[]>({
    queryKey: ['remote-hosts'],
    queryFn: () => api.get<any>('/infra/remote-hosts').then((d: any) => d.hosts ?? d),
    staleTime: 30_000,
  })

  const { data: metrics } = useQuery<any>({
    queryKey: ['infra-metrics'],
    queryFn: () => api.get('/infra/metrics'),
    refetchInterval: 30_000,
  })
  const historyId = picked?.id
  const fleetHistory = useQuery<any>({
    queryKey: ['infra-fleet-host-history', historyId],
    enabled: !!historyId && historyId !== 'local',
    queryFn: () => api.get(`/infra/fleet/${encodeURIComponent(historyId || '')}/history?range=1h`),
    refetchInterval: 30_000,
  })

  const disks: any[] = Array.isArray(host?.disk) ? host.disk : []
  const shownDisks = disks
  const diskSummary = disks.map((d) => (
    d.error
      ? `${d.mount} ${d.error}`
      : `${d.mount} ${d.used_h ?? '?'} / ${d.total_h ?? '?'} (${(d.used_pct ?? 0).toFixed(1)}%)`
  )).join('；')
  const uptimeH = typeof host?.uptime === 'string' ? host.uptime : host?.uptime?.human
  const aiContext = host
    ? `主机: ${host.hostname ?? 'unknown'}, OS: ${host.os ?? '?'}, 内核: ${host.kernel ?? '?'}\n` +
      `CPU: ${host.cpu?.cores ?? '?'} 核, 负载: ${host.cpu?.load1 ?? '?'} / ${host.cpu?.load5 ?? '?'} / ${host.cpu?.load15 ?? '?'}\n` +
      `内存: ${host.mem?.used_h ?? '?'} / ${host.mem?.total_h ?? '?'} (${(host.mem?.used_pct ?? 0).toFixed(1)}%)\n` +
      `磁盘: ${diskSummary || '无'}\n` +
      `运行时间: ${uptimeH ?? '?'}, Pod 数: ${host.pods?.count ?? '?'} (运行 ${host.pods?.running ?? '?'})`
    : '暂无主机数据'

  if (picked && picked.id !== 'local') {
    const vitals = machineVitals(picked.data)
    const cards = fleetCards([picked]).filter((card) => !card.empty)
    const shownRemote = vitals.disks
    const loadBadge = (value: number | null) => value == null ? '—' : value.toFixed(2)
    return (
      <>
        <InfraNav />
        <PageHeader title={picked.name || picked.id} description={`${archLabel(picked.hardware?.arch)} · ${picked.hardware?.cpu_model || '处理器未上报'} · ${picked.hardware?.product || '机型未上报'}`} doc={{ section: 'infra', item: 0, label: '主机监控文档' }} />
        <Link className="mb-4 inline-block text-xs text-accent" to="/infra/host">返回本机</Link>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <MetricCard icon={<Cpu size={18} />} label="负载 (1m)" value={vitals.load1 == null ? '—' : vitals.load1.toFixed(2)} />
          <MetricCard icon={<MemoryStick size={18} />} label="内存" value={vitals.memPct == null ? '—' : Math.round(vitals.memPct)} suffix={vitals.memPct == null ? undefined : '%'} percent={vitals.memPct ?? undefined} />
          <MetricCard icon={<HardDrive size={18} />} label="磁盘" value={vitals.disks.length} suffix="块" />
          <MetricCard icon={<Clock size={18} />} label="运行时间" value={vitals.uptime ?? '—'} />
        </div>
        <Card padding="lg" className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Info size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">系统信息</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted">CPU</p>
              <p className="text-sm font-medium">{vitals.cores ?? '—'} 核 · 使用 {vitals.cpuPct == null ? '—' : `${vitals.cpuPct}%`}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted">内存</p>
              <p className="text-sm font-medium">{vitals.memUsed ?? '—'} <span className="text-muted">/</span> {vitals.memTotal ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted">架构来源</p>
              <p className="text-sm font-medium">{picked.hardware?.arch_source === 'probe' ? '本机采样' : '节点登记'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted">运行时间</p>
              <div className="flex items-center gap-1.5">
                <Clock size={14} className="text-ok" />
                <p className="text-sm font-medium">{vitals.uptime ?? '—'}</p>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-black/[0.06]">
            <p className="text-xs text-muted mb-2">负载均值</p>
            <div className="flex items-center gap-4 sm:gap-6 flex-wrap">
              <div className="flex items-center gap-2"><span className="text-xs text-muted">1 min</span><Badge variant={(vitals.load1 ?? 0) > 4 ? 'warn' : 'ok'}>{loadBadge(vitals.load1)}</Badge></div>
              <div className="flex items-center gap-2"><span className="text-xs text-muted">5 min</span><Badge variant={(vitals.load5 ?? 0) > 4 ? 'warn' : 'default'}>{loadBadge(vitals.load5)}</Badge></div>
              <div className="flex items-center gap-2"><span className="text-xs text-muted">15 min</span><Badge variant={(vitals.load15 ?? 0) > 4 ? 'warn' : 'default'}>{loadBadge(vitals.load15)}</Badge></div>
            </div>
          </div>
          {(vitals.swapUsed != null || vitals.swapTotal != null) && (
            <div className="mt-3 pt-3 border-t border-black/[0.06] flex items-center gap-4">
              <span className="text-xs text-muted">Swap</span>
              <span className="text-sm font-medium">{vitals.swapUsed ?? '—'} <span className="text-muted">/</span> {vitals.swapTotal ?? '—'}</span>
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-black/[0.06] grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <p className="text-xs text-muted">驱动</p>
              <p className="text-sm font-medium">{vitals.driver ?? '未上报'}</p>
            </div>
            <div>
              <p className="text-xs text-muted">网络</p>
              <p className="text-sm font-medium">下行 {bytesRate(vitals.netRx)} · 上行 {bytesRate(vitals.netTx)}</p>
            </div>
            <div>
              <p className="text-xs text-muted">磁盘 IO</p>
              <p className="text-sm font-medium">读 {bytesRate(vitals.diskRead)} · 写 {bytesRate(vitals.diskWrite)}</p>
            </div>
          </div>
        </Card>
        {(() => {
          const series = hostHistorySeries(fleetHistory.data?.samples)
          const hasSeries = (series.host_cpu?.length ?? 0) > 1 || (series.network?.rx_bytes_per_sec?.length ?? 0) > 1 || (series.disk?.read_bytes_per_sec?.length ?? 0) > 1
          return hasSeries ? <div className="mb-4"><ClusterMetrics data={series} /></div> : null
        })()}
        <Card id="host-disks" padding="lg" className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <HardDriveDownload size={16} className="text-ok" />
            <h2 className="text-sm font-semibold">磁盘使用</h2>
          </div>
          {shownRemote.length ? (
            <div className="space-y-4">
              {shownRemote.map((disk, i) => {
                const pct = disk.usedPct ?? 0
                const color = disk.error ? 'bad' : pct > 90 ? 'bad' : pct > 70 ? 'warn' : 'ok'
                return (
                  <div key={`${disk.mount}-${i}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <CodeChip code={disk.mount || '—'} />
                        <span className="text-xs text-muted">{disk.error ? disk.error : `${disk.usedLabel ?? '—'} / ${disk.totalLabel ?? '—'}`}</span>
                      </div>
                      {!disk.error && disk.usedPct != null && <Badge variant={color}>{Math.round(pct)}%</Badge>}
                    </div>
                    {!disk.error && disk.usedPct != null && <Progress value={pct} size="sm" color={color} />}
                  </div>
                )
              })}
            </div>
          ) : <p className="text-xs text-muted">没有磁盘采样</p>}
        </Card>
        <Card padding="lg">
          <h2 className="mb-2 text-sm font-semibold">加速器</h2>
          {cards.length ? cards.map((card) => (
            <p key={card.cardKey} className="text-sm">{card.name} · {card.util == null ? '利用率未上报' : `${card.util}%`} · {card.memTotalMiB == null ? (card.unified ? '统一内存' : '显存未上报') : `${Math.round(card.memUsedMiB ?? 0)} / ${Math.round(card.memTotalMiB)} MiB`}</p>
          )) : <p className="text-sm text-muted">这台机器没有上报加速器</p>}
          <Link className="mt-3 inline-block text-xs text-accent" to={`/infra/gpu?host=${encodeURIComponent(picked.id)}`}>在加速器页打开这台机器</Link>
        </Card>
      </>
    )
  }

  return (
    <>
      <InfraNav />
      <PageHeader title="机器" description={picked ? `${picked.name || '本机'} · ${archLabel(picked.hardware?.arch)} · ${picked.hardware?.cpu_model || ''}` : '平台所在机器的健康与集群节点'} doc={{ section: 'infra', item: 0, label: '主机监控文档' }}>
        <PageAiAssistant page="host" context={aiContext} />
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && host && (
        <div data-onboarding-target="host-insight" className="mb-5">
          <AiInsightPanel page="host" context={aiContext} title="主机健康洞察" />
        </div>
      )}

      {hostError ? (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-3 flex-wrap">
            <AlertTriangle size={16} className="text-bad flex-shrink-0" />
            <span className="text-sm text-bad font-medium">主机数据加载失败：{(hostError as any)?.message || '网络异常'}</span>
            <Button variant="secondary" size="sm" className="ml-auto" onClick={() => refetchHost()}>重试</Button>
          </div>
        </Card>
      ) : isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={100} />)}
        </div>
      ) : (
        <motion.div
          data-onboarding-target="host-stats"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
          initial="initial" animate="animate"
          variants={{ animate: { transition: { staggerChildren: 0.06 } } }}
        >
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<Cpu size={18} />} label="负载 (1m)" value={(host?.load?.load1 ?? 0).toFixed(2)} />
          </motion.div>
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<MemoryStick size={18} />} label="内存" value={Math.round(host?.mem?.used_pct ?? 0)} suffix="%" percent={host?.mem?.used_pct} />
          </motion.div>
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<HardDrive size={18} />} label="磁盘" value={disks.length} suffix="块" />
          </motion.div>
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<Clock size={18} />} label="运行时间" value={uptimeH ?? '—'} />
          </motion.div>
        </motion.div>
      )}

      {/* System Info */}
      <Card data-onboarding-target="host-info" padding="lg" className="mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Info size={16} className="text-accent" />
          <h2 className="text-sm font-semibold">系统信息</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted">操作系统</p>
            <p className="text-sm font-medium">{host?.kernel_os?.os_pretty ?? '-'}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted">内核版本</p>
            <CodeChip code={host?.kernel_os?.release ?? '-'} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted">主机名 / 架构</p>
            <p className="text-sm font-medium">{host?.kernel_os?.nodename ?? '-'} <span className="text-muted">/</span> {host?.kernel_os?.machine ?? '-'}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted">CPU 核数 / Pod 数</p>
            <p className="text-sm font-medium">
              {host?.cpu?.cores ?? '-'} 核
              <span className="text-muted"> / </span>
              {host?.pods?.count ?? '-'} 个
              {host?.pods?.running != null && <span className="text-muted"> (运行 {host.pods.running})</span>}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted">运行时间</p>
            <div className="flex items-center gap-1.5">
              <Clock size={14} className="text-ok" />
              <p className="text-sm font-medium">{typeof host?.uptime === 'string' ? host.uptime : host?.uptime?.human ?? '-'}</p>
            </div>
          </div>
        </div>
        {/* Load averages */}
        {host?.load && (
          <div className="mt-4 pt-3 border-t border-black/[0.06]">
            <p className="text-xs text-muted mb-2">负载均值</p>
            <div className="flex items-center gap-4 sm:gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">1 min</span>
                <Badge variant={host.load.load1 > 4 ? 'warn' : 'ok'}>{host.load.load1.toFixed(2)}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">5 min</span>
                <Badge variant={host.load.load5 > 4 ? 'warn' : 'default'}>{host.load.load5.toFixed(2)}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">15 min</span>
                <Badge variant={host.load.load15 > 4 ? 'warn' : 'default'}>{host.load.load15.toFixed(2)}</Badge>
              </div>
            </div>
          </div>
        )}
        {/* Swap */}
        {host?.swap && (
          <div className="mt-3 pt-3 border-t border-black/[0.06] flex items-center gap-4">
            <span className="text-xs text-muted">Swap</span>
            <span className="text-sm font-medium">{host.swap.used_h ?? '0 B'} <span className="text-muted">/</span> {host.swap.total_h ?? '0 B'}</span>
          </div>
        )}
      </Card>

      {/* Infra Metrics — proper charts instead of raw JSON */}
      {metrics && Object.keys(metrics).length > 0 && (
        <div className="mb-6">
          <h2 data-onboarding-target="host-metrics" className="text-sm font-semibold mb-3">集群指标</h2>
          <ClusterMetrics data={metrics as ClusterMetricsData} />
        </div>
      )}

      {/* Disk Usage */}
      {host?.disk?.length > 0 && (
        <Card id="host-disks" data-onboarding-target="host-disks" padding="lg" className="mb-4 scroll-mt-24">
          <div className="flex items-center gap-2 mb-4">
            <HardDriveDownload size={16} className="text-ok" />
            <h2 className="text-sm font-semibold">磁盘使用</h2>
          </div>
          <div className="space-y-4">
            {shownDisks.map((d: any, i: number) => {
              const pct = d.used_pct ?? 0
              const color = d.error ? 'bad' : pct > 90 ? 'bad' : pct > 70 ? 'warn' : 'ok'
              return (
                <div key={`${d.mount}-${i}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <CodeChip code={d.mount} />
                      <span className="text-xs text-muted">{d.error ? d.error : `${d.used_h} / ${d.total_h}`}</span>
                    </div>
                    {!d.error && <Badge variant={color}>{Math.round(pct)}%</Badge>}
                  </div>
                  {!d.error && <Progress value={pct} size="sm" color={color} />}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* K3s Nodes */}
      {host?.k3s?.nodes?.length > 0 && (
        <Card id="host-k3s" data-onboarding-target="host-k3s" padding="lg" className="mb-4 scroll-mt-24">
          <div className="flex items-center gap-2 mb-4">
            <Container size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">K3s 节点</h2>
            <Badge variant="accent" className="ml-auto">{host.k3s.count} 节点</Badge>
          </div>
          <div className="space-y-3">
            {host.k3s.nodes.map((n: any, i: number) => (
              <div key={i} className="p-3 rounded-xl bg-black/[0.02] space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold">{n.name}</span>
                  <Badge variant={n.ready === 'True' ? 'ok' : 'bad'} dot>{n.ready === 'True' ? 'Ready' : 'NotReady'}</Badge>
                  <CodeChip code={n.version} className="ml-auto" />
                </div>
                {n.conditions && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(n.conditions).map(([key, val]: [string, any]) => (
                      <Badge key={key} variant={val === 'True' ? (key === 'Ready' ? 'ok' : 'muted') : 'bad'}>
                        {key}: {String(val)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* GPU — detail lives on /infra/gpu; here a link only */}
      {host?.nvidia?.gpus?.length > 0 && (
        <Link
          data-onboarding-target="host-gpu"
          to="/infra/gpu?host=local"
          className="glass-card rounded-2xl p-4 mb-4 flex items-center gap-4 hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group"
        >
          <div className="w-10 h-10 rounded-xl bg-warn/10 flex items-center justify-center text-warn flex-shrink-0">
            <Monitor size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold group-hover:text-accent transition-colors">GPU</span>
              <Badge variant="muted" className="text-[10px]">驱动 {host.nvidia.driver_version}</Badge>
            </div>
            <p className="text-xs text-muted mt-0.5">{host.nvidia.gpus.length} 块本机加速器 · 3090 和 Spark 在加速器页按机器查看</p>
          </div>
          <ChevronRight size={16} className="text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
        </Link>
      )}

      {/* FRP Connections */}
      {host?.frpc && (
        <Card data-onboarding-target="host-frp" padding="lg" className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">FRP 连接</h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted">运行中 / 总数</p>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold">{host.frpc.running}</span>
                <span className="text-muted">/</span>
                <span className="text-lg font-bold">{host.frpc.total}</span>
              </div>
            </div>
            <div className="flex-1">
              <Progress value={host.frpc.total ? (host.frpc.running / host.frpc.total) * 100 : 0} size="md" color={host.frpc.running === host.frpc.total ? 'ok' : 'warn'} showLabel />
            </div>
            <Badge variant={host.frpc.running === host.frpc.total ? 'ok' : 'warn'} dot>
              {host.frpc.running === host.frpc.total ? '全部在线' : `${host.frpc.total - host.frpc.running} 离线`}
            </Badge>
          </div>
        </Card>
      )}

      {/* Other machines live on their own page. This list only points at them. */}
      <div id="host-remote" data-onboarding-target="host-remote" className="space-y-3 scroll-mt-24">
        <h2 className="text-sm font-semibold">其它机器</h2>
        {fleetHosts.filter((item: any) => item.id !== 'local').map((item: any) => {
          const cards = fleetCards([item]).filter((card) => !card.empty)
          const relay = (remoteHosts ?? []).find((rh: any) => rh.name === item.id || rh.name === item.name)
          const vllm = relay?.data?.vllm
          return (
            <Link key={item.id} to={`/infra/host?machine=${encodeURIComponent(item.id)}`} className="glass-card rounded-2xl p-4 block hover:bg-black/[0.02]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{item.name || item.id}</span>
                <Badge variant={item.status === 'online' && !item.stale ? 'ok' : 'warn'} dot>{item.status || '未知'}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted">{archLabel(item.hardware?.arch)} · {item.hardware?.cpu_model || '处理器未上报'} · {item.hardware?.product || '机型未上报'}</p>
              <p className="mt-1 text-xs">{cards.length ? cards.map((card) => card.name).join('、') : '无加速器'}</p>
              {vllm != null && <p className="mt-1 text-xs text-muted">vLLM {vllm.healthy ? '在线' : '离线'}{vllm.model ? ` · ${vllm.model}` : ''}</p>}
            </Link>
          )
        })}
        {(remoteHosts ?? []).filter((rh: any) => !fleetHosts.some((item: any) => item.id === rh.name || item.name === rh.name)).map((rh: any) => (
          <Card key={rh.name} padding="lg">
            <div className="flex items-center gap-2">
              <Server size={16} className="text-muted" />
              <h3 className="text-sm font-semibold">{rh.name || rh.host}</h3>
              <Badge variant={rh.data?.error ? 'bad' : 'muted'} dot>{rh.data?.error ? '采集失败' : (rh.data?.kernel_os?.machine || '架构未知')}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted">{rh.desc || '不在集群采样里'}</p>
          </Card>
        ))}
        {fleetHosts.filter((item: any) => item.id !== 'local').length === 0 && (remoteHosts?.length ?? 0) === 0 && (
          <Card padding="lg"><p className="text-sm text-muted">暂无其它机器</p></Card>
        )}
      </div>
    </>
  )
}
