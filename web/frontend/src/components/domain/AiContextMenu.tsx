import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, X, Loader2, Sparkles, Languages, Search, Code, HelpCircle } from 'lucide-react'
import { streamAi, collectStream } from '@/api/ai'
import { MarkdownContent } from '@/components/ai'

interface AiAction {
  id: string
  label: string
  icon: React.ReactNode
  endpoint: string
  buildBody: (text: string) => Record<string, unknown>
}

const TEXT_ACTIONS: AiAction[] = [
  {
    id: 'explain',
    label: 'AI 解释',
    icon: <HelpCircle size={14} />,
    endpoint: '/ai/explain',
    buildBody: (text) => ({ text, stream: true }),
  },
  {
    id: 'translate',
    label: '翻译为中文',
    icon: <Languages size={14} />,
    endpoint: '/ai/translate',
    buildBody: (text) => ({ text, target: 'zh', stream: true }),
  },
  {
    id: 'summarize',
    label: 'AI 摘要',
    icon: <Sparkles size={14} />,
    endpoint: '/ai/analyze',
    buildBody: (text) => ({ text, task: 'summarize', stream: true }),
  },
  {
    id: 'code',
    label: '生成代码',
    icon: <Code size={14} />,
    endpoint: '/ai/code',
    buildBody: (text) => ({ prompt: text, task: 'generate', stream: true }),
  },
  {
    id: 'search',
    label: 'AI 搜索',
    icon: <Search size={14} />,
    endpoint: '/ai/web-qa',
    buildBody: (text) => ({ question: text, stream: true }),
  },
]

/** Global AI context menu — appears on text selection right-click. */
export function AiContextMenu() {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [selectedText, setSelectedText] = useState('')
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Listen for right-click on selected text
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const selection = window.getSelection()
      const text = selection?.toString().trim()
      if (!text || text.length < 3) return

      // Check if click is inside our menu
      if (menuRef.current?.contains(e.target as Node)) return

      e.preventDefault()
      setSelectedText(text)
      setPosition({ x: e.clientX, y: e.clientY })
      setVisible(true)
      setShowResult(false)
      setResult('')
    }

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setVisible(false)
    }

    document.addEventListener('contextmenu', handleContextMenu)
    document.addEventListener('click', handleClick)
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu)
      document.removeEventListener('click', handleClick)
    }
  }, [])

  const handleAction = useCallback(async (action: AiAction) => {
    setLoading(true)
    setShowResult(true)
    setResult('')

    let content = ''
    for await (const ev of streamAi(action.endpoint, action.buildBody(selectedText))) {
      if (ev.type === 'content') {
        content += ev.data
        setResult(content)
      }
    }
    setLoading(false)
  }, [selectedText])

  // Clamp position to viewport
  const x = Math.min(position.x, window.innerWidth - 280)
  const y = Math.min(position.y, window.innerHeight - 300)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={menuRef}
          className="fixed z-[var(--z-popover)] bg-white rounded-xl shadow-xl border border-black/[0.06] overflow-hidden"
          style={{ left: x, top: y }}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.12 }}
        >
          {/* Selected text preview */}
          <div className="px-3 py-2 border-b border-black/[0.06] bg-black/[0.02]">
            <p className="text-xs text-muted truncate max-w-[240px]">
              "{selectedText.slice(0, 60)}{selectedText.length > 60 ? '…' : ''}"
            </p>
          </div>

          {/* Actions */}
          {!showResult ? (
            <div className="p-1.5">
              {TEXT_ACTIONS.map(action => (
                <button
                  key={action.id}
                  onClick={() => handleAction(action)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-accent/10 hover:text-accent transition-colors"
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-3 max-w-[280px] max-h-[200px] overflow-y-auto overflow-x-auto">
              {loading && !result ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  <span>AI 思考中…</span>
                </div>
              ) : (
                <div className="text-sm"><MarkdownContent content={result} /></div>
              )}
              <div className="flex items-center justify-end gap-2 mt-2">
                {result && (
                  <button
                    onClick={() => { navigator.clipboard.writeText(result) }}
                    className="text-xs text-accent hover:underline"
                  >
                    复制
                  </button>
                )}
                <button
                  onClick={() => { setShowResult(false); setResult('') }}
                  className="text-xs text-muted hover:text-ink"
                >
                  返回
                </button>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
