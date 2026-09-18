import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, User } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { api } from '@/api/client'

interface Candidate { username: string }

export function UserCombobox({
  podName,
  label,
  value,
  onChange,
  placeholder = '输入用户名开头…',
}: {
  podName: string
  label: string
  value: string
  onChange: (username: string) => void
  placeholder?: string
}) {
  const [text, setText] = useState(value)
  const [items, setItems] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const selected = Boolean(value && text === value)

  useEffect(() => { setText(value); setItems([]) }, [value])
  useEffect(() => {
    const q = text.trim()
    if (q.length < 2 || selected) { setItems([]); setLoading(false); return }
    const id = ++requestId.current
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('')
      try {
        const data = await api.get<{ items?: Candidate[] }>(`/pods/${encodeURIComponent(podName)}/members/candidates?q=${encodeURIComponent(q)}&limit=10`)
        if (id === requestId.current) setItems(data.items ?? [])
      } catch (e: any) {
        if (id === requestId.current) { setItems([]); setError(e?.message || '搜索失败') }
      } finally { if (id === requestId.current) setLoading(false) }
    }, 280)
    return () => window.clearTimeout(timer)
  }, [podName, text, selected])

  return (
    <div className="relative">
      <Input
        label={label}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        onChange={e => { setText(e.target.value); if (e.target.value !== value) onChange('') }}
      />
      {(loading || error || items.length > 0 || (text.trim().length >= 2 && !selected && !loading)) && (
        <div className="absolute z-[var(--z-popover)] left-0 right-0 top-full mt-1 rounded-xl border-[0.5px] border-black/[0.08] bg-white/95 backdrop-blur-xl shadow-lg overflow-hidden">
          {loading && <div className="px-3 py-2 text-xs text-muted flex items-center gap-2"><Loader2 size={13} className="animate-spin" />搜索中…</div>}
          {!loading && error && <div className="px-3 py-2 text-xs text-bad">{error}</div>}
          {!loading && !error && items.map(item => (
            <button key={item.username} type="button" className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent-light active:bg-accent-light" onClick={() => { setText(item.username); onChange(item.username); setItems([]) }}>
              <User size={14} className="text-muted" />{item.username}
            </button>
          ))}
          {!loading && !error && text.trim().length >= 2 && !items.length && <div className="px-3 py-2 text-xs text-muted flex items-center gap-2"><Search size={13} />没有匹配的用户</div>}
        </div>
      )}
    </div>
  )
}
