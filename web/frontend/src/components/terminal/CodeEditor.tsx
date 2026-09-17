import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import { Sparkles, Loader2 } from 'lucide-react'
import { aiApi } from '@/api/ai'

interface CodeEditorProps {
  value: string
  language?: 'javascript' | 'python' | 'json' | 'text'
  readOnly?: boolean
  onChange?: (value: string) => void
  className?: string
}

const langExtensions: Record<string, any> = {
  javascript: javascript(),
  python: python(),
  json: javascript(),
  text: [],
}

export function CodeEditor({ value, language = 'text', readOnly = false, onChange, className }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiExplain = async () => {
    if (aiTip) { setAiTip(''); return }
    if (!value.trim()) return
    setAiLoading(true)
    try {
      const res = await aiApi.explain(value.slice(0, 8000))
      setAiTip(res.content)
    } catch {
      setAiTip('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  useEffect(() => {
    if (!containerRef.current) return

    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        langExtensions[language] || [],
        oneDark,
        EditorView.editable.of(!readOnly),
        onChange ? EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString())
        }) : [],
      ],
      parent: containerRef.current,
    })

    viewRef.current = view

    return () => view.destroy()
  }, [language, readOnly])

  // Update content when value changes externally
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    }
  }, [value])

  return (
    <div className="relative">
      <div ref={containerRef} className={className} />
      {readOnly && value.trim() && (
        <button
          onClick={handleAiExplain}
          disabled={aiLoading}
          className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-white bg-black/40 hover:bg-black/60 disabled:opacity-40 transition-colors backdrop-blur-sm"
        >
          {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          AI 解释
        </button>
      )}
      {aiTip && (
        <div className="mt-2 p-3 rounded-lg bg-accent/5 border border-accent/10 text-xs whitespace-pre-wrap max-h-60 overflow-y-auto">
          <div className="flex items-center gap-1 mb-1 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 解释</div>
          {aiTip}
        </div>
      )}
    </div>
  )
}
