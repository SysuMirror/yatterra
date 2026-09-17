import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plug, Plus, Trash2, ToggleLeft, Pencil, FlaskConical } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import { DataTable } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'

interface MCPServer {
  name: string
  id?: string
  command?: string
  transport?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
}

export default function DevMCP() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()

  const [addOpen, setAddOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<MCPServer | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formTransport, setFormTransport] = useState('stdio')
  const [formArgs, setFormArgs] = useState('')
  const [formEnv, setFormEnv] = useState('')

  const resetForm = () => {
    setFormName('')
    setFormCommand('')
    setFormTransport('stdio')
    setFormArgs('')
    setFormEnv('')
  }

  const openAdd = (prefill?: Partial<MCPServer>) => {
    resetForm()
    if (prefill) {
      setFormName(prefill.name || '')
      setFormCommand(prefill.command || '')
      setFormTransport(prefill.transport || 'stdio')
      setFormArgs(prefill.args?.join(' ') || '')
      setFormEnv(prefill.env ? Object.entries(prefill.env).map(([k, v]) => `${k}=${v}`).join('\n') : '')
    }
    setAddOpen(true)
  }

  const openEdit = (server: MCPServer) => {
    setEditing(server)
    setFormName(server.name)
    setFormCommand(server.command || '')
    setFormTransport(server.transport || 'stdio')
    setFormArgs(server.args?.join(' ') || '')
    setFormEnv(server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : '')
    setEditOpen(true)
  }

  const buildPayload = () => {
    const env: Record<string, string> = {}
    if (formEnv.trim()) {
      for (const line of formEnv.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }
    return {
      name: formName,
      command: formCommand,
      transport: formTransport,
      args: formArgs.trim() ? formArgs.trim().split(/\s+/) : [],
      env,
    }
  }

  const { data, isLoading } = useQuery<any[]>({
    queryKey: ['mcp'],
    queryFn: () => api.get<any>('/mcp').then(d => d.servers ?? d),
  })

  const { data: catalog } = useQuery<any[]>({
    queryKey: ['mcp-catalog'],
    queryFn: () => api.get('/mcp/catalog'),
  })

  const addMut = useMutation({
    mutationFn: (data: any) => api.post('/mcp', data),
    onSuccess: () => { toast({ type: 'success', message: '已添加' }); qc.invalidateQueries({ queryKey: ['mcp'] }); setAddOpen(false); resetForm() },
    onError: () => toast({ type: 'error', message: '添加失败' }),
  })

  const editMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.put(`/mcp/${id}`, data),
    onSuccess: () => { toast({ type: 'success', message: '已更新' }); qc.invalidateQueries({ queryKey: ['mcp'] }); setEditOpen(false); setEditing(null) },
    onError: () => toast({ type: 'error', message: '更新失败' }),
  })

  const toggleMut = useMutation({
    mutationFn: (id: string) => api.post(`/mcp/${id}/toggle`),
    onSuccess: () => { toast({ type: 'success', message: '已切换' }); qc.invalidateQueries({ queryKey: ['mcp'] }) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.del(`/mcp/${id}`),
    onSuccess: () => { toast({ type: 'success', message: '已删除' }); qc.invalidateQueries({ queryKey: ['mcp'] }) },
  })

  const testMut = useMutation({
    mutationFn: (id: string) => api.post(`/mcp/${id}/test`),
    onSuccess: () => toast({ type: 'success', message: '连接测试成功' }),
    onError: () => toast({ type: 'error', message: '连接测试失败' }),
  })

  return (
    <>
      <PageHeader title="MCP 服务器" description="Model Context Protocol 服务管理" doc={{ section: 'dev', item: 2, label: 'MCP 文档' }}>
        <div className="flex items-center gap-2">
          <PageAiAssistant page="mcp" context={data && data.length > 0 ? `MCP 服务器: ${data.length} 个\n${data.map((s: any) => `  ${s.name ?? s.id} [${s.transport ?? '?'}] ${s.enabled === false ? '(禁用)' : '(启用)'}`).join('\n')}` : '暂无 MCP 服务器'} />
          <Button size="sm" onClick={() => openAdd()}><Plus size={14} /> 添加</Button>
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && data && data.length > 0 && (
        <AiInsightPanel
          page="mcp"
          title="MCP 服务洞察"
          className="mb-5"
          context={`MCP 服务器: ${data.length} 个 (${data.filter((s: any) => s.enabled !== false).length} 启用, ${data.filter((s: any) => s.enabled === false).length} 禁用)\n${data.map((s: any) => `  ${s.name ?? s.id} [${s.transport ?? 'stdio'}] ${s.enabled === false ? '(禁用)' : '(启用)'}`).join('\n')}\nMCP 目录: ${catalog?.length ?? 0} 个可用`}
        />
      )}

      <Card padding="none">
        <DataTable
          columns={[
            { key: 'name', title: '名称', sortable: true, render: (r: any) => (
              <div className="flex items-center gap-2">
                <Plug size={14} className="text-accent" />
                <span className="font-medium">{r.name}</span>
              </div>
            )},
            { key: 'transport', title: '传输', render: (r: any) => <Badge variant="muted">{r.transport || 'stdio'}</Badge> },
            { key: 'enabled', title: '启用', render: (r: any) => (
              <Switch checked={r.enabled !== false} onChange={() => toggleMut.mutate(r.name)} />
            )},
            { key: 'actions', title: '', width: '120px', render: (r: any) => (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label="编辑"><Pencil size={14} /></Button>
                <Button variant="ghost" size="sm" onClick={() => testMut.mutate(r.name)} aria-label="测试"><FlaskConical size={14} /></Button>
                <Button variant="ghost" size="sm" onClick={() => deleteMut.mutate(r.name)} aria-label="删除"><Trash2 size={14} /></Button>
              </div>
            )},
          ]}
          data={data ?? []}
          keyFn={(r: any) => r.name}
          empty={<p className="text-sm text-muted text-center py-8">暂无 MCP 服务器</p>}
        />
      </Card>

      {/* MCP Catalog */}
      <Card className="mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">MCP 目录</h2>
          <Badge variant="muted">{catalog?.length ?? 0} 个</Badge>
        </div>
        {catalog && catalog.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {catalog.map((item: any) => (
              <Card key={item.name} padding="md">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Plug size={14} className="text-accent" />
                      <span className="font-medium text-sm">{item.name}</span>
                    </div>
                    <Badge variant="muted">{item.transport || 'stdio'}</Badge>
                  </div>
                  {item.description && <p className="text-xs text-muted">{item.description}</p>}
                  <Button size="sm" variant="outline" onClick={() => openAdd(item)}>
                    <Plus size={14} /> 安装
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-8">
            <Plug size={28} className="text-muted/40" />
            <p className="text-sm text-muted">暂无可用目录</p>
          </div>
        )}
      </Card>

      {/* Add Dialog */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="添加 MCP 服务器">
        <div className="space-y-4">
          <div>
            <Input label="名称" value={formName} onChange={e => setFormName(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="mcp" partial={formName} context="MCP 服务器名称" onApply={setFormName} /></div>
          </div>
          <div>
            <Input label="命令" value={formCommand} onChange={e => setFormCommand(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="mcp" partial={formCommand} onApply={setFormCommand} /></div>
          </div>
          <Select label="传输方式" value={formTransport} onChange={setFormTransport} options={[
            { value: 'stdio', label: 'stdio' },
            { value: 'sse', label: 'SSE' },
            { value: 'streamable-http', label: 'Streamable HTTP' },
          ]} />
          <div>
            <Input label="参数" value={formArgs} onChange={e => setFormArgs(e.target.value)} placeholder="空格分隔" />
            <div className="mt-1"><AiFormHelper type="general" partial={formArgs} context="MCP 服务器启动参数，空格分隔" onApply={setFormArgs} /></div>
          </div>
          <div>
            <label className="text-sm text-ink-2 mb-1 block">环境变量</label>
            <textarea
              className="w-full rounded-[10px] text-sm border-[0.5px] border-black/8 bg-white/62 px-3.5 py-2.5 focus:outline-none focus:border-accent resize-none"
              rows={3}
              placeholder="KEY=VALUE 每行一个"
              value={formEnv}
              onChange={e => setFormEnv(e.target.value)}
            />
            <div className="mt-1"><AiFormHelper type="general" partial={formEnv} context="MCP 服务器环境变量，每行 KEY=VALUE" onApply={setFormEnv} /></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>取消</Button>
            <Button onClick={() => addMut.mutate(buildPayload())} disabled={!formName || !formCommand}>
              确认
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="编辑 MCP 服务器">
        <div className="space-y-4">
          <div>
            <Input label="名称" value={formName} onChange={e => setFormName(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="mcp" partial={formName} context="MCP 服务器名称" onApply={setFormName} /></div>
          </div>
          <div>
            <Input label="命令" value={formCommand} onChange={e => setFormCommand(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="mcp" partial={formCommand} onApply={setFormCommand} /></div>
          </div>
          <Select label="传输方式" value={formTransport} onChange={setFormTransport} options={[
            { value: 'stdio', label: 'stdio' },
            { value: 'sse', label: 'SSE' },
            { value: 'streamable-http', label: 'Streamable HTTP' },
          ]} />
          <div>
            <Input label="参数" value={formArgs} onChange={e => setFormArgs(e.target.value)} placeholder="空格分隔" />
            <div className="mt-1"><AiFormHelper type="general" partial={formArgs} context="MCP 服务器启动参数，空格分隔" onApply={setFormArgs} /></div>
          </div>
          <div>
            <label className="text-sm text-ink-2 mb-1 block">环境变量</label>
            <textarea
              className="w-full rounded-[10px] text-sm border-[0.5px] border-black/8 bg-white/62 px-3.5 py-2.5 focus:outline-none focus:border-accent resize-none"
              rows={3}
              placeholder="KEY=VALUE 每行一个"
              value={formEnv}
              onChange={e => setFormEnv(e.target.value)}
            />
            <div className="mt-1"><AiFormHelper type="general" partial={formEnv} context="MCP 服务器环境变量，每行 KEY=VALUE" onApply={setFormEnv} /></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>取消</Button>
            <Button onClick={() => editing && editMut.mutate({ id: editing.name, data: buildPayload() })} disabled={!formName || !formCommand}>
              确认
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
