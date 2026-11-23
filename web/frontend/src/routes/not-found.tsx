import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Home, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { APP_ROUTES } from '@/lib/appRoutes'
import { recoveryPath } from '@/lib/uxRecover'

export default function NotFound() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const staticPaths = useMemo(() => APP_ROUTES.filter((route) => !route.path.includes(':')).map((route) => route.path), [])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return APP_ROUTES.filter((route) => {
      if (!q) return true
      return route.label.toLowerCase().includes(q) || route.path.toLowerCase().includes(q)
    }).map((route) => ({ ...route, href: recoveryPath(route.path, staticPaths) }))
  }, [query, staticPaths])

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 py-16">
      <span className="text-6xl font-bold text-muted/30">404</span>
      <h2 className="text-xl font-semibold">页面未找到</h2>
      <p className="text-sm text-muted">地址不对。按名称找回控制台页面，或回到上一页。</p>
      <div data-ux="ux-notfound-recover" className="rounded-2xl border border-black/10 p-3">
        <label className="block text-xs text-muted mb-2" htmlFor="ux-notfound-query">找回页面</label>
        <input
          id="ux-notfound-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例如 审计、GPU、Pod"
          className="h-10 w-full rounded-lg border border-black/10 bg-transparent px-3 text-sm"
        />
        <ul className="mt-3 max-h-64 space-y-1 overflow-auto">
          {matches.map((route) => (
            <li key={route.path}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-black/[0.04]"
                onClick={() => navigate(route.href)}
              >
                <span>{route.label}</span>
                <span className="font-mono text-xs text-muted">{route.path}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="px-2 py-3 text-sm text-muted">没有名称匹配的页面</li>}
        </ul>
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> 返回
        </Button>
        <Button size="sm" onClick={() => navigate('/console')}>
          <Home size={14} /> 首页
        </Button>
      </div>
    </div>
  )
}
