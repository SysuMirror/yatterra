import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Plus, Play, Trash2, Settings, Square, ChevronDown, ChevronRight, Package } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { Skeleton } from '@/components/ui/Skeleton'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'

import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'

export default function DevHarness() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()

  const [expandedHarness, setExpandedHarness] = useState<string | null>(null)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [sessionMode, setSessionMode] = useState('agent')
  const [sessionsOpen, setSessionsOpen] = useState(false)

  const { data: agents, isLoading } = useQuery<any[]>({
    queryKey: ['agents'],
    queryFn: () => api.get<any>('/agents').then(d => d.agents ?? d),
  })

  const { data: harnesses } = useQuery<string[]>({
    queryKey: ['harnesses'],
    queryFn: () => fetch('/harness/list', { credentials: 'same-origin' }).then(r => r.json()).then(d => d.names ?? d),
  })

  const { data: sessions } = useQuery<any[]>({
    queryKey: ['agent-sessions'],
    queryFn: () => api.get('/agents/sessions'),
  })

  const { data: harnessDetail } = useQuery<any>({
    queryKey: ['harness-detail', expandedHarness],
    queryFn: () => fetch(`/harness/def?name=${expandedHarness}`, { credentials: 'same-origin' }).then(r => r.json()),
    enabled: !!expandedHarness,
  })

  const { data: storeHarnesses } = useQuery<any[]>({
    queryKey: ['harness-store'],
    queryFn: () => fetch('/harness/store', { credentials: 'same-origin' }).then(r => r.json()).then(d => d.published ?? d),
  })

  const runMut = useMutation({
    mutationFn: (data: any) => api.post('/agents/run', data),
    onSuccess: () => toast({ type: 'success', message: 'Agent 运行中' }),
  })

  const stopMut = useMutation({
    mutationFn: (run_id: string) => api.post('/agents/stop', { run_id }),
    onSuccess: () => { toast({ type: 'success', message: '已停止' }); qc.invalidateQueries({ queryKey: ['agents'] }) },
    onError: () => toast({ type: 'error', message: '停止失败' }),
  })

  const newSessionMut = useMutation({
    mutationFn: (mode: string) => api.post('/agents/session/new', { mode }),
    onSuccess: () => { toast({ type: 'success', message: '会话已创建' }); qc.invalidateQueries({ queryKey: ['agent-sessions'] }); setNewSessionOpen(false) },
    onError: () => toast({ type: 'error', message: '创建失败' }),
  })

  const loadSessionMut = useMutation({
    mutationFn: (id: string) => api.get(`/agents/session/load?id=${id}`),
    onSuccess: () => toast({ type: 'success', message: '会话已加载' }),
    onError: () => toast({ type: 'error', message: '加载失败' }),
  })

  const deleteSessionMut = useMutation({
    mutationFn: (id: string) => api.post('/agents/session/delete', { id }),
    onSuccess: () => { toast({ type: 'success', message: '会话已删除' }); qc.invalidateQueries({ queryKey: ['agent-sessions'] }) },
    onError: () => toast({ type: 'error', message: '删除失败' }),
  })

  const runHarnessMut = useMutation({
    mutationFn: (name: string) => api.post(`/harnesses/${name}/run`),
    onSuccess: () => toast({ type: 'success', message: '编排已启动' }),
    onError: () => toast({ type: 'error', message: '启动失败' }),
  })

  const deleteHarnessMut = useMutation({
    mutationFn: (name: string) => fetch(`/harness/delete?name=${name}`, { credentials: 'same-origin', method: 'POST' }).then(r => r.json()),
    onSuccess: () => { toast({ type: 'success', message: '编排已删除' }); qc.invalidateQueries({ queryKey: ['harnesses'] }); setExpandedHarness(null) },
    onError: () => toast({ type: 'error', message: '删除失败' }),
  })

  const importStoreMut = useMutation({
    mutationFn: (name: string) => api.post('/harnesses/import', { name }),
    onSuccess: () => { toast({ type: 'success', message: '已导入' }); qc.invalidateQueries({ queryKey: ['harnesses'] }) },
    onError: () => toast({ type: 'error', message: '导入失败' }),
  })

  return (
    <>
      <PageHeader title="Agent 编排" description="多 Agent 工作流编排与调试" doc={{ section: 'dev', item: 1, label: '编排文档' }}>
        <PageAiAssistant page="harness" context={`Agent 编排: ${agents?.length ?? 0} 个 Agent, ${harnesses?.length ?? 0} 个编排, ${sessions?.length ?? 0} 个会话\nAgents:\n${(agents ?? []).slice(0, 10).map((a: any) => `  ${a.name ?? a.id} [${a.run_id ? '运行中' : '空闲'}]`).join('\n')}`} />
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && (
        <AiInsightPanel
          page="harness"
          title="编排洞察"
          className="mb-5"
          context={`Agent 编排: ${agents?.length ?? 0} 个 Agent (${(agents ?? []).filter((a: any) => a.run_id).length} 运行中), ${harnesses?.length ?? 0} 个编排, ${sessions?.length ?? 0} 个会话, 商店 ${storeHarnesses?.length ?? 0} 个\nAgents:\n${(agents ?? []).slice(0, 10).map((a: any) => `  ${a.name ?? a.id} [${a.runner ?? 'host'}] ${a.run_id ? '运行中' : '空闲'}`).join('\n')}\n编排:\n${(harnesses ?? []).slice(0, 10).map((h: any) => `  ${typeof h === 'string' ? h : h.name}`).join('\n')}`}
        />
      )}

      {/* Agents + Sessions */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">Agent 列表</h2>
          </div>
          <Badge variant="muted">{agents?.length ?? 0} 个</Badge>
        </div>
        {isLoading ? <Skeleton height={100} /> : (
          <DataTable
            columns={[
              { key: 'name', title: '名称', sortable: true, render: (r: any) => (
                <div className="flex items-center gap-2">
                  <span className="text-lg">{r.icon || '🤖'}</span>
                  <div>
                    <span className="font-medium">{r.label || r.name || r.id}</span>
                    <span className="text-xs text-muted ml-2">{r.id}</span>
                  </div>
                </div>
              )},
              { key: 'runner', title: '运行环境', render: (r: any) => <Badge variant={r.runner === 'pod' ? 'accent' : 'muted'}>{r.runner === 'pod' ? 'Pod 内' : '主机'}</Badge> },
              { key: 'action', title: '', width: '120px', render: (r: any) => (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => runMut.mutate({ agent: r.id })}>
                    <Play size={13} /> 运行
                  </Button>
                  {r.run_id && (
                    <Button variant="ghost" size="sm" onClick={() => stopMut.mutate(r.run_id)}>
                      <Square size={14} />
                    </Button>
                  )}
                </div>
              )},
            ]}
            data={agents ?? []}
            keyFn={(r: any) => r.id || r.name}
            empty={
              <div className="flex flex-col items-center gap-2 py-8">
                <Bot size={28} className="text-muted/40" />
                <p className="text-sm text-muted">暂无 Agent</p>
              </div>
            }
          />
        )}

        {/* Sessions — collapsible section */}
        <div className="border-t border-black/[0.06] mt-4 pt-4">
          <div className="flex items-center justify-between mb-4">
            <button
              className="flex items-center gap-2 text-sm font-semibold rounded-md px-2 py-1 hover:bg-black/[0.04] transition-colors"
              onClick={() => setSessionsOpen(!sessionsOpen)}
            >
              {sessionsOpen ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
              Agent 会话
              <Badge variant="muted">{sessions?.length ?? 0} 个</Badge>
            </button>
            <Button size="sm" variant="outline" onClick={() => setNewSessionOpen(true)}>
              <Plus size={14} /> 新建会话
            </Button>
          </div>
          {sessionsOpen && (
            sessions && sessions.length > 0 ? (
              <DataTable
                columns={[
                  { key: 'session_id', title: '会话 ID', render: (r: any) => <span className="font-mono text-xs max-w-[200px] truncate inline-block">{r.session_id || r.id}</span> },
                  { key: 'mode', title: '模式', render: (r: any) => <Badge variant="muted">{r.mode || 'agent'}</Badge> },
                  { key: 'created', title: '创建时间', render: (r: any) => <span className="text-xs text-muted">{r.created_at || r.created || '-'}</span> },
                  { key: 'actions', title: '', width: '120px', render: (r: any) => (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => loadSessionMut.mutate(r.session_id || r.id)}>加载</Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteSessionMut.mutate(r.session_id || r.id)}><Trash2 size={14} /></Button>
                    </div>
                  )},
                ]}
                data={sessions}
                keyFn={(r: any) => r.session_id || r.id}
                empty={
                  <div className="flex flex-col items-center gap-2 py-8">
                    <Bot size={28} className="text-muted/40" />
                    <p className="text-sm text-muted">暂无会话</p>
                  </div>
                }
              />
            ) : (
              <div className="flex flex-col items-center gap-2 py-8">
                <Bot size={28} className="text-muted/40" />
                <p className="text-sm text-muted">暂无会话</p>
              </div>
            )
          )}
        </div>
      </Card>

      {/* Harnesses */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">编排流程</h2>
          </div>
          <Badge variant="muted">{harnesses?.length ?? 0} 个</Badge>
        </div>
        <DataTable
          columns={[
            { key: 'name', title: '名称', sortable: true, render: (r: any) => (
              <button
                className="flex items-center gap-2 font-medium text-sm text-accent hover:text-accent/80 underline-offset-2 hover:underline transition-colors"
                onClick={() => setExpandedHarness(expandedHarness === r ? null : r)}
              >
                {expandedHarness === r ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {r}
              </button>
            )},
            { key: 'status', title: '状态', render: () => <Badge variant="muted">idle</Badge> },
            { key: 'actions', title: '', width: '100px', render: (r: any) => (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => runHarnessMut.mutate(r)}>
                  <Play size={14} /> 运行
                </Button>
              </div>
            )},
          ]}
          data={harnesses ?? []}
          keyFn={(r: any) => r}
          empty={
            <div className="flex flex-col items-center gap-2 py-8">
              <Settings size={28} className="text-muted/40" />
              <p className="text-sm text-muted">暂无编排</p>
            </div>
          }
        />

        {/* Harness Detail */}
        {expandedHarness && (
          <div className="mt-4 border-t border-black/[0.06] pt-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">{expandedHarness}</h4>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => runHarnessMut.mutate(expandedHarness)}>
                  <Play size={14} /> 运行
                </Button>
                <Button variant="ghost" size="sm" onClick={() => deleteHarnessMut.mutate(expandedHarness)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
            {harnessDetail ? (
              <>
                <h5 className="text-xs font-semibold text-muted mb-2">定义</h5>
                <pre className="text-xs font-mono bg-[#1d1d1f] text-[#f5f5f7] rounded-xl p-4 overflow-auto max-h-64">
                  {typeof harnessDetail === 'string' ? harnessDetail : JSON.stringify(harnessDetail, null, 2)}
                </pre>
              </>
            ) : (
              <Skeleton height={80} />
            )}
          </div>
        )}
      </Card>

      {/* Harness Store */}
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <Package size={16} className="text-muted" />
          <h2 className="text-sm font-semibold">编排商店</h2>
          <Badge variant="muted">{storeHarnesses?.length ?? 0} 个</Badge>
        </div>
        {storeHarnesses && storeHarnesses.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {storeHarnesses.map((item: any) => (
              <Card key={item.name} padding="md">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Package size={14} className="text-muted" />
                    <span className="font-medium text-sm">{item.name}</span>
                  </div>
                  {item.description && <p className="text-xs text-muted">{item.description}</p>}
                  <Button size="sm" variant="secondary" onClick={() => importStoreMut.mutate(item.name)}>
                    <Plus size={14} /> 导入
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-8">
            <Package size={28} className="text-muted/40" />
            <p className="text-sm text-muted">暂无可用编排</p>
          </div>
        )}
      </Card>

      {/* New Session Dialog */}
      <Dialog open={newSessionOpen} onClose={() => setNewSessionOpen(false)} title="新建会话">
        <div className="space-y-4">
          <Select
            label="模式"
            value={sessionMode}
            onChange={setSessionMode}
            options={[
              { value: 'agent', label: 'Agent' },
              { value: 'harness', label: 'Harness' },
            ]}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewSessionOpen(false)}>取消</Button>
            <Button onClick={() => newSessionMut.mutate(sessionMode)}>确认</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
