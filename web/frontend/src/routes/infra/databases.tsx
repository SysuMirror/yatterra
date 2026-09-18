import { useState } from 'react'
import { motion } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Database, Plus, Trash2, Shield, Link2, Copy, Globe, Server, Terminal } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { CodeChip } from '@/components/ui/CodeChip'
import { Disclosure } from '@/components/ui/Disclosure'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useAuthStore } from '@/stores/auth'
import { PUBLIC_HOST } from '@/lib/site'

const SERVICE_PORTS: Record<string, number> = { mysql: 3306, redis: 6379, qdrant: 6333 }
const NS = 'platform-infra'

// In-cluster endpoints (full k8s service DNS)
const INCLUSTER_ENDPOINTS = [
  { label: 'MySQL', value: `mysql.${NS}.svc.cluster.local:3306` },
  { label: 'Redis', value: `redis.${NS}.svc.cluster.local:6379` },
  { label: 'Qdrant', value: `http://qdrant.${NS}.svc.cluster.local:6333` },
  { label: 'Qdrant gRPC', value: `qdrant.${NS}.svc.cluster.local:6334` },
]

// FRP tunnel endpoints (relay host localhost)
const FRP_ENDPOINTS = [
  { label: 'MySQL', value: '127.0.0.1:25006' },
  { label: 'Redis', value: '127.0.0.1:25079' },
  { label: 'Qdrant', value: 'http://127.0.0.1:25033' },
  { label: 'Qdrant gRPC', value: '127.0.0.1:25034' },
]

const CONN_EXAMPLE = `# MySQL (pip install --break-system-packages pymysql)
import pymysql
db = pymysql.connect(host="mysql.platform-infra.svc.cluster.local", port=3306,
                     user="管理员发的用户", password="管理员发的密码",
                     database="管理员发的库")

# Redis (pip install --break-system-packages redis)
import redis
r = redis.Redis(host="redis.platform-infra.svc.cluster.local", port=6379,
                username="管理员发的用户", password="管理员发的密码")
r.set("前缀:mykey", "v")   # 键必须以 前缀: 开头

# Qdrant (pip install --break-system-packages qdrant-client)
from qdrant_client import QdrantClient
qc = QdrantClient(host="qdrant.platform-infra.svc.cluster.local", port=6333,
                  api_key="管理员发的key", https=False)
# 集合名以 前缀_ 开头,如 前缀_docs`

function buildConnStr(svc: string, cred: any, conf: any): string | null {
  const host = `${svc}:${SERVICE_PORTS[svc]}`
  if (svc === 'mysql') {
    const user = cred?.username || 'root'
    const pass = svc === 'mysql' && !cred?.secret ? conf?.mysql_root_password : cred?.secret
    const db = cred?.database || ''
    return `mysql://${user}:${pass}@${host}/${db}`
  }
  if (svc === 'redis') {
    const pass = cred?.secret || conf?.redis_password
    return `redis://:${pass}@${host}`
  }
  if (svc === 'qdrant') {
    const key = cred?.secret || conf?.qdrant_api_key
    return `http://${host}?api_key=${key}`
  }
  return null
}

function maskStr(s: string): string {
  if (s.length <= 4) return '••••'
  return s.slice(0, 2) + '••••' + s.slice(-2)
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function InfraDatabases() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [group, setGroup] = useState('')
  const [service, setService] = useState('')

  const { data, isLoading } = useQuery<any>({
    queryKey: ['infra-databases'],
    queryFn: () => api.get('/infra/databases'),
  })

  const ensureMut = useMutation({
    mutationFn: () => api.post('/infra/databases/ensure'),
    onSuccess: () => { toast({ type: 'success', message: '数据库服务已初始化' }); qc.invalidateQueries({ queryKey: ['infra-databases'] }) },
  })

  const createCredMut = useMutation({
    mutationFn: (d: { group: string; service: string }) => api.post('/infra/databases/creds', d),
    onSuccess: () => { toast({ type: 'success', message: '凭证已创建' }); setCreateOpen(false); qc.invalidateQueries({ queryKey: ['infra-databases'] }) },
  })

  const copyConnStr = (str: string) => {
    navigator.clipboard.writeText(str)
    toast({ type: 'success', message: '连接串已复制' })
  }

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({ type: 'success', message: '已复制' })
  }

  const auth = useAuthStore()
  const canManage = auth.perms.has('*') || auth.perms.has('infra.db')
  const anyReady = data?.status && Object.values(data.status).some((s: any) => s?.ready)

  // Group credentials by service
  const credsByService: Record<string, any[]> = {}
  if (data?.creds) {
    for (const c of data.creds) {
      const svc = c.service || c.kind || 'unknown'
      if (!credsByService[svc]) credsByService[svc] = []
      credsByService[svc].push(c)
    }
  }

  return (
    <>
      <PageHeader title="数据库" description="MySQL / Redis / Qdrant 服务与凭证" doc={{ section: 'infra', item: 2, label: '数据库文档' }}>
        <PageAiAssistant page="databases" context={data?.creds?.length > 0 ? `数据库凭证: ${data.creds.length} 个\n${Object.entries(credsByService).map(([svc, list]: [string, any[]]) => `  ${svc}: ${list.length} 个 (${list.map((c: any) => c.group ?? c.name).join(', ')})`).join('\n')}` : '暂无数据库凭证'} />
        <div className="flex gap-2">
          {canManage && <>
            <Button variant="secondary" size="sm" onClick={() => ensureMut.mutate()}>初始化</Button>
            <Button data-onboarding-target="db-create" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> 创建凭证</Button>
          </>}
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && data && (
        <AiInsightPanel
          page="databases"
          title="数据库洞察"
          className="mb-5"
          context={`数据库状态: ${['mysql','redis','qdrant'].map(s => `${s}=${data?.status?.[s]?.ready ? '运行' : data?.status?.[s]?.deployed ? '启动中' : '未部署'}`).join(', ')}\n凭证: ${data?.creds?.length ?? 0} 个\n${Object.entries(credsByService).map(([svc, list]: [string, any[]]) => `  ${svc}: ${list.length} 个 (${list.map((c: any) => c.group ?? c.username ?? c.id).join(', ')})`).join('\n')}`}
        />
      )}

      {/* Service Status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {['mysql', 'redis', 'qdrant'].map((svc) => {
          const info = data?.status?.[svc]
          const conf = data?.conf
          const port = SERVICE_PORTS[svc]
          const connStr = buildConnStr(svc, null, conf)
          return (
            <Card key={svc} padding="lg">
              <div className="flex items-center gap-2 mb-2">
                <Database size={16} className="text-muted" />
                <span className="text-sm font-semibold capitalize">{svc}</span>
                {info && <Badge variant={info.ready ? 'ok' : info.deployed ? 'warn' : 'bad'} dot>
                  {info.deployed ? (info.ready ? '运行中' : info.phase || '启动中') : '未部署'}
                </Badge>}
              </div>
              <CodeChip code={`${svc}:${port}`} className="mt-2" />
              {connStr && (
                <Button data-onboarding-target="db-copy" variant="ghost" size="sm" className="mt-2" onClick={() => copyConnStr(connStr)}>
                  <Link2 size={14} /> 复制连接串
                </Button>
              )}
            </Card>
          )
        })}
      </div>

      {/* In-cluster endpoints */}
      {anyReady && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Globe size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">Pod 内端点</h2>
            <Badge variant="muted" className="ml-1">in-cluster</Badge>
          </div>
          <p className="text-xs text-muted mb-3">组内连接信息，pod 经内网访问</p>
          <div className="space-y-2">
            {INCLUSTER_ENDPOINTS.map((ep) => (
              <div key={ep.label} className="flex items-center gap-3">
                <span className="text-xs text-muted w-20 flex-shrink-0 font-semibold">{ep.label}</span>
                <CodeChip code={ep.value} />
                <Button variant="ghost" size="sm" onClick={() => copyText(ep.value)}>
                  <Copy size={12} />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* FRP tunnel endpoints */}
      {anyReady && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Server size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">{PUBLIC_HOST} 本机端点</h2>
            <Badge variant="muted" className="ml-1">frp 隧道</Badge>
          </div>
          <p className="text-xs text-muted mb-3">仅 {PUBLIC_HOST} 上的应用可连(127.0.0.1)，公网不可达</p>
          <div className="space-y-2">
            {FRP_ENDPOINTS.map((ep) => (
              <div key={ep.label} className="flex items-center gap-3">
                <span className="text-xs text-muted w-20 flex-shrink-0 font-semibold">{ep.label}</span>
                <CodeChip code={ep.value} />
                <Button variant="ghost" size="sm" onClick={() => copyText(ep.value)}>
                  <Copy size={12} />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Root credentials (admin only) */}
      {anyReady && canManage && data?.root && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Shield size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">Root 凭证</h2>
            <Badge variant="warn" className="ml-1">仅管理员</Badge>
          </div>
          <p className="text-xs text-muted mb-3">排障用，请勿分享</p>
          <div className="space-y-2">
            {data.root.mysql_root_password && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted w-20 flex-shrink-0 font-semibold">MySQL root</span>
                <CodeChip code={maskStr(data.root.mysql_root_password)} />
                <Button variant="ghost" size="sm" onClick={() => copyText(data.root.mysql_root_password)}>
                  <Copy size={12} />
                </Button>
              </div>
            )}
            {data.root.redis_password && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted w-20 flex-shrink-0 font-semibold">Redis default</span>
                <CodeChip code={maskStr(data.root.redis_password)} />
                <Button variant="ghost" size="sm" onClick={() => copyText(data.root.redis_password)}>
                  <Copy size={12} />
                </Button>
              </div>
            )}
            {data.root.qdrant_api_key && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted w-20 flex-shrink-0 font-semibold">Qdrant api key</span>
                <CodeChip code={maskStr(data.root.qdrant_api_key)} />
                <Button variant="ghost" size="sm" onClick={() => copyText(data.root.qdrant_api_key)}>
                  <Copy size={12} />
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Connection examples */}
      {anyReady && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Terminal size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">连接示例</h2>
          </div>
          <pre className="bg-[#3a3329] text-[#d9d2c8] p-3 rounded-lg text-xs overflow-auto">
            <code>{CONN_EXAMPLE}</code>
          </pre>
        </Card>
      )}

      {/* Credentials grouped by service */}
      <div className="space-y-3">
        {['mysql', 'redis', 'qdrant'].map((svc) => {
          const creds = credsByService[svc]
          if (!creds?.length) return null
          return (
            <Disclosure key={svc} title={`${svc.charAt(0).toUpperCase() + svc.slice(1)} 凭证 (${creds.length})`} defaultOpen>
              <div className="space-y-2 -mx-4 -mb-3">
                {creds.map((c: any) => {
                  const credConnStr = buildConnStr(svc, c, data?.conf)
                  return (
                    <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-black/[0.02]">
                      <Shield size={14} className="text-muted" />
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                          <CodeChip code={c.username || c.user || c.id} />
                          {c.database && <CodeChip code={c.database} />}
                          {c.label && <Badge variant="muted">{c.label}</Badge>}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {c.secret && <CodeChip code={maskStr(c.secret)} />}
                          {c.created && <span className="text-xs text-muted">{fmtDate(c.created)}</span>}
                        </div>
                      </div>
                      <div className="flex-1" />
                      <div className="flex items-center gap-1">
                        {credConnStr && (
                          <Button variant="ghost" size="sm" onClick={() => copyConnStr(credConnStr)}>
                            <Link2 size={14} />
                          </Button>
                        )}
                        {canManage && <Button variant="ghost" size="sm" onClick={() => api.del(`/infra/databases/creds/${c.id}`).then(() => { toast({ type: 'success', message: '已删除' }); qc.invalidateQueries({ queryKey: ['infra-databases'] }) })}>
                          <Trash2 size={14} />
                        </Button>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Disclosure>
          )
        })}
        {/* Credentials for services not in the standard three */}
        {Object.keys(credsByService).filter((s) => !['mysql', 'redis', 'qdrant'].includes(s)).map((svc) => {
          const creds = credsByService[svc] ?? []
          return (
            <Disclosure key={svc} title={`${svc} 凭证 (${creds.length})`} defaultOpen>
              <div className="space-y-2 -mx-4 -mb-3">
                {creds.map((c: any) => (
                  <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-black/[0.02]">
                    <Shield size={14} className="text-muted" />
                    <CodeChip code={c.username || c.user || c.id} />
                    {c.label && <Badge variant="muted">{c.label}</Badge>}
                    {c.created && <span className="text-xs text-muted">{fmtDate(c.created)}</span>}
                    <div className="flex-1" />
                    {canManage && <Button variant="ghost" size="sm" onClick={() => api.del(`/infra/databases/creds/${c.id}`).then(() => { toast({ type: 'success', message: '已删除' }); qc.invalidateQueries({ queryKey: ['infra-databases'] }) })}>
                      <Trash2 size={14} />
                    </Button>}
                  </div>
                ))}
              </div>
            </Disclosure>
          )
        })}
        {!data?.creds?.length && (
          <Card padding="lg">
            <p className="text-sm text-muted">暂无凭证</p>
          </Card>
        )}
      </div>

      {/* Create Cred Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="创建数据库凭证">
        <div className="space-y-4">
          <div>
            <Input label="分组" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="my-group" />
            <div className="mt-1"><AiFormHelper type="general" partial={group} context="数据库凭证分组名称，用于组织管理数据库连接" onApply={setGroup} /></div>
          </div>
          <Select value={service} onChange={setService} options={[
            { value: 'mysql', label: 'MySQL' },
            { value: 'redis', label: 'Redis' },
            { value: 'qdrant', label: 'Qdrant' },
          ]} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => createCredMut.mutate({ group, service })} disabled={!group || !service}>创建</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
