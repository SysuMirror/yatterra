/**
 * 全局唯一 AI 助手面板(挂在 routes/_layout.tsx, 替代旧 AgentWidget)。
 *
 * 统一后的行为:
 * - 默认后台执行: POST /ai/page/run 拿 run_id 立即返回, 关面板/刷新/换页
 *   任务都继续跑; 事件流走 GET /ai/page/stream?run_id&offset 断线续传(3 次重试);
 * - 挂载时查 /ai/page/runs?active=1 + localStorage 自动重接进行中的任务;
 * - run 结束后端无论成败都推送(kind=agent-done), url 带 ?ai=1 回跳自动开面板;
 * - 会话仍存 MySQL(/ai/page/session/*), 历史对话列表不变。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Bot, X, Send, Loader2, StopCircle, Sparkles, ImagePlus, Plus, History, Trash2, MousePointerClick, Navigation, Zap, Wrench, Bell } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { cn } from '@/lib/cn'
import { aiApi } from '@/api/ai'
import type { ToolCall, ToolResult, PageSession, PageRunInfo } from '@/api/ai'
import { useAuthStore } from '@/stores/auth'
import { useAiAssistantStore } from '@/stores/aiAssistant'
import type { AssistantMode } from '@/stores/aiAssistant'
import { useToastStore } from '@/stores/toast'
import { perform, resolveAction, type AssistantAction, type Control } from '@/lib/assistantControl'
import { availableRoutes } from '@/lib/appRoutes'
import { AssistantSpotlight } from '@/components/ui/AssistantSpotlight'
import {
  MarkdownContent,
  InlineReasoning,
  ToolCallsBlock,
  appendText,
  appendTool,
  settleTool,
  segmentsText,
  segmentsReasoning,
  segmentsTools,
  fallbackSegments,
} from '@/components/ai'
import type { Segment, ToolCallEntry } from '@/components/ai'
import { Portal } from '@/components/ui/Portal'
import { usePageAiAllowed } from '@/lib/pagePerms'

// ── Types ──────────────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallEntry[]
  /** Arrival-ordered timeline of the stream (text / reasoning / tool runs). */
  segments?: Segment[]
  /** 后台 run 的归属标记(重接/多任务时按 runId 更新对应消息) */
  runId?: string
}

const PAGE_HINTS: Record<string, string[]> = {
  dashboard: ['分析集群健康状态', '哪些资源需要关注？', '给出优化建议'],
  pod: ['这个 Pod 在干嘛', '登录逻辑在哪实现', '解释错误日志', '代码审查'],
  terminal: ['解释命令输出', '建议修复方案', '生成常用命令'],
  audit: ['分析安全事件', '发现异常模式', '生成安全报告'],
  llm: ['测试 prompt', '对比模型输出', '优化推理参数'],
  users: ['权限审计建议', '批量操作方案'],
  'threat-map': ['分析攻击模式', '建议防御策略', '评估风险等级'],
  storage: ['分析桶策略', '优化存储配置'],
  databases: ['分析连接配置', '优化查询建议'],
  proxy: ['检查代理冲突', '推荐端口分配', '分析反代配置'],
  shared: ['分析文件结构', '清理建议', '查找大文件'],
  profile: ['安全设置建议', '身份绑定检查'],
  mcp: ['推荐 MCP 服务', '分析连接问题', '生成配置'],
  harness: ['优化编排流程', '分析运行结果', '推荐工作流'],
  docs: ['解释 API 用法', '查找功能文档', '生成示例命令'],
  dev: ['Agent 状态分析', '编排运行检查', '推荐工作流'],
  infra: ['基础设施健康检查', '资源瓶颈分析', '容量规划建议'],
  ops: ['运维事件摘要', '安全风险评估', '异常检测'],
  gpu: ['GPU 利用率分析', '显存优化建议', '温度异常检查'],
  host: ['主机健康检查', '资源使用分析', '性能瓶颈诊断'],
  fleet: ['集群健康检查', '节点状态分析'],
}

const POP = { type: 'spring' as const, stiffness: 420, damping: 34 }

// ── Conversation persistence helpers ───────────────────────────
const sidKey = (user: string) => `yatterra.pageai.sid.${encodeURIComponent(user)}`
const runsKey = (user: string) => `yatterra.pageai.activeruns.${encodeURIComponent(user)}`
const readLS = (key: string): any => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
const saveLS = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* stays in memory */ } }

interface StoredRun { run_id: string; question: string; session_id?: string; route?: string; started: number; seen?: boolean }

/** 从会话消息里去掉与回放 run 重复的纯文本 assistant 回复(回放版含
 *  reasoning/工具, 信息更全)。用户的问题气泡保留——回放时不重建它。 */
function dedupeTurns(msgs: ChatMsg[], questions: Set<string>): ChatMsg[] {
  const out: ChatMsg[] = []
  let skipping = false
  for (const m of msgs) {
    if (m.role === 'user') skipping = questions.has(m.content)
    // 命中的问题本身保留, 只跳过它后面那条纯文本回复
    if (m.role === 'user' || !skipping) out.push(m)
  }
  return out
}

// ── 页面操作(browser_control)────────────────────────────────────
/** 后端 page_action 事件里的单个动作(与 browser_assistant 协议同构) */
interface PageAction { type: 'navigate' | 'click' | 'fill' | 'inspect'; target_id: string; value?: string; route?: string }
/** 待确认/已处理的动作批(受限模式渲染确认卡片) */
interface PendingActionBatch {
  runId: string
  actionId: string
  actions: PageAction[]
  /** undefined=待处理; 其余为处理结果行(含「已取消」) */
  outcome?: string[]
}

const modeKey = (user: string) => `yatterra.pageai.mode.${encodeURIComponent(user)}`

/** 把动作描述成一句话(卡片与执行日志共用) */
function describeAction(a: PageAction, label: string): string {
  const name = label || a.target_id || a.route || '?'
  if (a.type === 'navigate') return `打开页面 ${a.route || name}`
  if (a.type === 'fill') return `在「${name}」中填写：${a.value ?? ''}`
  if (a.type === 'inspect') return `高亮标记「${name}」`
  return `点击「${name}」`
}

// ── Assistant bubble ───────────────────────────────────────────

function AssistantBody({ msg, streaming }: { msg: ChatMsg; streaming: boolean }) {
  const segs = msg.segments?.length ? msg.segments : fallbackSegments(msg)
  const hasText = segs.some((s) => s.kind === 'text')
  const hasTools = segs.some((s) => s.kind === 'tools')
  return (
    <>
      {segs.map((seg, i) => {
        const isLast = i === segs.length - 1
        if (seg.kind === 'reasoning') {
          return <InlineReasoning key={i} text={seg.text} loading={streaming && isLast} />
        }
        if (seg.kind === 'tools') {
          return <ToolCallsBlock key={i} calls={seg.calls} />
        }
        return <MarkdownContent key={i} content={seg.text} />
      })}
      {streaming && !hasText && (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Loader2 size={13} className="animate-spin" />
          <span>{hasTools ? '执行工具中…' : '思考中…'}</span>
        </div>
      )}
    </>
  )
}

// ── Main component ─────────────────────────────────────────────

export function GlobalAiAssistant() {
  const user = useAuthStore(s => s.user)
  const loggedIn = useAuthStore(s => s.isLoggedIn)
  if (!loggedIn || !user) return null
  return <AssistantSession key={user} user={user} />
}

function AssistantSession({ user }: { user: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const open = useAiAssistantStore(s => s.open)
  const page = useAiAssistantStore(s => s.page)
  const context = useAiAssistantStore(s => s.context)
  const pendingSend = useAiAssistantStore(s => s.pendingSend)
  const openPanel = useAiAssistantStore(s => s.openPanel)
  const close = useAiAssistantStore(s => s.close)
  const consumePendingSend = useAiAssistantStore(s => s.consumePendingSend)
  const aiAllowed = usePageAiAllowed(page)

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [sessionId, setSessionId] = useState('')
  const [sessions, setSessions] = useState<PageSession[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [activeRunIds, setActiveRunIds] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 每个 run 一份: 流式段缓冲 + 停止控制器(后台执行, 卸载不中止)
  const runSegments = useRef(new Map<string, Segment[]>())
  const runCtrls = useRef(new Map<string, AbortController>())
  const attachRef = useRef<((runId: string, question: string, resume: boolean, finished?: boolean) => Promise<void>) | null>(null)
  const sendRef = useRef<(text?: string) => void>(() => {})

  // ── 页面操作模式(受限/完全) + 动作批状态 ──
  const mode = useAiAssistantStore(s => s.mode)
  const setMode = useAiAssistantStore(s => s.setMode)
  const toast = useToastStore(s => s.add)
  const modeRef = useRef<AssistantMode>(mode)
  const [pendingBatches, setPendingBatches] = useState<PendingActionBatch[]>([])
  const submittedActionIds = useRef(new Set<string>())
  const [highlight, setHighlight] = useState<Control | null>(null)
  const prefersReducedMotion = useReducedMotion() ?? false
  // ── AI 导航全屏切屏过渡 ──
  // cover: 幕布从下滑入盖住屏幕 → 换页 → reveal: 幕布向上滑出。
  // reduced-motion 下直接跳转, 不放幕布。
  const [navVeil, setNavVeil] = useState<{ id: number; label: string; phase: 'cover' | 'reveal' } | null>(null)
  const navSeq = useRef(0)
  const transitionTo = useCallback((route: string, label: string) => {
    if (prefersReducedMotion) {
      navigate(route)
      return Promise.resolve()
    }
    const id = ++navSeq.current
    setNavVeil({ id, label, phase: 'cover' })
    return new Promise<void>((resolve) => {
      window.setTimeout(() => {
        navigate(route)
        setNavVeil((v) => (v && v.id === id ? { ...v, phase: 'reveal' } : v))
        window.setTimeout(() => {
          setNavVeil((v) => (v && v.id === id ? null : v))
          resolve()
        }, 320)
      }, 240)
    })
  }, [navigate, prefersReducedMotion])

  // 模式持久化(per-user localStorage); modeRef 供事件流回调里读最新值
  useEffect(() => {
    const saved = readLS(modeKey(user))
    if (saved === 'yolo' || saved === 'restricted') setMode(saved)
  }, [user, setMode])
  useEffect(() => { modeRef.current = mode }, [mode])
  const switchMode = useCallback((next: AssistantMode) => {
    if (next === 'yolo' && mode !== 'yolo') {
      toast({ type: 'warning', message: '已切换到完全权限模式：AI 将直接执行页面操作，不再逐批确认', duration: 5000 })
    }
    setMode(next)
    saveLS(modeKey(user), next)
  }, [mode, setMode, toast, user])

  /** 顺序执行一批动作, 收集结果(target_id/ok/detail)与展示行。 */
  const executeBatch = useCallback(async (actions: PageAction[]) => {
    const results: { target_id: string; ok: boolean; detail: string }[] = []
    const lines: string[] = []
    for (const a of actions) {
      const asst: AssistantAction = { ...a, id: `${a.target_id}:${a.type}` }
      // 导航动作走全屏切屏过渡: 幕布盖住屏幕 → 换页 → 幕布滑出,
      // 避免内容在身后无声瞬移。其余动作照旧。
      if (a.type === 'navigate') {
        const c = resolveAction(asst)
        if (c && c.route) {
          await transitionTo(c.route, c.label)
          results.push({ target_id: a.target_id, ok: true, detail: `已打开 ${a.route}` })
          lines.push(`已打开 ${a.route}`)
          continue
        }
      }
      const control = a.type === 'inspect' ? resolveAction(asst) : perform(asst, (r) => navigate(r))
      const label = control?.label || a.target_id || a.route || ''
      if (a.type === 'inspect') {
        if (control) {
          setHighlight(control)
          results.push({ target_id: a.target_id, ok: true, detail: `已高亮: ${control.label}` })
          lines.push(`已标记: ${control.label}`)
        } else {
          results.push({ target_id: a.target_id, ok: false, detail: '目标在当前页面不存在' })
          lines.push(`失败: 目标 ${a.target_id} 不存在`)
        }
        continue
      }
      if (control) {
        const desc = a.type === 'navigate' ? `已打开 ${a.route}` : a.type === 'fill' ? `已填写 ${control.label}` : `已点击 ${control.label}`
        results.push({ target_id: a.target_id, ok: true, detail: desc })
        lines.push(desc)
      } else {
        results.push({ target_id: a.target_id, ok: false, detail: '目标不存在或不可操作(可能需要先 navigate 到正确页面)' })
        lines.push(`失败: ${describeAction(a, label)}`)
      }
    }
    return { results, lines }
  }, [navigate, transitionTo])

  /** 受限模式: 用户点「执行」/「取消」后回传结果并更新卡片。 */
  const resolveBatch = useCallback(async (batch: PendingActionBatch, cancelled: boolean) => {
    setPendingBatches(prev => prev.map(b => b.actionId === batch.actionId
      ? { ...b, outcome: cancelled ? ['已取消'] : undefined } : b))
    let lines: string[]
    let results: { target_id: string; ok: boolean; detail: string }[]
    if (cancelled) {
      results = batch.actions.map(a => ({ target_id: a.target_id, ok: false, detail: '用户取消' }))
      lines = ['已取消']
    } else {
      ;({ results, lines } = await executeBatch(batch.actions))
    }
    submittedActionIds.current.add(batch.actionId)
    setPendingBatches(prev => prev.map(b => b.actionId === batch.actionId ? { ...b, outcome: lines } : b))
    aiApi.submitPageActionResult(batch.runId, results, batch.actionId).catch(() => {})
  }, [executeBatch])

  const loading = activeRunIds.size > 0

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!open) return
    stickRef.current = true
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, close])

  const refreshSessions = useCallback(async () => {
    try { setSessions((await aiApi.pageSessions()).sessions || []) } catch { /* keep current */ }
  }, [])

  // 挂载时一次性恢复: 会话历史 + 本地记录的 run(进行中实时跟随,
  // 刚结束≤30min 且没看过的回放完整事件流——含 reasoning/工具调用,
  // 比 MySQL 里只存最终文字的轮次信息更全, 故先去掉会话里的重复轮次)。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // 1) 会话历史(与旧逻辑一致: 上次用的会话, 没有则最新一个)
      let sessionMsgs: ChatMsg[] = []
      try {
        const list = (await aiApi.pageSessions()).sessions || []
        if (cancelled) return
        setSessions(list)
        const id = readLS(sidKey(user))
        const target = (id && list.some(s => s.id === id)) ? id : (list[0]?.id || '')
        if (target) {
          const data = await aiApi.loadPageSession(target)
          if (cancelled) return
          setSessionId(target)
          saveLS(sidKey(user), target)
          sessionMsgs = (data.messages || []).map(m => ({ role: m.role, content: m.content }))
        }
      } catch { /* no history — start fresh */ }

      // 2) 本地记录的 run: 服务器已清(>24h)的丢弃
      let stored: StoredRun[] = []
      try { stored = readLS(runsKey(user)) || [] } catch { stored = [] }
      let all: PageRunInfo[] = []
      try { all = (await aiApi.pageRuns()).runs || [] } catch { /* 服务器不可达: 只靠本地 */ }
      if (cancelled) return
      const byId = new Map(all.map(r => [r.run_id, r]))
      const now = Date.now()
      const attachList: { s: StoredRun; finished: boolean }[] = []
      const keep: StoredRun[] = []
      for (const s of stored) {
        if (now - s.started > 24 * 3600 * 1000) continue
        const info = byId.get(s.run_id)
        if (info && info.status === 'running') {
          attachList.push({ s, finished: false })
          keep.push(s)
        } else if (info && !s.seen && now - (info.finished || 0) * 1000 < 30 * 60 * 1000) {
          attachList.push({ s, finished: true })
          keep.push({ ...s, seen: true })
        } else {
          keep.push(s)
        }
      }
      try { saveLS(runsKey(user), keep) } catch { /* ignore */ }

      // 3) 回放 run 会重建对应轮次(带工具), 去掉会话里的纯文本重复版
      const replayQs = new Set(attachList.map(a => a.s.question || ''))
      if (replayQs.size && sessionMsgs.length) sessionMsgs = dedupeTurns(sessionMsgs, replayQs)
      setMessages(sessionMsgs)

      // 4) 逐个接上(attachRun 内部各自独立缓冲/重试)
      for (const a of attachList) {
        attachRef.current?.(a.s.run_id, a.s.question || '(后台任务)', true, a.finished)
      }
    })()
    return () => { cancelled = true }
  }, [user])

  const newConversation = useCallback(() => {
    if (loading) return
    setSessionId('')
    setMessages([])
    setShowHistory(false)
    try { localStorage.removeItem(sidKey(user)) } catch { /* ignore */ }
  }, [loading, user])

  const openConversation = useCallback(async (id: string) => {
    if (loading) return
    try {
      const data = await aiApi.loadPageSession(id)
      setSessionId(id)
      saveLS(sidKey(user), id)
      setMessages((data.messages || []).map(m => ({ role: m.role, content: m.content })))
      setShowHistory(false)
    } catch { /* keep current view */ }
  }, [loading, user])

  const deleteConversation = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await aiApi.deletePageSession(id)
      if (id === sessionId) newConversation()
      refreshSessions()
    } catch { /* ignore */ }
  }, [sessionId, newConversation, refreshSessions])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(file)
      })
      setPendingImages(prev => [...prev, base64])
    }
    e.target.value = ''
  }

  const updateRunMsg = useCallback((runId: string, updates: Partial<ChatMsg>) => {
    setMessages(prev => prev.map(m => m.runId === runId ? { ...m, ...updates, role: 'assistant' as const } : m))
  }, [])

  /** 跟随一个后台 run 的事件流(offset 断线续传, 指数退避无限重试直到终止帧)。
   * finished=true 表示回放一个已结束的 run(纯看历史, 忽略 page_action)。 */
  const attachRun = useCallback(async (runId: string, question: string, resume: boolean, finished = false) => {
    runSegments.current.set(runId, [])
    // 已结束 run 的回放是纯历史, 不算 loading(否则每次刷新都闪"任务进行中")
    if (!finished) setActiveRunIds(prev => new Set(prev).add(runId))
    setMessages(prev => [
      ...prev,
      ...(resume ? [] : [{ role: 'user' as const, content: question }]),
      { role: 'assistant' as const, content: '', runId },
    ])
    const ctrl = new AbortController()
    runCtrls.current.set(runId, ctrl)

    const commit = () => {
      const segments = runSegments.current.get(runId) || []
      updateRunMsg(runId, {
        content: segmentsText(segments),
        reasoning: segmentsReasoning(segments),
        toolCalls: segmentsTools(segments),
        segments,
      })
    }
    const push = (kind: 'reasoning' | 'text', data: string) => {
      runSegments.current.set(runId, appendText(runSegments.current.get(runId) || [], kind, data))
      commit()
    }

    let offset = 0
    let terminal = false
    let attempt = 0        // 连续失败计数(收到任何帧即清零)
    let emptyConns = 0     // 连接成功但一个帧都没有的次数(防 run 被淘汰后死循环)
    try {
      while (!terminal && !ctrl.signal.aborted) {
        let frames = 0
        const connStart = Date.now()
        try {
          const resp = await fetch(
            `/api/ai/page/stream?run_id=${encodeURIComponent(runId)}&offset=${offset}`,
            { credentials: 'same-origin', signal: ctrl.signal })
          if (!resp.ok || !resp.body) throw new Error('Stream failed')
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          try {
            while (!terminal) {
              const chunk = await reader.read()
              buffer += decoder.decode(chunk.value, { stream: !chunk.done })
              const framesArr = buffer.replace(/\r\n/g, '\n').split('\n\n')
              buffer = framesArr.pop() || ''
              if (chunk.done && buffer.trim()) { framesArr.push(buffer); buffer = '' }
              for (const frame of framesArr) {
                const lines = frame.split('\n')
                const idLine = lines.find(l => l.startsWith('id:'))
                const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
                if (!data) continue
                const id = idLine ? Number(idLine.slice(3)) : offset
                if (!Number.isInteger(id) || id < offset) continue
                let ev: any
                try { ev = JSON.parse(data) } catch { continue }
                frames++
                if (ev.type === 'reasoning') push('reasoning', String(ev.data ?? ''))
                else if (ev.type === 'content') push('text', String(ev.data ?? ''))
                else if (ev.type === 'tool_call') {
                  const tc = ev.data as ToolCall
                  runSegments.current.set(runId, appendTool(runSegments.current.get(runId) || [], {
                    id: tc.id, name: tc.name, args: tc.arguments, status: 'running',
                  }))
                  commit()
                } else if (ev.type === 'tool_result') {
                  const tr = ev.data as ToolResult
                  runSegments.current.set(runId, settleTool(runSegments.current.get(runId) || [], tr.tool_call_id, { result: tr.result, status: 'done' }))
                  commit()
                } else if (ev.type === 'page_action') {
                  // browser_control 工具发来的动作批: 受限模式渲染确认卡片,
                  // 完全模式直接自动执行; 事件重放(断线重连)靠 action_id 去重。
                  // 已结束 run 的回放不再触发(工具侧早已超时)。
                  const pd = ev.data as { action_id?: string; actions?: PageAction[] }
                  const actionId = String(pd?.action_id || '')
                  const actions = Array.isArray(pd?.actions) ? pd.actions : []
                  if (!finished && actionId && !submittedActionIds.current.has(actionId)) {
                    if (modeRef.current === 'yolo') {
                      submittedActionIds.current.add(actionId)
                      void (async () => {
                        const { results, lines } = await executeBatch(actions)
                        push('text', '\n\n' + lines.join('\n'))
                        aiApi.submitPageActionResult(runId, results, actionId).catch(() => {})
                      })()
                    } else {
                      setPendingBatches(prev => prev.some(b => b.actionId === actionId)
                        ? prev : [...prev, { runId, actionId, actions }])
                    }
                  }
                } else if (ev.type === 'done') {
                  if (ev.cancelled) push('text', '\n\n[已停止]')
                  terminal = true
                } else if (ev.type === 'error') {
                  push('text', `\n\n${typeof ev.data === 'string' ? ev.data : '任务失败'}`)
                  terminal = true
                }
                offset = id + 1
              }
              if (chunk.done) break
            }
          } finally { await reader.cancel().catch(() => {}) }
        } catch { /* 网络闪断: 落到下面退避重试 */ }
        if (terminal || ctrl.signal.aborted) break
        if (frames > 0) {
          attempt = 0; emptyConns = 0
          // 连接过快结束(代理掐断等): 稍等再续, 防紧循环
          if (Date.now() - connStart < 1000) await new Promise(r => setTimeout(r, 500))
          continue
        }
        // 本次连接一帧未得: run 可能已不在服务端, 连续多次后放弃
        emptyConns++
        attempt++
        if (emptyConns >= 5) {
          push('text', '\n\n[连接中断，任务仍在后台执行；刷新页面可重连，完成后会推送通知]')
          break
        }
        await new Promise(r => setTimeout(r, Math.min(15000, 500 * 2 ** attempt)))
      }
      // Finalize: 没有文字也没有工具调用时补一条占位
      const segments = runSegments.current.get(runId) || []
      if (!segmentsText(segments).trim() && segmentsTools(segments).length === 0) {
        if (!segmentsReasoning(segments)) {
          updateRunMsg(runId, { content: 'AI 已完成，无输出', segments: undefined })
        } else {
          push('text', '(思考完成，无文字输出)')
        }
      }
    } finally {
      runCtrls.current.delete(runId)
      runSegments.current.delete(runId)
      setActiveRunIds(prev => { const n = new Set(prev); n.delete(runId); return n })
      // run 已结束: 还没处理的确认卡片标过期(工具侧早已超时/收不到结果)
      setPendingBatches(prev => prev.map(b =>
        b.runId === runId && !b.outcome ? { ...b, outcome: ['(任务已结束，本批未执行)'] } : b))
      // 本地记录标 seen(下次刷新不再回放), 24h 后清理; 不再直接删——
      // 刚结束的 run 靠它在新会话里回放出带工具调用的完整历史。
      // 只有正常收到终止帧才标 seen: 卸载/登出导致的中断不标,
      // 重新进入时还能回放/重接。
      try {
        const stored: StoredRun[] = readLS(runsKey(user)) || []
        const now = Date.now()
        saveLS(runsKey(user), stored
          .map(s => s.run_id === runId && terminal ? { ...s, seen: true } : s)
          .filter(s => now - s.started < 24 * 3600 * 1000))
      } catch { /* ignore */ }
      refreshSessions()
    }
  }, [refreshSessions, updateRunMsg, user, executeBatch])
  attachRef.current = attachRun

  /** 发送: 起后台 run → 存 localStorage → 跟随事件流。 */
  const handleSend = async (text?: string) => {
    const msg = (text || input).trim()
    if (!msg || loading) return
    const imgs = pendingImages.length > 0 ? pendingImages : undefined
    stickRef.current = true
    setInput('')
    setPendingImages([])

    // Ensure a persisted conversation exists, then let the server load its
    // history (per-user, untamperable) — the client no longer sends history.
    let sid = sessionId
    if (!sid) {
      try {
        sid = (await aiApi.newPageSession(page)).session_id
        setSessionId(sid)
        saveLS(sidKey(user), sid)
      } catch { sid = '' }
    }

    let runId = ''
    try {
      const res = await aiApi.startPageRun({
        page: page as any,
        question: msg,
        // 附上按权限过滤的站内路由清单, 模型据此发 route:<路径> 导航动作
        // (不依赖当前页渲染了哪些控件, 手机上侧栏关闭时也能导航)。
        context: (context ? context + '\n' : '') + '[可导航路由] ' + JSON.stringify(availableRoutes().map(r => ({ path: r.path, label: r.label }))),
        session_id: sid || undefined,
        images: imgs,
        route: location.pathname,
      })
      runId = res.run_id
      try {
        const stored: StoredRun[] = readLS(runsKey(user)) || []
        stored.push({ run_id: runId, question: msg, session_id: sid || undefined, route: location.pathname, started: Date.now() })
        saveLS(runsKey(user), stored)
      } catch { /* ignore */ }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'user', content: msg }, { role: 'assistant', content: `任务启动失败: ${e?.message || '未知'}` }])
      return
    }
    await attachRun(runId, msg, false)
  }
  sendRef.current = handleSend

  // 刷新/换页后重接已并入上面的挂载恢复 effect(进行中 + 刚结束回放)。

  // 通知回跳: url 带 ?ai=1 时自动打开面板(并清掉参数)
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('ai') !== '1') return
    params.delete('ai')
    const qs = params.toString()
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true })
    openPanel()
  }, [location.search, location.pathname, navigate, openPanel])

  // 旧入口的预设问题(PageAiAssistantHandle.send / 按钮带问)
  useEffect(() => {
    if (!open || !pendingSend) return
    consumePendingSend()
    sendRef.current(pendingSend.text)
  }, [open, pendingSend, consumePendingSend])

  const handleStop = useCallback(() => {
    for (const [rid, ctrl] of runCtrls.current) {
      ctrl.abort()
      aiApi.stopPageRun(rid).catch(() => {})
    }
  }, [])

  // 卸载(登出/切用户)时停掉所有事件流跟随; 后台 run 本身不受影响,
  // 重新登录后挂载恢复 effect 会凭 localStorage + 服务端列表重接。
  useEffect(() => () => {
    for (const ctrl of runCtrls.current.values()) ctrl.abort()
  }, [])

  const hints = PAGE_HINTS[page] || PAGE_HINTS[page?.split(':')[0] as string] || PAGE_HINTS.dashboard

  return (
    <>
      {/* 全局悬浮球(原 AgentWidget 样式) */}
      {!open && aiAllowed && (
        <button
          type="button"
          data-onboarding-target="assistant"
          aria-label="打开 AI 助手"
          onClick={() => { openPanel() }}
          className="fixed right-4 bottom-[calc(var(--mobile-tabbar-h,0px)+.75rem)] z-[var(--z-fab)] flex h-12 w-12 items-center justify-center rounded-full bg-accent/85 glass-blur text-white shadow-lg md:bottom-6"
        >
          <Bot size={22} />
          {loading && (
            <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-pulse rounded-full bg-ok ring-2 ring-surface-1" />
          )}
        </button>
      )}

      {/* Slide-in panel + backdrop — portaled so `fixed` resolves against the
          viewport, not the page-transition wrapper. */}
      <Portal>
        <AnimatePresence>
          {open && (
            <div data-onboarding-overlay className="fixed inset-0 z-[var(--z-modal)]">
              <motion.div
                className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => close()}
              />
              <motion.div
                className="absolute inset-y-0 right-0 flex w-[420px] max-w-[92vw] flex-col overflow-hidden border-l border-black/[0.08] bg-surface-1 text-ink shadow-3"
                // PWA 全屏模式下状态栏/刘海会盖住顶到屏幕上沿的面板头部,
                // 与 TopBar 一致用安全区内边距把内容推下来(背景仍铺满全高)。
                style={{ paddingTop: 'var(--sat)', paddingBottom: 'var(--sab)' }}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={POP}
              >
                <div className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-accent/50 via-accent/10 to-transparent" />
                {/* 顶部氛围光晕: accent 光斑 + 细网格渐隐, 给纯色面板加层次 */}
                <div className="pointer-events-none absolute -top-20 right-0 h-56 w-72 rounded-full bg-accent/[0.07] blur-3xl" />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-accent/[0.04] to-transparent" />

                {/* Header */}
                <header className="relative flex h-14 shrink-0 items-center justify-between gap-2 border-b border-black/[0.06] bg-surface-1 px-4">
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent" />
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-[#5e5ce6] text-white shadow-1">
                      <Bot size={15} />
                      {loading && (
                        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-ok ring-2 ring-surface-1" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                        AI 助手
                        {mode === 'yolo' && (
                          <span className="rounded-full bg-orange-500/15 px-1.5 py-px text-[9px] font-bold tracking-wide text-orange-600">
                            YOLO
                          </span>
                        )}
                      </span>
                      <span className="truncate text-[10px] text-muted">
                        {loading ? `任务进行中 · ${page}` : page}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {/* 页面操作模式开关: 受限(逐批确认) / 完全(YOLO 直接执行) */}
                    <div className="mr-1 flex items-center rounded-full border border-black/[0.08] bg-surface-2 p-0.5 text-[10px] leading-none">
                      <button
                        type="button"
                        onClick={() => switchMode('restricted')}
                        title="受限模式：AI 提议页面操作，需逐批确认后执行"
                        className={cn(
                          'rounded-full px-2 py-1 transition-colors',
                          mode === 'restricted' ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:text-ink',
                        )}
                      >
                        受限
                      </button>
                      <button
                        type="button"
                        onClick={() => switchMode('yolo')}
                        title="完全权限模式：AI 的页面操作直接自动执行"
                        className={cn(
                          'rounded-full px-2 py-1 transition-colors',
                          mode === 'yolo' ? 'bg-orange-500/15 font-medium text-orange-600' : 'text-muted hover:text-ink',
                        )}
                      >
                        完全
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={newConversation}
                      title="新对话"
                      aria-label="新对话"
                      className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-black/[0.05] hover:text-ink"
                    >
                      <Plus size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowHistory(v => !v); if (!showHistory) refreshSessions() }}
                      title="历史对话"
                      aria-label="历史对话"
                      className={cn(
                        'grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-black/[0.05]',
                        showHistory ? 'text-accent' : 'text-muted hover:text-ink',
                      )}
                    >
                      <History size={16} />
                    </button>
                    {loading && (
                      <button
                        type="button"
                        onClick={handleStop}
                        title="停止生成"
                        className="grid h-8 w-8 place-items-center rounded-full bg-bad/10 text-bad transition-colors hover:bg-bad/20"
                      >
                        <StopCircle size={15} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => close()}
                      aria-label="关闭助手"
                      className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-black/[0.05] hover:text-ink"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </header>

                {/* History drawer — per-user global conversation list */}
                <AnimatePresence>
                  {showHistory && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="shrink-0 overflow-hidden border-b border-black/[0.06] bg-surface-2"
                    >
                      <div className="max-h-56 overflow-y-auto px-2 py-2">
                        {sessions.length === 0 && (
                          <p className="px-2 py-3 text-center text-xs text-muted">暂无历史对话</p>
                        )}
                        {sessions.map(s => (
                          <div
                            key={s.id}
                            onClick={() => openConversation(s.id)}
                            className={cn(
                              'group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors',
                              s.id === sessionId ? 'bg-accent/10 text-accent' : 'text-ink hover:bg-black/[0.04]',
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{s.title || '新对话'}</span>
                            <span className="shrink-0 text-[10px] text-muted">{s.n} 条</span>
                            <button
                              type="button"
                              onClick={(e) => deleteConversation(s.id, e)}
                              aria-label="删除对话"
                              className="shrink-0 text-muted opacity-0 transition-opacity hover:text-bad group-hover:opacity-100"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Messages */}
                <div className="relative min-h-0 flex-1">
                  <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className="h-full space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain bg-canvas px-4 py-4"
                  >
                  {messages.length === 0 && (
                    <div className="flex min-h-full flex-col items-center justify-center px-2 text-center">
                      <span className="relative mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-accent to-[#5e5ce6] text-white shadow-3">
                        <Sparkles size={24} />
                        <span className="absolute -inset-2 -z-10 rounded-3xl bg-accent/25 blur-xl" />
                      </span>
                      <p className="text-sm font-medium text-ink">问我关于这个页面的任何问题</p>
                      <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
                        {[
                          { icon: Zap, label: '后台执行' },
                          { icon: Wrench, label: '工具调用' },
                          { icon: Navigation, label: '页面操作' },
                          { icon: Bell, label: '完成推送' },
                        ].map(({ icon: Icon, label }) => (
                          <span
                            key={label}
                            className="flex items-center gap-1 rounded-full border border-black/[0.06] bg-surface-2/80 px-2.5 py-1 text-[10px] text-muted"
                          >
                            <Icon size={11} className="text-accent/80" />
                            {label}
                          </span>
                        ))}
                      </div>
                      <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                        {(hints ?? []).map((hint: string) => (
                          <button
                            key={hint}
                            onClick={() => sendRef.current(hint)}
                            className="rounded-full border border-black/[0.08] bg-[var(--glass-bg-weak)] glass-blur px-3 py-1.5 text-xs text-muted transition-all duration-150 hover:-translate-y-0.5 hover:border-accent/40 hover:bg-accent/5 hover:text-accent active:translate-y-0 active:scale-95"
                          >
                            {hint}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {messages.map((msg, i) => {
                    const streaming = !!msg.runId && activeRunIds.has(msg.runId)
                    if (msg.role === 'user') {
                      return (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={POP}
                          className="flex justify-end"
                        >
                          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-accent to-[#5e5ce6] px-3.5 py-2.5 text-sm text-white shadow-2">
                            {msg.content}
                          </div>
                        </motion.div>
                      )
                    }
                    return (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={POP}
                        className="flex items-start gap-2"
                      >
                        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-[#5e5ce6] text-white shadow-1">
                          <Bot size={12} />
                        </span>
                        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-black/[0.06] bg-surface-1 px-3 py-2.5 shadow-1">
                          <AssistantBody msg={msg} streaming={streaming} />
                        </div>
                      </motion.div>
                    )
                  })}

                  {/* 受限模式: browser_control 动作批确认卡片(事件重放天然支持) */}
                  {pendingBatches.map(b => (
                    <motion.div
                      key={b.actionId}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={POP}
                      className="rounded-2xl border border-accent/30 bg-accent/[0.04] px-3 py-2.5 text-sm shadow-1"
                    >
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-accent">
                        <span className="grid h-5 w-5 place-items-center rounded-full bg-accent/12">
                          <MousePointerClick size={12} />
                        </span>
                        AI 提议了页面操作
                      </div>
                      <ul className="space-y-1 text-xs text-ink">
                        {b.actions.map((a, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                            <span>{describeAction(a, resolveAction({ ...a, id: a.target_id })?.label || '')}</span>
                          </li>
                        ))}
                      </ul>
                      {b.outcome ? (
                        <p className="mt-2 text-xs text-muted">{b.outcome.join('；')}</p>
                      ) : (
                        <div className="mt-2.5 flex gap-2">
                          <button
                            type="button"
                            onClick={() => resolveBatch(b, false)}
                            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
                          >
                            执行
                          </button>
                          <button
                            type="button"
                            onClick={() => resolveBatch(b, true)}
                            className="rounded-lg px-3 py-1.5 text-xs text-muted transition-colors hover:bg-black/[0.05] hover:text-ink"
                          >
                            取消
                          </button>
                        </div>
                      )}
                    </motion.div>
                  ))}
                  </div>
                  {/* 顶部渐隐: 消息滚出时淡出而非硬切(与 canvas 同色) */}
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-canvas to-transparent" />
                </div>

                {/* Input */}
                <div className="shrink-0 border-t border-black/[0.06] px-4 py-3">
                  {pendingImages.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {pendingImages.map((img, i) => (
                        <div key={i} className="relative h-12 w-12 overflow-hidden rounded-lg border border-black/10">
                          <img src={img} alt="" className="h-full w-full object-cover" />
                          <button
                            type="button"
                            onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                            className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl-md bg-black/60 text-white"
                            aria-label="移除图片"
                          >
                            <X size={8} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <form onSubmit={(e) => { e.preventDefault(); sendRef.current() }} className="flex items-end gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-black/[0.08] bg-surface-2 px-3 py-2 transition-colors focus-within:border-accent/45 focus-within:ring-2 focus-within:ring-accent/15">
                      <input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={aiAllowed ? '输入问题…' : '当前页面无 AI 助手权限'}
                        disabled={!aiAllowed}
                        className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none disabled:opacity-50"
                      />
                      <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileChange} className="hidden" />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="shrink-0 text-muted transition-colors hover:text-accent"
                        title="添加图片"
                      >
                        <ImagePlus size={16} />
                      </button>
                    </div>
                    {loading ? (
                      <button
                        type="button"
                        onClick={handleStop}
                        aria-label="停止生成"
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-bad/10 text-bad transition-all hover:bg-bad/20 active:scale-95"
                      >
                        <StopCircle size={17} />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={(!input.trim() && pendingImages.length === 0) || loading || !aiAllowed}
                        aria-label="发送"
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent to-[#5e5ce6] text-white shadow-1 transition-all duration-100 active:scale-95 disabled:opacity-40 disabled:shadow-none"
                      >
                        <Send size={17} />
                      </button>
                    )}
                  </form>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
        {/* inspect 动作的目标高亮(自 portal 到 body, 30s 自动关闭) */}
        {highlight && <AssistantSpotlight element={highlight.element} label={highlight.label} close={() => setHighlight(null)} />}

        {/* AI 导航全屏切屏过渡: 幕布从下滑入盖住屏幕, 换页后向上滑出。
            transform/opacity 走 GPU; reduced-motion 下不放幕布(transitionTo 直接跳转)。 */}
        <AnimatePresence>
          {navVeil && (
            <motion.div
              key={navVeil.id}
              role="status"
              aria-label={`AI 正在前往 ${navVeil.label}`}
              className="pointer-events-none fixed inset-0 z-[calc(var(--z-modal)+1)] flex items-center justify-center bg-canvas"
              initial={{ transform: 'translateY(100%)' }}
              animate={{ transform: navVeil.phase === 'cover' ? 'translateY(0%)' : 'translateY(-100%)' }}
              transition={
                navVeil.phase === 'cover'
                  ? { duration: 0.24, ease: [0.77, 0, 0.175, 1] }
                  : { duration: 0.32, ease: [0.23, 1, 0.32, 1] }
              }
            >
              <motion.div
                className="flex items-center gap-3 text-base font-medium text-ink"
                initial={{ opacity: 0, transform: 'translateY(8px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1], delay: 0.08 }}
              >
                <Navigation size={18} className="text-accent" />
                <span>正在前往「{navVeil.label}」</span>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  )
}
