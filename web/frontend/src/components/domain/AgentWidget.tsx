import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, X, Send, Loader2, StopCircle } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'
import { api } from '@/api/client'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const DEFAULT_AGENT = 'ops'

/** Floating Agent assistant widget — FAB in bottom-right. */
export function AgentWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const isDesktop = useIsDesktop()
  const auth = useAuthStore()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
  }, [])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!auth.isLoggedIn) return

    const userMsg: Message = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      // Start agent run
      const { run_id } = await api.post<{ run_id: string }>('/agents/run', {
        mode: DEFAULT_AGENT,
        message: text,
      })

      // Stream SSE events
      const abort = new AbortController()
      abortRef.current = abort

      const res = await fetch(`/api/agents/stream?run_id=${run_id}`, {
        credentials: 'same-origin',
        signal: abort.signal,
      })

      if (!res.ok || !res.body) {
        setMessages((prev) => [...prev, { role: 'assistant', content: `请求失败: HTTP ${res.status}` }])
        setLoading(false)
        return
      }

      // Read SSE stream
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''
      let assistantAdded = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        // Parse SSE data lines
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            // Agent events have different shapes; extract text content
            const text = ev.text || ev.content || ev.message || ev.output || ''
            if (text) {
              assistantContent += text
              if (!assistantAdded) {
                assistantAdded = true
                setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }])
              } else {
                setMessages((prev) => {
                  const updated = [...prev]
                  updated[updated.length - 1] = { role: 'assistant', content: assistantContent }
                  return updated
                })
              }
            }
            // Check for completion
            if (ev.type === 'done' || ev.done) break
          } catch {
            // Non-JSON data line, skip
          }
        }
      }

      // If no content was received, show a fallback
      if (!assistantContent) {
        setMessages((prev) => [...prev, { role: 'assistant', content: '助手已完成，无输出内容' }])
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return
      setMessages((prev) => [...prev, { role: 'assistant', content: `连接失败: ${e.message || '未知错误'}` }])
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  return (
    <>
      {/* FAB — offset above mobile tab bar */}
      <AnimatePresence>
        {!open && (
          <motion.button
            className={cn(
              'fixed right-4 z-40 w-12 h-12 rounded-full bg-accent text-white',
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

      {/* Chat panel — responsive sizing */}
      <AnimatePresence>
        {open && (
          <motion.div
            className={cn(
              'fixed z-40 flex flex-col overflow-hidden',
              isDesktop
                ? 'bottom-6 right-6 w-[380px] h-[520px] rounded-2xl'
                : 'inset-x-2 rounded-2xl',
            )}
            style={{
              height: isDesktop ? 520 : undefined,
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
            <div className="flex items-center justify-between px-4 h-12 border-b border-black/[0.06] flex-shrink-0">
              <div className="flex items-center gap-2">
                <Bot size={18} className="text-accent" />
                <span className="text-sm font-semibold">助手</span>
              </div>
              <button onClick={() => { haptic('light'); setOpen(false) }} className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] active:scale-90 transition-all">
                <X size={16} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.length === 0 && (
                <p className="text-center text-sm text-muted py-8">有什么可以帮你的？</p>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap ${
                    msg.role === 'user' ? 'bg-accent text-white' : 'bg-black/[0.04] text-ink'
                  }`}>
                    {msg.content}
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

            {/* Input */}
            <div className="px-4 py-3 border-t border-black/[0.06]">
              <form
                onSubmit={(e) => { e.preventDefault(); handleSend() }}
                className="flex items-center gap-2"
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="输入消息..."
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
                    disabled={!input.trim() || loading}
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
