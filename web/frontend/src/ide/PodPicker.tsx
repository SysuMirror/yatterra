/**
 * IDE 内 Pod 切换器(全局单例)。
 *
 * 触发(三处 → 同一个窗口事件 openPodPicker):
 *  - IDE 顶栏的 pod 名(桌面 IdeShell / 手机 MobileIdeLayout),名字右侧 ▾
 *  - 手机平台底栏「IDE」Tab 长按
 *  - 桌面侧栏「IDE」项右键
 *
 * 呈现:Dialog —— 桌面居中模态 / 手机底部 Sheet(复用平台质感与动效),
 * 顶部带搜索框(几十个 Pod 时比纯菜单好用),下方「最近」+「全部 Pod」两组。
 * 行内:当前 Pod 打 ✓、右侧状态点 + 我的角色。
 *
 * 选择 → navigate(`/pods/<name>/ide`);每个 Pod 的 IDE 布局本来就分开存
 * (`yatterra.ide.layout.<pod>`),所以切换互不影响对方的开面板/活动 Tab 等状态。
 *
 * 「最近」由 IdeShell 进入 Pod 时写入(rememberPod,MRU 最多 5 个)。
 * 底部的「浏览全部 Pod」指向 /pods 列表页而不是 /ide —— /ide 有 lastPod 时会
 * 直接跳回 IDE(见 routes/ide.tsx),拿不到列表。
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight } from 'lucide-react'
import { api } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { SearchBar } from '@/components/ui/SearchBar'
import { Badge } from '@/components/ui/Badge'
import { podStatusLabel } from '@/lib/format'
import { haptic } from '@/lib/haptic'
import { cn } from '@/lib/cn'

const POD_PICKER_EVENT = 'yatterra:pod-picker'
export const RECENT_PODS_KEY = 'yatterra.ide.recentPods'
/** 与 routes/ide.tsx / IdeShell 写的是同一个 key(/ide 入口页据此直达)。 */
const LAST_POD_KEY = 'yatterra.ide.lastPod'
const RECENT_MAX = 5

export interface PodLite {
  name: string
  status?: string
  my_role?: string | null
}

const STATUS_VARIANT: Record<string, 'ok' | 'muted' | 'warn' | 'bad'> = {
  Running: 'ok',
  Stopped: 'muted',
  Pending: 'warn',
  Failed: 'bad',
  Succeeded: 'ok',
}

const ROLE_LABEL: Record<string, string> = {
  owner: '负责人',
  admin: '管理员',
  super: '管理员',
  member: '成员',
}

/** 最近打开的 Pod(最新的在前;解析失败/类型不对当空)。 */
export function readRecentPods(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_PODS_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string' && !!x).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** 记住最近打开的 Pod(MRU,最多 5;已存在则提到最前)。 */
export function rememberPod(name: string) {
  if (!name) return
  try {
    const next = [name, ...readRecentPods().filter((n) => n !== name)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_PODS_KEY, JSON.stringify(next))
  } catch { /* localStorage 不可用时静默降级 */ }
}

/** 唤起切换器(任意页面 / 任意触发点)。 */
export function openPodPicker() {
  window.dispatchEvent(new CustomEvent(POD_PICKER_EVENT))
}

/** 全局挂载一次(routes/_layout.tsx):让任何 openPodPicker() 都有落点。 */
export function PodPickerHost() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const h = () => setOpen(true)
    window.addEventListener(POD_PICKER_EVENT, h)
    return () => window.removeEventListener(POD_PICKER_EVENT, h)
  }, [])
  return <PodPicker open={open} onClose={() => setOpen(false)} />
}

/** 当前所在 Pod:IDE 页面取路径,其它页面(底栏/侧栏长按)回退到 lastPod。 */
function currentPodName(pathname: string): string | null {
  const m = /^\/pods\/([^/]+)\/ide\/?$/.exec(pathname)
  if (m?.[1]) return decodeURIComponent(m[1])
  try { return localStorage.getItem(LAST_POD_KEY) } catch { return null }
}

function PodPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [q, setQ] = useState('')

  useEffect(() => { if (open) setQ('') }, [open])

  const { data, isLoading } = useQuery<{ pods: PodLite[] }>({
    queryKey: ['ide-pods'],
    queryFn: () => api.get('/pods?per_page=100'),
    enabled: open,
    staleTime: 30_000,
  })

  const pods = useMemo(() => data?.pods ?? [], [data])
  const byName = useMemo(() => new Map(pods.map((p) => [p.name, p])), [pods])
  const current = currentPodName(location.pathname)

  const kw = q.trim().toLowerCase()
  const matched = useMemo(
    () => (kw ? pods.filter((p) => p.name.toLowerCase().includes(kw)) : pods),
    [pods, kw],
  )

  // 「最近」只列仍然可见(有权限 / 未被删除)的 Pod,避免点了 403
  const recent = useMemo(
    () => (kw ? [] : readRecentPods().map((n) => byName.get(n)).filter((p): p is PodLite => !!p)),
    [kw, byName],
  )
  const recentNames = useMemo(() => new Set(recent.map((p) => p.name)), [recent])
  const rest = useMemo(
    () => (kw ? matched : matched.filter((p) => !recentNames.has(p.name))),
    [kw, matched, recentNames],
  )

  const pick = (name: string) => {
    haptic('selection')
    onClose()
    if (name === current && /\/ide\/?$/.test(location.pathname)) return
    navigate(`/pods/${encodeURIComponent(name)}/ide`)
  }

  return (
    <Dialog open={open} onClose={onClose} title="切换 Pod" description="各 Pod 的 IDE 布局独立保存" width="max-w-md">
      <SearchBar value={q} onChange={setQ} placeholder="搜索 Pod…" className="mb-3" />

      {isLoading && pods.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted">加载中…</div>
      ) : matched.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted">
          {kw ? `没有匹配「${q.trim()}」的 Pod` : '还没有可访问的 Pod'}
        </div>
      ) : (
        <div className="space-y-3">
          {recent.length > 0 && (
            <Group title="最近">
              {recent.map((p) => (
                <PodRow key={p.name} pod={p} current={p.name === current} onPick={pick} />
              ))}
            </Group>
          )}
          {rest.length > 0 && (
            <Group title={kw ? '搜索结果' : '全部 Pod'}>
              {rest.map((p) => (
                <PodRow key={p.name} pod={p} current={p.name === current} onPick={pick} />
              ))}
            </Group>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => { haptic('light'); onClose(); navigate('/pods') }}
        className="mt-3 w-full flex items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-medium text-accent hover:bg-accent/8 active:bg-accent/12 transition-colors"
      >
        浏览全部 Pod
        <ChevronRight size={14} />
      </button>
    </Dialog>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function PodRow({ pod, current, onPick }: { pod: PodLite; current: boolean; onPick: (name: string) => void }) {
  const role = pod.my_role ? ROLE_LABEL[pod.my_role] : null
  return (
    <button
      type="button"
      onClick={() => onPick(pod.name)}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98]',
        current ? 'bg-accent/8' : 'hover:bg-black/[0.04] active:bg-black/[0.06]',
      )}
    >
      <span className="w-4 h-4 shrink-0 grid place-items-center">
        {current && <Check size={15} className="text-accent" />}
      </span>
      <span className="min-w-0 flex-1 font-mono text-[13px] font-medium text-ink truncate" title={pod.name}>
        {pod.name}
      </span>
      {role && <span className="shrink-0 text-[11px] text-muted">{role}</span>}
      {pod.status && (
        <Badge variant={STATUS_VARIANT[pod.status] ?? 'muted'} dot>
          {podStatusLabel(pod.status)}
        </Badge>
      )}
    </button>
  )
}
