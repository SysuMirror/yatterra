import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { Server, Cpu, HardDrive, Monitor, Wifi, WifiOff, Info, HardDriveDownload, Container, Zap, Thermometer, Clock, Activity } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { Skeleton } from '@/components/ui/Skeleton'
import { CodeChip } from '@/components/ui/CodeChip'
import { api } from '@/api/client'
import { formatBytes } from '@/lib/format'
import { ClusterMetrics, type ClusterMetricsData } from '@/components/domain/ClusterMetrics'

/** Reusable bar row for disk/mem/swap usage */
function BarRow({ label, usedH, totalH, pct }: { label: string; usedH: string; totalH: string; pct: number }) {
  const color = pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'ok'
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        <span className="text-xs text-muted">{usedH} / {totalH} · {Math.round(pct)}%</span>
      </div>
      <Progress value={pct} size="sm" color={color} />
    </div>
  )
}

export default function InfraHost() {
  const { data: host, isLoading } = useQuery<any>({
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

  const { data: cpuStats } = useQuery<any>({
    queryKey: ['infra-cpu-stats'],
    queryFn: () => api.get('/infra/cpu-stats'),
    refetchInterval: 10_000,
  })

  const rootDisk = host?.disk?.find((d: any) => d.mount === '/') ?? host?.disk?.[0]
  const uptimeH = typeof host?.uptime === 'string' ? host.uptime : host?.uptime?.human
  const aiContext = host
    ? `主机: ${host.hostname ?? 'unknown'}, OS: ${host.os ?? '?'}, 内核: ${host.kernel ?? '?'}\n` +
      `CPU: ${host.cpu?.cores ?? '?'} 核, 负载: ${host.cpu?.load1 ?? '?'} / ${host.cpu?.load5 ?? '?'} / ${host.cpu?.load15 ?? '?'}\n` +
      `内存: ${host.mem?.used_h ?? '?'} / ${host.mem?.total_h ?? '?'} (${(host.mem?.used_pct ?? 0).toFixed(1)}%)\n` +
      `磁盘: ${rootDisk?.used_h ?? '?'} / ${rootDisk?.total_h ?? '?'} (${(rootDisk?.used_pct ?? 0).toFixed(1)}%)\n` +
      `运行时间: ${uptimeH ?? '?'}, Pod 数: ${host.pods?.count ?? '?'} (运行 ${host.pods?.running ?? '?'})`
    : '暂无主机数据'

  return (
    <>
      <PageHeader title="主机健康" description="集群节点状态与资源使用" doc={{ section: 'infra', item: 0, label: '主机监控文档' }}>
        <PageAiAssistant page="host" context={aiContext} />
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && host && (
        <AiInsightPanel page="host" context={aiContext} title="主机健康洞察" className="mb-5" />
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={100} />)}
        </div>
      ) : (
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
          initial="initial" animate="animate"
          variants={{ animate: { transition: { staggerChildren: 0.06 } } }}
        >
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<Cpu size={18} className="text-accent" />} label="负载" value={(host?.load?.load1 ?? 0).toFixed(2)} color="accent" />
          </motion.div>
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<HardDrive size={18} className="text-ok" />} label="内存" value={Math.round(host?.mem?.used_pct ?? 0)} suffix="%" color="ok" />
          </motion.div>
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<Monitor size={18} className="text-warn" />} label="GPU" value={host?.nvidia?.count ?? 0} color="warn" />
          </motion.div>
          <motion.div variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }}>
            <MetricCard icon={<Server size={18} className="text-bad" />} label="节点" value={host?.k3s?.count ?? 0} color="bad" />
          </motion.div>
        </motion.div>
      )}

      {/* System Info */}
      <Card padding="lg" className="mb-4">
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

      {/* Per-group Resource Usage */}
      {cpuStats?.per_group?.length > 0 && (
        <Card padding="lg" className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Cpu size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">分组资源</h2>
            <Badge variant="accent" className="ml-auto">{cpuStats.per_group.length} 组</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/[0.06]">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted">组名</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted">CPU</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted">内存</th>
                </tr>
              </thead>
              <tbody>
                {cpuStats.per_group.map((g: any, i: number) => (
                  <tr key={i} className="border-b border-black/[0.04] last:border-0">
                    <td className="py-2 px-3 font-medium">{g.name}</td>
                    <td className="py-2 px-3 font-mono text-xs text-ink-2">{g.cpu}</td>
                    <td className="py-2 px-3 font-mono text-xs text-ink-2">{g.mem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Infra Metrics — proper charts instead of raw JSON */}
      {metrics && Object.keys(metrics).length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-3">集群指标</h2>
          <ClusterMetrics data={metrics as ClusterMetricsData} />
        </div>
      )}

      {/* Disk Usage */}
      {host?.disk?.length > 0 && (
        <Card padding="lg" className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <HardDriveDownload size={16} className="text-ok" />
            <h2 className="text-sm font-semibold">磁盘使用</h2>
          </div>
          <div className="space-y-4">
            {host.disk.map((d: any, i: number) => {
              const pct = d.used_pct ?? 0
              const color = pct > 90 ? 'bad' : pct > 70 ? 'warn' : 'ok'
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <CodeChip code={d.mount} />
                      <span className="text-xs text-muted">{d.used_h} / {d.total_h}</span>
                    </div>
                    <Badge variant={color}>{Math.round(pct)}%</Badge>
                  </div>
                  <Progress value={pct} size="sm" color={color} />
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* K3s Nodes */}
      {host?.k3s?.nodes?.length > 0 && (
        <Card padding="lg" className="mb-4">
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

      {/* GPU Details */}
      {host?.nvidia?.gpus?.length > 0 && (
        <Card padding="lg" className="mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Monitor size={16} className="text-warn" />
            <h2 className="text-sm font-semibold">GPU 详情</h2>
            <Badge variant="warn" className="ml-auto">驱动 {host.nvidia.driver_version}</Badge>
          </div>
          <div className="space-y-3">
            {host.nvidia.gpus.map((g: any, i: number) => (
              <div key={i} className="p-3 rounded-xl bg-black/[0.02]">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-sm font-semibold">#{g.index}</span>
                  <span className="text-sm">{g.name}</span>
                  <Badge variant={g.temp > 80 ? 'bad' : g.temp > 65 ? 'warn' : 'ok'}>
                    <Thermometer size={10} className="inline mr-1" />{g.temp}°C
                  </Badge>
                  <Badge variant="default">
                    <Zap size={10} className="inline mr-1" />{g.power}
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted mb-1">利用率</p>
                    <div className="flex items-center gap-2">
                      <Progress value={g.util ?? 0} size="sm" color={g.util > 90 ? 'bad' : g.util > 70 ? 'warn' : 'ok'} className="flex-1" />
                      <span className="text-xs font-medium">{g.util}%</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted mb-1">显存</p>
                    <div className="flex items-center gap-2">
                      <Progress value={g.mem_total ? (parseFloat(g.mem_used) / parseFloat(g.mem_total)) * 100 : 0} size="sm" color="accent" className="flex-1" />
                      <span className="text-xs font-medium">{g.mem_used} / {g.mem_total}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* FRP Connections */}
      {host?.frpc && (
        <Card padding="lg" className="mb-4">
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

      {/* Remote Hosts — detailed monitoring */}
      {(remoteHosts?.length ?? 0) > 0 && (
        <div className="space-y-4">
          {remoteHosts!.map((rh: any, ri: number) => {
            const d = rh.data ?? {}
            const hasError = !!d.error
            const vllm = d.vllm

            return (
              <Card key={ri} padding="lg">
                {/* Header */}
                <div className="flex items-center gap-2 mb-4 flex-wrap">
                  <Server size={16} className="text-muted" />
                  <h2 className="text-sm font-semibold">{rh.name || rh.host}</h2>
                  {hasError ? (
                    <Badge variant="bad" dot>采集失败</Badge>
                  ) : d.kernel_os?.os_pretty ? (
                    <>
                      <Badge variant="muted" dot>{d.kernel_os.os_pretty}</Badge>
                      {vllm != null && (
                        vllm.healthy
                          ? <Badge variant="ok" dot>vLLM 在线</Badge>
                          : <Badge variant="bad" dot>vLLM 离线</Badge>
                      )}
                    </>
                  ) : (
                    <Badge variant="ok" dot>在线</Badge>
                  )}
                </div>

                {hasError ? (
                  <p className="text-sm text-muted">{d.error}</p>
                ) : (
                  <>
                    <p className="text-xs text-muted mb-4">{rh.desc}{rh.desc && ' · '}经 {rh.host} SSH 中继采集 · 不参与 k3s 调度</p>

                    {/* KPI tiles */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      <div className="space-y-1">
                        <p className="text-xs text-muted">内核</p>
                        <p className="text-sm font-medium font-mono truncate">{d.kernel_os?.release ?? d.kernel_os?.uname_error ?? '-'}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted">架构</p>
                        <p className="text-sm font-medium">{d.kernel_os?.machine ?? '-'}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted">运行时长</p>
                        <p className="text-sm font-medium">{d.uptime?.human ?? '-'}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted">负载 1 / 5 / 15</p>
                        <p className="text-sm font-medium">
                          {d.load?.error ? '—' : `${d.load?.load1 ?? '-'} / ${d.load?.load5 ?? '-'} / ${d.load?.load15 ?? '-'}`}
                        </p>
                      </div>
                    </div>

                    {/* NVIDIA + vLLM stats */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      {(d.nvidia?.count > 0 || d.nvidia?.error) && (
                        <div className="space-y-1">
                          <p className="text-xs text-muted">NVIDIA</p>
                          {d.nvidia?.error ? (
                            <Badge variant="bad" dot>异常</Badge>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Badge variant="ok" dot>{d.nvidia.count} GPU</Badge>
                              <span className="text-xs text-muted">驱动 {d.nvidia.driver_version || '-'}</span>
                            </div>
                          )}
                        </div>
                      )}
                      {vllm != null && (
                        <div className="space-y-1">
                          <p className="text-xs text-muted">vLLM</p>
                          <div className="flex items-center gap-2">
                            {vllm.healthy
                              ? <Badge variant="ok" dot>healthy</Badge>
                              : <Badge variant="bad" dot>down</Badge>
                            }
                            {vllm.model && <span className="text-xs text-ink-2">{vllm.model}</span>}
                            {vllm.container_status && <span className="text-xs text-muted">· 容器 {vllm.container_status}</span>}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Two columns: disk/mem/swap bars + GPU table */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Left: disk, mem, swap bars */}
                      <div>
                        <h3 className="text-xs font-semibold text-muted mb-2">磁盘</h3>
                        {d.disk?.map((dk: any, di: number) => (
                          dk.error
                            ? <p key={di} className="text-xs text-muted mb-2">{dk.mount}: {dk.error}</p>
                            : <BarRow key={di} label={dk.mount} usedH={dk.used_h} totalH={dk.total_h} pct={dk.used_pct} />
                        ))}

                        <h3 className="text-xs font-semibold text-muted mb-2 mt-3">内存</h3>
                        {d.mem?.error ? (
                          <p className="text-xs text-muted">{d.mem.error}</p>
                        ) : d.mem && (
                          <BarRow label="物理内存" usedH={d.mem.used_h} totalH={d.mem.total_h} pct={d.mem.used_pct} />
                        )}

                        <h3 className="text-xs font-semibold text-muted mb-2 mt-3">交换分区</h3>
                        {d.swap?.error ? (
                          <p className="text-xs text-muted">{d.swap.error}</p>
                        ) : d.swap?.total === 0 ? (
                          <p className="text-xs text-muted">未启用交换分区</p>
                        ) : d.swap && (
                          <BarRow label="Swap" usedH={d.swap.used_h} totalH={d.swap.total_h} pct={d.swap.used_pct} />
                        )}
                      </div>

                      {/* Right: GPU table */}
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="text-xs font-semibold text-muted">GPU</h3>
                          <Badge variant="muted">{d.nvidia?.count ?? 0} 块</Badge>
                        </div>
                        {d.nvidia?.error ? (
                          <p className="text-xs text-muted">{d.nvidia.error}</p>
                        ) : d.nvidia?.gpus?.length > 0 ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-black/[0.06]">
                                  <th className="text-left py-2 px-2 text-xs font-semibold text-muted">GPU</th>
                                  <th className="text-left py-2 px-2 text-xs font-semibold text-muted">型号</th>
                                  <th className="text-left py-2 px-2 text-xs font-semibold text-muted">利用率</th>
                                  <th className="text-left py-2 px-2 text-xs font-semibold text-muted">显存</th>
                                  <th className="text-left py-2 px-2 text-xs font-semibold text-muted">温度</th>
                                </tr>
                              </thead>
                              <tbody>
                                {d.nvidia.gpus.map((g: any, gi: number) => (
                                  <tr key={gi} className="border-b border-black/[0.04] last:border-0">
                                    <td className="py-2 px-2 font-medium">{g.index}</td>
                                    <td className="py-2 px-2 font-medium truncate max-w-[200px]">{g.name}</td>
                                    <td className="py-2 px-2 font-mono text-xs">
                                      {g.util != null ? `${g.util}%` : '—'}
                                    </td>
                                    <td className="py-2 px-2 font-mono text-xs">
                                      {g.mem_total == null || g.mem_used == null
                                        ? <span className="text-muted">统一内存</span>
                                        : `${g.mem_used} / ${g.mem_total} MiB`
                                      }
                                    </td>
                                    <td className="py-2 px-2 font-mono text-xs">
                                      {g.temp != null ? `${g.temp}°C` : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className="text-xs text-muted">无 GPU 信息</p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* No remote hosts fallback */}
      {(!remoteHosts || remoteHosts.length === 0) && (
        <Card padding="lg">
          <div className="flex items-center gap-2 mb-4">
            <Server size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">远程主机</h2>
          </div>
          <p className="text-sm text-muted">暂无远程主机</p>
        </Card>
      )}
    </>
  )
}
