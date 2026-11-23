import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Rocket, Play, Square, ScrollText, Plus, Trash2, Zap, Sparkles, SlidersHorizontal, Hourglass, Pencil, Copy, RefreshCw, KeyRound } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { aiApi } from '@/api/ai'
import { MarkdownContent } from '@/components/ai'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { cn } from '@/lib/cn'

/** Throw on an explicit `{ok:false}` API envelope so react-query surfaces the message. */
const requireOk = (res: any, fallback: string) => {
  if (res?.ok === false) throw new Error(res.msg || fallback)
  return res
}

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
  const [editingId, setEditingId] = useState<string | null>(null)

  // ── Form state ──
  const [dSource, setDSource] = useState<'repo' | 'local'>('repo')
  const [dName, setDName] = useState('')
  const [dRepo, setDRepo] = useState('')
  const [dScript, setDScript] = useState('')
  const [dBranch, setDBranch] = useState('')
  const [dSubdir, setDSubdir] = useState('')
  const [dMode, setDMode] = useState<'service' | 'oneshot'>('service')
  const [dKind, setDKind] = useState<'serve' | 'train'>('serve')
  const [dGpu, setDGpu] = useState('')            // '' = 自动分配（见 GPU_OPTIONS）
  const [dVram, setDVram] = useState('')
  const [dToken, setDToken] = useState('')
  const [dHealth, setDHealth] = useState('')
  const [dHealthTimeout, setDHealthTimeout] = useState('60')
  const [dAutoDeploy, setDAutoDeploy] = useState(false)
  // P1-c flexibility contract (train only)
  const [dDeferOk, setDDeferOk] = useState(false)
  const [dPreemptOk, setDPreemptOk] = useState(true)
  const [dDeadline, setDDeadline] = useState('')
  const [dDeadlineKind, setDDeadlineKind] = useState<'soft' | 'hard'>('soft')
  const [dEstDur, setDEstDur] = useState('')

  const resetForm = () => {
    setDSource('repo'); setDName(''); setDRepo(''); setDScript('')
    setDBranch(''); setDSubdir(''); setDMode('service'); setDKind('serve')
    // 推理服务按设计是「创建时钉一张卡」，默认取本 Pod 分配到的第一张；
    // 无卡 Pod 走 CPU 部署，这里留空即可（字段反正会被隐藏/归一化）。
    setDGpu(podGpus.length ? String(podGpus[0]) : '')
    setDVram(''); setDToken(''); setDHealth('')
    setDHealthTimeout('60'); setDAutoDeploy(false)
    setDDeferOk(false); setDPreemptOk(true); setDDeadline('')
    setDDeadlineKind('soft'); setDEstDur('')
  }

  const openCreate = () => { resetForm(); setEditingId(null); setCreateOpen(true) }
  const openEdit = (d: any) => {
    setEditingId(d.id ?? d.name)
    setDSource(d.source === 'local' ? 'local' : 'repo')
    setDName(d.name ?? '')
    setDRepo(d.repo ?? ''); setDScript(d.script ?? '')
    setDBranch(d.branch ?? ''); setDSubdir(d.subdir ?? '')
    setDMode(d.mode === 'oneshot' ? 'oneshot' : 'service')
    setDKind(d.kind === 'train' ? 'train' : 'serve')
    setDGpu(d.gpu ?? ''); setDVram(d.vram ?? '')
    setDToken('')                                  // 留空 = 保持原 token
    setDHealth(d.health ?? ''); setDHealthTimeout(String(d.health_timeout ?? '60'))
    setDAutoDeploy(!!d.auto_deploy)
    const c = d.contract ?? {}
    setDDeferOk(!!c.defer_ok); setDPreemptOk(c.preempt_ok !== false)
    setDDeadline(''); setDDeadlineKind('soft'); setDEstDur('')
    setCreateOpen(true)
  }

  const { data, isLoading } = useQuery<any>({
    queryKey: ['deploys', podName],
    queryFn: () => api.get(`/pods/${podName}/deploys`),
    refetchInterval: 15_000,
  })
  const deploys = data?.deploys ?? data ?? []
  // 这个 Pod 是否分配了显卡（type=gpu）。没卡的 Pod 容器里根本没有 CUDA 设备，
  // 所以「推理/训练」调度类型和「绑卡 GPU」对它都是空转 —— 后端也会把这类字段
  // 归一化掉（deploys.sanitize_gpu_fields），前端据此整块隐藏。
  const gpuCapable: boolean = data?.gpu_capable !== false
  const podGpus: number[] = Array.isArray(data?.gpus) ? data.gpus : []
  const gpuOptions = [
    { value: '', label: '自动分配' },
    ...podGpus.map((i) => ({ value: String(i), label: `GPU ${i}` })),
  ]
  const refresh = () => qc.invalidateQueries({ queryKey: ['deploys', podName] })

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
  const saveDeploy = useMutation({
    mutationFn: async () => {
      const editing = !!editingId
      const body: any = {
        mode: dMode,
        // 无卡 Pod 只可能是推理：训练类会被排到永远等不到的卡上，后端也会归一化。
        kind: gpuCapable ? dKind : 'serve',
        gpu: gpuCapable ? dGpu : '',
        vram: gpuCapable ? dVram.trim() : '',
        health: dHealth.trim(),
        health_timeout: dHealthTimeout.trim() || '60',
        auto_deploy: dAutoDeploy,
      }
      if (!editing) { body.name = dName.trim(); body.source = dSource }
      if (gpuCapable && dKind === 'train') {
        body.defer_ok = dDeferOk
        body.preempt_ok = dPreemptOk
        body.deadline = dDeadline.trim()
        body.deadline_kind = dDeadlineKind
        body.est_duration_s = dEstDur.trim()
      }
      if (isRepo) {
        body.repo = dRepo.trim()
        body.branch = dBranch.trim()
        body.subdir = dSubdir.trim()
        // 编辑时留空表示保持原 token（presence-driven：只在有值才发送）
        if (dToken.trim() || !editing) body.token = dToken.trim()
      } else if (!editing) {
        body.script = dScript.trim()
      }
      return requireOk(
        editing
          ? await api.put(`/pods/${podName}/deploys/${editingId}`, body)
          : await api.post(`/pods/${podName}/deploys`, body),
        editing ? '保存失败' : '创建失败',
      )
    },
    onSuccess: (res: any) => {
      toast({ type: 'success', message: editingId ? '部署已更新' : '部署创建成功' })
      if (res?.gpu_normalized) {
        toast({ type: 'warning', message: '该 Pod 未分配 GPU，已按 CPU 部署保存（忽略调度类型/绑卡/显存）', duration: 6000 })
      }
      setCreateOpen(false); setEditingId(null); resetForm(); refresh()
    },
    onError: (e: any) => toast({ type: 'error', message: e?.message || (editingId ? '保存失败' : '创建失败') }),
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

  // ── Contract edit (train only, P1-c) ──
  const [contractDep, setContractDep] = useState<any | null>(null)
  const [cDeferOk, setCDeferOk] = useState(false)
  const [cPreemptOk, setCPreemptOk] = useState(true)
  const [cDeadline, setCDeadline] = useState('')
  const [cDeadlineKind, setCDeadlineKind] = useState<'soft' | 'hard'>('soft')
  const [cEstDur, setCEstDur] = useState('')
  const openContract = (d: any) => {
    const c = d.contract ?? {}
    setCDeferOk(!!c.defer_ok); setCPreemptOk(!!c.preempt_ok)
    setCDeadline(''); setCDeadlineKind('soft'); setCEstDur('')
    setContractDep(d)
  }
  const saveContract = useMutation({
    mutationFn: async () => {
      const d = contractDep
      const body = {
        kind: 'train',
        defer_ok: cDeferOk,
        preempt_ok: cPreemptOk,
        deadline: cDeadline.trim(),
        deadline_kind: cDeadlineKind,
        est_duration_s: cEstDur.trim(),
      }
      return requireOk(await api.put(`/pods/${podName}/deploys/${d.id ?? d.name}`, body), '保存失败')
    },
    onSuccess: () => { toast({ type: 'success', message: '契约已更新' }); setContractDep(null); refresh() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '保存失败' }),
  })

  const isRepo = dSource === 'repo'
  const isTrain = gpuCapable && dKind === 'train'

  // Validation: name required for local, repo required for repo source.
  // 编辑时 name/source/script 不可改，因此只需 repo 仍有效。
  const canSubmit = editingId
    ? (isRepo ? dRepo.trim() : true)
    : (dSource === 'local' ? dName.trim() && dScript.trim() : dRepo.trim())

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2"><Rocket size={15} /> 部署</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <a href="/docs?lesson=deploy" className="text-accent hover:underline">部署教程</a>
            <a href="/docs?lesson=webhook" className="text-accent hover:underline">Webhook 说明</a>
          </div>
        </div>
        {canManage && <Button data-onboarding-target="deploy-create" size="sm" onClick={openCreate}><Plus size={14} /> 创建部署</Button>}
      </div>

      {/* ── Defer queue (P1-c, read-only) ── */}
      <DeferQueuePanel podName={podName} />

      {/* ── Quickstart templates ── */}
      {canManage && deploys.length === 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted">快速开始 — 选择模板一键部署：</p>
          <p className="text-xs text-muted/80">模板会立即创建并运行；自定义部署会先保存，之后用部署卡片的「启动」运行。</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
            {TEMPLATES.filter((tpl) => gpuCapable || tpl.id !== 'vllm').map((tpl) => (
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

      {/* ── Create / edit deploy dialog ── */}
      <Dialog open={createOpen} onClose={() => { setCreateOpen(false); setEditingId(null) }} title={editingId ? `编辑部署 — ${dName}` : '创建部署'} width="max-w-2xl">
        <div className="space-y-4">
          {/* Row 1: Source + Name */}
          {editingId ? (
            <div className="text-xs text-muted">名称与来源不可修改；如需更换请删除后重新创建。</div>
          ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select label="来源" value={dSource} onChange={(v) => setDSource(v as 'repo' | 'local')} options={[{ value: 'repo', label: '绑仓库' }, { value: 'local', label: '本地脚本' }]} />
            <div className="sm:col-span-2">
              <Input label={isRepo ? '名称 (留空取仓库名)' : '名称 (必填)'} value={dName} onChange={e => setDName(e.target.value)} placeholder="deploy-name" className="sm:col-span-2" />
              <div className="mt-1"><AiFormHelper type="deploy" partial={dName} onApply={setDName} /></div>
            </div>
          </div>
          )}

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

          <p className="text-xs text-muted">常驻服务会自动重启；一次性脚本可能在 supervisor 启动时执行一次。按任务选择模式。</p>

          {/* Row 4: Mode (+ 调度类型 / 绑卡 only when the Pod actually owns cards) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select label="类型" value={dMode} onChange={(v) => setDMode(v as 'service' | 'oneshot')} options={[{ value: 'service', label: '常驻服务' }, { value: 'oneshot', label: '一次性脚本' }]} />
            {gpuCapable && (
              <Select label="调度类型" value={dKind} onChange={(v) => setDKind(v as 'serve' | 'train')} options={[{ value: 'serve', label: '推理服务' }, { value: 'train', label: '训练(池化)' }]} />
            )}
            {gpuCapable && (isTrain ? (
              <div>
                <Input label="显存(MB)" value={dVram} onChange={e => setDVram(e.target.value)} placeholder="默认 12000" />
                <div className="mt-1"><AiFormHelper type="general" partial={dVram} context="显存限制 MB" onApply={setDVram} /></div>
              </div>
            ) : (
              <Select label="绑卡 GPU" value={dGpu} onChange={setDGpu} options={gpuOptions} />
            ))}
          </div>

          {!gpuCapable && (
            <p className="text-xs text-muted">
              该 Pod 未分配 GPU：容器内没有 CUDA 设备，因此不需要选择调度类型或绑卡，部署按常驻/一次性方式运行即可。
            </p>
          )}

          {/* Row 4b: Flexibility contract (train only, P1-c) */}
          {isTrain && (
            <div className="rounded-xl border-[0.5px] border-black/8 bg-black/[0.02] p-3 space-y-3">
              <div className="text-xs font-medium text-ink-2">弹性调度（训练专用）</div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <Switch checked={dDeferOk} onChange={setDDeferOk} />
                  谷期可延迟
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <Switch checked={dPreemptOk} onChange={setDPreemptOk} />
                  可被抢占
                </label>
                <span className="text-xs text-muted">谷期可延迟：暂无空卡时排队等谷期，而不是被清退。</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Select label="截止类型" value={dDeadlineKind} onChange={(v) => setDDeadlineKind(v as 'soft' | 'hard')} options={[{ value: 'soft', label: '软截止' }, { value: 'hard', label: '硬截止' }]} />
                <Input label="截止时间（可选）" value={dDeadline} onChange={e => setDDeadline(e.target.value)} placeholder="+2h 或 2026-11-08T09:00" />
                <Input label="预计时长 秒（可选）" value={dEstDur} onChange={e => setDEstDur(e.target.value)} placeholder="默认 3600" />
              </div>
            </div>
          )}

          {/* Row 5: Token (repo only) + Health check */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {isRepo && (
              <Input data-onboarding-target="deploy-token" label="私有库 token" type="password" value={dToken} onChange={e => setDToken(e.target.value)} placeholder={editingId ? '保持不变（留空不改）' : '公开库留空'} />
            )}
            <div>
              <Input label="健康检查路径（可选）" value={dHealth} onChange={e => setDHealth(e.target.value)} placeholder="/health 留空跳过" />
              <div className="mt-1"><AiFormHelper type="general" partial={dHealth} context="健康检查 URL 路径" onApply={setDHealth} /></div>
            </div>
            <div>
              <Input label="超时(秒)" value={dHealthTimeout} onChange={e => setDHealthTimeout(e.target.value)} placeholder="60" />
              <div className="mt-1"><AiFormHelper type="general" partial={dHealthTimeout} context="健康检查超时秒数" onApply={setDHealthTimeout} /></div>
            </div>
          </div>

          <p className="text-xs text-muted">健康检查留空即可跳过；填写后仅在检查失败等条件满足时参与条件回滚。</p>

          {/* Row 6: Auto-deploy (repo only) */}
          {isRepo && (
            <div className="flex items-center gap-2">
              <Switch checked={dAutoDeploy} onChange={setDAutoDeploy} />
              <span className="text-sm text-ink-2">push 自动部署</span>
              <span className="text-xs text-muted">需明确分支。开启后本部署会生成独立回调密钥，可在部署卡片查看/复制/轮换；推送须匹配本部署的仓库与非空分支。</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => { setCreateOpen(false); setEditingId(null) }}>取消</Button>
            <Button data-onboarding-target="deploy-submit" disabled={!canSubmit} loading={saveDeploy.isPending} onClick={() => saveDeploy.mutate()}>{editingId ? '保存' : '确认'}</Button>
          </div>
        </div>
      </Dialog>

      {/* ── Contract edit dialog (train only) ── */}
      <Dialog open={!!contractDep} onClose={() => setContractDep(null)} title={`弹性契约 — ${contractDep?.name ?? ''}`} width="max-w-xl">
        <div className="space-y-4">
          <p className="text-xs text-muted">契约决定该训练部署何时可被排到谷期（谷期可延迟），以及有压力时能否被清退（可被抢占）。改动保存后即刻生效，无需重新部署。</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Switch checked={cDeferOk} onChange={setCDeferOk} />
              谷期可延迟
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Switch checked={cPreemptOk} onChange={setCPreemptOk} />
              可被抢占
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select label="截止类型" value={cDeadlineKind} onChange={(v) => setCDeadlineKind(v as 'soft' | 'hard')} options={[{ value: 'soft', label: '软截止' }, { value: 'hard', label: '硬截止' }]} />
            <Input label="截止时间（可选）" value={cDeadline} onChange={e => setCDeadline(e.target.value)} placeholder="+2h 或 2026-11-08T09:00" />
            <Input label="预计时长 秒（可选）" value={cEstDur} onChange={e => setCEstDur(e.target.value)} placeholder="默认 3600" />
          </div>
          <p className="text-xs text-muted/80">留空的字段会清空对应设置。截止时间支持 +2h/+90m/+1d 或 ISO 时间。</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setContractDep(null)}>取消</Button>
            <Button loading={saveContract.isPending} onClick={() => saveContract.mutate()}>保存</Button>
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
              {gpuCapable && d.kind && d.kind !== 'serve' && <Badge variant="accent">{d.kind === 'train' ? '训练' : d.kind}</Badge>}
              {gpuCapable && d.kind === 'train' && d.contract?.defer_ok && <Badge variant="accent">谷期可延迟</Badge>}
              {gpuCapable && d.kind === 'train' && d.contract && d.contract.preempt_ok === false && <Badge variant="muted">不可抢占</Badge>}
              {gpuCapable && d.kind === 'train' && d.contract?.deadline && <Badge variant="muted">截止 {fmtDeadline(d.contract.deadline)}</Badge>}
              {d.source === 'local' && <Badge variant="muted">本地</Badge>}
              {d.auto_deploy && <Badge variant="accent">自动部署</Badge>}
              {running && <DeployStatusBadge podName={podName} deployId={id} />}
              <div className="flex-1" />
              {canManage && (
                <div data-ux="ux-deploy-touch" className="flex items-center gap-1.5">
                  {running ? (
                    <Button variant="secondary" size="sm" onClick={() => stop.mutate(d)}><Square size={13} /> 停止</Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => run.mutate(d)}><Play size={13} /> 启动</Button>
                  )}
                  {gpuCapable && d.kind === 'train' && (
                    <Button variant="ghost" size="sm" aria-label="弹性契约" title="弹性契约" onClick={() => openContract(d)}>
                      <SlidersHorizontal size={13} />
                    </Button>
                  )}
                  <Button
                    variant="ghost" size="sm"
                    aria-label="编辑部署"
                    title="编辑部署"
                    onClick={() => openEdit(d)}
                  >
                    <Pencil size={13} />
                  </Button>
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
            {canManage && d.auto_deploy && <DeployWebhookPanel podName={podName} deployId={id} />}
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
        <div className="mb-2 p-3 rounded-lg bg-accent/5 border border-accent/10">
          <div className="flex items-center gap-1 mb-1 text-xs font-semibold text-accent"><Sparkles size={12} /> AI 分析</div>
          <MarkdownContent content={aiExplain} />
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

/** Per-deploy webhook credentials: callback URL + this deploy's own secret
 * (with reveal/copy/rotate).  Only rendered for managers of auto-deploy deployments. */
function DeployWebhookPanel({ podName, deployId }: { podName: string; deployId: string }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [reveal, setReveal] = useState(false)
  const { data, isLoading } = useQuery<any>({
    queryKey: ['deploy-webhook', podName, deployId],
    queryFn: () => api.get(`/pods/${podName}/deploys/${deployId}/webhook`),
  })
  const rotate = useMutation({
    mutationFn: async () => requireOk(await api.post(`/pods/${podName}/deploys/${deployId}/webhook/rotate`), '轮换失败'),
    onSuccess: () => { toast({ type: 'success', message: '回调密钥已轮换' }); qc.invalidateQueries({ queryKey: ['deploy-webhook', podName, deployId] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '轮换失败' }),
  })
  const copy = (text: string, label: string) => {
    if (!text) return
    navigator.clipboard?.writeText(text).then(
      () => toast({ type: 'success', message: `${label}已复制` }),
      () => toast({ type: 'error', message: '复制失败，请手动选择' }),
    )
  }
  if (isLoading) return <div className="mt-2 text-xs text-muted">加载回调信息…</div>
  if (!data) return null
  const secret: string = data.secret || ''
  const masked = secret ? `${secret.slice(0, 4)}${'•'.repeat(Math.max(0, secret.length - 8))}${secret.slice(-4)}` : ''

  return (
    <div className="mt-3 rounded-xl border-[0.5px] border-black/8 bg-black/[0.02] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <KeyRound size={13} className="text-accent" />
        <span className="text-xs font-medium text-ink-2">推送自动部署回调</span>
        {data.source && <Badge variant="muted">{data.source === 'github' ? 'GitHub' : data.source === 'gitee' ? 'Gitee' : data.source}</Badge>}
      </div>
      <div className="text-xs text-muted">
        仓库 <span className="font-mono">{data.repo || '—'}</span>
        {data.branch ? <> · 分支 <span className="font-mono">{data.branch}</span></> : <> · 分支未设置（不会触发）</>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-16 flex-shrink-0">回调地址</span>
        <span className="flex-1 min-w-0 truncate font-mono text-xs text-ink-2">{data.url}</span>
        <Button variant="ghost" size="sm" className="min-h-9 min-w-9 sm:min-h-0 sm:min-w-0" aria-label="复制回调地址" title="复制" onClick={() => copy(data.url, '回调地址')}>
          <Copy size={13} />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-16 flex-shrink-0">回调密钥</span>
        <span className="flex-1 min-w-0 truncate font-mono text-xs text-ink-2">{secret ? (reveal ? secret : masked) : '未设置'}</span>
        {secret && (
          <>
            <Button variant="ghost" size="sm" className="min-h-9 min-w-9 sm:min-h-0 sm:min-w-0" aria-label={reveal ? '隐藏' : '显示'} title={reveal ? '隐藏' : '显示'} onClick={() => setReveal((v) => !v)}>
              <ScrollText size={13} />
            </Button>
            <Button variant="ghost" size="sm" className="min-h-9 min-w-9 sm:min-h-0 sm:min-w-0" aria-label="复制密钥" title="复制" onClick={() => copy(secret, '回调密钥')}>
              <Copy size={13} />
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" className="min-h-9 sm:min-h-0" loading={rotate.isPending} aria-label="轮换密钥" title="轮换密钥" onClick={() => { if (confirm('轮换后将立即失效旧密钥，仓库需同步更新。继续？')) rotate.mutate() }}>
          <RefreshCw size={13} />
        </Button>
      </div>
      <p className="text-[11px] text-muted/80">在仓库 Webhook 填该地址与密钥（GitHub 用 Secret，Gitee 用 Token）。仅当推送的仓库与非空分支匹配本部署时才会触发。</p>
    </div>
  )
}

function fmtDeadline(sec: number): string {
  try { return new Date(sec * 1000).toLocaleString() } catch { return String(sec) }
}

/** Read-only view of the P1-c defer queue for this pod's group.  Renders
 * nothing until the queue has been used, so an un-opted-in platform sees no
 * change. */
function DeferQueuePanel({ podName }: { podName: string }) {
  const [open, setOpen] = useState(false)
  const { data } = useQuery<any>({
    queryKey: ['defer-queue', podName],
    queryFn: () => api.get(`/pods/${podName}/defer-queue`),
    refetchInterval: 10_000,
  })
  const items: any[] = data?.items ?? []
  const counters = data?.counters ?? {}
  if (!items.length && !Object.keys(counters).length) return null
  return (
    <div className="rounded-xl border-[0.5px] border-black/8 bg-white/62 p-3">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <Hourglass size={14} className="text-accent" />
        <span className="text-sm font-medium">延迟队列</span>
        <Badge variant="muted">{items.length} 项</Badge>
        <div className="flex-1" />
        <span className="text-xs text-muted">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-muted">空闲显存：{data?.free_mib == null ? '不可用' : `${data.free_mib} MB`}</p>
          {items.length === 0 && <p className="text-xs text-muted">暂无排队/运行的训练部署。</p>}
          {items.map((it: any) => (
            <div key={it.deploy_id} className="flex items-center gap-2 text-xs">
              <Badge variant={it.state === 'running' ? 'ok' : 'accent'} dot>{it.state}</Badge>
              <span className="font-mono truncate">{it.name || it.deploy_id}</span>
              <div className="flex-1" />
              <span className="text-muted">{it.last_decision?.reason || ''}</span>
            </div>
          ))}
        </div>
      )}
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
