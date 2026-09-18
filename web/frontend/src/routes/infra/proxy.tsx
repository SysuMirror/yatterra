import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, Plus, Trash2, Server, Wifi, WifiOff, Monitor } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import { DataTable } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { CodeChip } from '@/components/ui/CodeChip'
import { MetricCard } from '@/components/domain/MetricCard'
import { Progress } from '@/components/ui/Progress'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { DOMAIN } from '@/lib/site'

export default function InfraProxy() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [subdomain, setSubdomain] = useState('')
  const [port, setPort] = useState('')
  const [note, setNote] = useState('')
  const [pod, setPod] = useState('')

  const { data, isLoading } = useQuery<any>({
    queryKey: ['infra-proxy'],
    queryFn: () => api.get('/infra/proxy'),
  })

  // Host data for FRP status
  const { data: host } = useQuery<any>({
    queryKey: ['infra-host'],
    queryFn: () => api.get('/infra/host'),
    staleTime: 10_000,
  })

  // Remote hosts
  const { data: remoteHosts } = useQuery<any[]>({
    queryKey: ['infra-remote-hosts'],
    queryFn: () => api.get<any>('/infra/remote-hosts').then((d: any) => d.hosts ?? d).catch(() => []),
    staleTime: 30_000,
  })

  const createMut = useMutation({
    mutationFn: (d: any) => api.post('/infra/proxy', d),
    onSuccess: () => { toast({ type: 'success', message: '映射已创建' }); setCreateOpen(false); qc.invalidateQueries({ queryKey: ['infra-proxy'] }) },
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.put(`/infra/proxy/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-proxy'] }),
  })

  const mappings = data?.mappings ?? data?.items ?? []
  const enabledCount = mappings.filter((m: any) => m.enabled !== false).length
  const disabledCount = mappings.length - enabledCount
  const frpc = host?.frpc

  return (
    <>
      <PageHeader title="子域名反代" description="Nginx 反向代理映射管理" doc={{ section: 'infra', item: 3, label: '子域名文档' }}>
        <div className="flex items-center gap-2">
          <PageAiAssistant page="proxy" context={`反代映射: ${mappings.length} 个 (${enabledCount} 启用, ${disabledCount} 禁用), FRP 隧道 ${frpc?.running ?? 0}/${frpc?.total ?? 0} 运行, 反代容器 ${data?.container_running ? '运行中' : '停止'}, 远程主机 ${remoteHosts?.length ?? 0} 台\n映射列表:\n${mappings.slice(0, 20).map((m: any) => `  ${m.subdomain} → :${m.port} ${m.enabled !== false ? '✓' : '✗'} ${m.note || ''}`).join('\n')}${remoteHosts?.length ? '\n远程主机:\n' + remoteHosts.slice(0, 10).map((h: any) => `  ${h.hostname || h.name}: ${h.online !== false ? '在线' : '离线'}, 磁盘 ${Math.round(h.disk?.used_pct ?? 0)}%, 内存 ${Math.round(h.mem?.used_pct ?? 0)}%${h.nvidia?.count ? `, ${h.nvidia.count} GPU` : ''}`).join('\n') : ''}`} />
          <Button data-onboarding-target="proxy-create" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> 添加映射</Button>
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && data && (
        <AiInsightPanel
          page="proxy"
          title="反代映射洞察"
          className="mb-5"
          context={`反代映射: ${mappings.length} 个 (${enabledCount} 启用, ${disabledCount} 禁用), FRP 隧道 ${frpc?.running ?? 0}/${frpc?.total ?? 0} 运行, 反代容器 ${data?.container_running ? '运行中' : '停止'}, 远程主机 ${remoteHosts?.length ?? 0} 台\n映射列表:\n${mappings.slice(0, 20).map((m: any) => `  ${m.subdomain} → :${m.port} ${m.enabled !== false ? '✓' : '✗'} ${m.note || ''}`).join('\n')}`}
        />
      )}

      {/* FRP + Mapping stats */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        <MetricCard
          icon={<Globe size={15} className="text-accent" />}
          label="映射总数"
          value={mappings.length}
          suffix={`${enabledCount} 启用`}
        />
        <MetricCard
          icon={<Wifi size={15} className={frpc?.running ? 'text-ok' : 'text-bad'} />}
          label="FRP 隧道"
          value={frpc?.running ?? 0}
          suffix={`/ ${frpc?.total ?? 0}`}
        />
        <MetricCard
          icon={<Server size={15} className="text-muted" />}
          label="远程主机"
          value={remoteHosts?.length ?? 0}
          suffix="台"
        />
        <MetricCard
          icon={<WifiOff size={15} className={disabledCount > 0 ? 'text-warn' : 'text-muted'} />}
          label="已禁用"
          value={disabledCount}
        />
      </div>

      {/* FRP connection health */}
      {frpc && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Wifi size={16} className={frpc.running ? 'text-ok' : 'text-bad'} />
            <h2 className="text-sm font-semibold">FRP 连接状态</h2>
            <Badge variant={frpc.running ? 'ok' : 'bad'} dot className="ml-auto">
              {frpc.running ? '正常' : '异常'}
            </Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted mb-1">运行中隧道</p>
              <p className="font-medium">{frpc.running ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">总隧道数</p>
              <p className="font-medium">{frpc.total ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">健康率</p>
              <p className="font-medium">{frpc.total > 0 ? ((frpc.running / frpc.total) * 100).toFixed(0) : 0}%</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">反代容器</p>
              <Badge variant={data?.container_running ? 'ok' : 'bad'} dot>{data?.container_running ? '运行' : '停止'}</Badge>
            </div>
          </div>
        </Card>
      )}

      {/* Proxy mapping table */}
      <Card padding="none" className="mb-6">
        <DataTable
          columns={[
            { key: 'subdomain', title: '子域名', sortable: true, render: (r: any) => (
              <div className="flex items-center gap-2">
                <Globe size={14} className="text-muted" />
                <span className="font-medium">{r.subdomain}</span>
              </div>
            )},
            { key: 'port', title: '端口', sortable: true, render: (r: any) => <CodeChip code={String(r.port)} /> },
            { key: 'pod', title: '所属 Pod', render: (r: any) => r.pod
              ? <Badge variant="accent">{r.pod}</Badge>
              : <Badge variant="muted">未归属</Badge> },
            { key: 'enabled', title: '状态', render: (r: any) => (
              <Switch checked={r.enabled !== false} onChange={(v) => toggleMut.mutate({ id: r.id, enabled: v })} />
            )},
            { key: 'note', title: '备注', render: (r: any) => <span className="text-muted">{r.note || '—'}</span> },
            { key: 'actions', title: '', render: (r: any) => (
              <Button variant="ghost" size="sm" onClick={() => { if (confirm('删除此代理规则？')) api.del(`/infra/proxy/${r.id}`).then(() => { toast({ type: 'success', message: '已删除' }); qc.invalidateQueries({ queryKey: ['infra-proxy'] }) }) }}>
                <Trash2 size={14} />
              </Button>
            )},
          ]}
          data={mappings}
          keyFn={(r: any) => r.id || r.subdomain}
          empty={<p className="text-sm text-muted text-center py-8">暂无映射</p>}
        />
      </Card>

      {/* Remote hosts */}
      {remoteHosts && remoteHosts.length > 0 && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Server size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">远程主机</h2>
            <Badge variant="muted">{remoteHosts.length} 台</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {remoteHosts.map((h: any, i: number) => (
              <div key={i} className="p-3 rounded-xl bg-black/[0.02] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{h.hostname || h.name || `主机 ${i + 1}`}</span>
                  <Badge variant={h.online !== false ? 'ok' : 'bad'} dot className="text-[10px]">
                    {h.online !== false ? '在线' : '离线'}
                  </Badge>
                </div>
                {h.kernel && <p className="text-xs text-muted">{h.kernel}</p>}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {h.disk && (
                    <div>
                      <p className="text-muted">磁盘</p>
                      <div className="flex items-center gap-1">
                        <Progress value={h.disk.used_pct ?? 0} size="sm" color={h.disk.used_pct > 90 ? 'bad' : h.disk.used_pct > 70 ? 'warn' : 'ok'} />
                        <span className="tnum">{Math.round(h.disk.used_pct ?? 0)}%</span>
                      </div>
                    </div>
                  )}
                  {h.mem && (
                    <div>
                      <p className="text-muted">内存</p>
                      <div className="flex items-center gap-1">
                        <Progress value={h.mem.used_pct ?? 0} size="sm" color={h.mem.used_pct > 90 ? 'bad' : h.mem.used_pct > 70 ? 'warn' : 'ok'} />
                        <span className="tnum">{Math.round(h.mem.used_pct ?? 0)}%</span>
                      </div>
                    </div>
                  )}
                  {h.uptime && (
                    <div>
                      <p className="text-muted">运行时间</p>
                      <p className="font-medium">{h.uptime}</p>
                    </div>
                  )}
                  {h.load && (
                    <div>
                      <p className="text-muted">负载</p>
                      <p className="font-medium tnum">{h.load.load1?.toFixed(2) ?? '—'}</p>
                    </div>
                  )}
                </div>
                {/* vLLM status */}
                {h.vllm && (
                  <div className="mt-1 pt-1 border-t border-black/[0.04]">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={h.vllm.healthy ? 'ok' : 'bad'} dot className="text-[10px]">vLLM</Badge>
                      {h.vllm.model && <span className="text-[10px] text-muted truncate">{h.vllm.model}</span>}
                    </div>
                  </div>
                )}
                {/* NVIDIA info */}
                {h.nvidia && h.nvidia.count > 0 && (
                  <div className="mt-1 pt-1 border-t border-black/[0.04]">
                    <div className="flex items-center gap-1.5">
                      <Monitor size={10} className="text-warn" />
                      <span className="text-[10px] text-muted">{h.nvidia.count} GPU · 驱动 {h.nvidia.driver_version}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="添加反代映射">
        <div className="space-y-4">
          <div>
            <Input label="子域名" value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="my-app" hint={`将映射到 my-app.${DOMAIN}`} />
            <div className="mt-1"><AiFormHelper type="general" partial={subdomain} context="子域名反代映射" onApply={setSubdomain} /></div>
          </div>
          <div>
            <Input label="端口" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8080" />
            <div className="mt-1"><AiFormHelper type="general" partial={port} context="服务端口号" onApply={setPort} /></div>
          </div>
          <div>
            <Input label="备注" value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
            <div className="mt-1"><AiFormHelper type="general" partial={note} context="反代映射备注" onApply={setNote} /></div>
          </div>
          <div>
            <Input label="所属 Pod (可选)" value={pod} onChange={(e) => setPod(e.target.value)} placeholder="留空则未归属,仅管理员可管理" hint="填写 Pod 名称后,该 Pod 的 owner 可自行管理此映射" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => createMut.mutate({ subdomain, port: +port, note, pod: pod.trim() || undefined })} disabled={!subdomain || !port}>创建</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
