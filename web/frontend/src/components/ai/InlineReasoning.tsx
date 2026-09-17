import { Brain } from 'lucide-react'

export function InlineReasoning({ text, loading }: { text: string; loading?: boolean }) {
  if (!text) return null
  return (
    <div className="px-3 py-2 rounded-xl bg-amber-50/70 border border-amber-200/40 text-xs text-amber-800 whitespace-pre-wrap leading-relaxed mb-1 max-h-64 overflow-y-auto">
      <div className="flex items-center gap-1 mb-1 text-amber-600 font-medium">
        <Brain size={12} />
        <span>{loading ? '思考中…' : '思考过程'}</span>
      </div>
      {text}
    </div>
  )
}
