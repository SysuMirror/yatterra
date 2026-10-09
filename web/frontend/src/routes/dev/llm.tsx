import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Plus, Trash2, Star, FlaskConical, BarChart3, Users, Clock, TrendingUp, Pencil } from 'lucide-react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell,
} from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SkeletonTable } from '@/components/ui/Skeleton'
import { MetricCard } from '@/components/domain/MetricCard'
import { ModelFallbackList } from '@/components/domain/ModelFallbackList'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useThemeStore } from '@/stores/theme'
import { formatDatetime } from '@/lib/format'

const COMPONENT_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#ff453a', '#bf5af2', '#64d2ff']

const typeOptions = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'vllm', label: 'vLLM' },
]

const typeBadge = (t: string): 'accent' | 'ok' | 'warn' | 'muted' => {
  switch (t) {
    case 'openai': return 'accent'
    case 'anthropic': return 'ok'
    case 'ollama': return 'warn'
    case 'vllm': return 'muted'
    default: return 'muted'
  }
}

export default function DevLlm() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const dark = useThemeStore((s) => s.resolved) === 'dark'

  // 跟随主题的 recharts tooltip / 坐标轴样式
  const tooltipStyle = {
    contentStyle: {
      borderRadius: 10,
      border: dark ? '0.5px solid rgba(255,255,255,0.12)' : '0.5px solid rgba(0,0,0,0.1)',
      fontSize: 12,
      background: dark ? 'rgba(28,28,30,0.95)' : 'rgba(255,255,255,0.95)',
      color: dark ? '#f5f5f7' : undefined,
    },
    labelStyle: { color: dark ? '#98989d' : '#86868b', fontSize: 11 },
  }
  const tickFill = dark ? '#98989d' : '#86868b'
  const labelTickFill = dark ? '#f5f5f7' : '#1d1d1f'
  const gridStroke = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'

  // Provider list
  const { data: providers, isLoading } = useQuery<any[]>({
    queryKey: ['llm-providers'],
    queryFn: () => api.get<any>('/llm/providers').then((d: any) => d.providers ?? d),
  })

  // Usage summary
  const { data: usage } = useQuery<any>({
    queryKey: ['llm-usage'],
    queryFn: () => api.get('/llm/usage/summary'),
  })

  // Detailed usage (daily, component, top_users, recent)
  const { data: usageDetail } = useQuery<any>({
    queryKey: ['llm-usage-detail'],
    queryFn: () => api.get('/llm/usage'),
    staleTime: 30_000,
  })

  // Add dialog state
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [eName, setEName] = useState('')
  const [eType, setEType] = useState('openai')
  const [eBaseUrl, setEBaseUrl] = useState('')
  const [eApiKey, setEApiKey] = useState('')
  const [eKeyDirty, setEKeyDirty] = useState(false)
  const [eModels, setEModels] = useState<string[]>([])

  const resetAdd = () => {
    setName(''); setType('openai'); setBaseUrl(''); setApiKey(''); setModels([])
  }

  const openEdit = (r: any) => {
    setEditing(r)
    setEName(r.name || '')
    setEType(r.type || 'openai')
    setEBaseUrl(r.base_url || '')
    setEApiKey('')
    setEKeyDirty(false)
    setEModels(Array.isArray(r.models) && r.models.length ? r.models : (r.model ? [r.model] : []))
    setEditOpen(true)
  }

  const addMut = useMutation({
    mutationFn: (d: any) => api.post('/llm/providers/add', d),
    onSuccess: () => {
      toast({ type: 'success', message: 'Provider 已添加' })
      setAddOpen(false)
      resetAdd()
      qc.invalidateQueries({ queryKey: ['llm-providers'] })
    },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  const editMut = useMutation({
    mutationFn: ({ id, ...d }: any) => api.put(`/llm/providers/${id}`, d),
    onSuccess: () => {
      toast({ type: 'success', message: 'Provider 已更新' })
      setEditOpen(false); setEditing(null)
      qc.invalidateQueries({ queryKey: ['llm-providers'] })
    },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  const saveEdit = () => {
    if (!editing) return
    const payload: any = {
      name: eName, type: eType, base_url: eBaseUrl,
      models: eModels, model: eModels[0] ?? '',
    }
    // Only send api_key when the user actually changed it — never write a
    // masked key back over the stored one.
    if (eKeyDirty) payload.api_key = eApiKey
    editMut.mutate({ id: editing.id, ...payload })
  }

  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.post('/llm/providers/delete', { id }),
    onSuccess: () => { toast({ type: 'success', message: 'Provider 已删除' }); setDeleteTarget(null); qc.invalidateQueries({ queryKey: ['llm-providers'] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '删除 Provider 失败' }),
  })

  const defaultMut = useMutation({
    mutationFn: (id: string) => api.post('/llm/providers/set-default', { id }),
    onSuccess: () => { toast({ type: 'success', message: '默认 Provider 已设置' }); qc.invalidateQueries({ queryKey: ['llm-providers'] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '设置默认 Provider 失败' }),
  })

  const testMut = useMutation({
    mutationFn: (id: string) => api.post('/llm/providers/test', { id }),
    onSuccess: (res: any) => { toast({ type: 'success', message: res.message || '连接测试成功' }) },
    onError: (e: any) => toast({ type: 'error', message: e.message || '连接测试失败' }),
  })

  const daily = usageDetail?.daily ?? []
  const componentData = usageDetail?.component ?? []
  const topUsers = usageDetail?.top_users ?? []
  const recent = usageDetail?.recent ?? []

  return (
    <>
      <PageHeader title="LLM 服务" description="大语言模型服务管理" count={providers?.length ? `${providers.length} 个` : undefined} doc={{ section: 'dev', item: 4, label: 'LLM 文档' }}>
        <PageAiAssistant page="llm" context={providers && providers.length > 0 ? `LLM Providers: ${providers.length} 个\n${providers.map((p: any) => `  ${p.name} [${p.type ?? p.model ?? '?'}] ${p.is_default ? '(默认)' : ''} ${p.enabled === false ? '(禁用)' : ''}`).join('\n')}\n用量: 总Token ${usage?.total_tokens ?? 0}, 费用 ¥${(usage?.total_cost ?? 0).toFixed(2)}` : '暂无 LLM Provider'} />
        <Button data-onboarding-target="llm-add" size="sm" onClick={() => setAddOpen(true)}><Plus size={14} /> 添加</Button>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && providers && (
        <div data-onboarding-target="llm-insight" className="mb-5">
        <AiInsightPanel
          page="llm"
          title="LLM 用量洞察"
          context={`LLM Providers: ${providers.length} 个\n${providers.map((p: any) => `  ${p.name} [${p.type ?? p.model ?? '?'}] ${p.is_default ? '(默认)' : ''} ${p.enabled === false ? '(禁用)' : ''}`).join('\n')}\n用量: 总Token ${usage?.total_tokens ?? 0}, Prompt ${usage?.prompt_tokens ?? 0}, Completion ${usage?.completion_tokens ?? 0}, 费用 ¥${(usage?.total_cost ?? 0).toFixed(2)}\n${topUsers.length > 0 ? 'Top用户:\n' + topUsers.slice(0, 5).map((u: any) => `  ${u.user_label ?? u.user}: ${(u.tokens ?? 0).toLocaleString()} tokens, ¥${(u.cost ?? 0).toFixed(2)}`).join('\n') : ''}`}
        />
        </div>
      )}

      {isLoading ? (
        <SkeletonTable rows={5} />
      ) : (
      <Card data-onboarding-target="llm-table" padding="none" className="mb-6">
        <DataTable
          columns={[
            { key: 'name', title: '名称', sortable: true, render: (r: any) => (
              <div className="flex items-center gap-2">
                <Bot size={14} className="text-accent" />
                <span className="font-medium">{r.name}</span>
                {r.is_default && <Badge variant="ok" className="text-[10px] px-1.5 py-0">默认</Badge>}
              </div>
            )},
            { key: 'type', title: '类型', sortable: true, render: (r: any) => (
              <div className="flex items-center gap-1.5">
                <Badge variant={typeBadge(r.type)}>{r.type || r.model || '-'}</Badge>
                {Array.isArray(r.models) && r.models.length > 1 && (
                  <Badge variant="muted" className="text-[10px] px-1.5 py-0">{r.models.length} 模型</Badge>
                )}
              </div>
            )},
            { key: 'base_url', title: 'Base URL', render: (r: any) => (
              <span className="text-sm text-muted font-mono truncate max-w-[280px] inline-block">{r.base_url || '-'}</span>
            )},
            { key: 'actions', title: '', width: '160px', render: (r: any) => (
              <div className="flex items-center gap-1">
                {!r.is_default && (
                  <Button variant="ghost" size="sm" onClick={() => defaultMut.mutate(r.id ?? r.name)} aria-label="设为默认">
                    <Star size={14} />
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label="编辑">
                  <Pencil size={14} />
                </Button>
                <Button data-onboarding-target="llm-test" variant="ghost" size="sm" onClick={() => testMut.mutate(r.id ?? r.name)} aria-label="测试">
                  <FlaskConical size={14} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(r)} aria-label="删除">
                  <Trash2 size={14} />
                </Button>
              </div>
            )},
          ]}
          data={providers ?? []}
          keyFn={(r: any) => r.id ?? r.name}
          empty={<div className="flex flex-col items-center gap-2 py-8"><Bot size={28} className="text-muted/40" /><p className="text-sm text-muted">暂无 LLM 服务</p></div>}
        />
      </Card>
      )}

      {/* Usage Summary Cards */}
      {usage && (
        <div data-onboarding-target="llm-usage-stats" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
          <MetricCard icon={<BarChart3 size={16} />} label="总 Token" value={usage.total_tokens ?? 0} />
          <MetricCard icon={<Bot size={16} />} label="Prompt Token" value={usage.prompt_tokens ?? 0} />
          <MetricCard icon={<Bot size={16} />} label="Completion Token" value={usage.completion_tokens ?? 0} />
          <MetricCard icon={<TrendingUp size={16} />} label="总费用" value={`¥${(usage.total_cost ?? 0).toFixed(2)}`} />
        </div>
      )}

      {/* Daily usage trend */}
      {daily.length > 1 && (
        <Card data-onboarding-target="llm-trend" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">用量趋势</h2>
            <Badge variant="muted">{daily.length} 天</Badge>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="llm-daily-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0a84ff" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#0a84ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: tickFill }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 10, fill: tickFill }} tickLine={false} axisLine={false} />
                <Tooltip {...tooltipStyle} formatter={(v: any) => [Number(v).toLocaleString(), 'Token']} />
                <Area type="monotone" dataKey="tokens" stroke="#0a84ff" strokeWidth={1.5} fill="url(#llm-daily-grad)" dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Component distribution */}
      {componentData.length > 0 && (
        <Card data-onboarding-target="llm-components" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Bot size={16} className="text-ok" />
            <h2 className="text-sm font-semibold">按组件分布</h2>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={componentData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 60 }}>
                <CartesianGrid stroke={gridStroke} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: tickFill }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="component" tick={{ fontSize: 11, fill: labelTickFill }} tickLine={false} axisLine={false} width={56} />
                <Tooltip {...tooltipStyle} formatter={(v: any) => [Number(v).toLocaleString(), 'Token']} />
                <Bar dataKey="tokens" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {componentData.map((_: any, i: number) => (
                    <Cell key={i} fill={COMPONENT_COLORS[i % COMPONENT_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Top users */}
      {topUsers.length > 0 && (
        <Card data-onboarding-target="llm-top-users" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Users size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">用量排行</h2>
            <Badge variant="muted">Top {topUsers.length}</Badge>
          </div>
          <div className="space-y-2">
            {topUsers.slice(0, 10).map((u: any, i: number) => (
              <div key={u.user ?? i} className="flex items-center gap-3 p-2 rounded-xl hover:bg-black/[0.02] transition-colors">
                <span className="text-xs text-muted w-5 text-right tnum">{i + 1}</span>
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{u.user_label || u.user}</span>
                <span className="text-xs text-muted tnum">{(u.tokens ?? 0).toLocaleString()} tokens</span>
                <span className="text-xs text-muted tnum">¥{(u.cost ?? 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Recent requests */}
      {recent.length > 0 && (
        <Card data-onboarding-target="llm-recent" padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">最近请求</h2>
          </div>
          <div className="space-y-1.5">
            {recent.slice(0, 20).map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-black/[0.02] text-xs">
                <span className="text-muted tnum w-[140px] flex-shrink-0">{formatDatetime(r.ts || r.time)}</span>
                <span className="font-medium flex-1 min-w-0 truncate">{r.user_label || r.user || r.component || '—'}</span>
                <Badge variant="muted" className="text-[10px]">{r.model || r.component || '-'}</Badge>
                <span className="text-muted tnum">{(r.tokens ?? r.total_tokens ?? 0).toLocaleString()} tk</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Delete provider confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id ?? deleteTarget.name)}
        loading={deleteMut.isPending}
        title={`删除 Provider ${deleteTarget?.name ?? ''}`}
        description="删除后使用该 Provider 的模型调用将失败，该操作不可撤销。"
      />

      {/* Add Provider Dialog */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="添加 LLM Provider">
        <div className="space-y-4">
          <div>
            <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="general" partial={name} context="LLM 提供商名称" onApply={setName} /></div>
          </div>
          <Select label="类型" value={type} onChange={setType} options={typeOptions} />
          <Input label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          <div className="mt-1"><AiFormHelper type="general" partial={baseUrl} context="LLM Provider 的 Base URL，如 https://api.openai.com/v1 或 https://api.deepseek.com/v1" onApply={setBaseUrl} /></div>
          <Input label="API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <ModelFallbackList models={models} onChange={setModels} baseUrl={baseUrl} apiKey={apiKey} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>取消</Button>
            <Button
              onClick={() => addMut.mutate({ name, type, base_url: baseUrl, api_key: apiKey, models, model: models[0] ?? '' })}
              disabled={!name || !baseUrl || !apiKey || models.length === 0}
            >
              添加
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Edit Provider Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="编辑 LLM Provider">
        <div className="space-y-4">
          <div>
            <Input label="名称" value={eName} onChange={(e) => setEName(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="general" partial={eName} context="LLM 提供商名称" onApply={setEName} /></div>
          </div>
          <Select label="类型" value={eType} onChange={setEType} options={typeOptions} />
          <Input label="Base URL" value={eBaseUrl} onChange={(e) => setEBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          <Input
            label="API Key"
            type="password"
            value={eApiKey}
            onChange={(e) => { setEApiKey(e.target.value); setEKeyDirty(true) }}
            placeholder="留空则保持不变"
          />
          <ModelFallbackList
            models={eModels}
            onChange={setEModels}
            baseUrl={eBaseUrl}
            apiKey={eKeyDirty ? eApiKey : undefined}
            providerId={editing?.id}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>取消</Button>
            <Button onClick={saveEdit} disabled={!eName || !eBaseUrl || eModels.length === 0}>保存</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
