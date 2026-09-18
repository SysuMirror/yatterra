import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, X, Send, Loader2, StopCircle, Sparkles, MessageSquare, ImagePlus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { streamAi } from '@/api/ai'
import type { AiPageType, ToolCall, ToolResult } from '@/api/ai'
import { MarkdownContent, InlineReasoning, ToolCallsBlock } from '@/components/ai'
import type { ToolCallEntry } from '@/components/ai'
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

// ── Main component ─────────────────────────────────────────────

export interface PageAiAssistantHandle {
  send: (text: string) => void
}

export const PageAiAssistant = forwardRef<PageAiAssistantHandle, PageAiAssistantProps>(
  function PageAiAssistant({ page, context, className }, ref) {
  // hide the assistant entirely on pages the user has no permission for
  const aiAllowed = usePageAiAllowed(page)
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null)
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setPendingImages([])
    setLoading(true)

    const ctrl = new AbortController()
    setAbortCtrl(ctrl)

    // Build history from previous messages (exclude current user msg)
    const history = messages.map(m => ({ role: m.role, content: m.content }))

    let assistantContent = ''
    let assistantReasoning = ''
    let toolCalls: ToolCallEntry[] = []
    let assistantAdded = false

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

    try {
      for await (const ev of streamAi('/ai/page', {
        page,
        question: msg,
        context: context || '',
        history,
        images: imgs,
      }, ctrl.signal)) {
        if (ctrl.signal.aborted) break

        if (ev.type === 'reasoning') {
          assistantReasoning += ev.data as string
          updateAssistant({ reasoning: assistantReasoning })
        } else if (ev.type === 'content') {
          assistantContent += ev.data as string
          updateAssistant({ content: assistantContent, reasoning: assistantReasoning, toolCalls: [...toolCalls] })
          assistantAdded = true
        } else if (ev.type === 'tool_call') {
          const tc = ev.data as ToolCall
          const entry: ToolCallEntry = {
            id: tc.id,
            name: tc.name,
            args: tc.arguments,
            status: 'running',
          }
          toolCalls = [...toolCalls, entry]
          updateAssistant({ content: assistantContent, reasoning: assistantReasoning, toolCalls: [...toolCalls] })
          assistantAdded = true
        } else if (ev.type === 'tool_result') {
          const tr = ev.data as ToolResult
          toolCalls = toolCalls.map(tc =>
            tc.id === tr.tool_call_id
              ? { ...tc, result: tr.result, status: 'done' as const }
              : tc
          )
          updateAssistant({ content: assistantContent, reasoning: assistantReasoning, toolCalls: [...toolCalls] })
        }
      }

      // Finalize: if no content was added, add a placeholder
      if (!assistantAdded && !assistantContent && toolCalls.length === 0) {
        if (!assistantReasoning) {
          setMessages(prev => [...prev, { role: 'assistant', content: 'AI 已完成，无输出' }])
        } else {
          updateAssistant({ content: assistantContent || '(思考完成，无文字输出)', reasoning: assistantReasoning })
        }
      }
    } catch (e: any) {
      if (!ctrl.signal.aborted) {
        setMessages(prev => [...prev, { role: 'assistant', content: `错误: ${e.message || '未知'}` }])
      }
    } finally {
      setLoading(false)
      setAbortCtrl(null)
    }
  }

  const hints = PAGE_HINTS[page] || PAGE_HINTS.dashboard

  if (!aiAllowed) return null

  useImperativeHandle(ref, () => ({
    send(text: string) {
      setOpen(true)
      handleSend(text)
    }
  }))

  return (
    <>
      {/* Toggle button */}
      <button
        data-onboarding-target="page-assistant"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
          open
            ? 'bg-accent/10 text-accent'
            : 'text-muted hover:text-accent hover:bg-accent/5',
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
              className="absolute inset-0 bg-black/20"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
            />
            {/* Panel */}
            <motion.div
              className="absolute top-0 right-0 bottom-0 w-[400px] max-w-[92vw] flex flex-col bg-white border-l border-black/[0.06] shadow-2xl"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
            {/* Header */}
            <div className="flex items-center justify-between px-4 h-12 border-b border-black/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-accent" />
                <span className="text-sm font-semibold">AI 助手</span>
                <span className="text-[10px] text-muted bg-black/[0.04] px-1.5 py-0.5 rounded">{page}</span>
              </div>
              <div className="flex items-center gap-1">
                {loading && (
                  <button
                    onClick={handleStop}
                    className="w-7 h-7 rounded-full flex items-center justify-center text-muted hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="停止生成"
                  >
                    <StopCircle size={15} />
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-4 py-3 space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-6 space-y-3">
                  <MessageSquare size={28} className="text-muted/30 mx-auto" />
                  <p className="text-sm text-muted">问我关于这个页面的任何问题</p>
                  <p className="text-xs text-muted/60">支持工具调用 · 实时推理 · Markdown</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {(hints ?? []).map(hint => (
                      <button
                        key={hint}
                        onClick={() => handleSend(hint)}
                        className="px-2.5 py-1 rounded-full text-xs bg-black/[0.04] text-muted hover:bg-accent/10 hover:text-accent transition-colors"
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] ${
                    msg.role === 'user'
                      ? 'px-3 py-2 rounded-xl text-sm bg-accent text-white'
                      : 'w-full space-y-0'
                  }`}>
                    {msg.role === 'user' ? (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    ) : (
                      <div className="px-3 py-2 rounded-xl bg-black/[0.04]">
                        {msg.reasoning && <InlineReasoning text={msg.reasoning} loading={loading && i === messages.length - 1} />}
                        {msg.toolCalls && msg.toolCalls.length > 0 && <ToolCallsBlock calls={msg.toolCalls} />}
                        {msg.content ? (
                          <MarkdownContent content={msg.content} />
                        ) : (
                          loading && i === messages.length - 1 && !msg.toolCalls?.length && (
                            <div className="flex items-center gap-1.5 text-muted text-xs">
                              <Loader2 size={13} className="animate-spin" />
                              <span>思考中...</span>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 rounded-xl bg-black/[0.04] flex items-center gap-1.5 text-muted text-xs">
                    <Loader2 size={13} className="animate-spin" />
                    <span>思考中...</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="px-4 py-3 border-t border-black/[0.06]">
              {pendingImages.length > 0 && (
                <div className="flex gap-1.5 mb-2 flex-wrap">
                  {pendingImages.map((img, i) => (
                    <div key={i} className="relative w-12 h-12 rounded-lg overflow-hidden border border-black/10">
                      <img src={img} alt="" className="w-full h-full object-cover" />
                      <button
                        onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                        className="absolute top-0 right-0 w-4 h-4 bg-black/60 text-white rounded-bl-md flex items-center justify-center"
                      >
                        <X size={8} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form
                onSubmit={(e) => { e.preventDefault(); handleSend() }}
                className="flex items-center gap-2"
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="输入问题..."
                  className="flex-1 px-3 py-2.5 rounded-lg text-sm bg-black/[0.03] border-0 focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
                <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileChange} className="hidden" />
                <button
                  type="button"
                  onClick={handleImageSelect}
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-muted hover:text-accent hover:bg-accent/5 transition-colors"
                  title="添加图片"
                >
                  <ImagePlus size={16} />
                </button>
                <button
                  type="submit"
                  disabled={(!input.trim() && pendingImages.length === 0) || loading}
                  className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent text-white disabled:opacity-40 active:scale-95 transition-all duration-100"
                >
                  {loading ? <StopCircle size={16} onClick={handleStop} /> : <Send size={16} />}
                </button>
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
