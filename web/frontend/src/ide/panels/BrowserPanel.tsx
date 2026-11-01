/**
 * IDE 内置浏览器面板:浏览 Pod 内本地端口上跑的服务(开发服务器、
 * 应用页面、API 文档等),也可预览 /home/cloud 与 /shared 下的 HTML 文件。
 *
 * 请求全部走同源后端代理:
 *   - 端口浏览:GET /api/pods/<pod>/proxy/<port>/<path>?<qs>
 *     (后端只打该 Pod 自己的 IP,member 权限,只读 GET)
 *   - 文件预览:GET /api/pods/<pod>/files/raw?path=<p>(同编辑器预览)
 *
 * 输入框格式(自动归一化):
 *   3000 | :3000 | localhost:3000 | 127.0.0.1:3000
 *   3000/admin | localhost:3000/index.html
 *   /home/cloud/web/index.html(以 / 开头视为文件路径,走 files/raw)
 *
 * 上次地址按 Pod 持久化(localStorage),重挂载(手机切 tab)后恢复。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, RotateCw, ExternalLink, CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PanelProps } from '../types'

const URL_KEY = (podName: string) => `yatterra.ide.browser.${podName}`

/** 把用户输入归一化成 { port, path } 或 { filePath };非法返回 null */
function parseInput(raw: string): { port: number; path: string } | { filePath: string } | null {
  const s = raw.trim()
  if (!s) return null
  // 以 / 开头 → 文件路径预览
  if (s.startsWith('/')) return { filePath: s }
  // 去掉协议与主机名,只留 :port/path
  const noProto = s.replace(/^https?:\/\//i, '')
  const m = noProto.match(/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?(?::(\d+))?(?:$|[/?#])(.*)$/i)
  if (!m) return null
  const port = Number(m[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const rest = m[2] ?? ''
  // m[2] 从 / 或 ? 或 # 之后开始;没有主机分隔符时(纯 "3000")为空
  const path = rest.startsWith('/') ? rest : rest ? `/${rest}` : ''
  return { port, path }
}

export function BrowserPanel({ podName, surface }: PanelProps) {
  const mobile = surface === 'mobile'
  const [input, setInput] = useState('')
  const [nonce, setNonce] = useState(0)
  const [error, setError] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)
  /** 当前加载的归一化目标(null = 未加载) */
  const [target, setTarget] = useState<{ port: number; path: string } | { filePath: string } | null>(null)

  // 恢复上次地址(仅首次挂载;手机渲染器会卸载不可见面板)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(URL_KEY(podName))
      if (saved) {
        setInput(saved)
        const t = parseInput(saved)
        if (t) setTarget(t)
      }
    } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navigate = (raw?: string) => {
    const t = parseInput(raw ?? input)
    if (!t) {
      setError('格式:3000 / localhost:3000/path / /home/cloud/x.html')
      return
    }
    setError('')
    setTarget(t)
    setNonce((n) => n + 1)
    try { localStorage.setItem(URL_KEY(podName), (raw ?? input).trim()) } catch { /* ignore */ }
  }

  const src = useMemo(() => {
    if (!target) return null
    if ('filePath' in target) {
      return `/api/pods/${podName}/files/raw?path=${encodeURIComponent(target.filePath)}`
    }
    return `/api/pods/${podName}/proxy/${target.port}${target.path || '/'}`
  }, [target, podName])

  const label = target
    ? 'filePath' in target
      ? target.filePath
      : `localhost:${target.port}${target.path || '/'}`
    : ''

  const inputH = mobile ? 'h-10 text-[13px]' : 'h-8 text-xs'

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-surface-1 overflow-hidden">
      {/* 地址栏 */}
      <div
        className="flex items-center gap-1 shrink-0 px-1.5 py-1 border-b"
        style={{ background: 'var(--ide-bg)', borderColor: 'var(--ide-line)' }}
      >
        <Globe size={14} className="shrink-0" style={{ color: 'var(--ide-mut)' }} />
        <div className="relative flex-1 min-w-0">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate() }}
            placeholder="localhost:3000 或 /home/cloud/page.html"
            spellCheck={false}
            autoComplete="off"
            className={cn(
              'w-full px-2.5 rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-accent/25',
              inputH,
            )}
            style={{ background: 'rgba(127,127,127,0.08)', color: 'var(--ide-ink)' }}
          />
        </div>
        <button
          type="button"
          aria-label="前往"
          onClick={() => navigate()}
          className={cn(
            'flex items-center justify-center rounded-lg transition-colors',
            mobile ? 'w-10 h-10' : 'w-8 h-8',
          )}
          style={{ color: 'var(--ide-accent)' }}
        >
          <CornerDownLeft size={mobile ? 16 : 14} />
        </button>
        <button
          type="button"
          aria-label="刷新"
          disabled={!target}
          onClick={() => setNonce((n) => n + 1)}
          className={cn(
            'flex items-center justify-center rounded-lg transition-colors disabled:opacity-30',
            mobile ? 'w-10 h-10' : 'w-8 h-8',
          )}
          style={{ color: 'var(--ide-mut)' }}
        >
          <RotateCw size={mobile ? 16 : 14} />
        </button>
        {src && !mobile && (
          <button
            type="button"
            aria-label="新标签页打开"
            title="新标签页打开"
            onClick={() => window.open(src, '_blank', 'noopener')}
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ color: 'var(--ide-mut)' }}
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {/* 状态/错误条 */}
      {(error || label) && (
        <div
          className="shrink-0 px-3 py-1 text-[11px] truncate border-b"
          style={{
            borderColor: 'var(--ide-line)',
            color: error ? 'var(--bad, #e5484d)' : 'var(--ide-mut)',
            background: error ? 'rgba(229,72,77,0.06)' : undefined,
          }}
        >
          {error || label}
        </div>
      )}

      {/* 视口 */}
      <div className="flex-1 min-h-0 relative">
        {src ? (
          // 不给 allow-same-origin:被浏览的是 Pod 里任意学生代码,若与平台
          // 同源,其 JS 可拿会话 cookie 冒充用户调平台 API。opaque origin +
          // SameSite cookie 已足够挡住;代价是 iframe 内 localStorage 不可用。
          <iframe
            ref={frameRef}
            key={nonce}
            src={src}
            title={label}
            className="absolute inset-0 w-full h-full bg-white"
            sandbox="allow-forms allow-scripts allow-popups allow-modals allow-downloads"
          />
        ) : (
          <div className="absolute inset-0 ide-empty flex flex-col items-center justify-center gap-2 px-6 text-center select-none">
            <Globe size={22} style={{ color: 'var(--ide-mut)', opacity: 0.5 }} />
            <p className="ide-cmt text-[13px]">// 输入 Pod 内端口,如 localhost:3000</p>
            <p className="ide-cmt ide-cmt-dim text-[12px]">// 或 /home/cloud/xxx.html 预览本地文件</p>
          </div>
        )}
      </div>
    </div>
  )
}
