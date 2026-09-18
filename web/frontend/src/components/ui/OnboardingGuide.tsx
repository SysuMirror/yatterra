import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HelpCircle, X } from 'lucide-react'
import { useLocation } from 'react-router'
import { useAuthStore } from '@/stores/auth'
import { Portal } from '@/components/ui/Portal'

type Step = {
  target: string
  title: string
  description: string
  optional?: boolean
  // Completion is checked against a real rendered control/state marker when available.
  doneTarget?: string
}
const step = (target: string, title: string, description: string, optional = false, doneTarget?: string): Step => ({ target, title, description, optional, doneTarget })
const docs = (description: string) => step('page-docs', '打开对应文档', description, true)

// A short, task-based path. Targets are real controls; optional items disappear when
// the current account or resource has no such capability.
const guides: Record<string, Step[]> = {
  '/': [
    step('goto-/pods', '先找到 Pod', 'Pod 是你的开发环境。先打开 Pod 页面，查看已有环境或创建一个新的。'),
    step('page-docs', '需要时查文档', '文档按任务组织；遇到权限、空列表或加载失败时，先看页面提示，不要猜测命令。', true),
  ],
  '/pods': [
    step('pods-create', '创建一个 Pod', '填写名称和资源规格后提交。GPU、内存和存储按实际工作负载选择，创建结果会进入 Pod 详情。', false, 'pods-created'),
    step('pods-search', '找到你的 Pod', '用名称搜索；状态筛选可定位运行中、等待中或失败的环境。列表为空时先清除筛选。'),
    step('pods-status', '确认状态', '以列表中的状态徽标为准。Pending 表示仍在调度，Failed 请打开详情查看日志或资源原因。', true),
  ],
  '/pods/:name': [
    step('pod-tab-connect', '连接 Pod', '连接页会显示当前 Pod 已分配的 SSH 命令、密码和 Web 地址（如果提供）。只复制并使用界面显示的准确值；不要自行拼接主机、端口或其他端点。'),
    step('pod-tab-terminal', '使用浏览器终端', '终端标签页提供浏览器终端（当前 Pod 已加载且权限允许时）。在终端中执行命令前确认路径和作用范围。'),
    step('pod-tab-files', '管理文件', '文件页用于浏览、编辑或上传允许目录中的文件。只操作你有权限的路径；不要把密码或 Token 写进文件、截图或日志。'),
    step('pod-tab-settings', '修改环境变量', '设置页的环境变量区域可添加或删除变量。敏感值不要暴露给他人；页面提示环境变量修改需重启 Pod 后生效。'),
    step('pod-tab-deploys', '打开部署管理', '部署页管理应用部署。先选择仓库或本地 deploy.sh，再配置健康检查；提交后用部署状态、启动/停止和部署日志确认结果。'),
    step('deploy-create', '创建部署', '点击「创建部署」打开表单。部署来源可以是仓库或本地脚本；私有仓库 Token 只填入密码字段，不要写进脚本或截图。'),
    step('deploy-script', '填写 deploy.sh', '本地来源填写界面要求的 deploy.sh 路径，并确保脚本位于可访问位置且可执行。仓库来源按页面字段填写，不要猜测额外 URL。'),
    step('deploy-submit', '提交部署配置', '填写必要字段后点击「确认」。健康检查路径按应用实际提供的路径填写；留空表示不配置健康检查。'),
    step('pod-tab-logs', '查看容器日志', '日志标签页查看容器 stdout/stderr。部署卡片中的日志是该部署运行日志；两者来源不同，按对应时间和错误排查。'),
    step('pod-tab-app-logs', '查看应用日志', '应用日志标签页查看服务输出。若没有日志，先确认应用确实启动并把输出写到平台读取的日志来源。', true),
  ],
  '/docs': [
    step('docs-section', '按任务打开文档', '展开快速开始、Pod、连接与部署章节，优先阅读与你当前页面对应的条目。'),
    step('docs-item', '核对页面实际能力', '文档不会承诺未在界面中暴露的连接、市场或云端操作；看到“未提供/未验证”时请按页面提示处理。', true),
  ],
}

const STORAGE_KEY = 'sseinfra_onboarding_v4'

function completed(user: string, page: string): boolean {
  try { return localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`) === 'done' } catch { return false }
}
function finish(user: string, page: string) {
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`, 'done') } catch { /* private browsing / quota */ }
}
function skippedIndex(user: string, page: string, length: number): number {
  try {
    const value = Number(localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`))
    return Number.isFinite(value) ? Math.min(length - 1, Math.max(0, Math.floor(value))) : 0
  } catch { return 0 }
}
function wasSkipped(user: string, page: string): boolean {
  try { return localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`) === '1' } catch { return false }
}
function restart(user: string, page: string) {
  try { localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`); localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`) } catch { /* private browsing / quota */ }
}
function skip(user: string, page: string, index: number) {
  // Closing or skipping is not completion: replay from the saved point later.
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`, '1'); localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`, String(index)) } catch { /* private browsing / quota */ }
}

function rendered(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
  }
  return true
}
function viewport() {
  const v = window.visualViewport
  return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight }
}
// Intersect overflow ancestors as well as the viewport (main and horizontal tabs scroll independently).
function visibleRect(el: HTMLElement) {
  const r = el.getBoundingClientRect(), v = viewport()
  let left = Math.max(r.left, v.left), right = Math.min(r.right, v.left + v.width)
  let top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.top + v.height)
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p), b = p.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right) }
    if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom) }
  }
  return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
type Geometry = { left: number; top: number; width: number; height: number; x: number; y: number; arrow: number; above: boolean; maxHeight: number }

export function OnboardingGuide() {
  const { pathname, key } = useLocation()
  const user = useAuthStore(s => s.user)
  const loggedIn = useAuthStore(s => s.isLoggedIn)
  const path = pathname.replace(/\/$/, '') || '/'
  const page = /^\/pods\/[^/]+$/.test(path) ? '/pods/:name' : path
  if (!loggedIn || !user || !guides[page]) return null
  // A keyed instance synchronously discards bubbles, timers and progress on navigation / identity change.
  return <PageGuide key={`${user}:${pathname}:${key}`} user={user} page={page} pathname={pathname} steps={guides[page]!} />
}

function PageGuide({ user, page, pathname, steps }: { user: string; page: string; pathname: string; steps: Step[] }) {
  const [open, setOpen] = useState(() => !completed(user, page) && !wasSkipped(user, page))
  const [index, setIndex] = useState(() => skippedIndex(user, page, steps.length))
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const replay = useRef<HTMLButtonElement>(null)
  const scrollRequested = useRef(true)
  const current = steps[index]!
  const close = (completed = false) => {
    if (bubble.current?.contains(document.activeElement)) replay.current?.focus({ preventScroll: true })
    if (completed) finish(user, page)
    else { skip(user, page, index); setOpen(false) }
    setOpen(false)
  }
  const advance = (next: number) => {
    scrollRequested.current = true
    setGeometry(null)
    setIndex(next)
  }

  useLayoutEffect(() => {
    let frame = 0, target: HTMLElement | null = null, missingSince = performance.now()
    let disposed = false
    const ro = new ResizeObserver(() => schedule())
    const update = () => {
      if (disposed) return
      const root = Array.from(document.querySelectorAll<HTMLElement>('[data-onboarding-page]')).find(el => el.dataset.onboardingPage === pathname)
      const suppressed = !!root?.querySelector('[data-onboarding-unavailable]')
      setUnavailable(suppressed)
      if (suppressed || !open) { setGeometry(prev => prev === null ? prev : null); return }
      const done = current.doneTarget && root?.querySelector(`[data-onboarding-state=\"${current.doneTarget}\"]`)
      if (done && rendered(done as HTMLElement)) {
        if (index < steps.length - 1) { scrollRequested.current = true; setIndex(index + 1) }
        else { finish(user, page); setOpen(false) }
        return
      }
      const targetRoot = current.target.startsWith('deploy-') ? document : (root || document)
      const candidates = Array.from(targetRoot.querySelectorAll<HTMLElement>(`[data-onboarding-target="${current.target}"]`)).filter(rendered)
      const next = candidates.find(el => { const r = visibleRect(el); return r.width > 4 && r.height > 4 }) ?? candidates[0] ?? null
      if (target !== next) {
        if (target) ro.unobserve(target)
        target = next
        if (target) ro.observe(target)
      }
      // Let dialogs, menus, drawers and the assistant own their interaction surface.
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="listbox"], [role="menu"], [data-onboarding-overlay]')).some(rendered)
      if (!target || (overlay && !current.target.startsWith('deploy-'))) {
        setGeometry(prev => prev === null ? prev : null)
        if (!target && current.optional && performance.now() - missingSince > 2200) {
          if (index < steps.length - 1) {
            scrollRequested.current = true
            setIndex(index + 1)
          } else {
            finish(user, page)
            setOpen(false)
          }
        }
        return
      }
      missingSince = performance.now()
      let r = visibleRect(target)
      if (scrollRequested.current) {
        scrollRequested.current = false
        const full = target.getBoundingClientRect()
        if (r.width < full.width - 2 || r.height < full.height - 2) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        r = visibleRect(target)
      }
      if (r.width < 4 || r.height < 4) { setGeometry(prev => prev === null ? prev : null); return }
      const v = viewport(), margin = 12, gap = 14
      const width = Math.min(320, v.width - margin * 2)
      const below = v.top + v.height - margin - r.bottom - gap
      const aboveSpace = r.top - v.top - margin - gap
      const naturalHeight = (bubble.current?.lastElementChild?.scrollHeight ?? 0) + 2
      const above = below < naturalHeight && aboveSpace > below
      const maxHeight = Math.max(0, above ? aboveSpace : below)
      // If the keyboard / a giant target leaves no usable space, don't cover the control.
      if (maxHeight < 110) { setGeometry(prev => prev === null ? prev : null); return }
      const height = Math.min(naturalHeight, maxHeight)
      const x = Math.max(v.left + margin, Math.min(v.left + v.width - margin - width, r.left + r.width / 2 - width / 2))
      const y = above ? r.top - gap - height : r.bottom + gap
      const nextGeometry = { left: r.left, top: r.top, width: r.width, height: r.height, x, y, arrow: Math.max(14, Math.min(width - 14, r.left + r.width / 2 - x)), above, maxHeight }
      setGeometry(prev => prev && Object.keys(nextGeometry).every(k => prev[k as keyof Geometry] === nextGeometry[k as keyof Geometry]) ? prev : nextGeometry)
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    if (bubble.current) ro.observe(bubble.current)
    const mo = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-onboarding-ui]'))) schedule()
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-modal', 'aria-expanded'] })
    // A low-frequency check handles late mounts, CSS transitions and missing optional controls.
    const timer = open ? window.setInterval(schedule, 250) : undefined
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearInterval(timer); mo.disconnect(); ro.disconnect()
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, index, current, pathname, steps, user, page])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // No global arrow shortcuts: inputs, terminals, selects and editors retain their keys.
      if (event.key !== 'Escape' || event.defaultPrevented || !geometry) return
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (unavailable) return null

  return <Portal>
    <button ref={replay} type="button" data-onboarding-ui aria-label={open ? '关闭本页指引' : '重新打开当前页面的新手指引'}
      onClick={() => { if (open) close(); else { setGeometry(null); scrollRequested.current = true; setOpen(true) } }}
      className="fixed right-20 bottom-[calc(var(--mobile-tabbar-h)+0.75rem)] z-[var(--z-fab)] flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-3 py-2 text-xs text-ink-2 shadow-2 backdrop-blur-md md:top-auto md:bottom-6 md:right-24">
      <HelpCircle size={14} />{open ? '关闭指引' : (wasSkipped(user, page) ? '继续学习' : '本页指引')}
    </button>
    {!open && wasSkipped(user, page) && <button type="button" data-onboarding-ui onClick={() => { restart(user, page); setIndex(0); setGeometry(null); scrollRequested.current = true; setOpen(true) }} className="fixed right-20 bottom-[calc(var(--mobile-tabbar-h)+4.25rem)] z-[var(--z-fab)] rounded-full border border-black/10 bg-white/80 px-3 py-2 text-xs text-ink-2 shadow-2 backdrop-blur-md md:top-auto md:bottom-20 md:right-24">重新开始</button>}
    {open && <>
      {geometry && <div data-onboarding-ui aria-hidden="true" className="pointer-events-none fixed rounded-lg border-2 border-accent/70 shadow-[0_0_0_4px_rgba(10,132,255,0.12)]" style={{ zIndex: 'var(--z-popover)', left: geometry.left - 3, top: geometry.top - 3, width: geometry.width + 6, height: geometry.height + 6 }} />}
      <div ref={bubble} data-onboarding-ui data-onboarding-active-target={current.target} role="dialog" aria-modal="false" aria-labelledby="onboarding-title" aria-describedby="onboarding-description"
        className="fixed rounded-2xl border border-white/70 bg-white/80 text-ink shadow-[0_12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl"
        style={{ zIndex: 'var(--z-popover)', width: Math.min(320, viewport().width - 24), left: geometry?.x ?? 0, top: geometry?.y ?? 0, visibility: geometry ? 'visible' : 'hidden', pointerEvents: geometry ? 'auto' : 'none' }}>
        {geometry && <span data-onboarding-arrow aria-hidden="true" className="pointer-events-none absolute h-3 w-3 rotate-45 border-white/70 bg-white/80" style={{ left: geometry.arrow - 6, [geometry.above ? 'bottom' : 'top']: -7, borderWidth: geometry.above ? '0 1px 1px 0' : '1px 0 0 1px' }} />}
        <div className="relative overflow-y-auto p-4" style={{ maxHeight: geometry ? geometry.maxHeight - 2 : undefined }}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-accent">本页指引 · {index + 1} / {steps.length}</span>
            <button type="button" aria-label="关闭本页指引" onClick={() => close(false)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/5"><X size={15} /></button>
          </div>
          <div aria-live="polite" aria-atomic="true">
            <h2 id="onboarding-title" className="mt-1 text-base font-bold">{current.title}</h2>
            <p id="onboarding-description" className="mt-2 text-xs leading-5 text-ink-2">{current.description}</p>
          </div>
          {(current.target === 'pod-tab-deploys' || current.target.startsWith('deploy-')) && (
            <button type="button" onClick={() => {
              document.querySelector<HTMLElement>('[data-onboarding-target="pod-tab-deploys"]')?.click()
              if (current.target !== 'pod-tab-deploys') document.querySelector<HTMLElement>('[data-onboarding-target="deploy-create"]')?.click()
            }} className="mb-3 w-full rounded-lg border border-accent/30 px-2 py-2 text-xs text-accent hover:bg-accent/5">
              {current.target === 'pod-tab-deploys' ? '打开部署标签（不会提交）' : '打开部署表单（不会提交）'}
            </button>
          )}
          <div className="mt-4 flex items-center justify-between gap-2">
            <button type="button" onClick={() => close(false)} className="rounded-lg px-2 py-2 text-xs text-muted">跳过本页</button>
            <div className="flex gap-1">
              {index > 0 && <button type="button" onClick={() => advance(index - 1)} className="rounded-lg px-2 py-2 text-xs hover:bg-black/5">上一步</button>}
              <button type="button" onClick={() => index === steps.length - 1 ? close(true) : advance(index + 1)} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white">{index === steps.length - 1 ? '已读' : '下一步'}</button>
            </div>
          </div>
        </div>
      </div>
    </>}
  </Portal>
}
