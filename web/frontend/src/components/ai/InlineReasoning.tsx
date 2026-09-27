import { useEffect, useState } from 'react'
import { Brain, Loader2, ChevronRight } from 'lucide-react'

/**
 * Collapsible reasoning trace. While the model is still thinking the live
 * block stays open; the moment a later segment takes over it folds itself
 * away so the timeline does not fill up with finished traces, and can still
 * be re-opened by clicking the header.
 */
export function InlineReasoning({ text, loading }: { text: string; loading?: boolean }) {
  const [open, setOpen] = useState(() => Boolean(loading))
  useEffect(() => { setOpen(Boolean(loading)) }, [loading])
  if (!text) return null

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-warn/30 bg-warn/10">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-medium text-warn transition-colors hover:bg-warn/10"
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
        <span>{loading ? '思考中…' : '思考过程'}</span>
        <ChevronRight
          size={12}
          className={`ml-auto shrink-0 text-warn/70 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-2.5 pb-2 pt-1 text-xs leading-relaxed text-ink-2">
          {text}
        </div>
      )}
    </div>
  )
}
