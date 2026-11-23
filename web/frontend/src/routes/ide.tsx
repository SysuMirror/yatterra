/**
 * /ide — Web IDE 入口页。
 * 有最近打开的 pod 且仍可访问 → 直达其 IDE;否则列出 pod 供选择。
 * 真正的 IDE 在 /pods/:name/ide(IdeShell)。
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Code2, ChevronRight } from 'lucide-react'
import { api } from '@/api/client'
import { usePageAiAllowed } from '@/lib/pagePerms'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'

export const LAST_POD_KEY = 'yatterra.ide.lastPod'

interface Pod {
  name: string
  status?: string
  image?: string
}

export default function IdeLandingPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery<{ pods: Pod[] }>({
    queryKey: ['ide-pods'],
    queryFn: () => api.get('/pods?per_page=200'),
  })
  const aiAllowed = usePageAiAllowed('pod_ide')

  const [query, setQuery] = useState('')
  const pods = data?.pods ?? []
  const lastPod = (() => {
    try { return localStorage.getItem(LAST_POD_KEY) } catch { return null }
  })()
  const lastOk = lastPod && pods.some((p) => p.name === lastPod)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return pods.filter((pod) => !q || pod.name.toLowerCase().includes(q) || (pod.image || '').toLowerCase().includes(q))
  }, [pods, query])

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      {aiAllowed && (
        <PageAiAssistant page="pod_ide" context="IDE 入口页: 用户在挑选 pod 进入 Web IDE" />
      )}
      <div className="flex items-center gap-2 mb-4">
        <Code2 size={20} className="text-primary" />
        <h1 className="text-lg font-semibold">Web IDE</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">选择一个 Pod 进入在线开发环境。上次打开的环境留在这里，不会自动跳走。</p>
      <div data-ux="ux-ide-chooser" className="mb-4 space-y-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按名称或镜像筛选" className="h-10 w-full rounded-lg border border-border bg-transparent px-3 text-sm" />
        {lastOk && (
          <button type="button" className="flex w-full items-center justify-between rounded-lg bg-primary/10 px-4 py-3 text-left" onClick={() => navigate(`/pods/${lastPod}/ide`)}>
            <span>继续上次的 {lastPod}</span>
            <ChevronRight size={16} />
          </button>
        )}
      </div>
      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">加载中…</div>
      ) : pods.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          还没有 Pod,先去 <Link className="text-primary underline" to="/pods">Pod 列表</Link> 创建一个
        </div>
      ) : (
        <div className="grid gap-2">
          {shown.map((pod) => (
            <Link
              key={pod.name}
              to={`/pods/${pod.name}/ide`}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:bg-accent transition-colors"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{pod.name}</div>
                {pod.image && <div className="text-xs text-muted-foreground truncate">{pod.image}</div>}
              </div>
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
