import { motion } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { HardDrive, Plus, Trash2, Key, ExternalLink, Eye, EyeOff, FolderOpen } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { CodeChip } from '@/components/ui/CodeChip'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useAuth } from '@/hooks/useAuth'
import { useState } from 'react'

function MaskedSecret({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false)
  const tail = value.length > 4 ? value.slice(-4) : value
  const display = revealed ? value : `****${tail}`
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/[0.04] border-[0.5px] border-black/[0.06] font-mono text-xs text-ink-2 max-w-full">
      <code className="select-all break-all min-w-0">{display}</code>
      <button
        onClick={handleCopy}
        className="w-8 h-8 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors"
        title="复制"
      >
        {copied ? <span className="text-ok text-[10px]">✓</span> : <span className="text-[10px]">⧉</span>}
      </button>
      <button
        onClick={() => setRevealed(!revealed)}
        className="w-8 h-8 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors"
        title={revealed ? '隐藏' : '显示'}
      >
        {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </div>
  )
}

function formatDate(ts: number) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const permLabel: Record<string, string> = { readwrite: '读写', readonly: '只读', writeonly: '只写' }
const permVariant: Record<string, 'ok' | 'accent' | 'muted'> = { readwrite: 'ok', readonly: 'accent', writeonly: 'muted' }

const CLUSTER_ENDPOINT = 'http://minio.platform-infra.svc.cluster.local:9000'

const PYTHON_EXAMPLE = `from minio import Minio
client = Minio(
    "minio.platform-infra.svc.cluster.local:9000",
    access_key="管理员发的 AK",
    secret_key="管理员发的 SK",
    secure=False,
)
client.fput_object("授权的桶", "ckpt.bin", "/shared/weights/model.bin")`

export default function InfraStorage() {
  const toast = useToastStore((s) => s.add)
  const { hasPerm } = useAuth()
  const canManage = hasPerm('infra.storage')
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [bucketName, setBucketName] = useState('')
  const [keyFormOpen, setKeyFormOpen] = useState(false)
  const [keyLabel, setKeyLabel] = useState('')
  const [keyBucket, setKeyBucket] = useState('')
  const [keyPerm, setKeyPerm] = useState('readwrite')
  const [endpointCopied, setEndpointCopied] = useState(false)

  const { data, isLoading } = useQuery<any>({
    queryKey: ['infra-storage'],
    queryFn: () => api.get('/infra/storage'),
  })

  const ensureMut = useMutation({
    mutationFn: () => api.post('/infra/storage/ensure'),
    onSuccess: () => { toast({ type: 'success', message: '存储服务已初始化' }); qc.invalidateQueries({ queryKey: ['infra-storage'] }) },
    onError: (err: any) => { toast({ type: 'error', message: err?.message || '初始化存储失败' }) },
  })

  const createBucketMut = useMutation({
    mutationFn: (name: string) => api.post('/infra/storage/buckets', { name }),
    onSuccess: () => { toast({ type: 'success', message: '桶已创建' }); setCreateOpen(false); qc.invalidateQueries({ queryKey: ['infra-storage'] }) },
    onError: (err: any) => { toast({ type: 'error', message: err?.message || '创建桶失败' }) },
  })

  const createKeyMut = useMutation({
    mutationFn: (params: { label: string; bucket: string; perm: string }) => api.post('/infra/storage/keys', params),
    onSuccess: () => { toast({ type: 'success', message: '密钥已创建' }); setKeyFormOpen(false); setKeyLabel(''); setKeyBucket(''); setKeyPerm('readwrite'); qc.invalidateQueries({ queryKey: ['infra-storage'] }) },
    onError: (err: any) => { toast({ type: 'error', message: err?.message || '创建密钥失败' }) },
  })

  const buckets = data?.buckets ?? []
  const bucketOptions = buckets.map((b: any) => {
    const name = typeof b === 'string' ? b : b.name
    return { value: name, label: name }
  })

  const handleCopyEndpoint = async () => {
    await navigator.clipboard.writeText(CLUSTER_ENDPOINT)
    setEndpointCopied(true)
    setTimeout(() => setEndpointCopied(false), 2000)
  }

  return (
    <>
      <PageHeader title="对象存储" description="MinIO 存储桶与访问密钥管理" doc={{ section: 'infra', item: 1, label: '对象存储文档' }}>
        <PageAiAssistant page="storage" context={buckets.length > 0 ? `存储桶: ${buckets.length} 个\n${buckets.map((b: any) => `  ${b.name ?? b} (${b.creation_date ?? b.created ?? '?'})`).join('\n')}` : '暂无存储桶'} />
        <div className="flex gap-2">
          {canManage && <>
            <Button variant="secondary" size="sm" onClick={() => ensureMut.mutate()}>初始化</Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> 创建桶</Button>
          </>}
          <a
            href="http://localhost:9001"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-2 transition-colors duration-100 hover:bg-black/[0.04] active:bg-black/[0.06]"
          >
            <ExternalLink size={14} /> 控制台
          </a>
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && data && (
        <AiInsightPanel
          page="storage"
          title="存储洞察"
          className="mb-5"
          context={`MinIO 状态: ${data?.status?.ready ? '运行中' : data?.status?.deployed ? '启动中' : '未部署'}\n存储桶: ${buckets.length} 个 (${buckets.map((b: any) => typeof b === 'string' ? b : b.name).join(', ')})\n访问密钥: ${data?.keys?.length ?? 0} 个\n${data?.keys?.length ? '密钥详情:\n' + data.keys.slice(0, 10).map((k: any) => `  ${k.label ?? k.id}: 桶=${k.bucket ?? '?'}, 权限=${k.perm ?? 'rw'}`).join('\n') : ''}`}
        />
      )}

      {/* Status */}
      {data?.status && (
        <div className="mb-4">
          <Badge variant={data.status.ready ? 'ok' : data.status.deployed ? 'warn' : 'bad'} dot>
            MinIO {data.status.deployed ? (data.status.ready ? '运行中' : data.status.phase || '启动中') : '未部署'}
          </Badge>
        </div>
      )}

      {/* In-cluster Endpoint */}
      {data?.status?.deployed && (
        <Card padding="lg" className="mb-6">
          <h2 className="text-sm font-semibold mb-3">Pod 内连接端点</h2>
          <p className="text-xs text-muted mb-2">供集群内 pod 访问 MinIO，组内代码使用此地址</p>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/[0.04] border-[0.5px] border-black/[0.06] font-mono text-xs text-ink-2 max-w-full">
            <code className="select-all break-all min-w-0">{CLUSTER_ENDPOINT}</code>
            <button
              onClick={handleCopyEndpoint}
              className="w-8 h-8 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors"
              title="复制"
            >
              {endpointCopied ? <span className="text-ok text-[10px]">✓</span> : <span className="text-[10px]">⧉</span>}
            </button>
          </div>
        </Card>
      )}

      {/* Admin Credentials */}
      {data?.conf && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold">Root 凭证</h2>
            <Badge variant="muted">仅管理员</Badge>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted w-16 shrink-0">Access Key</span>
              <CodeChip code={data.conf.access_key} mask />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted w-16 shrink-0">Secret</span>
              <MaskedSecret value={data.conf.secret} />
            </div>
          </div>
        </Card>
      )}

      {/* Buckets */}
      <Card padding="lg" className="mb-6">
        <h2 className="text-sm font-semibold mb-3">存储桶</h2>
        {buckets.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {buckets.map((b: any, i: number) => {
              const name = typeof b === 'string' ? b : b.name
              return (
                <div key={i} className="flex flex-col gap-2 p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] transition-colors">
                  <div className="flex items-center gap-2">
                    <HardDrive size={14} className="text-muted shrink-0" />
                    <span className="font-medium text-sm truncate" title={name}>{name}</span>
                  </div>
                  <div className="flex gap-1 self-start">
                    <Button variant="ghost" size="sm">
                      <FolderOpen size={12} /> 浏览
                    </Button>
                    {canManage && <Button variant="ghost" size="sm" onClick={() => { if (confirm(`删除桶 ${name}？桶内数据将丢失。`)) api.del(`/infra/storage/buckets/${name}`).then(() => { toast({ type: 'success', message: '桶已删除' }); qc.invalidateQueries({ queryKey: ['infra-storage'] }) }) }}>
                      <Trash2 size={12} />
                    </Button>}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted">暂无桶</p>
        )}
      </Card>

      {/* Access Keys */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold">访问密钥</h2>
          {canManage && <Button size="sm" onClick={() => { setKeyFormOpen(true); if (bucketOptions.length && !keyBucket) setKeyBucket(bucketOptions[0].value) }}>
            <Plus size={14} /> 发密钥
          </Button>}
        </div>
        <p className="text-xs text-muted mb-3">每把密钥绑一个桶 + 权限，桶级隔离。组内用它而非 root 凭证。</p>

        {/* Key creation form */}
        {keyFormOpen && (
          <div className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-black/[0.02] mb-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Input label="标签" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} placeholder="如 group-A" />
                <div className="mt-1"><AiFormHelper type="general" partial={keyLabel} context="存储访问密钥标签" onApply={setKeyLabel} /></div>
              </div>
              <Select
                label="桶"
                value={keyBucket}
                onChange={setKeyBucket}
                options={bucketOptions}
                placeholder="选择桶..."
              />
              <Select
                label="权限"
                value={keyPerm}
                onChange={setKeyPerm}
                options={[
                  { value: 'readwrite', label: '读写' },
                  { value: 'readonly', label: '只读' },
                  { value: 'writeonly', label: '只写' },
                ]}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => createKeyMut.mutate({ label: keyLabel, bucket: keyBucket, perm: keyPerm })}
                disabled={!keyLabel.trim() || !keyBucket}
              >
                发密钥
              </Button>
              <Button variant="secondary" onClick={() => setKeyFormOpen(false)}>取消</Button>
            </div>
          </div>
        )}

        {data?.keys?.length ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.keys.map((k: any, i: number) => (
              <div key={i} className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-black/[0.02]">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-sm font-semibold">{k.label || `key-${i}`}</span>
                  {k.bucket && (
                    <Badge variant="muted">🪣 {k.bucket}</Badge>
                  )}
                  <Badge variant={permVariant[k.perm] || 'muted'}>{permLabel[k.perm] || k.perm || '读写'}</Badge>
                  <div className="flex-1" />
                  {canManage && <Button variant="ghost" size="sm" onClick={() => { if (confirm(`删除密钥 ${k.label || k.id}？`)) api.del(`/infra/storage/keys/${k.id}`).then(() => { toast({ type: 'success', message: '已删除' }); qc.invalidateQueries({ queryKey: ['infra-storage'] }) }) }}>
                    <Trash2 size={14} />
                  </Button>}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted w-[78px] shrink-0">Access Key</span>
                    <CodeChip code={k.access_key || k.name || `key-${i}`} />
                  </div>
                  {canManage && <div className="flex items-center gap-3">
                    <span className="text-xs text-muted w-[78px] shrink-0">Secret</span>
                    <MaskedSecret value={k.secret || ''} />
                  </div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">暂无访问密钥，先建桶再发</p>
        )}
      </Card>

      {/* Student Python Example */}
      {data?.status?.deployed && (
        <Card padding="lg">
          <h2 className="text-sm font-semibold mb-3">Python 连接示例</h2>
          <pre className="p-3 rounded-lg bg-[#3a3329] text-[#d9d2c8] text-xs overflow-auto font-mono leading-relaxed">
            <code>{PYTHON_EXAMPLE}</code>
          </pre>
        </Card>
      )}

      {/* Create Bucket Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="创建存储桶">
        <div className="space-y-4">
          <div>
            <Input label="桶名称" value={bucketName} onChange={(e) => setBucketName(e.target.value)} placeholder="my-bucket" />
            <div className="mt-1"><AiFormHelper type="general" partial={bucketName} context="S3 存储桶名称，需符合 DNS 命名规范（小写字母、数字、连字符）" onApply={setBucketName} /></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => createBucketMut.mutate(bucketName)} disabled={!bucketName.trim()}>创建</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
