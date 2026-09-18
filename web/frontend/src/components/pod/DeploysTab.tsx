import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Rocket, Play, Square, ScrollText, Plus, Trash2, Zap, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { aiApi } from '@/api/ai'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { cn } from '@/lib/cn'

/** Quickstart template definitions (mirrors server _TEMPLATES keys) */
const TEMPLATES = [
  { id: 'flask', label: 'Flask', desc: 'Python Flask Web 服务' },
  { id: 'fastapi', label: 'FastAPI', desc: 'Python FastAPI 异步服务' },
  { id: 'node', label: 'Node.js', desc: 'Node HTTP 服务' },
  { id: 'streamlit', label: 'Streamlit', desc: 'Python Streamlit 可视化' },
  { id: 'vllm', label: 'vLLM', desc: 'vLLM 模型推理服务' },
] as const

export function DeploysTab({ podName, canManage }: { podName: string; canManage: boolean }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  // ── Form state ──
  const [dSource, setDSource] = useState<'repo' | 'local'>('repo')
  const [dName, setDName] = useState('')
  const [dRepo, setDRepo] = useState('')
  const [dScript, setDScript] = useState('')
  const [dBranch, setDBranch] = useState('')
  const [dSubdir, setDSubdir] = useState('')
  const [dMode, setDMode] = useState<'service' | 'oneshot'>('service')
  const [dKind, setDKind] = useState<'serve' | 'train'>('serve')
  const [dGpu, setDGpu] = useState('0')
  const [dVram, setDVram] = useState('')
  const [dToken, setDToken] = useState('')
  const [dHealth, setDHealth] = useState('')
  const [dHealthTimeout, setDHealthTimeout] = useState('60')
  const [dAutoDeploy, setDAutoDeploy] = useState(false)

  const resetForm = () => {
    setDSource('repo'); setDName(''); setDRepo(''); setDScript('')
    setDBranch(''); setDSubdir(''); setDMode('service'); setDKind('serve')
    setDGpu('0'); setDVram(''); setDToken(''); setDHealth('')
    setDHealthTimeout('60'); setDAutoDeploy(false)
  }

  const { data, isLoading } = useQuery<any>({
    queryKey: ['deploys', podName],
    queryFn: () => api.get(`/pods/${podName}/deploys`),
    refetchInterval: 15_000,
  })
  const deploys = data?.deploys ?? data ?? []
  const refresh = () => qc.invalidateQueries({ queryKey: ['deploys', podName] })
  const requireOk = (res: any, fallback: string) => {
    if (res?.ok === false) throw new Error(res.msg || fallback)
    return res
  }

  const run = useMutation({
    mutationFn: async (d: any) => requireOk(await api.post(`/pods/${podName}/deploys/${d.id ?? d.name}/run`), '启动失败'),
    onSuccess: (_d, dd) => { toast({ type: 'success', message: `${dd.name} 启动中` }); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '启动失败' }),
  })
  const stop = useMutation({
    mutationFn: (d: any) => api.post(`/pods/${podName}/deploys/${d.id ?? d.name}/stop`),
    onSuccess: (_d, dd) => { toast({ type: 'success', message: `${dd.name} 停止中` }); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '停止失败' }),
  })
  const createDeploy = useMutation({
    mutationFn: () => {
      const body: any = {
        name: dName.trim(),
        source: dSource,
        mode: dMode,
        kind: dKind,
        gpu: dGpu,
        vram: dVram.trim(),
        health: dHealth.trim(),
        health_timeout: dHealthTimeout.trim() || '60',
        auto_deploy: dAutoDeploy,
      }
      if (dSource === 'repo') {
        body.repo = dRepo.trim()
        body.branch = dBranch.trim()
        body.subdir = dSubdir.trim()
        body.token = dToken.trim()
      } else {
        body.script = dScript.trim()
      }
      return api.post(`/pods/${podName}/deploys`, body)
    },
    onSuccess: () => { toast({ type: 'success', message: '部署创建成功' }); setCreateOpen(false); resetForm(); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '创建失败' }),
  })
  const deleteDeploy = useMutation({
    mutationFn: (d: any) => api.del(`/pods/${podName}/deploys?id=${encodeURIComponent(d.id ?? d.name)}`),
    onSuccess: (_d, dd) => { toast({ type: 'success', message: `${dd.name} 已删除` }); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '删除失败' }),
  })
  const applyTemplate = useMutation({
    mutationFn: async (tplId: string) => requireOk(await api.post(`/pods/${podName}/apply-template`, { template: tplId }), '模板部署失败'),
    onSuccess: (_d, tplId: any) => { toast({ type: 'success', message: `模板 ${tplId} 已部署` }); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '模板部署失败' }),
  })

  // Validation: name required for local, repo required for repo source
  const canSubmit = dSource === 'local'
    ? dName.trim() && dScript.trim()
    : dRepo.trim()

  const isRepo = dSource === 'repo'
  const isTrain = dKind === 'train'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Rocket size={15} /> 部署</h3>
        {canManage && <Button data-onboarding-target="deploy-create" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> 创建部署</Button>}
      </div>

      {/* ── Quickstart templates ── */}
      {canManage && deploys.length === 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted">快速开始 — 选择模板一键部署：</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => applyTemplate.mutate(tpl.id)}
                disabled={applyTemplate.isPending}
                className="flex flex-col items-center gap-1 p-3 rounded-xl border-[0.5px] border-black/8 bg-white/62 hover:bg-white/80 active:scale-[0.97] transition-all text-center"
              >
                <Zap size={16} className="text-accent" />
                <span className="text-sm font-medium">{tpl.label}</span>
                <span className="text-[11px] text-muted leading-tight">{tpl.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Create deploy dialog ── */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="创建部署" width="max-w-2xl">
        <div className="space-y-4">
          {/* Row 1: Source + Name */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select label="来源" value={dSource} onChange={(v) => setDSource(v as 'repo' | 'local')} options={[{ value: 'repo', label: '绑仓库' }, { value: 'local', label: '本地脚本' }]} />
            <div className="sm:col-span-2">
              <Input label={isRepo ? '名称 (留空取仓库名)' : '名称 (必填)'} value={dName} onChange={e => setDName(e.target.value)} placeholder="deploy-name" className="sm:col-span-2" />
              <div className="mt-1"><AiFormHelper type="deploy" partial={dName} onApply={setDName} /></div>
            </div>
          </div>

          {/* Row 2: Repo URL or Script path */}
          {isRepo ? (
            <div>
              <Input label="仓库地址" value={dRepo} onChange={e => setDRepo(e.target.value)} placeholder="https://gitee.com/xxx/yyy.git" />
              <div className="mt-1"><AiFormHelper type="deploy" partial={dRepo} onApply={setDRepo} /></div>
            </div>
          ) : (
            <div>
              <Input data-onboarding-target="deploy-script" label="deploy.sh 路径" value={dScript} onChange={e => setDScript(e.target.value)} placeholder="/home/cloud/myapp/start.sh" />
              <div className="mt-1"><AiFormHelper type="general" partial={dScript} context="部署脚本路径" onApply={setDScript} /></div>
            </div>
          )}

          {/* Row 3: Branch + Subdir (repo only) */}
          {isRepo && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Input label="分支" value={dBranch} onChange={e => setDBranch(e.target.value)} placeholder="默认" />
                <div className="mt-1"><AiFormHelper type="general" partial={dBranch} context="Git 分支名" onApply={setDBranch} /></div>
              </div>
              <div>
                <Input label="子目录" value={dSubdir} onChange={e => setDSubdir(e.target.value)} placeholder="留空" />
                <div className="mt-1"><AiFormHelper type="general" partial={dSubdir} context="代码子目录" onApply={setDSubdir} /></div>
              </div>
            </div>
          )}

          {/* Row 4: Mode + Kind + GPU/VRAM */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select label="类型" value={dMode} onChange={(v) => setDMode(v as 'service' | 'oneshot')} options={[{ value: 'service', label: '常驻服务' }, { value: 'oneshot', label: '一次性脚本' }]} />
            <Select label="调度类型" value={dKind} onChange={(v) => setDKind(v as 'serve' | 'train')} options={[{ value: 'serve', label: '推理服务' }, { value: 'train', label: '训练(池化)' }]} />
            {isTrain ? (
              <div>
                <Input label="显存(MB)" value={dVram} onChange={e => setDVram(e.target.value)} placeholder="默认 12000" />
                <div className="mt-1"><AiFormHelper type="general" partial={dVram} context="显存限制 MB" onApply={setDVram} /></div>
              </div>
            ) : (
              <Select label="绑卡 GPU" value={dGpu} onChange={setDGpu} options={[{ value: '0', label: 'GPU 0' }, { value: '1', label: 'GPU 1' }, { value: '2', label: 'GPU 2' }]} />
            )}
          </div>

          {/* Row 5: Token (repo only) + Health check */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {isRepo && (
              <Input data-onboarding-target="deploy-token" label="私有库 token" type="password" value={dToken} onChange={e => setDToken(e.target.value)} placeholder="公开库留空" />
            )}
            <div>
              <Input label="健康检查路径" value={dHealth} onChange={e => setDHealth(e.target.value)} placeholder="/health 留空跳过" />
              <div className="mt-1"><AiFormHelper type="general" partial={dHealth} context="健康检查 URL 路径" onApply={setDHealth} /></div>
            </div>
            <div>
              <Input label="超时(秒)" value={dHealthTimeout} onChange={e => setDHealthTimeout(e.target.value)} placeholder="60" />
              <div className="mt-1"><AiFormHelper type="general" partial={dHealthTimeout} context="健康检查超时秒数" onApply={setDHealthTimeout} /></div>
            </div>
          </div>

          {/* Row 6: Auto-deploy (repo only) */}
          {isRepo && (
            <div className="flex items-center gap-2">
              <Switch checked={dAutoDeploy} onChange={setDAutoDeploy} />
              <span className="text-sm text-ink-2">push 自动部署</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button data-onboarding-target="deploy-submit" disabled={!canSubmit} loading={createDeploy.isPending} onClick={() => createDeploy.mutate()}>确认</Button>
          </div>
        </div>
      </Dialog>

      {isLoading && <div className="text-sm text-muted text-center py-8">加载中…</div>}
      {!isLoading && deploys.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8">
          <Rocket size={28} className="text-muted/40" />
          <p className="text-sm text-muted">暂无部署</p>
        </div>
      )}
      {deploys.map((d: any) => {
        const id = d.id ?? d.name
        const running = d.state === 'running'
        return (
          <Card key={id} padding="md" className={cn('border-l-2', running ? 'border-l-ok' : 'border-l-transparent')}>
            <div className="flex items-center gap-3 flex-wrap">
              <Rocket size={15} className="text-muted flex-shrink-0" />
              <span className="text-sm font-medium font-mono truncate min-w-0">{d.name}</span>
              <Badge variant={running ? 'ok' : 'muted'} dot>{d.state || 'stopped'}</Badge>
              {d.kind && d.kind !== 'serve' && <Badge variant="accent">{d.kind === 'train' ? '训练' : d.kind}</Badge>}
              {d.source === 'local' && <Badge variant="muted">本地</Badge>}
              {d.auto_deploy && <Badge variant="accent">自动部署</Badge>}
              {running && <DeployStatusBadge podName={podName} deployId={id} />}
              <div className="flex-1" />
              {canManage && (
                <div className="flex items-center gap-1.5">
                  {running ? (
                    <Button variant="secondary" size="sm" onClick={() => stop.mutate(d)}><Square size={13} /> 停止</Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => run.mutate(d)}><Play size={13} /> 启动</Button>
                  )}
                  <Button
                    variant="ghost" size="sm"
                    aria-label="查看日志"
                    onClick={() => setLogsFor(logsFor === id ? null : id)}
                  >
                    <ScrollText size={13} />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="删除" onClick={() => { if (confirm(`删除部署 ${d.name}？`)) deleteDeploy.mutate(d) }}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              )}
            </div>
            {logsFor === id && <DeployLogs podName={podName} deployId={id} />}
          </Card>
        )
      })}
    </div>
  )
}

function DeployLogs({ podName, deployId }: { podName: string; deployId: string }) {
  const [aiExplain, setAiExplain] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const { data, isLoading } = useQuery<any>({
    queryKey: ['deploy-logs', podName, deployId],
    queryFn: () => api.get(`/pods/${podName}/deploys/${deployId}/logs?tail=200`),
    refetchInterval: 5_000,
  })
  const lines: string[] = Array.isArray(data) ? data
    : (data?.logs ?? data?.lines ?? (typeof data === 'string' ? data.split('\n') : []))

  const errorLines = lines.filter(l => /error|fail|traceback|exception|fatal|panic/i.test(l))
  const handleAiExplain = async () => {
    if (!errorLines.length) return
    setAiLoading(true)
    setAiExplain('')
    try {
      const res = await aiApi.explain(errorLines.slice(-20).join('\n'))
      setAiExplain(res.content)
    } catch {
      setAiExplain('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs text-muted">运行日志（每 5 秒刷新）</span>
        <div className="flex-1" />
        {errorLines.length > 0 && (
          <button
            onClick={handleAiExplain}
            disabled={aiLoading}
            className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 disabled:opacity-40 transition-colors"
          >
            <Sparkles size={12} />
            {aiLoading ? '分析中...' : `AI 解释错误 (${errorLines.length})`}
          </button>
        )}
        <span className="text-xs text-muted/60">{lines.length} 行</span>
      </div>
      {aiExplain && (
        <div className="mb-2 p-3 rounded-lg bg-accent/5 border border-accent/10 text-sm whitespace-pre-wrap">
          <div className="flex items-center gap-1 mb-1 text-xs font-semibold text-accent"><Sparkles size={12} /> AI 分析</div>
          {aiExplain}
        </div>
      )}
      <div className="h-56 overflow-y-auto overflow-x-auto rounded-lg p-3 font-mono text-xs leading-5 bg-[#1d1d1f] text-[#f5f5f7]">
        {isLoading ? (
          <span className="text-white/40">加载中…</span>
        ) : lines.length ? (
          lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-all', /error|fail|traceback|exception/i.test(l) && 'text-[#ff453a]')}>
              {l}
            </div>
          ))
        ) : (
          <span className="text-white/40">暂无日志</span>
        )}
      </div>
    </div>
  )
}

function DeployStatusBadge({ podName, deployId }: { podName: string; deployId: string }) {
  const { data } = useQuery<any>({
    queryKey: ['deploy-status', podName, deployId],
    queryFn: () => api.get(`/pods/${podName}/deploys/${deployId}/status`),
    refetchInterval: 10_000,
  })
  if (!data) return null
  const status = typeof data === 'string' ? data : data?.status
  if (!status) return null
  const variant = status === 'healthy' ? 'ok' : status === 'unhealthy' ? 'bad' : 'accent'
  return <Badge variant={variant as any} dot>{status}</Badge>
}
