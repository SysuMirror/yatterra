import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Save } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useNavigate } from 'react-router'

export function SettingsTab({ podName, pod, canManage }: { podName: string; pod: any; canManage: boolean }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [cpu, setCpu] = useState(String(pod?.cpu ?? 2))
  const [mem, setMem] = useState(String(pod?.mem ?? 4))
  const [storage, setStorage] = useState(String(pod?.storage ?? 20))
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    setCpu(String(pod?.cpu ?? 2))
    setMem(String(pod?.mem ?? 4))
    setStorage(String(pod?.storage ?? 20))
  }, [podName, pod?.cpu, pod?.mem, pod?.storage])

  const resize = async () => {
    setResizing(true)
    try {
      await api.post(`/pods/${podName}/resize`, { cpu: +cpu, mem: +mem, storage: +storage })
      toast({ type: 'success', message: '资源配置已更新，重启后完全生效' })
      qc.invalidateQueries({ queryKey: ['pod', podName] })
    } catch (e: any) {
      toast({ type: 'error', message: e?.message || '调整失败' })
    } finally {
      setResizing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Resources */}
      <Card padding="lg">
        <h3 data-onboarding-target="pod-resources" className="text-sm font-semibold mb-4">资源配置</h3>
        {canManage ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-xl">
              <Input label="CPU (核)" type="number" value={cpu} onChange={(e) => setCpu(e.target.value)} />
              <Input label="内存 (GB)" type="number" value={mem} onChange={(e) => setMem(e.target.value)} />
              <Input label="存储 (GB)" type="number" value={storage} onChange={(e) => setStorage(e.target.value)} />
            </div>
            <div className="mt-2"><AiFormHelper type="pod" partial={`${cpu}核/${mem}GB/${storage}GB`} context="Pod 资源配置调整，根据工作负载推荐合适的 CPU/内存/存储" onApply={(v) => { const m = v.match(/(\d+)\s*核?\s*\/\s*(\d+)\s*GB?\s*\/\s*(\d+)/); if (m) { setCpu(m[1] ?? ''); setMem(m[2] ?? ''); setStorage(m[3] ?? '') } }} /></div>
          </>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div><span className="text-muted">CPU</span><p className="font-medium mt-0.5">{pod?.cpu} 核</p></div>
            <div><span className="text-muted">内存</span><p className="font-medium mt-0.5">{pod?.mem} GB</p></div>
            <div><span className="text-muted">GPU</span><p className="font-medium mt-0.5">{pod?.gpus?.length ?? pod?.gpus ?? 0}</p></div>
            <div><span className="text-muted">存储</span><p className="font-medium mt-0.5">{pod?.storage} GB</p></div>
          </div>
        )}
        {canManage && (
          <div className="mt-4">
            <Button size="sm" onClick={resize} loading={resizing}><Save size={13} /> 应用配置</Button>
          </div>
        )}
      </Card>

      {/* Env vars */}
      <EnvCard podName={podName} initialEnv={pod?.env} canManage={canManage} />

      {/* Internal (cluster-only) service ports */}
      <InternalPortsCard
        podName={podName}
        initialPorts={pod?.internal_ports}
        internalHost={pod?.internal_host}
        canManage={canManage}
      />

      {/* Danger zone */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-bad mb-3">危险操作</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="danger" size="sm" onClick={async () => {
            try {
              const d: any = await api.post(`/pods/${podName}/reset-pw`)
              toast({ type: 'success', message: `新密码: ${d.password}` })
            } catch (e: any) {
              toast({ type: 'error', message: e?.message || '重置密码失败' })
            }
          }}>重置密码</Button>
          {canManage && (
            <Button variant="danger" size="sm" onClick={async () => {
              if (!confirm('确定删除此 Pod？环境内数据将丢失。')) return
              try {
                await api.del(`/pods/${podName}`)
                toast({ type: 'success', message: '已删除' })
                navigate('/pods')
              } catch (e: any) {
                toast({ type: 'error', message: e?.message || '删除 Pod 失败' })
              }
            }}>删除 Pod</Button>
          )}
        </div>
      </Card>
    </div>
  )
}

function InternalPortsCard({ podName, initialPorts, internalHost, canManage }: {
  podName: string
  initialPorts: number[] | undefined
  internalHost: string | undefined
  canManage: boolean
}) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const { data } = useQuery<{ ports: number[] }>({
    queryKey: ['pod-internal-ports', podName],
    queryFn: () => api.get(`/pods/${podName}/internal-ports`),
    initialData: initialPorts ? { ports: initialPorts } : undefined,
  })
  const ports = data?.ports ?? []
  const [draft, setDraft] = useState('')

  const save = useMutation({
    mutationFn: (next: number[]) =>
      api.post<{ ports: number[] }>(`/pods/${podName}/internal-ports`, { ports: next }),
    onSuccess: () => {
      toast({ type: 'success', message: '已更新；Service 立即生效，Pod 内 INTERNAL_PORTS 变量重启后刷新' })
      qc.invalidateQueries({ queryKey: ['pod-internal-ports', podName] })
      qc.invalidateQueries({ queryKey: ['pod', podName] })
    },
    onError: (e: any) => toast({ type: 'error', message: e?.message }),
  })

  const addPort = () => {
    const v = draft.trim()
    if (!v) return
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      toast({ type: 'error', message: '端口需为 1-65535 的整数' })
      return
    }
    if (ports.includes(n)) { setDraft(''); return }
    save.mutate([...ports, n])
    setDraft('')
  }

  return (
    <Card padding="lg">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">内网端口</h3>
        <p className="mt-1 text-xs text-muted">
          只对 k3s 集群内的 Pod 开放（Service 上不分配 NodePort，公网访问不到）。
          集群内用 <span className="font-mono">{internalHost || `group-${podName}-internal.clouds.svc.cluster.local`}</span> 加端口访问。
          列表自动从小到大排序；修改只重写 Service，不会重启 Pod。
        </p>
      </div>
      <div className="space-y-1.5 font-mono text-xs">
        {ports.map((p) => (
          <div key={p} className="flex items-center gap-2 py-1 group">
            <span className="text-accent">{p}</span>
            <span className="text-muted flex-1 break-all">
              {internalHost || `group-${podName}-internal.clouds.svc.cluster.local`}:{p}
            </span>
            {canManage && (
              <button
                aria-label={`删除端口 ${p}`}
                className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted hover:text-bad hover:bg-bad/10 transition-all flex-shrink-0"
                onClick={() => save.mutate(ports.filter((x) => x !== p))}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        {!ports.length && <p className="text-muted text-sm font-sans">暂无内网端口</p>}
      </div>
      {canManage && (
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <Input
            placeholder="端口，如 8000"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addPort() }}
            className="w-36 font-mono"
          />
          <Button variant="secondary" size="sm" disabled={!draft.trim()} loading={save.isPending} onClick={addPort}>
            <Plus size={13} /> 添加
          </Button>
        </div>
      )}
    </Card>
  )
}


function EnvCard({ podName, initialEnv, canManage }: { podName: string; initialEnv: Record<string, string> | undefined; canManage: boolean }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const { data } = useQuery<Record<string, string>>({
    queryKey: ['pod-env', podName],
    queryFn: () => api.get(`/pods/${podName}/env`),
    initialData: initialEnv,
  })
  const env = data ?? {}
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const add = useMutation({
    mutationFn: () => api.post(`/pods/${podName}/env`, { key: newKey, value: newVal }),
    onSuccess: () => { toast({ type: 'success', message: '已添加，重启后生效' }); setNewKey(''); setNewVal(''); qc.invalidateQueries({ queryKey: ['pod-env', podName] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message }),
  })
  const del = useMutation({
    mutationFn: (k: string) => api.del(`/pods/${podName}/env/${encodeURIComponent(k)}`),
    onSuccess: () => { toast({ type: 'success', message: '已删除，重启后生效' }); qc.invalidateQueries({ queryKey: ['pod-env', podName] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message }),
  })

  return (
    <Card padding="lg">
      <div className="mb-4">
        <h3 data-onboarding-target="pod-env" className="text-sm font-semibold">环境变量</h3>
        <p className="mt-1 text-xs text-muted">保存后会触发 Pod 重启；重启完成后请重新运行部署，刷新 supervisor 中已持久化的环境。不要把密钥写入日志。</p>
        <a href="/docs?lesson=environment" className="mt-1 inline-flex text-xs text-accent hover:underline">环境变量教程</a>
      </div>
      <div className="space-y-1.5 font-mono text-xs max-h-72 overflow-y-auto overflow-x-auto">
        {Object.entries(env).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 py-1 group">
            <span className="text-accent">{k}</span>
            <span className="text-muted">=</span>
            <span className="text-ink-2 flex-1 break-all">{String(v)}</span>
            {canManage && (
              <button
                aria-label={`删除 ${k}`}
                className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted hover:text-bad hover:bg-bad/10 transition-all flex-shrink-0"
                onClick={() => del.mutate(k)}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        {!Object.keys(env).length && <p className="text-muted text-sm font-sans">暂无环境变量</p>}
      </div>
      {canManage && (
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <Input placeholder="KEY" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="w-36 font-mono" />
          <Input placeholder="value" value={newVal} onChange={(e) => setNewVal(e.target.value)} className="w-48 font-mono" />
          <Button variant="secondary" size="sm" disabled={!newKey.trim()} loading={add.isPending} onClick={() => add.mutate()}>
            <Plus size={13} /> 添加
          </Button>
          <div className="w-full mt-1"><AiFormHelper type="general" partial={newVal} context="环境变量 KEY=VALUE" onApply={(v) => { const idx = v.indexOf('='); if (idx > 0) { setNewKey(v.slice(0, idx).trim()); setNewVal(v.slice(idx + 1).trim()); } }} /></div>
        </div>
      )}
    </Card>
  )
}
