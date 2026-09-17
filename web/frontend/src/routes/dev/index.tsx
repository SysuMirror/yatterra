import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Bot, Workflow, Plug, ChevronRight, Play, Square, Plus, Clock, Activity, TrendingUp } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { api } from '@/api/client'
import { formatDatetime } from '@/lib/format'

export default function DevOverview() {
  const { data: agentsRaw, isLoading: agentsLoading } = useQuery<any[]>({
    queryKey: ['agents'],
    queryFn: () => api.get<any>('/agents').then((d: any) => d.agents ?? d),
    staleTime: 15_000,
  })
  const agents = agentsRaw ?? []

  const { data: harnesses } = useQuery<string[]>({
    queryKey: ['harnesses'],
    queryFn: () => fetch('/harness/list', { credentials: 'same-origin' }).then(r => r.json()).then(d => d.names ?? d).catch(() => []),
    staleTime: 30_000,
  })

  const { data: mcpRaw } = useQuery<any[]>({
    queryKey: ['mcp'],
    queryFn: () => api.get<any>('/mcp').then((d: any) => d.servers ?? d).catch(() => []),
    staleTime: 30_000,
  })
  const mcpServers = mcpRaw ?? []

  const { data: llmRaw } = useQuery<any[]>({
    queryKey: ['llm-providers'],
    queryFn: () => api.get<any>('/llm/providers').then((d: any) => d.providers ?? d).catch(() => []),
    staleTime: 30_000,
  })
  const llmProviders = llmRaw ?? []

  // Recent agent sessions
  const { data: sessionsRaw } = useQuery<any[]>({
    queryKey: ['agent-sessions-recent'],
    queryFn: () => api.get<any>('/agents/sessions?mode=ops').then((d: any) => d.sessions ?? d).catch(() => []),
    staleTime: 15_000,
  })
  const sessions = sessionsRaw ?? []

  // LLM usage summary
  const { data: llmUsage } = useQuery<any>({
    queryKey: ['llm-usage-summary'],
    queryFn: () => api.get('/llm/usage/summary').catch(() => null),
    staleTime: 30_000,
  })

  const runningAgents = agents.filter((a: any) => a.run_id)
  const enabledMcp = mcpServers.filter((s: any) => s.enabled !== false)
  const defaultLlm = llmProviders.find((p: any) => p.is_default)

  const aiContext = `开发概览: Agent ${agents.length} 个 (${runningAgents.length} 运行中), MCP ${mcpServers.length} 个 (${enabledMcp.length} 启用), LLM ${llmProviders.length} 个, Harness ${harnesses?.length ?? 0} 个\nLLM用量: ${(llmUsage?.total_tokens ?? 0).toLocaleString()} tokens, ¥${(llmUsage?.total_cost ?? 0).toFixed(2)}\nAgent列表:\n${agents.slice(0, 10).map((a: any) => `  ${a.name ?? a.id} [${a.mode ?? '?'}] ${a.run_id ? '运行中' : '空闲'}`).join('\n')}`

  return (
    <>
      <PageHeader title="开发" description="Agent、编排与模型服务概览" doc={{ section: 'dev', item: 0, label: '助手文档' }}>
        <PageAiAssistant page="dev" context={`开发概览: Agent ${agents.length} 个 (${runningAgents.length} 运行中), 编排 ${harnesses?.length ?? 0} 个, MCP ${mcpServers.length} 个 (${enabledMcp.length} 启用), LLM ${llmProviders.length} 个${defaultLlm ? `, 默认: ${defaultLlm.name}` : ''}`} />
      </PageHeader>

      {/* AI Insight */}
      {!agentsLoading && (
        <AiInsightPanel
          page="dev"
          title="开发概览洞察"
          className="mb-5"
          context={aiContext}
        />
      )}

      {/* Core metrics */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {agentsLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<Bot size={15} className="text-accent" />} label="Agent" value={agents.length} suffix={runningAgents.length > 0 ? `${runningAgents.length} 运行中` : undefined} />
            <MetricCard icon={<Workflow size={15} className="text-ok" />} label="编排" value={harnesses?.length ?? 0} />
            <MetricCard icon={<Plug size={15} className="text-warn" />} label="MCP" value={mcpServers.length} suffix={`${enabledMcp.length} 启用`} />
            <MetricCard icon={<Bot size={15} className="text-muted" />} label="LLM" value={llmProviders.length} suffix={defaultLlm ? defaultLlm.name : undefined} />
          </>
        )}
      </div>

      {/* Recent agent sessions */}
      {sessions.length > 0 && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-accent" />
              <h2 className="text-sm font-semibold">最近会话</h2>
              <Badge variant="muted">{sessions.length} 条</Badge>
            </div>
            <Link to="/dev/harness" className="text-xs text-accent hover:underline flex items-center gap-1">
              查看全部 <ChevronRight size={12} />
            </Link>
          </div>
          <div className="space-y-2">
            {sessions.slice(0, 5).map((s: any) => (
              <div key={s.id || s.session_id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors">
                <span className="text-lg flex-shrink-0">{s.mode === 'ops' ? '🔧' : s.mode === 'build' ? '💻' : '🤖'}</span>
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{s.title || s.mode || 'New'}</span>
                <Badge variant="muted" className="text-[10px]">{s.mode}</Badge>
                {s.updated && (
                  <span className="text-xs text-muted tnum flex-shrink-0">{formatDatetime(s.updated)}</span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* MCP server status */}
      {mcpServers.length > 0 && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Plug size={16} className="text-warn" />
              <h2 className="text-sm font-semibold">MCP 服务器</h2>
              <Badge variant="muted">{mcpServers.length} 台</Badge>
            </div>
            <Link to="/dev/mcp" className="text-xs text-accent hover:underline flex items-center gap-1">
              查看全部 <ChevronRight size={12} />
            </Link>
          </div>
          <div className="space-y-2">
            {mcpServers.slice(0, 6).map((s: any) => (
              <div key={s.id || s.name} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors">
                <Plug size={14} className={s.enabled !== false ? 'text-ok' : 'text-muted'} />
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{s.name}</span>
                <Badge variant={s.enabled !== false ? 'ok' : 'muted'} dot className="text-[10px]">
                  {s.enabled !== false ? '启用' : '禁用'}
                </Badge>
                {s.transport && (
                  <Badge variant="muted" className="text-[10px]">{s.transport}</Badge>
                )}
              </div>
            ))}
            {mcpServers.length > 6 && (
              <p className="text-xs text-muted text-center pt-1">还有 {mcpServers.length - 6} 台…</p>
            )}
          </div>
        </Card>
      )}

      {/* Agent summary */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">Agent</h2>
            <Badge variant="muted">{agents.length} 个</Badge>
          </div>
          <Link to="/dev/harness" className="text-xs text-accent hover:underline flex items-center gap-1">
            查看全部 <ChevronRight size={12} />
          </Link>
        </div>
        {agents.length > 0 ? (
          <div className="space-y-2">
            {agents.slice(0, 5).map((a: any) => (
              <div key={a.id || a.name} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors">
                <span className="text-lg flex-shrink-0">{a.icon || '🤖'}</span>
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{a.label || a.name || a.id}</span>
                <Badge variant={a.run_id ? 'ok' : 'muted'} dot className="text-[10px]">
                  {a.run_id ? '运行中' : '空闲'}
                </Badge>
              </div>
            ))}
            {agents.length > 5 && (
              <p className="text-xs text-muted text-center pt-1">还有 {agents.length - 5} 个…</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted py-4 text-center">暂无 Agent</p>
        )}
      </Card>

      {/* LLM usage summary */}
      {llmUsage && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <TrendingUp size={16} className="text-accent" />
              <h2 className="text-sm font-semibold">LLM 用量</h2>
            </div>
            <Link to="/dev/llm" className="text-xs text-accent hover:underline flex items-center gap-1">
              查看详情 <ChevronRight size={12} />
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted mb-1">总 Token</p>
              <p className="font-medium tnum">{(llmUsage.total_tokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">Prompt</p>
              <p className="font-medium tnum">{(llmUsage.prompt_tokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">Completion</p>
              <p className="font-medium tnum">{(llmUsage.completion_tokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">总费用</p>
              <p className="font-medium tnum">¥{(llmUsage.total_cost ?? 0).toFixed(2)}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Harness summary */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Workflow size={16} className="text-ok" />
            <h2 className="text-sm font-semibold">编排流程</h2>
            <Badge variant="muted">{harnesses?.length ?? 0} 个</Badge>
          </div>
          <Link to="/dev/harness" className="text-xs text-accent hover:underline flex items-center gap-1">
            查看全部 <ChevronRight size={12} />
          </Link>
        </div>
        {harnesses && harnesses.length > 0 ? (
          <div className="space-y-2">
            {harnesses.slice(0, 5).map((name: string) => (
              <div key={name} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-black/[0.02] transition-colors">
                <Workflow size={14} className="text-muted flex-shrink-0" />
                <span className="text-sm font-medium flex-1 min-w-0 truncate">{name}</span>
                <Badge variant="muted" className="text-[10px]">idle</Badge>
              </div>
            ))}
            {harnesses.length > 5 && (
              <p className="text-xs text-muted text-center pt-1">还有 {harnesses.length - 5} 个…</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted py-4 text-center">暂无编排</p>
        )}
      </Card>

      {/* Quick actions */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <QuickAction icon={<Bot size={18} />} label="新建会话" desc="与 Agent 开始对话" to="/dev/harness" />
        <QuickAction icon={<Plug size={18} />} label="添加 MCP" desc="连接外部工具服务" to="/dev/mcp" />
        <QuickAction icon={<Bot size={18} />} label="添加 LLM" desc="配置大语言模型服务" to="/dev/llm" />
      </section>
    </>
  )
}

function QuickAction({ icon, label, desc, to }: { icon: React.ReactNode; label: string; desc: string; to: string }) {
  return (
    <Link
      to={to}
      className="glass-card rounded-2xl p-4 flex items-center gap-4 hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group"
    >
      <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <span className="text-sm font-semibold group-hover:text-accent transition-colors">{label}</span>
        <p className="text-xs text-muted">{desc}</p>
      </div>
      <ChevronRight size={14} className="ml-auto text-muted/40 group-hover:text-muted transition-colors flex-shrink-0" />
    </Link>
  )
}
