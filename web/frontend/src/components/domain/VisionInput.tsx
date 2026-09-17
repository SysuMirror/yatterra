import { useState, useRef, useCallback } from 'react'
import { ImagePlus, X, Loader2, Bot } from 'lucide-react'
import { streamAi, fileToBase64 } from '@/api/ai'

interface VisionInputProps {
  onResult?: (result: string) => void
  className?: string
}

/** Image input component — paste/drop/select image, ask question, get AI response. */
export function VisionInput({ onResult, className }: VisionInputProps) {
  const [image, setImage] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return
    const base64 = await fileToBase64(file)
    setImage(base64)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) handleFile(file)
        return
      }
    }
  }, [handleFile])

  const handleAnalyze = async () => {
    if (!image || loading) return
    setLoading(true)
    setResult('')
    let content = ''
    for await (const ev of streamAi('/ai/vision', {
      image,
      prompt: prompt || '请详细描述这张图片的内容',
    })) {
      if (ev.type === 'content') {
        content += ev.data
        setResult(content)
      }
    }
    setLoading(false)
    onResult?.(content)
  }

  return (
    <div
      className={`space-y-3 ${className || ''}`}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onPaste={handlePaste}
    >
      {/* Image preview / drop zone */}
      {image ? (
        <div className="relative inline-block">
          <img src={`data:image/png;base64,${image}`} alt="" className="max-h-48 rounded-xl border border-black/[0.06]" />
          <button
            onClick={() => setImage(null)}
            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileRef.current?.click()}
          className="flex flex-col items-center gap-2 p-6 rounded-xl border-2 border-dashed border-black/[0.08] hover:border-accent/30 hover:bg-accent/5 cursor-pointer transition-colors"
        >
          <ImagePlus size={24} className="text-muted" />
          <p className="text-sm text-muted">拖拽、粘贴或点击选择图片</p>
          <p className="text-xs text-muted/60">支持 PNG、JPG、WebP</p>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
        className="hidden"
      />

      {/* Prompt input */}
      {image && (
        <div className="flex items-center gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="问关于这张图片的问题..."
            className="flex-1 px-3 py-2 rounded-lg text-sm bg-black/[0.03] border-0 focus:outline-none focus:ring-2 focus:ring-accent/20"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAnalyze() } }}
          />
          <button
            onClick={handleAnalyze}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 active:scale-95 transition-all"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="px-3 py-2 rounded-xl bg-black/[0.04] text-sm whitespace-pre-wrap">
          {result}
        </div>
      )}
    </div>
  )
}
