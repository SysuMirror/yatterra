import { lazy, Suspense, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Terminal as TermIcon, Activity, Key, Rocket, Users, Settings, Play, Square, RotateCw, ArrowLeft, FolderOpen, Plus, Trash2, ScrollText, Link2, Lock, Globe } from 'lucide-react'
import { Tabs } from '@/components/ui/Tabs'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { MonitorTab } from '@/components/pod/MonitorTab'
import { TerminalPane } from '@/components/pod/TerminalPane'
const FilesTab = lazy(() => import('@/components/pod/FilesTab').then(m => ({ default: m.FilesTab })))
const SettingsTab = lazy(() => import('@/components/pod/SettingsTab').then(m => ({ default: m.SettingsTab })))
const MembersTab = lazy(() => import('@/components/pod/MembersTab').then(m => ({ default: m.MembersTab })))
const DeploysTab = lazy(() => import('@/components/pod/DeploysTab').then(m => ({ default: m.DeploysTab })))
import { CredentialCard } from '@/components/domain/CredentialCard'
import { CodeChip } from '@/components/ui/CodeChip'
import { LogViewer } from '@/components/domain/LogViewer'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { DocHint } from '@/components/domain/DocHint'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { podStatusLabel } from '@/lib/format'
import { DOMAIN, PUBLIC_HOST, PUBLIC_SCHEME, publicUrl, subdomainUrl } from '@/lib/site'

const tabDefs = [
  { key: 'monitor', label: '监控', icon: <Activity size={15} /> },
  { key: 'connect', label: '连接', icon: <Link2 size={15} /> },
  { key: 'terminal', label: '终端', icon: <TermIcon size={15} /> },
  { key: 'files', label: '文件', icon: <FolderOpen size={15} /> },
  { key: 'logs', label: '日志', icon: <TermIcon size={15} /> },
  { key: 'app-logs', label: '应用日志', icon: <ScrollText size={15} /> },
  { key: 'creds', label: '凭证', icon: <Key size={15} /> },
  { key: 'domains', label: '子域名', icon: <Globe size={15} /> },
  { key: 'deploys', label: '部署', icon: <Rocket size={15} /> },
  { key: 'members', label: '成员', icon: <Users size={15} /> },
  { key: 'settings', label: '设置', icon: <Settings size={15} /> },
]

export default function PodDetail() {
  const { name } = useParams()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('monitor')
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [joinReason, setJoinReason] = useState('')

  const actOnPod = async (action: 'start' | 'stop' | 'restart', pendingMessage: string) => {
    try {
      await api.post(`/pods/${name}/${action}`)
      toast({ type: 'success', message: pendingMessage })
      qc.invalidateQueries({ queryKey: ['pod', name] })
    } catch (e: any) {
      toast({ type: 'error', message: e?.message || `${pendingMessage.replace('中', '')}失败` })
    }
  }

  const { data: pod, isLoading, error } = useQuery<any>({
    queryKey: ['pod', name],
    queryFn: () => api.get(`/pods/${name}`),
    enabled: !!name,
    staleTime: 5_000,
    retry: false,
  })

  const noAccess = error && (error as any)?.status === 403

  const joinPod = useMutation({
    mutationFn: () => api.post(`/pods/${name}/join`, { reason: joinReason }),
    onSuccess: () => { toast({ type: 'success', message: '申请已提交,等待 owner 审批' }); navigate('/pods') },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '申请失败' }),
  })

  const { data: metrics } = useQuery<any>({
    queryKey: ['metrics', name],
    queryFn: () => api.get(`/pods/${name}/metrics`),
    enabled: !!name && activeTab === 'monitor',
    refetchInterval: 5_000,
  })

  const { data: history } = useQuery<any>({
    queryKey: ['metrics-history', name],
    queryFn: () => api.get(`/pods/${name}/metrics/history`),
    enabled: !!name && activeTab === 'monitor',
    refetchInterval: 30_000,
  })



  if (isLoading) return <PodDetailSkeleton />

  if (noAccess) {
    return (
      <div data-onboarding-unavailable className="flex flex-col items-center justify-center min-h-[60vh] gap-4 relative">
        <button onClick={() => navigate('/pods')} aria-label="返回" className="absolute top-0 left-0 w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors">
          <ArrowLeft size={18} />
        </button>
        <div className="w-16 h-16 rounded-full bg-black/[0.04] flex items-center justify-center">
          <Lock size={28} className="text-muted" />
        </div>
        <h2 className="text-lg font-semibold">{name}</h2>
        <p className="text-sm text-muted text-center max-w-md">无权限</p>
        <p className="text-sm text-muted text-center max-w-md">你没有访问该 Pod 的权限。申请加入后,待 owner 审批。</p>
        <div className="w-full max-w-md space-y-3">
          <textarea
            value={joinReason}
            onChange={(e) => setJoinReason(e.target.value)}
            placeholder="说明申请理由…"
            className="w-full min-h-[80px] px-3 py-2.5 rounded-xl text-sm border border-black/[0.06] bg-black/[0.02] resize-vertical focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
          <div className="-mt-1"><AiFormHelper type="general" partial={joinReason} context="申请加入 Pod 的理由说明" onApply={setJoinReason} /></div>
          <Button
            className="w-full"
            disabled={!joinReason.trim()}
            loading={joinPod.isPending}
            onClick={() => joinPod.mutate()}
          >
            申请加入
          </Button>
        </div>
      </div>
    )
  }

  const status = pod?.status || 'Unknown'
  const running = status === 'Running'
  const statusVariant = running ? 'ok' : status === 'Stopped' ? 'muted' : status === 'Failed' ? 'bad' : 'accent'
  const canManage = pod?.my_role === 'owner' || pod?.my_role === 'admin' || pod?.my_role === 'super'

  return (
    <>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button onClick={() => navigate('/pods')} aria-label="返回" className="w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-xl font-bold tracking-tight font-mono break-all">{name}</h1>
            <Badge variant={statusVariant as any} dot>{podStatusLabel(status)}</Badge>
            <DocHint section="pods" item={1} label="Pod 文档" />
          </div>
          <p className="text-sm text-muted mt-0.5 truncate">
            {pod?.owners?.[0] && `所有者: ${pod.owners[0]}`}{pod?.my_role && ` · 角色: ${pod.my_role === 'owner' ? '负责人' : pod.my_role}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="secondary" size="sm" onClick={() => actOnPod('stop', '停止中')}>
              <Square size={14} /> 停止
            </Button>
          ) : (
            <Button size="sm" onClick={() => actOnPod('start', '启动中')}>
              <Play size={14} /> 启动
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => actOnPod('restart', '重启中')}>
            <RotateCw size={14} /> 重启
          </Button>
          <PageAiAssistant page="pod" context={pod ? `Pod: ${pod.name}, 状态: ${pod.status}, CPU: ${pod.cpu}核, 内存: ${pod.mem}GB, 存储: ${pod.storage}GB, GPU: ${(pod.gpus ?? []).join(',')}, 类型: ${pod.type ?? ''}, 创建者: ${pod.creator ?? ''}` : ''} />
        </div>
      </div>

      <AiInsightPanel
        page="pod"
        title={`Pod ${name} 洞察`}
        className="mb-5"
        context={pod ? `Pod: ${pod.name}, 状态: ${pod.status}, CPU: ${pod.cpu}核, 内存: ${pod.mem}GB, 存储: ${pod.storage}GB, GPU: ${(pod.gpus ?? []).join(',')}, 类型: ${pod.type ?? ''}, 创建者: ${pod.creator ?? ''}, 成员: ${(pod.members ?? []).join(', ')}, 角色: ${pod.my_role ?? ''}` : ''}
      />

      <Tabs onboardingPrefix="pod-tab" tabs={tabDefs} active={activeTab} onChange={setActiveTab} className="mb-6" swipeable />

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
        >
          <Suspense fallback={<Skeleton height={200} />}>
          {activeTab === 'monitor' && <MonitorTab metrics={metrics} history={history} pod={{ ...pod, name }} />}
          {activeTab === 'connect' && <ConnectTab pod={pod} />}
          {activeTab === 'terminal' && <TerminalPane podName={name!} running={running} />}
          {activeTab === 'files' && <FilesTab podName={name!} />}
          {activeTab === 'logs' && <LogViewer podName={name!} streamUrl={`/api/pods/${name}/logs/stream`} className="p-1" />}
          {activeTab === 'app-logs' && <AppLogsTab podName={name!} />}
          {activeTab === 'creds' && <CredsTab podName={name!} pod={pod} />}
          {activeTab === 'domains' && <SubdomainsTab podName={name!} />}
          {activeTab === 'deploys' && <DeploysTab podName={name!} canManage={canManage} />}
          {activeTab === 'members' && <MembersTab podName={name!} canManage={canManage} />}
          {activeTab === 'settings' && <SettingsTab podName={name!} pod={pod} canManage={canManage} />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </>
  )
}

function ConnectTab({ pod }: { pod?: any }) {
  const [pwVisible, setPwVisible] = useState(false)
  const [sshCfgOpen, setSshCfgOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const sshCmd = pod?.ssh_public ? `ssh -p ${pod.ssh_public} cloud@${PUBLIC_HOST}` : ''
  const webUrl = pod?.web_public ? publicUrl(pod.web_public) : ''
  const password = pod?.password || ''
  const podName = pod?.name || ''
  const sshConfigSnippet = pod?.ssh_public
    ? `Host ${podName}\n    HostName ${PUBLIC_HOST}\n    Port ${pod.ssh_public}\n    User cloud`
    : ''

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">连接信息</h2>

      <div className="space-y-3">
        {/* SSH 命令 */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">SSH 命令</span>
          {sshCmd
            ? <CodeChip code={sshCmd} />
            : <span className="text-xs text-muted">—</span>}
        </div>

        {/* SSH 密码 */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">SSH 密码</span>
          {password
            ? <div className="inline-flex items-center gap-2">
                <CodeChip code={password} mask={!pwVisible} />
                <Button variant="ghost" size="sm" onClick={() => setPwVisible(v => !v)}>
                  {pwVisible ? '隐藏' : '显示'}
                </Button>
              </div>
            : <span className="text-xs text-muted">—</span>}
        </div>

        {/* Web 地址 */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Web 地址</span>
          {webUrl
            ? <CodeChip code={webUrl} />
            : <span className="text-xs text-muted">—</span>}
        </div>
      </div>

      <p className="text-xs text-muted">容器内应用需绑定 0.0.0.0:8080 才能通过 Web 地址访问。</p>

      {/* SSH Config 片段 */}
      {sshConfigSnippet && (
        <div className="border-[0.5px] border-black/[0.06] rounded-xl overflow-hidden">
          <button
            onClick={() => setSshCfgOpen(v => !v)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold hover:bg-black/[0.02] transition-colors"
          >
            <span>🔑 SSH Config 片段</span>
            <span className="ml-auto text-muted text-xs">{sshCfgOpen ? '▾' : '▸'}</span>
          </button>
          {sshCfgOpen && (
            <div className="px-4 pb-3 space-y-2">
              <p className="text-xs text-muted">添加到本地 <code className="font-mono bg-black/[0.04] px-1 rounded">~/.ssh/config</code> 即可 <code className="font-mono bg-black/[0.04] px-1 rounded">ssh {podName}</code> 直连。</p>
              <pre className="bg-[#1d1d1f] text-[#f5f5f7] text-xs leading-6 p-3 rounded-lg overflow-x-auto">{sshConfigSnippet}</pre>
              <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(sshConfigSnippet)}>复制</Button>
            </div>
          )}
        </div>
      )}

      {/* 使用说明 */}
      <div className="border-[0.5px] border-black/[0.06] rounded-xl overflow-hidden">
        <button
          onClick={() => setGuideOpen(v => !v)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold hover:bg-black/[0.02] transition-colors"
        >
          <span>📖 使用说明</span>
          <span className="ml-auto text-muted text-xs">{guideOpen ? '▾' : '▸'}</span>
        </button>
        {guideOpen && (
          <div className="px-4 pb-4 space-y-4 text-xs">
            <p className="text-muted">容器内可用的共享存储与对象存储。</p>

            {/* ① 共享权重 */}
            <div>
              <h4 className="text-sm font-semibold mb-1">① 共享权重 / 数据集(只读)</h4>
              <div className="flex flex-col gap-1">
                <span className="text-muted">挂载点</span>
                <CodeChip code="/shared" />
              </div>
              <p className="text-muted mt-1">模型权重/数据集在此,只读。例:<code className="font-mono bg-black/[0.04] px-1 rounded">ls /shared</code>、在代码里直接读 <code className="font-mono bg-black/[0.04] px-1 rounded">/shared/weights/模型名/</code>。</p>
            </div>

            {/* ② MinIO */}
            <div>
              <h4 className="text-sm font-semibold mb-1">② MinIO 对象存储(S3 兼容)</h4>
              <div className="flex flex-col gap-1">
                <span className="text-muted">端点</span>
                <CodeChip code="http://minio.platform-infra.svc.cluster.local:9000" />
              </div>
              <p className="text-muted mt-1">向 owner 索要 access key / secret(按桶授权)。</p>
            </div>

            {/* ③ 自己起服务 */}
            <div>
              <h4 className="text-sm font-semibold mb-1">③ 自己起服务(绑 8080 即公网可达)</h4>
              <p className="text-muted break-words">应用绑定 <code className="font-mono bg-black/[0.04] px-1 rounded">0.0.0.0:8080</code>,通过 <code className="font-mono bg-black/[0.04] px-1 rounded break-all">{webUrl || `${PUBLIC_SCHEME}://${PUBLIC_HOST}:端口`}</code> 访问。</p>
            </div>

            {/* ④ 公共数据库 */}
            <div>
              <h4 className="text-sm font-semibold mb-1">④ 公共数据库(MySQL / Redis / Qdrant)</h4>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">MySQL</span><CodeChip code="mysql.platform-infra.svc.cluster.local:3306" /></div>
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">Redis</span><CodeChip code="redis.platform-infra.svc.cluster.local:6379" /></div>
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">Qdrant</span><CodeChip code="http://qdrant.platform-infra.svc.cluster.local:6333" /></div>
              </div>
              <p className="text-muted mt-2 mb-1">{PUBLIC_HOST} 本机(经 frp 隧道):</p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">MySQL</span><CodeChip code="127.0.0.1:25006" /></div>
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">Redis</span><CodeChip code="127.0.0.1:25079" /></div>
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">Qdrant</span><CodeChip code="http://127.0.0.1:25033" /></div>
                <div className="flex items-center gap-2"><span className="w-14 text-muted shrink-0">Qdrant gRPC</span><CodeChip code="127.0.0.1:25034" /></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CredsTab({ podName, pod }: { podName: string; pod?: any }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [applyOpen, setApplyOpen] = useState(false)
  const [service, setService] = useState('mysql')
  const [bucket, setBucket] = useState('')
  const [perm, setPerm] = useState('readwrite')

  const { data, isLoading } = useQuery<any>({
    queryKey: ['creds', podName],
    queryFn: () => api.get(`/pods/${podName}/credentials`),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['creds', podName] })

  const applyCred = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { service }
      if (service === 'minio') {
        body.bucket = bucket.trim() || podName
        body.perm = perm
      }
      return api.post(`/pods/${podName}/credentials/apply`, body)
    },
    onSuccess: () => { toast({ type: 'success', message: '凭证申请成功' }); setApplyOpen(false); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '申请失败' }),
  })
  const revokeCred = useMutation({
    mutationFn: (c: any) => api.del(`/pods/${podName}/credentials/${c.id}`),
    onSuccess: () => { toast({ type: 'success', message: '凭证已撤销' }); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '撤销失败' }),
  })

  if (isLoading) return <Skeleton height={100} />

  const dbCreds = data?.databases ?? []
  const minioCreds = data?.minio ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">凭证管理</h2>
        <Button size="sm" onClick={() => setApplyOpen(true)}><Plus size={14} /> 应用凭证</Button>
      </div>
      <ConnCard pod={pod} />

      <Dialog open={applyOpen} onClose={() => setApplyOpen(false)} title="应用凭证">
        <div className="space-y-4">
          <Select label="服务类型" value={service} onChange={(v) => { setService(v); if (v !== 'minio') { setBucket(''); setPerm('readwrite') } }} options={[
            { value: 'mysql', label: 'MySQL' },
            { value: 'redis', label: 'Redis' },
            { value: 'qdrant', label: 'Qdrant' },
            { value: 'minio', label: 'MinIO' },
          ]} />
          {service === 'minio' && (
            <>
              <div>
                <Input label="MinIO 桶 (可选，默认=组名)" value={bucket} onChange={e => setBucket(e.target.value)} placeholder="留空则使用组名" />
                <div className="mt-1"><AiFormHelper type="general" partial={bucket} context="MinIO 存储桶名称" onApply={setBucket} /></div>
              </div>
              <Select label="MinIO 权限" value={perm} onChange={setPerm} options={[
                { value: 'readwrite', label: '读写' },
                { value: 'readonly', label: '只读' },
                { value: 'writeonly', label: '只写' },
              ]} />
            </>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setApplyOpen(false)}>取消</Button>
            <Button size="sm" disabled={!service} loading={applyCred.isPending} onClick={() => applyCred.mutate()}>应用</Button>
          </div>
        </div>
      </Dialog>
      {dbCreds.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3">数据库凭证</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {dbCreds.map((c: any, i: number) => (
              <div key={i} className="relative">
                <CredentialCard service={c.service || c.kind} type="database" host={c.host} port={c.port} username={c.user} password={c.password} database={c.database} />
                <Button variant="ghost" size="sm" className="absolute top-2 right-2" aria-label="撤销凭证" onClick={() => { if (confirm('撤销此凭证？')) revokeCred.mutate(c) }}>
                  <Trash2 size={13} /> 撤销
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {minioCreds.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3">存储凭证</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {minioCreds.map((c: any, i: number) => (
              <div key={i} className="relative">
                <CredentialCard service={c.service || 'MinIO'} type="storage" host={c.host} port={c.port} username={c.access_key} password={c.secret_key} />
                <Button variant="ghost" size="sm" className="absolute top-2 right-2" aria-label="撤销凭证" onClick={() => { if (confirm('撤销此凭证？')) revokeCred.mutate(c) }}>
                  <Trash2 size={13} /> 撤销
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {dbCreds.length === 0 && minioCreds.length === 0 && (
        <p className="text-sm text-muted text-center py-8">暂无凭证</p>
      )}
    </div>
  )
}

function SubdomainsTab({ podName }: { podName: string }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [subdomain, setSubdomain] = useState('')
  const [note, setNote] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editPrefix, setEditPrefix] = useState('')

  const { data, isLoading } = useQuery<any>({
    queryKey: ['pod-proxy', podName],
    queryFn: () => api.get(`/infra/pods/${podName}/proxy`),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['pod-proxy', podName] })

  const addMut = useMutation({
    // port is derived server-side from this pod's own public ports
    mutationFn: () => api.post(`/infra/pods/${podName}/proxy`, { subdomain, note }),
    onSuccess: () => { toast({ type: 'success', message: '子域名映射已创建' }); setAddOpen(false); setSubdomain(''); setNote(''); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '创建失败' }),
  })
  const delMut = useMutation({
    mutationFn: (id: string) => api.del(`/infra/pods/${podName}/proxy/${id}`),
    onSuccess: () => { toast({ type: 'success', message: '已删除' }); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '删除失败' }),
  })
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.put(`/infra/pods/${podName}/proxy/${id}`, { enabled }),
    onSuccess: () => refresh(),
    onError: (e: any) => toast({ type: 'error', message: e?.message || '操作失败' }),
  })
  const renameMut = useMutation({
    mutationFn: ({ id, subdomain }: { id: string; subdomain: string }) => api.put(`/infra/pods/${podName}/proxy/${id}`, { subdomain }),
    onSuccess: () => { toast({ type: 'success', message: '前缀已更新' }); setEditId(null); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '更新失败' }),
  })

  if (isLoading) return <Skeleton height={120} />

  const mappings: any[] = data?.mappings ?? []
  const ports: { port: number; label: string; key: string }[] = data?.ports ?? []
  const webPort = ports.find((p) => p.key === 'web_public')?.port ?? ports[0]?.port

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">子域名映射</h2>
        <DocHint section="infra" item={3} label="子域名文档" />
        <Button size="sm" className="ml-auto" onClick={() => setAddOpen(true)}><Plus size={14} /> 添加子域名</Button>
      </div>
      <p className="text-xs text-muted">
        填一个前缀,自动指向本 Pod 的公网端口 <code className="font-mono bg-black/[0.04] px-1 rounded">{webPort ?? '—'}</code>,
        访问 <code className="font-mono bg-black/[0.04] px-1 rounded">&lt;前缀&gt;.{DOMAIN}</code> 即可。只能管理本 Pod 的前缀。
      </p>

      {mappings.length === 0 ? (
        <p className="text-sm text-muted text-center py-8">暂无子域名映射</p>
      ) : (
        <div className="space-y-2">
          {mappings.map((m: any) => (
            <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)]">
              <Globe size={15} className="text-muted shrink-0" />
              <div className="min-w-0 flex-1">
                {editId === m.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={editPrefix}
                      onChange={(e) => setEditPrefix(e.target.value)}
                      className="w-40 rounded-md border border-black/[0.12] px-2 py-1 text-sm font-mono focus:outline-none focus:border-accent/50"
                      autoFocus
                    />
                    <span className="text-xs text-muted">.{DOMAIN}</span>
                    <Button size="sm" loading={renameMut.isPending} disabled={!editPrefix.trim()} onClick={() => renameMut.mutate({ id: m.id, subdomain: editPrefix.trim() })}>保存</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditId(null)}>取消</Button>
                  </div>
                ) : (
                  <>
                    <a href={subdomainUrl(m.subdomain)} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline truncate block">
                      {m.subdomain}.{DOMAIN}
                    </a>
                    <p className="text-xs text-muted">→ 端口 {m.port}{m.note ? ` · ${m.note}` : ''}</p>
                  </>
                )}
              </div>
              {m.enabled === false && <Badge variant="muted">已停用</Badge>}
              {editId !== m.id && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => { setEditId(m.id); setEditPrefix(m.subdomain) }}>改前缀</Button>
                  <Button variant="ghost" size="sm" onClick={() => toggleMut.mutate({ id: m.id, enabled: m.enabled === false })}>
                    {m.enabled === false ? '启用' : '停用'}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="删除映射" onClick={() => { if (confirm(`删除 ${m.subdomain}.${DOMAIN}？`)) delMut.mutate(m.id) }}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="添加子域名映射">
        <div className="space-y-4">
          <div>
            <Input label="子域名前缀" value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="my-app" hint={`将映射到 my-app.${DOMAIN}`} />
            <div className="mt-1"><AiFormHelper type="general" partial={subdomain} context="子域名前缀" onApply={setSubdomain} /></div>
          </div>
          <div>
            <Input label="备注" value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
          </div>
          <p className="text-xs text-muted">端口自动绑定到本 Pod 的公网端口 {webPort ?? '—'}。</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>取消</Button>
            <Button loading={addMut.isPending} disabled={!subdomain} onClick={() => addMut.mutate()}>创建</Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function ConnCard({ pod }: { pod?: any }) {
  const ssh = pod?.ssh
  if (!ssh?.port) return null
  const sshCmd = `ssh -p ${ssh.port} ${ssh.user}@${ssh.host}`
  const cfg = `Host ${pod?.name || 'pod'}
    HostName ${ssh.host}
    Port ${ssh.port}
    User ${ssh.user}`
  return (
    <div>
      <h2 className="text-sm font-semibold mb-3">连接信息</h2>
      <div className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-2.5 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] transition-all duration-200">
        <div className="flex items-center gap-2">
          <TermIcon size={16} className="text-muted" />
          <span className="text-sm font-semibold">SSH 连接</span>
        </div>
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted w-12">命令</span>
            <CodeChip code={sshCmd} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted w-12">密码</span>
            <CodeChip code={ssh.password ?? ''} mask />
          </div>
          {pod?.web_url && (
            <div className="flex items-center gap-2">
              <span className="text-muted w-12">网址</span>
              <CodeChip code={pod.web_url} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-muted w-12">Config</span>
            <CodeChip code={cfg} />
          </div>
        </div>
      </div>
    </div>
  )
}

function AppLogsTab({ podName }: { podName: string }) {
  const { data, isLoading, isFetching } = useQuery<any>({
    queryKey: ['app-logs', podName],
    queryFn: () => api.get(`/pods/${podName}/app-logs?tail=200`),
    refetchInterval: 10_000,
  })
  const lines: string[] = Array.isArray(data) ? data : (data?.logs ?? data?.lines ?? (typeof data === 'string' ? data.split('\n') : []))
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">应用日志</h2>
        {isFetching && !isLoading && <RotateCw size={13} className="animate-spin text-muted" />}
      </div>
      <div className="rounded-xl p-4 font-mono text-xs leading-5 bg-[#1d1d1f] text-[#f5f5f7] max-h-[min(480px,70vh)] min-h-[200px] overflow-y-auto overflow-x-auto">
        {isLoading ? <span className="text-white/40">加载中…</span> :
         lines.length ? lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>) :
         <div className="flex items-center gap-2 py-4"><ScrollText size={16} className="text-white/40" /><span className="text-white/40">暂无应用日志</span></div>}
      </div>
    </div>
  )
}

function PodDetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton height={32} width="40%" />
      <Skeleton height={48} />
      <Skeleton height={200} />
    </div>
  )
}
