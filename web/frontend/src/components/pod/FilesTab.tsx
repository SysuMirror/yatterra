import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Folder, File, FilePlus, FolderPlus, Trash2, Save, ArrowLeft, RefreshCw, Sparkles, Loader2 } from 'lucide-react'
import { api } from '@/api/client'
import { aiApi } from '@/api/ai'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { CodeEditor } from '@/components/terminal/CodeEditor'
import { useToastStore } from '@/stores/toast'
import { cn } from '@/lib/cn'

const HOME = '/home/cloud'
const TEXT_EXT = /\.(txt|md|json|ya?ml|toml|ini|conf|cfg|env|sh|bash|py|js|ts|jsx|tsx|css|html|htm|xml|sql|c|h|cpp|go|rs|java|log|gitignore|dockerfile)$/i
const MAX_EDIT_BYTES = 512 * 1024

interface Entry { name: string; path: string; is_dir: boolean; is_exec: boolean }

function langOf(name: string): 'javascript' | 'python' | 'json' | 'text' {
  if (/\.json$/i.test(name)) return 'json'
  if (/\.(js|ts|jsx|tsx|html|css|xml)$/i.test(name)) return 'javascript'
  if (/\.py$/i.test(name)) return 'python'
  return 'text'
}

export function FilesTab({ podName }: { podName: string }) {
  const [dir, setDir] = useState(HOME)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()

  const { data: listing, isLoading } = useQuery<{ ok: boolean; entries: Entry[]; error: string }>({
    queryKey: ['files', podName, dir],
    queryFn: () => api.get(`/pods/${podName}/files?path=${encodeURIComponent(dir)}`),
    enabled: !openFile,
    staleTime: 5_000,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['files', podName] })

  const createEntry = async (type: 'file' | 'dir') => {
    const name = prompt(type === 'dir' ? '新目录名' : '新文件名')
    if (!name?.trim()) return
    try {
      await api.post(`/pods/${podName}/files/create`, { path: `${dir.replace(/\/$/, '')}/${name.trim()}`, type: type === 'dir' ? 'folder' : type })
      toast({ type: 'success', message: `已创建 ${name}` })
      refresh()
    } catch (e: any) {
      toast({ type: 'error', message: e?.message || '创建失败' })
    }
  }

  const deleteEntry = async (entry: Entry) => {
    if (!confirm(`删除 ${entry.name}？${entry.is_dir ? '目录内容将一并删除' : ''}`)) return
    try {
      await api.del(`/pods/${podName}/files?path=${encodeURIComponent(entry.path)}`)
      toast({ type: 'success', message: `已删除 ${entry.name}` })
      refresh()
    } catch (e: any) {
      toast({ type: 'error', message: e?.message || '删除失败' })
    }
  }

  if (openFile) {
    return <FileEditor podName={podName} path={openFile} onBack={() => setOpenFile(null)} />
  }

  const entries = listing?.entries ?? []
  const crumbs = dir.split('/').filter(Boolean)

  return (
    <div>
      {/* Toolbar: breadcrumb + actions */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <button
          onClick={() => setDir(dir === HOME ? '/shared' : HOME)}
          className="text-xs px-2 py-1 rounded-md text-muted hover:text-ink hover:bg-black/[0.05] transition-colors"
          title="切换 /home/cloud 与 /shared"
        >
          <ArrowLeft size={13} className="inline mr-1" />{dir === HOME ? '/shared' : HOME}
        </button>
        <nav className="flex items-center gap-1 text-sm font-mono min-w-0 overflow-x-auto" aria-label="目录">
          <button className="px-1.5 py-0.5 rounded text-muted hover:text-ink" onClick={() => setDir('/')}>/</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1 whitespace-nowrap">
              <button
                className="px-1.5 py-0.5 rounded hover:bg-black/[0.05] text-ink-2"
                onClick={() => setDir('/' + crumbs.slice(0, i + 1).join('/'))}
              >
                {c}
              </button>
              {i < crumbs.length - 1 && <span className="text-muted/50">/</span>}
            </span>
          ))}
        </nav>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={refresh}><RefreshCw size={13} /></Button>
        <Button variant="secondary" size="sm" onClick={() => createEntry('file')}><FilePlus size={13} /> 新文件</Button>
        <Button variant="secondary" size="sm" onClick={() => createEntry('dir')}><FolderPlus size={13} /> 新目录</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={32} />)}</div>
      ) : !listing?.ok && listing?.error ? (
        <p className="text-sm text-bad py-8 text-center">{listing.error}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted py-8 text-center">空目录</p>
      ) : (
        <ul className="rounded-xl border-[0.5px] border-black/[0.06] overflow-hidden">
          {entries.map((e) => (
            <li
              key={e.path}
              className="flex items-center gap-3 px-4 py-2 border-b border-black/[0.04] last:border-0 hover:bg-black/[0.02] transition-colors group"
            >
              {e.is_dir
                ? <Folder size={15} className="text-accent flex-shrink-0" />
                : <File size={15} className={cn('flex-shrink-0', e.is_exec ? 'text-warn' : 'text-muted')} />}
              <button
                className="flex-1 min-w-0 text-left text-sm font-mono truncate hover:text-accent transition-colors"
                title={e.path}
                onClick={() => (e.is_dir ? setDir(e.path) : setOpenFile(e.path))}
              >
                {e.name}
              </button>
              <button
                aria-label={`删除 ${e.name}`}
                className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1.5 rounded-md text-muted hover:text-bad hover:bg-bad/10 transition-all"
                onClick={() => deleteEntry(e)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FileEditor({ podName, path, onBack }: { podName: string; path: string; onBack: () => void }) {
  const toast = useToastStore((s) => s.add)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [aiExplain, setAiExplain] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const dirty = useRef(false)

  const handleAiExplain = async () => {
    if (!content) return
    setAiLoading(true)
    setAiExplain('')
    try {
      const res = await aiApi.explain(content.slice(0, 8000))
      setAiExplain(res.content)
    } catch {
      setAiExplain('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    api.get(`/pods/${podName}/files/content?path=${encodeURIComponent(path)}`)
      .then((text: any) => {
        if (cancelled) return
        const t = typeof text === 'string' ? text : (text?.content ?? JSON.stringify(text, null, 2))
        if (t.length > MAX_EDIT_BYTES) {
          setError(`文件过大（${(t.length / 1024).toFixed(0)} KB），仅支持编辑 512 KB 以内的文本文件`)
        } else if (!TEXT_EXT.test(path) && /\0/.test(t.slice(0, 4096))) {
          setError('二进制文件不支持在线编辑')
        } else {
          setContent(t)
        }
      })
      .catch((e: any) => !cancelled && setError(e?.message || '读取失败'))
    return () => { cancelled = true }
  }, [podName, path])

  const save = async () => {
    if (content == null) return
    setSaving(true)
    try {
      await api.put(`/pods/${podName}/files/save`, { path, content })
      dirty.current = false
      toast({ type: 'success', message: `已保存 ${path.split('/').pop()}` })
    } catch (e: any) {
      toast({ type: 'error', message: e?.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> 返回</Button>
        <span className="text-sm font-mono text-ink-2 truncate" title={path}>{path}</span>
        <div className="flex-1" />
        {content != null && (
          <button
            onClick={handleAiExplain}
            disabled={aiLoading}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
          >
            {aiLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {aiLoading ? '分析中...' : 'AI 解释'}
          </button>
        )}
        {content != null && (
          <Button size="sm" onClick={save} loading={saving}>
            <Save size={13} /> 保存{dirty.current ? ' *' : ''}
          </Button>
        )}
      </div>
      {aiExplain && (
        <div className="mb-3 p-3 rounded-lg bg-accent/5 border border-accent/10 text-sm whitespace-pre-wrap">
          <div className="flex items-center gap-1 mb-1 text-xs font-semibold text-accent"><Sparkles size={12} /> AI 解释</div>
          {aiExplain}
        </div>
      )}
      {error ? (
        <p className="text-sm text-bad py-8 text-center">{error}</p>
      ) : content == null ? (
        <Skeleton height={400} />
      ) : (
        <div className="rounded-xl overflow-hidden">
          <CodeEditor
            value={content}
            language={langOf(path)}
            onChange={(v) => { setContent(v); dirty.current = true }}
            className="min-h-[480px]"
          />
        </div>
      )}
    </div>
  )
}
