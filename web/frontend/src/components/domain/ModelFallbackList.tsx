import { useEffect, useRef, useState } from 'react'
import { Reorder } from 'framer-motion'
import { GripVertical, X, Plus, RefreshCw, Loader2 } from 'lucide-react'
import { api } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'

interface ModelFallbackListProps {
  models: string[]
  onChange: (models: string[]) => void
  baseUrl?: string
  apiKey?: string
  providerId?: string
}

type Status = 'idle' | 'loading' | 'ok' | 'error'

/**
 * Ordered model picker for an LLM provider.
 *
 * Models are listed top-to-bottom in fallback priority: models[0] is tried
 * first, and if it fails the next one is used. Candidates are auto-fetched
 * from the provider's `{base_url}/models` endpoint; when that fails the user
 * can still type model names by hand.
 */
export function ModelFallbackList({ models, onChange, baseUrl, apiKey, providerId }: ModelFallbackListProps) {
  const [candidates, setCandidates] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [manual, setManual] = useState('')

  const timer = useRef<number | null>(null)
  const lastKey = useRef<string>('')
  const reqSeq = useRef(0)

  const fetchCandidates = async () => {
    if (!baseUrl?.trim()) {
      setCandidates([]); setStatus('idle'); setMessage('')
      return
    }
    const seq = ++reqSeq.current
    setStatus('loading'); setMessage('')
    try {
      const res = await api.post<any>('/llm/providers/models', {
        base_url: baseUrl,
        api_key: apiKey || undefined,
        id: providerId || undefined,
      })
      if (seq !== reqSeq.current) return
      setCandidates(Array.isArray(res?.models) ? res.models : [])
      setStatus(res?.ok ? 'ok' : 'error')
      setMessage(res?.message || '')
    } catch (e: any) {
      if (seq !== reqSeq.current) return
      setCandidates([]); setStatus('error'); setMessage(e?.message || '拉取模型列表失败')
    }
  }

  // Auto-fetch (debounced ~700ms), keyed on baseUrl|providerId|apiKey so we
  // don't refire on unrelated re-renders.
  useEffect(() => {
    const key = `${baseUrl ?? ''}|${providerId ?? ''}|${apiKey ?? ''}`
    if (key === lastKey.current) return
    lastKey.current = key
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { fetchCandidates() }, 700)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, providerId, apiKey])

  const add = (m: string) => {
    const v = (m || '').trim()
    if (!v || models.includes(v)) return
    onChange([...models, v])
  }
  const remove = (m: string) => onChange(models.filter((x) => x !== m))

  const unused = candidates.filter((c) => !models.includes(c))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-ink-2">模型（回退顺序）</label>
        <div className="flex items-center gap-1.5">
          {status === 'ok' && <span className="text-[11px] text-muted tnum">{candidates.length} 个可选</span>}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { lastKey.current = ''; fetchCandidates() }}
            disabled={!baseUrl?.trim() || status === 'loading'}
            aria-label="刷新候选"
          >
            {status === 'loading' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </Button>
        </div>
      </div>

      {/* Selected models — drag to reorder (top == highest priority) */}
      {models.length > 0 ? (
        <Reorder.Group axis="y" values={models} onReorder={onChange} className="space-y-1.5">
          {models.map((m, i) => (
            <Reorder.Item
              key={m}
              value={m}
              style={{ touchAction: 'none' }}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] cursor-grab active:cursor-grabbing',
                'border-[0.5px] border-black/8 bg-white/62 select-none',
              )}
            >
              <GripVertical size={14} className="text-muted flex-shrink-0" />
              <Badge variant={i === 0 ? 'accent' : 'muted'} className="text-[10px] px-1.5 py-0 flex-shrink-0">
                {i === 0 ? '主' : `备${i}`}
              </Badge>
              <span className="font-mono text-xs text-ink flex-1 min-w-0 truncate">{m}</span>
              <button
                type="button"
                onClick={() => remove(m)}
                className="w-5 h-5 rounded flex items-center justify-center text-muted hover:text-bad hover:bg-black/[0.04] active:scale-90 transition-all flex-shrink-0"
                aria-label={`移除 ${m}`}
              >
                <X size={13} />
              </button>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <p className="text-xs text-muted px-0.5 py-1">尚未选择模型。至少添加一个。</p>
      )}

      <p className="text-[11px] text-muted">拖动排序，靠前者优先；失败自动 fallback 到下一个。</p>

      {/* Candidate chips — click to append */}
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {unused.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => add(c)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono bg-black/[0.04] text-ink-2 hover:bg-accent/10 hover:text-accent-dark active:scale-95 transition-all max-w-full"
            >
              <Plus size={11} className="flex-shrink-0" />
              <span className="truncate">{c}</span>
            </button>
          ))}
        </div>
      )}

      {(status === 'error' || (status === 'ok' && candidates.length === 0)) && message && (
        <p className={cn('text-[11px]', status === 'error' ? 'text-bad' : 'text-muted')}>{message}</p>
      )}
      {status === 'error' && <p className="text-[11px] text-muted">拉取失败，可手动输入模型名。</p>}

      {/* Manual entry — always available (needed when the probe fails) */}
      <div className="flex items-center gap-2">
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="手动输入模型名"
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(manual); setManual('') }
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { add(manual); setManual('') }}
          disabled={!manual.trim() || models.includes(manual.trim())}
        >
          添加
        </Button>
      </div>
    </div>
  )
}
