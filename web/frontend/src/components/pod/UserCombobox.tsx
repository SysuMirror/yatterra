import { useEffect, useId, useRef, useState } from 'react'
import { Loader2, Search, User } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { api } from '@/api/client'

interface Candidate { user_id?: string; username: string; display_name?: string; avatar_url?: string }

export function UserCombobox({ podName, label, value, onChange, mode = 'invite', disabled = false }: {
  podName: string
  label: string
  value: string
  onChange: (username: string) => void
  mode?: 'invite' | 'owner'
  disabled?: boolean
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)
  const controller = useRef<AbortController | null>(null)
  // Clearing the selected value while editing must not clear the draft.
  const editing = useRef(false)
  const [text, setText] = useState(value)
  const [items, setItems] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const selected = Boolean(value && text === value)
  const query = text.trim()

  const cancel = () => { ++requestId.current; controller.current?.abort() }
  useEffect(() => {
    if (editing.current && !value) { editing.current = false; return }
    setText(value); setOpen(false); setItems([])
  }, [value])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  useEffect(() => {
    const token = ++requestId.current
    setItems([]); setError(''); setActive(-1)
    if (!open || disabled || !query || selected) { setLoading(false); return }
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.get<{ items: Candidate[] }>(
          `/pods/${encodeURIComponent(podName)}/members/candidates?q=${encodeURIComponent(query)}&limit=10&mode=${mode}`,
          { signal: abort.signal },
        )
        if (token === requestId.current) setItems(data.items)
      } catch (e: unknown) {
        if (token === requestId.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : '搜索失败')
      } finally { if (token === requestId.current) setLoading(false) }
    }, 240)
    return () => { ++requestId.current; window.clearTimeout(timer); abort.abort() }
  }, [podName, query, selected, mode, open, disabled])

  const choose = (item: Candidate) => {
    cancel(); editing.current = false; setText(item.username); onChange(item.username); setItems([]); setOpen(false)
  }
  const showMenu = open && !disabled && !selected && Boolean(query)
  return (
    <div ref={root} className="relative" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
      <Input id={id} label={label} value={text} disabled={disabled} maxLength={64}
        placeholder="搜索昵称、用户名或绑定身份…" hint={selected ? '已选择用户' : '支持昵称、用户名、OAuth 昵称前缀匹配'}
        autoComplete="off" role="combobox" aria-expanded={showMenu} aria-autocomplete="list"
        aria-controls={`${id}-list`} aria-activedescendant={showMenu && active >= 0 ? `${id}-option-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onChange={e => {
          cancel(); setItems([]); setError(''); setLoading(Boolean(e.target.value.trim())); setActive(-1)
          setText(e.target.value); setOpen(true)
          if (value) { editing.current = true; onChange('') }
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape' && showMenu) { e.preventDefault(); e.stopPropagation(); cancel(); setOpen(false) }
          else if (e.key === 'Tab') setOpen(false)
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); setOpen(true)
            if (items.length) setActive(i => e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1))
          } else if (e.key === 'Enter' && showMenu) {
            e.preventDefault()
            if (!loading && items[active]) choose(items[active])
          }
        }}
      />
      {showMenu && <div className="relative z-[var(--z-popover)] mt-1 rounded-xl border-[0.5px] border-black/[0.08] bg-white/95 shadow-lg overflow-hidden">
        <div role="status" aria-live="polite">
          {loading && <div className="px-3 py-2 text-xs text-muted flex items-center gap-2"><Loader2 size={13} className="animate-spin" />搜索中…</div>}
          {!loading && error && <div className="px-3 py-2 text-xs text-bad">{error}</div>}
          {!loading && !error && !items.length && <div className="px-3 py-2 text-xs text-muted flex items-center gap-2"><Search size={13} />没有匹配的用户</div>}
        </div>
        <div id={`${id}-list`} role="listbox" aria-label={label} className="max-h-52 overflow-y-auto overscroll-contain">
          {!loading && !error && items.map((item, index) => <button key={item.user_id || item.username} id={`${id}-option-${index}`}
            type="button" role="option" tabIndex={-1} aria-selected={index === active}
            className={`w-full flex items-center gap-2 px-3 py-3 text-left text-sm hover:bg-accent-light active:bg-accent-light ${index === active ? 'bg-accent-light' : ''}`}
            onMouseDown={e => e.preventDefault()} onClick={() => choose(item)}>
            <User size={14} className="text-muted shrink-0" /><span className="min-w-0"><span className="block break-all">{item.display_name || item.username}</span>{item.display_name && item.display_name !== item.username && <span className="block text-xs text-muted break-all">{item.username}</span>}</span>
          </button>)}
        </div>
      </div>}
    </div>
  )
}
