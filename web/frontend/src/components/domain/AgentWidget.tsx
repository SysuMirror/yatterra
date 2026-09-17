import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, X, Send, Loader2, StopCircle, ImagePlus, ChevronDown, ChevronRight, Plus, Trash2, Brain } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'
import { api } from '@/api/client'
import { streamAi, fileToBase64 } from '@/api/ai'
import { MarkdownContent, InlineReasoning, ToolCallsBlock } from '@/components/ai'
import type { ToolCallEntry } from '@/components/ai'
import { DocHint } from '@/components/domain/DocHint'

interface Message {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  images?: string[]  // base64 images
  toolCalls?: ToolCallEntry[]
  compact?: { before: number; after: number }
}

interface Session {
  id: string
  title: string
  updated: number
  preview: string
  n: number
}

const AGENT_MODES = [
  { id: 'ops', label: '运维助手', icon: '🛠️', runner: 'host' },
  { id: 'build', label: '编程助手', icon: '💻', runner: 'pod' },
  { id: 'db', label: '数据库助手', icon: '🗃️', runner: 'host' },
  { id: 'storage', label: '存储助手', icon: '📦', runner: 'host' },
  { id: 'net', label: '网络助手', icon: '🔌', runner: 'host' },
  { id: 'gpu', label: 'GPU助手', icon: '🎮', runner: 'host' },
  { id: 'web', label: 'Web助手', icon: '🌐', runner: 'pod' },
  { id: 'train', label: '训练助手', icon: '🧠', runner: 'pod' },
]

interface PodOption {
  name: string
  status: string
  role: string
}

/** Floating Agent assistant widget — FAB in bottom-right. */
export function AgentWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState('ops')
  const [pods, setPods] = useState<PodOption[]>([])
  const [podName, setPodName] = useState('')
  const [showModes, setShowModes] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isDesktop = useIsDesktop()
  const auth = useAuthStore()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load sessions when panel opens
  useEffect(() => {
    if (open) {
      api.get('/agents/sessions').then((d: any) => setSessions(d.sessions ?? d)).catch(() => {})
    }
  }, [open])

  // Pod-runner modes (build/web/train) execute inside a group container, so
  // they need a target pod. Load the caller's accessible pods and default to
  // the first running one.
  const modeRunner = AGENT_MODES.find(m => m.id === mode)?.runner ?? 'host'
  useEffect(() => {
    if (!open || modeRunner !== 'pod') return
    api.get<any>('/agents/pods')
      .then((d: any) => {
        const list: PodOption[] = d.pods ?? d ?? []
        setPods(list)
        setPodName(prev => {
          if (prev && list.some(p => p.name === prev)) return prev
          const running = list.find(p => p.status === 'Running')
          return running?.name ?? list[0]?.name ?? ''
        })
      })
      .catch(() => setPods([]))
  }, [open, modeRunner])

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
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
  }, [])

  const handleImageSelect = useCallback(async () => {
    fileInputRef.current?.click()
  }, [])

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    const file = Array.from(files).find(f => f.type.startsWith('image/'))
    if (file) setPendingImages([await fileToBase64(file)])
    e.target.value = ''
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          fileToBase64(file).then(base64 => {
            setPendingImages([base64])
          })
        }
      }
    }
  }, [])

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && pendingImages.length === 0) || loading) return
    if (!auth.isLoggedIn) return
    if (modeRunner === 'pod' && !podName) {
      setMessages(prev => [...prev, { role: 'assistant', content: '该助手在 Pod 内运行，请先在顶部选择一个 Pod。' }])
      return
    }

    const userMsg: Message = {
      role: 'user',
      content: text,
      images: pendingImages.length > 0 ? pendingImages : undefined,
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setPendingImages([])
    setLoading(true)

    try {
      // If we have images, use the vision API
      if (pendingImages.length > 0) {
        const abort = new AbortController()
        abortRef.current = abort
        let assistantContent = ''
        let reasoning = ''
        let assistantAdded = false

        for await (const ev of streamAi('/ai/vision', {
          image: pendingImages[0],
          prompt: text || '请描述这张图片',
        }, abort.signal)) {
          if (ev.type === 'content') {
            assistantContent += ev.data
            if (!assistantAdded) {
              assistantAdded = true
              setMessages(prev => [...prev, { role: 'assistant', content: assistantContent, reasoning }])
            } else {
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = { role: 'assistant', content: assistantContent, reasoning }
                return updated
              })
            }
          } else if (ev.type === 'reasoning') {
            reasoning += ev.data
            // Update reasoning in real-time
            setMessages(prev => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last && last.role === 'assistant') {
                updated[updated.length - 1] = { ...last, reasoning, role: 'assistant' as const }
              }
              return updated
            })
          }
        }
        if (!assistantContent) {
          setMessages(prev => [...prev, { role: 'assistant', content: '分析完成，无输出' }])
        }
        setLoading(false)
        return
      }

      // Text chat: use agent run for tool-use capable agents
      const { run_id } = await api.post<{ run_id: string }>('/agents/run', {
        mode,
        message: text,
        ...(modeRunner === 'pod' ? { name: podName } : {}),
      })

      const abort = new AbortController()
      abortRef.current = abort

      const res = await fetch(`/api/agents/stream?run_id=${run_id}`, {
        credentials: 'same-origin',
        signal: abort.signal,
      })

      if (!res.ok || !res.body) {
        setMessages(prev => [...prev, { role: 'assistant', content: `请求失败: HTTP ${res.status}` }])
        setLoading(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''
      let reasoning = ''
      let toolCalls: ToolCallEntry[] = []
      let assistantAdded = false
      let sseBuffer = ''
      let streamDone = false

      // Strip ACTION: lines from displayed text (they're internal protocol)
      const stripActionLine = (text: string) => text.replace(/^\s*ACTION:\s*\{.*\}\s*$/gm, '')

      const updateAssistant = (updates: Partial<Message>) => {
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

      while (!streamDone) {
        const { done, value } = await reader.read()
        streamDone = done
        sseBuffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''  // keep last partial line in buffer
        // Accept a complete final JSON line from servers that omit its newline.
        if (done && sseBuffer.trim()) {
          lines.push(sseBuffer)
          sseBuffer = ''
        }

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))

            // Handle reasoning (thinking) — stream inline in real-time
            if (ev.type === 'reasoning' || ev.kind === 'reasoning') {
              reasoning += ev.data || ev.text || ''
              updateAssistant({ reasoning, content: assistantContent, toolCalls: [...toolCalls] })
            }

            // Handle tool_call events — structured tracking
            if (ev.type === 'tool_call') {
              const td = ev.data || ev
              const toolName = td.tool || td.name || '?'
              const toolArgs = td.args || td.arguments || {}
              const tcId = td.id || `tc_${toolCalls.length}`
              const entry: ToolCallEntry = {
                id: tcId,
                name: toolName,
                args: toolArgs,
                status: 'running',
              }
              toolCalls = [...toolCalls, entry]
              updateAssistant({ content: assistantContent, reasoning, toolCalls: [...toolCalls] })
              assistantAdded = true
            }

            // Handle tool_result events — update structured tracking
            if (ev.type === 'tool_result') {
              const td = ev.data || ev
              const output = String(td.output ?? td.result ?? '(无输出)').slice(0, 2000)
              const tcId = td.id || td.tool_call_id || ''
              // Find the matching tool call and update it
              if (tcId && toolCalls.some(tc => tc.id === tcId)) {
                toolCalls = toolCalls.map(tc =>
                  tc.id === tcId
                    ? { ...tc, result: output, ok: td.ok !== false, status: (td.ok === false ? 'error' : 'done') as 'done' | 'error' }
                    : tc
                )
              } else {
                // No matching ID — attach to last running tool call
                const lastRunning = toolCalls.findIndex(tc => tc.status === 'running')
                if (lastRunning >= 0) {
                  toolCalls = toolCalls.map((tc, i) =>
                    i === lastRunning
                      ? { ...tc, result: output, ok: td.ok !== false, status: (td.ok === false ? 'error' : 'done') as 'done' | 'error' }
                      : tc
                  )
                }
              }
              updateAssistant({ content: assistantContent, reasoning, toolCalls: [...toolCalls] })
            }

            // Handle compact events — show context compression indicator
            if (ev.type === 'compact') {
              const cd = ev.data || ev
              if (cd.after != null) {
                updateAssistant({
                  content: assistantContent,
                  reasoning,
                  toolCalls: [...toolCalls],
                  compact: { before: cd.before, after: cd.after },
                })
              }
            }

            // Handle text content
            const text = ev.text || ev.content || ev.message || ev.output || ''
            if (ev.type === 'text' || text) {
              const raw = text || ev.data || ''
              // Strip ACTION: protocol lines from display
              assistantContent += stripActionLine(raw)
              updateAssistant({ content: assistantContent, reasoning, toolCalls: [...toolCalls] })
              assistantAdded = true
            }

            if (ev.type === 'done' || ev.done) {
              const doneText = typeof ev.data === 'string' ? stripActionLine(ev.data) : ''
              if (doneText.trim() && !assistantContent.trim()) {
                assistantContent = doneText
                updateAssistant({ content: assistantContent, reasoning, toolCalls: [...toolCalls] })
                assistantAdded = true
              }
              streamDone = true
              break
            }
          } catch {
            // skip
          }
        }
      }

      if (!assistantAdded && !assistantContent && toolCalls.length === 0) {
        if (!reasoning) {
          setMessages(prev => [...prev, { role: 'assistant', content: '助手已完成，无输出内容' }])
        } else {
          updateAssistant({ content: '(思考完成)', reasoning })
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return
      setMessages(prev => [...prev, { role: 'assistant', content: `连接失败: ${e.message || '未知错误'}` }])
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  const newSession = async () => {
    try {
      await api.post('/agents/session/new', { mode })
      const d: any = await api.get('/agents/sessions')
      setSessions(d.sessions ?? d)
    } catch {}
  }

  const loadSession = async (id: string) => {
    try {
      const data: any = await api.get(`/agents/session/load?id=${id}`)
      const turns = data.turns || []
      const loaded: Message[] = turns
        .filter((t: any) => t.role === 'user' || t.role === 'assistant')
        .map((t: any) => ({
          role: t.role as 'user' | 'assistant',
          content: t.content || '',
        }))
      setMessages(loaded)
      if (data.mode) setMode(data.mode)
      setShowSessions(false)
    } catch {}
  }

  const deleteSession = async (id: string) => {
    try {
      await api.post('/agents/session/delete', { id })
      setSessions(prev => prev.filter(s => s.id !== id))
    } catch {}
  }

  const currentMode = AGENT_MODES.find(m => m.id === mode) || AGENT_MODES[0]

  return (
    <>
      {/* FAB */}
      <AnimatePresence>
        {!open && (
          <motion.button
            className={cn(
              'fixed right-4 z-[var(--z-fab)] w-12 h-12 rounded-full bg-accent text-white',
              'shadow-[0_4px_16px_rgba(10,132,255,0.3)] flex items-center justify-center',
              isDesktop ? 'bottom-6' : 'bottom-[calc(var(--mobile-tabbar-h)+0.75rem)]',
            )}
            onClick={() => { haptic('light'); setOpen(true) }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          >
            <Bot size={22} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            className={cn(
              'fixed z-[var(--z-fab)] flex flex-col overflow-hidden min-w-0',
              isDesktop
                ? 'bottom-6 right-6 w-[420px] h-[560px] rounded-2xl'
                : 'inset-x-2 rounded-2xl',
            )}
            style={{
              height: isDesktop ? 560 : undefined,
              top: isDesktop ? undefined : 'calc(var(--topbar-h) + 0.5rem)',
              bottom: isDesktop ? undefined : 'calc(var(--mobile-tabbar-h, 0px) + 0.5rem)',
              background: 'rgba(255,255,255,0.88)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              border: '0.5px solid rgba(0,0,0,0.06)',
              boxShadow: '0 0 0 0.5px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.12), 0 32px 64px rgba(0,0,0,0.08)',
            }}
            initial={{ opacity: 0, y: 20, scale: isDesktop ? 0.95 : 1 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: isDesktop ? 0.95 : 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 h-12 border-b border-black/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowModes(!showModes)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-black/[0.04] transition-colors"
                >
                  <span className="text-base">{currentMode?.icon}</span>
                  <span className="text-sm font-semibold">{currentMode?.label}</span>
                  <ChevronDown size={12} className="text-muted" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                {modeRunner === 'pod' && (
                  <select
                    aria-label="选择 Pod"
                    value={podName}
                    onChange={(e) => { setPodName(e.target.value); haptic('light') }}
                    className="max-w-[130px] truncate rounded-lg border border-black/[0.08] bg-white px-1.5 py-1 text-xs text-ink-2 focus:outline-none focus:border-accent/40"
                  >
                    {pods.length === 0 && <option value="">无可用 Pod</option>}
                    {pods.map(p => (
                      <option key={p.name} value={p.name}>
                        {p.name}{p.status === 'Running' ? '' : ` (${p.status})`}
                      </option>
                    ))}
                  </select>
                )}
                <DocHint section="dev" item={0} label="" title="查看助手文档" />
                <button
                  onClick={() => setShowSessions(!showSessions)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] transition-colors"
                  title="会话"
                >
                  <Brain size={14} />
                </button>
                <button aria-label="关闭助手" onClick={() => { haptic('light'); setOpen(false) }} className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] transition-colors">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Mode selector dropdown */}
            <AnimatePresence>
              {showModes && (
                <motion.div
                  className="absolute top-12 left-2 z-10 bg-white rounded-xl shadow-lg border border-black/[0.06] p-1 min-w-[160px]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  {AGENT_MODES.map(m => (
                    <button
                      key={m.id}
                      onClick={() => { setMode(m.id); setShowModes(false); haptic('light') }}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                        mode === m.id ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-black/[0.04]',
                      )}
                    >
                      <span>{m.icon}</span>
                      <span>{m.label}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Sessions panel */}
            <AnimatePresence>
              {showSessions && (
                <motion.div
                  className="absolute top-12 right-2 z-10 bg-white rounded-xl shadow-lg border border-black/[0.06] p-2 w-[240px]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-muted">历史会话</span>
                    <button onClick={newSession} className="text-xs text-accent hover:underline flex items-center gap-0.5">
                      <Plus size={10} /> 新建
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {sessions.length === 0 ? (
                      <p className="text-xs text-muted text-center py-3">暂无会话</p>
                    ) : sessions.map(s => (
                      <div key={s.id} className="group flex items-center gap-1 rounded-lg hover:bg-black/[0.04]">
                        <button type="button" onClick={() => loadSession(s.id)} className="min-w-0 flex-1 px-2 py-1.5 text-left">
                          <span className="block truncate text-xs">{s.title || s.preview || s.id}</span>
                        </button>
                        <button type="button" aria-label={`删除会话 ${s.title || s.preview || s.id}`} onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-all hover:bg-bad/10 hover:text-bad focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-bad/40 group-hover:opacity-100">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-4 py-3 space-y-3" onPaste={handlePaste}>
              {messages.length === 0 && (
                <div className="text-center py-8 space-y-2">
                  <p className="text-sm text-muted">有什么可以帮你的？</p>
                  <p className="text-xs text-muted/60">支持工具调用 · 实时推理 · Markdown · 网页操作</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {['分析集群状态', '解释错误日志', '生成部署配置', '搜索文档'].map(hint => (
                      <button
                        key={hint}
                        onClick={() => setInput(hint)}
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
                  <div className={`max-w-[85%] ${msg.role === 'user' ? '' : 'w-full space-y-0'}`}>
                    {/* Images */}
                    {msg.images && msg.images.length > 0 && (
                      <div className="flex gap-1 mb-1">
                        {msg.images.map((img, j) => (
                          <img key={j} src={`data:image/png;base64,${img}`} alt="" className="max-h-32 rounded-lg border border-black/[0.06]" />
                        ))}
                      </div>
                    )}
                    {msg.role === 'user' ? (
                      <div className="px-3 py-2 rounded-xl text-sm bg-accent text-white whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    ) : (
                      <>
                        {/* Reasoning — always visible, streams inline */}
                        {msg.reasoning && <InlineReasoning text={msg.reasoning} loading={loading && i === messages.length - 1} />}
                        {/* Compact indicator */}
                        {msg.compact && (
                          <div className="text-[10px] text-muted/60 italic mb-1 px-3">
                            上下文已压缩 ({msg.compact.before} → {msg.compact.after} tokens)
                          </div>
                        )}
                        {/* Tool calls — structured display */}
                        {msg.toolCalls && msg.toolCalls.length > 0 && <ToolCallsBlock calls={msg.toolCalls} />}
                        {/* Content — full markdown rendering */}
                        {msg.content ? (
                          <div className="px-3 py-2 rounded-xl bg-black/[0.04] text-ink">
                            <MarkdownContent content={msg.content} />
                          </div>
                        ) : (
                          loading && i === messages.length - 1 && !msg.toolCalls?.length && (
                            <div className="px-3 py-2 rounded-xl bg-black/[0.04] flex items-center gap-1.5 text-muted text-xs">
                              <Loader2 size={13} className="animate-spin" />
                              <span>思考中...</span>
                            </div>
                          )
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 rounded-xl bg-black/[0.04]">
                    <Loader2 size={16} className="animate-spin text-muted" />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Pending images preview */}
            {pendingImages.length > 0 && (
              <div className="px-4 py-1 flex gap-1 border-t border-black/[0.04]">
                {pendingImages.map((img, i) => (
                  <div key={i} className="relative">
                    <img src={`data:image/png;base64,${img}`} alt="" className="h-10 rounded border border-black/[0.06]" />
                    <button
                      onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-bad text-white flex items-center justify-center text-[8px]"
                    >
                      <X size={8} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="px-4 py-3 border-t border-black/[0.06]">
              <form
                onSubmit={(e) => { e.preventDefault(); handleSend() }}
                className="flex items-center gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={onFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={handleImageSelect}
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-muted hover:text-accent hover:bg-accent/10 transition-colors flex-shrink-0"
                  title="添加图片 (Vision)"
                >
                  <ImagePlus size={16} />
                </button>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="输入消息... (可粘贴图片)"
                  className="flex-1 px-3 py-2.5 rounded-lg text-sm bg-black/[0.03] border-0 focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
                {loading ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-10 h-10 rounded-lg flex items-center justify-center bg-red-500/10 text-red-500 active:scale-95 transition-all duration-100"
                  >
                    <StopCircle size={16} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={(!input.trim() && pendingImages.length === 0) || loading}
                    className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent text-white disabled:opacity-40 active:scale-95 transition-all duration-100"
                  >
                    <Send size={16} />
                  </button>
                )}
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
