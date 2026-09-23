import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, X, Send, Loader2, StopCircle } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/api/client'
import { AssistantSpotlight } from '@/components/ui/AssistantSpotlight'
import { MarkdownContent } from '@/components/ai'
import { snapshot, perform, resolveAction, type AssistantAction, type Control } from '@/lib/assistantControl'

type Message = { role: 'user' | 'assistant'; content: string }
const keyFor = (user: string) => `yatterra.browser-assistant.session.${encodeURIComponent(user)}`
const readId = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const saveId = (key: string, id: string) => { try { localStorage.setItem(key,id) } catch { /* session remains in memory */ } }

// Keying by identity synchronously discards private state on logout/account switch.
export function AgentWidget() {
  const user = useAuthStore(s => s.user), loggedIn = useAuthStore(s => s.isLoggedIn)
  return loggedIn && user ? <AssistantSession key={user} user={user}/> : null
}
function AssistantSession({ user }: { user: string }) {
  const location = useLocation(), navigate = useNavigate()
  const [open,setOpen] = useState(false), [ready,setReady] = useState(false)
  const [messages,setMessages] = useState<Message[]>([]), [input,setInput] = useState('')
  const [loading,setLoading] = useState(false), [error,setError] = useState('')
  const [actions,setActions] = useState<AssistantAction[]>([])
  const [highlight,setHighlight] = useState<Control | null>(null)
  const [viewport,setViewport] = useState({ top: 0, height: window.visualViewport?.height ?? innerHeight })
  const sid = useRef(''), mounted = useRef(true), active = useRef<{ ctrl: AbortController; run?: string } | null>(null)
  const path = useRef(location.pathname); path.current = location.pathname
  const list = useRef<HTMLDivElement>(null), launcher = useRef<HTMLButtonElement>(null)
  const clearHighlight = useCallback(() => setHighlight(null), [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.ctrl.abort() }
  }, [])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let id = readId(keyFor(user)), data: { turns?: Message[]; session_id?: string } = {}
        if (id) {
          try { data = await api.get(`/agents/browser/session/load?id=${encodeURIComponent(id)}`) }
          catch (e) { if (e instanceof ApiError && e.status === 404) id = null; else throw e }
        }
        if (!id) { data = await api.post('/agents/browser/session/new', {}); id = data.session_id || null }
        if (cancelled) return
        if (!id) throw new Error('missing session')
        sid.current = id; saveId(keyFor(user),id)
        setMessages((data.turns || []).filter(t => ['user','assistant'].includes(t.role)).map(t => ({ role:t.role, content:String(t.content || '') })))
        setReady(true)
      } catch { if (!cancelled) setError('会话加载失败，请刷新后重试。') }
    })()
    return () => { cancelled = true }
  }, [user])
  useEffect(() => { setActions([]); setHighlight(null) }, [location.pathname])
  useEffect(() => {
    const update = () => setViewport({ top:window.visualViewport?.offsetTop ?? 0, height:window.visualViewport?.height ?? innerHeight })
    window.visualViewport?.addEventListener('resize',update); window.visualViewport?.addEventListener('scroll',update); window.addEventListener('resize',update)
    return () => { window.visualViewport?.removeEventListener('resize',update); window.visualViewport?.removeEventListener('scroll',update); window.removeEventListener('resize',update) }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && (open || highlight)) { setHighlight(null); setOpen(false); launcher.current?.focus() } }
    document.addEventListener('keydown',onKey); return () => document.removeEventListener('keydown',onKey)
  }, [open,highlight])
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [messages,actions,open])

  const send = async () => {
    if (!input.trim() || !ready || active.current) return
    const message = input.trim(), requestedPage = path.current
    const task = { ctrl:new AbortController(), run:undefined as string | undefined }; active.current = task
    setLoading(true); setError(''); setInput(''); setActions([]); setHighlight(null)
    setMessages(m => [...m,{role:'user',content:message}])
    const valid = () => mounted.current && !task.ctrl.signal.aborted && active.current === task
    let replied = false
    const reply = (content: string) => { if (!replied) { replied = true; setMessages(m => [...m,{role:'assistant',content}]) } }
    try {
      // Do not abort the POST: if Stop wins this race we still need its run ID to cancel server work.
      const run = await api.post<{run_id:string}>('/agents/browser/run',{session_id:sid.current,message,page:requestedPage,context:JSON.stringify(snapshot())})
      task.run = run.run_id
      if (!valid()) { if (useAuthStore.getState().user === user) await api.post('/agents/browser/stop',{run_id:task.run}); return }
      let offset = 0, terminal = false
      for (let attempt = 0; attempt < 3 && !terminal; attempt++) {
        try {
          const response = await fetch(`/api/agents/browser/stream?run_id=${encodeURIComponent(task.run)}&offset=${offset}`,{credentials:'same-origin',signal:task.ctrl.signal})
          if (!response.ok || !response.body) throw new Error('Stream failed')
          const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
          try {
            while (!terminal && valid()) {
              const chunk = await reader.read(); buffer += decoder.decode(chunk.value,{stream:!chunk.done})
              const frames = buffer.replace(/\r\n/g,'\n').split('\n\n'); buffer = frames.pop() || ''
              if (chunk.done && buffer.trim()) { frames.push(buffer); buffer = '' }
              for (const frame of frames) {
                const lines = frame.split('\n'), idLine = lines.find(l => l.startsWith('id:'))
                const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
                if (!data || !valid()) continue
                const id = idLine ? Number(idLine.slice(3)) : offset
                if (!Number.isInteger(id) || id < offset) continue
                const ev = JSON.parse(data)
                if (ev.type === 'proposal' && ev.data && typeof ev.data.message === 'string') {
                  reply(ev.data.message)
                  if (path.current === requestedPage && Array.isArray(ev.data.actions)) setActions(ev.data.actions.filter((a: AssistantAction) => a && resolveAction(a)))
                }
                if (ev.type === 'done') { if (!replied && typeof ev.data === 'string') reply(ev.data); terminal = true }
                if (ev.type === 'error') { setError('助手暂时不可用，请重试。'); terminal = true }
                offset = id + 1
              }
              if (chunk.done) break
            }
          } finally { await reader.cancel().catch(() => {}) }
        } catch (e) { if (!valid() || attempt === 2) throw e }
        if (!terminal && valid()) await new Promise(r => setTimeout(r,500))
      }
      if (!terminal && valid()) throw new Error('Connection interrupted')
    } catch { if (valid()) setError('连接中断，请重试；已保存的会话会保留。') }
    finally { if (active.current === task) { active.current = null; if (mounted.current) setLoading(false) } }
  }
  const stop = async () => {
    const task = active.current; task?.ctrl.abort(); setActions([]); setHighlight(null)
    if (task?.run) { try { await api.post('/agents/browser/stop',{run_id:task.run}) } catch { setError('停止请求未确认，请稍后重试。') } }
    // Keep send disabled until the in-flight POST returns, so a stopped run cannot race a new one.
  }
  const execute = (action: AssistantAction) => {
    const target = perform(action,navigate)
    if (!target) { setError('目标已改变、不可用或无权操作，请重新询问。'); setActions([]); return }
    setActions(a => a.filter(x => x !== action)); setOpen(false)
    if (action.type !== 'navigate') setHighlight(target)
    setMessages(m => [...m,{role:'assistant',content:`已${action.type === 'inspect' ? '标记' : '执行'}：${target.label}`}])
  }
  return <>
    {!open && <button ref={launcher} type="button" data-onboarding-target="assistant" aria-label="打开 AI 助手" onClick={() => { setHighlight(null); setOpen(true) }} className="fixed right-4 bottom-[calc(var(--mobile-tabbar-h,0px)+.75rem)] z-[var(--z-fab)] flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-lg md:bottom-6"><Bot size={22}/></button>}
    {highlight && <AssistantSpotlight element={highlight.element} label={highlight.label} close={clearHighlight}/>}
    {open && <section role="dialog" aria-modal="false" aria-label="AI 助手" data-assistant-ui data-onboarding-overlay className="fixed right-2 bottom-[calc(var(--mobile-tabbar-h,0px)+.5rem)] z-[var(--z-fab)] flex w-[min(420px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white/95 shadow-2xl backdrop-blur-xl md:bottom-6" style={{height:Math.min(560, Math.max(180, viewport.height - 16 - 56))}}>
      <header className="flex shrink-0 items-center justify-between border-b px-3 py-2"><b className="flex items-center gap-2"><Bot size={16}/>AI 助手</b><button type="button" aria-label="关闭助手" className="p-2" onClick={() => setOpen(false)}><X size={18}/></button></header>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {!messages.length && <p className="text-sm text-muted">告诉我你想做什么。我可以打开已授权页面、切换标签、填写搜索条件，或标记需要查看的位置。页面提交和敏感操作仍由你完成。</p>}
        {messages.map((m,i) => <div key={i} className={`rounded-xl p-3 text-sm break-words ${m.role === 'user' ? 'ml-8 bg-accent text-white whitespace-pre-wrap' : 'bg-black/5'}`}>{m.role === 'assistant' ? <MarkdownContent content={m.content}/> : m.content}</div>)}
        {actions.map((a,i) => <div key={`${a.id}:${i}`} className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm"><b>{resolveAction(a)?.label || a.target_id}</b><p className="my-2">{a.type === 'fill' ? `填写为：${a.value}` : a.type === 'inspect' ? '标记此处' : a.type === 'navigate' ? '打开此页面' : '切换此标签'}</p><button type="button" className="rounded bg-accent px-3 py-2 text-white" onClick={() => execute(a)}>确认执行</button><button type="button" className="ml-2 px-3 py-2" onClick={() => setActions(list => list.filter(x => x !== a))}>取消</button></div>)}
        {loading && <div role="status" className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin"/>正在处理…</div>}
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>
      <form className="flex shrink-0 items-end gap-2 border-t p-3" onSubmit={e => {e.preventDefault();void send()}}><textarea aria-label="发送消息" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {e.preventDefault();void send()}}} maxLength={8000} rows={2} placeholder="问我如何操作此页面…" className="min-w-0 flex-1 resize-none rounded-xl bg-black/5 p-2 text-sm"/>{loading ? <button type="button" aria-label="停止" className="p-3 text-bad" onClick={() => void stop()}><StopCircle size={18}/></button> : <button type="submit" aria-label="发送" disabled={!ready || !input.trim()} className="rounded-xl bg-accent p-3 text-white disabled:opacity-40"><Send size={18}/></button>}</form>
    </section>}
  </>
}
