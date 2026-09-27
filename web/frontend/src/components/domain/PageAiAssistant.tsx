import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, X, Send, Loader2, StopCircle, Sparkles, ImagePlus, Plus, History, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { streamAi, aiApi } from '@/api/ai'
import type { AiPageType, ToolCall, ToolResult, PageSession } from '@/api/ai'
import { useAuthStore } from '@/stores/auth'
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

interface PageAiAssistantProps {
  page: AiPageType
  context?: string
  className?: string
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallEntry[]
  /** Arrival-ordered timeline of the stream (text / reasoning / tool runs). */
  segments?: Segment[]
}

const PAGE_HINTS: Record<string, string[]> = {
  dashboard: ['分析集群健康状态', '哪些资源需要关注？', '给出优化建议'],
  pod: ['分析 Pod 状态', '解释错误日志', '生成部署配置', '代码审查'],
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
}

const POP = { type: 'spring' as const, stiffness: 420, damping: 34 }

// ── Conversation persistence helpers ───────────────────────────
// One global conversation list per user, shared across all pages. The active
// conversation id is remembered per user so navigating between pages (which
// remounts this component) resumes the same conversation.
const sidKey = (user: string) => `yatterra.pageai.sid.${encodeURIComponent(user)}`
const readSid = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const saveSid = (key: string, id: string) => { try { localStorage.setItem(key, id) } catch { /* stays in memory */ } }

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

export interface PageAiAssistantHandle {
  send: (text: string) => void
}

export const PageAiAssistant = forwardRef<PageAiAssistantHandle, PageAiAssistantProps>(
  function PageAiAssistant({ page, context, className }, ref) {
    // hide the assistant entirely on pages the user has no permission for
    const aiAllowed = usePageAiAllowed(page)
    const user = useAuthStore(s => s.user)
    const [open, setOpen] = useState(false)
    const [messages, setMessages] = useState<ChatMsg[]>([])
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null)
    const [pendingImages, setPendingImages] = useState<string[]>([])
    // Persisted (MySQL) conversation for this user; '' until the first send.
    const [sessionId, setSessionId] = useState('')
    const [sessions, setSessions] = useState<PageSession[]>([])
    const [showHistory, setShowHistory] = useState(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const stickRef = useRef(true)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const onScroll = () => {
      const el = scrollRef.current
      if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56
    }

    // Follow the stream only while the reader is at the bottom, so scrolling
    // up to inspect a tool result is never yanked back down mid-generation.
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

    // Escape key to close panel
    useEffect(() => {
      if (!open) return
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
        }
      }
      document.addEventListener('keydown', handleKey)
      return () => document.removeEventListener('keydown', handleKey)
    }, [open])

    const handleStop = useCallback(() => {
      abortCtrl?.abort()
      setAbortCtrl(null)
      setLoading(false)
    }, [abortCtrl])

    const refreshSessions = useCallback(async () => {
      try { setSessions((await aiApi.pageSessions()).sessions || []) } catch { /* keep current */ }
    }, [])

    // Restore the last-used conversation for this user (per-user, global list)
    // so switching pages keeps the thread. Empty when the user has none yet.
    useEffect(() => {
      if (!user) return
      let cancelled = false
      ;(async () => {
        try {
          const list = (await aiApi.pageSessions()).sessions || []
          if (cancelled) return
          setSessions(list)
          const id = readSid(sidKey(user))
          const target = (id && list.some(s => s.id === id)) ? id : (list[0]?.id || '')
          if (!target) return
          const data = await aiApi.loadPageSession(target)
          if (cancelled) return
          setSessionId(target)
          saveSid(sidKey(user), target)
          setMessages((data.messages || []).map(m => ({ role: m.role, content: m.content })))
        } catch { /* no history — start fresh */ }
      })()
      return () => { cancelled = true }
    }, [user])

    const newConversation = useCallback(() => {
      if (loading) return
      setSessionId('')
      setMessages([])
      setShowHistory(false)
      if (user) { try { localStorage.removeItem(sidKey(user)) } catch { /* ignore */ } }
    }, [loading, user])

    const openConversation = useCallback(async (id: string) => {
      if (loading) return
      try {
        const data = await aiApi.loadPageSession(id)
        setSessionId(id)
        if (user) saveSid(sidKey(user), id)
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

    const handleImageSelect = useCallback(async () => {
      fileInputRef.current?.click()
    }, [])

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

    const handleSend = async (text?: string) => {
      const msg = (text || input).trim()
      if (!msg || loading) return
      const imgs = pendingImages.length > 0 ? pendingImages : undefined

      const userMsg: ChatMsg = { role: 'user', content: msg }
      stickRef.current = true
      setMessages(prev => [...prev, userMsg])
      setInput('')
      setPendingImages([])
      setLoading(true)

      const ctrl = new AbortController()
      setAbortCtrl(ctrl)

      // Ensure a persisted conversation exists, then let the server load its
      // history (per-user, untamperable) — the client no longer sends history.
      let sid = sessionId
      if (!sid) {
        try {
          sid = (await aiApi.newPageSession(page)).session_id
          setSessionId(sid)
          if (user) saveSid(sidKey(user), sid)
        } catch { sid = '' }
      }

      let segments: Segment[] = []

      const updateAssistant = (updates: Partial<ChatMsg>) => {
        setMessages(prev => {
          const updated = [...prev]
          const lastIdx = updated.length - 1
          const last = lastIdx >= 0 ? updated[lastIdx] : undefined
          if (last && last.role === 'assistant') {
            updated[lastIdx] = { ...last, ...updates, role: 'assistant' as const }
          } else {
            updated.push({ role: 'assistant', content: '', ...updates })
          }
          return updated
        })
      }

      const commit = () => {
        updateAssistant({
          content: segmentsText(segments),
          reasoning: segmentsReasoning(segments),
          toolCalls: segmentsTools(segments),
          segments,
        })
      }

      try {
        for await (const ev of streamAi('/ai/page', {
          page,
          question: msg,
          context: context || '',
          session_id: sid || undefined,
          images: imgs,
        }, ctrl.signal)) {
          if (ctrl.signal.aborted) break

          if (ev.type === 'reasoning') {
            segments = appendText(segments, 'reasoning', ev.data as string)
            commit()
          } else if (ev.type === 'content') {
            segments = appendText(segments, 'text', ev.data as string)
            commit()
          } else if (ev.type === 'tool_call') {
            const tc = ev.data as ToolCall
            segments = appendTool(segments, {
              id: tc.id,
              name: tc.name,
              args: tc.arguments,
              status: 'running',
            })
            commit()
          } else if (ev.type === 'tool_result') {
            const tr = ev.data as ToolResult
            segments = settleTool(segments, tr.tool_call_id, { result: tr.result, status: 'done' })
            commit()
          }
        }

        // Finalize: reasoning without any text or tool call still needs a body.
        if (!segmentsText(segments).trim() && segmentsTools(segments).length === 0) {
          if (!segmentsReasoning(segments)) {
            setMessages(prev => [...prev, { role: 'assistant', content: 'AI 已完成，无输出' }])
          } else {
            segments = appendText(segments, 'text', '(思考完成，无文字输出)')
            commit()
          }
        }
      } catch (e: any) {
        if (!ctrl.signal.aborted) {
          setMessages(prev => [...prev, { role: 'assistant', content: `错误: ${e.message || '未知'}` }])
        }
      } finally {
        setLoading(false)
        setAbortCtrl(null)
        if (sid) refreshSessions()
      }
    }

    // NOTE: must stay above the `if (!aiAllowed) return null` guard below.
    // A hook after a conditional return changes the hook count when `aiAllowed`
    // flips (perms hydrate/refresh), which makes React throw
    // "Rendered more hooks than during the previous render".
    useImperativeHandle(ref, () => ({
      send(text: string) {
        setOpen(true)
        handleSend(text)
      }
    }))

    const hints = PAGE_HINTS[page] || PAGE_HINTS.dashboard

    if (!aiAllowed) return null

    return (
      <>
        {/* Toggle button */}
        <button
          data-onboarding-target="page-assistant"
          onClick={() => setOpen(!open)}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all',
            open
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-black/[0.08] bg-surface-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-accent',
            className,
          )}
        >
          <Sparkles size={14} />
          <span className="hidden sm:inline">AI 助手</span>
        </button>

        {/* Slide-in panel + backdrop — portaled so `fixed` resolves against the
            viewport, not the page-transition wrapper (which has will-change:
            transform and would otherwise trap it inside the content box). */}
        <Portal>
        <AnimatePresence>
          {open && (
            <div data-onboarding-overlay className="fixed inset-0 z-[var(--z-modal)]">
              {/* Backdrop */}
              <motion.div
                className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setOpen(false)}
              />
              {/* Panel */}
              <motion.div
                className="absolute inset-y-0 right-0 flex w-[420px] max-w-[92vw] flex-col overflow-hidden border-l border-black/[0.08] bg-surface-1 text-ink shadow-3"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={POP}
              >
                {/* Hairline that keeps the panel edge readable on dark themes */}
                <div className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-accent/50 via-accent/10 to-transparent" />

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
                      <span className="text-sm font-semibold text-ink">AI 助手</span>
                      <span className="truncate text-[10px] text-muted">{page}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
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
                      onClick={() => setOpen(false)}
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
                <div
                  ref={scrollRef}
                  onScroll={onScroll}
                  className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain bg-canvas px-4 py-4"
                >
                  {messages.length === 0 && (
                    <div className="flex min-h-full flex-col items-center justify-center px-2 text-center">
                      <span className="relative mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-accent to-[#5e5ce6] text-white shadow-3">
                        <Sparkles size={24} />
                        <span className="absolute -inset-2 -z-10 rounded-3xl bg-accent/25 blur-xl" />
                      </span>
                      <p className="text-sm font-medium text-ink">问我关于这个页面的任何问题</p>
                      <p className="mt-1 text-xs text-muted">支持工具调用 · 实时推理 · Markdown</p>
                      <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                        {(hints ?? []).map(hint => (
                          <button
                            key={hint}
                            onClick={() => handleSend(hint)}
                            className="rounded-full border border-black/[0.08] bg-surface-1 px-3 py-1.5 text-xs text-muted transition-all hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
                          >
                            {hint}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {messages.map((msg, i) => {
                    const streaming = loading && i === messages.length - 1
                    if (msg.role === 'user') {
                      return (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={POP}
                          className="flex justify-end"
                        >
                          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-sm text-white shadow-2">
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

                  {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-[#5e5ce6] text-white shadow-1">
                        <Bot size={12} />
                      </span>
                      <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-md border border-black/[0.06] bg-surface-1 px-3 py-2.5 text-xs text-muted shadow-1">
                        <Loader2 size={13} className="animate-spin" />
                        <span>思考中…</span>
                      </div>
                    </div>
                  )}
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
                  <form onSubmit={(e) => { e.preventDefault(); handleSend() }} className="flex items-end gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-black/[0.08] bg-surface-2 px-3 py-2 transition-colors focus-within:border-accent/45 focus-within:ring-2 focus-within:ring-accent/15">
                      <input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="输入问题…"
                        className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                      />
                      <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileChange} className="hidden" />
                      <button
                        type="button"
                        onClick={handleImageSelect}
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
                        disabled={(!input.trim() && pendingImages.length === 0) || loading}
                        aria-label="发送"
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white transition-all duration-100 active:scale-95 disabled:opacity-40"
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
        </Portal>
      </>
    )
  }
)
