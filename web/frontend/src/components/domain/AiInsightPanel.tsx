import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles, Loader2, ChevronDown, ChevronUp, RefreshCw, MessageSquare, Send, StopCircle, X } from 'lucide-react'
import { aiApi, streamAi } from '@/api/ai'
import type { ToolCall, ToolResult } from '@/api/ai'
import { MarkdownContent, InlineReasoning, ToolCallsBlock } from '@/components/ai'
import type { ToolCallEntry } from '@/components/ai'

interface Props {
  /** Page type for context routing */
  page?: string
  /** Data context string — the page's key data serialized as text */
  context: string
  /** Panel title (default: AI 洞察) */
  title?: string
  /** Custom prompt prefix to guide the summary focus */
  promptHint?: string
  /** Whether to auto-generate on mount (default: true) */
  auto?: boolean
  /** Debounce delay in ms (default: 800) — avoids re-generating on every keystroke */
  debounce?: number
  /** Collapsible — default open (default: true) */
  collapsible?: boolean
  /** Max height in px before scroll (default: 200) */
  maxHeight?: number
  className?: string
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallEntry[]
}

/**
 * Proactive AI insight/summary panel with pre-computed cache + inline chat.
 *
 * On mount, reads a pre-computed summary from Redis (via /api/ai/insight/<page>).
 * On cache miss, falls back to synchronous LLM generate. Users can continue
 * the conversation inline using the page's live context.
 */
export function AiInsightPanel({
  page,
  context,
  title = 'AI 洞察',
  promptHint,
  auto = true,
  debounce = 800,
  collapsible = true,
  maxHeight = 200,
  className,
}: Props) {
  const [summary, setSummary] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [insightTs, setInsightTs] = useState(0)
  const [hasRequested, setHasRequested] = useState(auto)
  const lastContextRef = useRef('')
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchedPageRef = useRef('')

  // ── Chat state ──
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatAtBottomRef = useRef(true)

  // ── Sync generate (fallback) ──
  const generate = useCallback(async (ctx: string) => {
    if (!ctx || ctx.length < 10) return
    setHasRequested(true)
    setLoading(true)
    setError('')
    setSummary('')
    try {
      const prompt = promptHint
        ? `${promptHint}\n\n数据:\n${ctx}`
        : `请根据以下平台数据生成简洁的运维洞察摘要，包括：关键状态、潜在风险、建议操作。控制在 3-5 行以内。\n\n数据:\n${ctx}`
      const res = await aiApi.analyze({ text: prompt, task: 'summarize' })
      setSummary(res.content)
      setInsightTs(Date.now() / 1000)
    } catch (e: any) {
      setError(e?.message || '生成失败')
    } finally {
      setLoading(false)
    }
  }, [promptHint])

  // ── On mount: try cached insight first ──
  useEffect(() => {
    if (!page || page === fetchedPageRef.current) return
    fetchedPageRef.current = page

    let cancelled = false
    ;(async () => {
      try {
        const data = await aiApi.getInsight(page)
        if (cancelled) return
        if (data.cached && data.content) {
          setSummary(data.content)
          setInsightTs(data.ts || 0)
        } else if (auto) {
          // Cache miss → fallback to sync generate (debounced)
          lastContextRef.current = context
          if (debounceTimer.current) clearTimeout(debounceTimer.current)
          debounceTimer.current = setTimeout(() => generate(context), debounce)
        }
      } catch {
        if (!cancelled && auto && context.length >= 10) {
          lastContextRef.current = context
          debounceTimer.current = setTimeout(() => generate(context), debounce)
        }
      }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // ── Refresh: force re-compute on backend ──
  const handleRefresh = async () => {
    if (!page) { lastContextRef.current = ''; generate(context); return }
    setLoading(true)
    setError('')
    try {
      const data = await aiApi.refreshInsight(page)
      if (data.cached && data.content) {
        setSummary(data.content)
        setInsightTs(data.ts || 0)
      } else {
        // backend gather failed → sync fallback
        lastContextRef.current = ''
        generate(context)
      }
    } catch {
      lastContextRef.current = ''
      generate(context)
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = () => { if (collapsible) setCollapsed(!collapsed) }

  // ── Chat send ──
  // Auto-scroll only the chat container (not the page), only if user is at bottom
  useEffect(() => {
    const el = chatScrollRef.current
    if (el && chatAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [chatMsgs])

  const handleChatStop = useCallback(() => {
    abortCtrl?.abort()
    setAbortCtrl(null)
    setChatLoading(false)
  }, [abortCtrl])

  const handleChatSend = async (text?: string) => {
    const msg = (text || chatInput).trim()
    if (!msg || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: msg }
    setChatMsgs(prev => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)
    chatAtBottomRef.current = true  // force follow on new message

    const ctrl = new AbortController()
    setAbortCtrl(ctrl)

    const history = chatMsgs.map(m => ({ role: m.role, content: m.content }))
    let assistantContent = ''
    let assistantReasoning = ''
    let toolCalls: ToolCallEntry[] = []

    const updateAssistant = (updates: Partial<ChatMsg>) => {
      setChatMsgs(prev => {
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

    try {
      for await (const ev of streamAi('/ai/page', {
        page,
        question: msg,
        context: context || '',
        history,
      }, ctrl.signal)) {
        if (ctrl.signal.aborted) break
        if (ev.type === 'reasoning') {
          assistantReasoning += ev.data as string
          updateAssistant({ reasoning: assistantReasoning })
        } else if (ev.type === 'content') {
          assistantContent += ev.data as string
          updateAssistant({ content: assistantContent, reasoning: assistantReasoning, toolCalls: [...toolCalls] })
        } else if (ev.type === 'tool_call') {
          const tc = ev.data as ToolCall
          toolCalls = [...toolCalls, { id: tc.id, name: tc.name, args: tc.arguments, status: 'running' }]
          updateAssistant({ content: assistantContent, reasoning: assistantReasoning, toolCalls: [...toolCalls] })
        } else if (ev.type === 'tool_result') {
          const tr = ev.data as ToolResult
          toolCalls = toolCalls.map(tc => tc.id === tr.tool_call_id ? { ...tc, result: tr.result, status: 'done' as const } : tc)
          updateAssistant({ content: assistantContent, reasoning: assistantReasoning, toolCalls: [...toolCalls] })
        }
      }
    } catch (e: any) {
      if (!ctrl.signal.aborted) {
        updateAssistant({ content: `请求失败: ${e?.message || e}` })
      }
    } finally {
      setChatLoading(false)
      setAbortCtrl(null)
    }
  }

  if (!context || context.length < 10) return null

  const tsLabel = insightTs ? `更新于 ${Math.round((Date.now() / 1000 - insightTs) / 60)} 分钟前` : ''

  return (
    <div className={`rounded-xl border border-accent/15 bg-accent/[0.03] overflow-hidden ${className ?? ''}`}>
      {/* Header */}
      <div
        className={`flex items-center gap-2 px-4 py-2.5 ${collapsible ? 'cursor-pointer hover:bg-accent/[0.05]' : ''} transition-colors`}
        onClick={handleToggle}
      >
        <Sparkles size={14} className="text-accent flex-shrink-0" />
        <span className="text-sm font-semibold text-accent flex-1">{title}</span>
        {tsLabel && !loading && (
          <span className="text-[10px] text-muted/50 font-mono">{tsLabel}</span>
        )}
        {page && (
          <span className="text-[10px] text-muted/60 font-mono uppercase tracking-wide">{page}</span>
        )}
        {loading && <Loader2 size={13} className="animate-spin text-accent/60" />}
        {!loading && !collapsed && summary && (
          <button
            onClick={(e) => { e.stopPropagation(); handleRefresh() }}
            className="p-1 rounded-md text-muted hover:text-accent hover:bg-accent/10 transition-colors"
            title="刷新"
          >
            <RefreshCw size={12} />
          </button>
        )}
        {collapsible && (
          collapsed
            ? <ChevronDown size={14} className="text-muted/60" />
            : <ChevronUp size={14} className="text-muted/60" />
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="px-4 pb-3">
          {loading && !summary && (
            <div className="flex items-center gap-2 py-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs text-muted">正在分析数据...</span>
            </div>
          )}
          {error && <p className="text-xs text-bad py-1">{error}</p>}
          {!summary && !loading && !hasRequested && (
            <button type="button" onClick={() => generate(context)} className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 px-2.5 py-1.5 text-xs text-accent">
              <Sparkles size={12} /> 分析当前数据
            </button>
          )}
          {summary && (
            <div
              className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed"
              style={{ maxHeight: `${maxHeight}px`, overflowY: maxHeight > 0 ? 'auto' : 'visible' }}
            >
              {summary.trim()}
            </div>
          )}

          {/* Inline chat toggle */}
          {summary && !loading && (
            <div className="mt-2 pt-2 border-t border-accent/10">
              {!chatOpen ? (
                <button
                  onClick={() => setChatOpen(true)}
                  className="flex items-center gap-1.5 text-xs text-accent/80 hover:text-accent transition-colors"
                >
                  <MessageSquare size={12} />
                  <span>追问 / 继续对话</span>
                </button>
              ) : (
                <div className="space-y-2">
                  {/* Chat messages — fixed height, internal scroll only */}
                  {chatMsgs.length > 0 && (
                    <div
                      ref={chatScrollRef}
                      onScroll={(e) => {
                        const el = e.currentTarget
                        chatAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
                      }}
                      className="space-y-2 max-h-60 overflow-y-auto"
                    >
                      {chatMsgs.map((m, i) => (
                        <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                          <div
                            className={
                              m.role === 'user'
                                ? 'rounded-lg bg-accent/15 px-2.5 py-1.5 text-sm max-w-[85%]'
                                : 'rounded-lg bg-muted/10 px-2.5 py-1.5 text-sm max-w-[85%] space-y-1'
                            }
                          >
                            {m.role === 'assistant' && m.reasoning && <InlineReasoning text={m.reasoning} />}
                            {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && <ToolCallsBlock calls={m.toolCalls} />}
                            {m.content && (m.role === 'user' ? m.content : <MarkdownContent content={m.content} />)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Chat input */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend() } }}
                      placeholder="基于当前数据追问..."
                      disabled={chatLoading}
                      className="flex-1 rounded-lg border border-accent/15 bg-bg px-2.5 py-1.5 text-sm focus:outline-none focus:border-accent/40 disabled:opacity-50"
                    />
                    {chatLoading ? (
                      <button
                        onClick={handleChatStop}
                        className="p-1.5 rounded-lg text-bad hover:bg-bad/10 transition-colors"
                        title="停止"
                      >
                        <StopCircle size={14} />
                      </button>
                    ) : (
                      <button
                        onClick={() => handleChatSend()}
                        disabled={!chatInput.trim()}
                        className="p-1.5 rounded-lg text-accent hover:bg-accent/10 transition-colors disabled:opacity-30"
                        title="发送"
                      >
                        <Send size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => { setChatOpen(false); setChatMsgs([]); handleChatStop() }}
                      className="p-1.5 rounded-lg text-muted hover:bg-muted/10 transition-colors"
                      title="关闭对话"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
