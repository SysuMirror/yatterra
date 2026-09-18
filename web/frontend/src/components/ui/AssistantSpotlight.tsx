import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { rendered } from '@/lib/assistantControl'

export function AssistantSpotlight({ element, label, close }: { element: HTMLElement; label: string; close: () => void }) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    let frame = 0
    const update = () => {
      if (!rendered(element)) { close(); return }
      const r = element.getBoundingClientRect(), v = window.visualViewport
      let left = Math.max(r.left, v?.offsetLeft ?? 0), top = Math.max(r.top, v?.offsetTop ?? 0)
      let right = Math.min(r.right, (v?.offsetLeft ?? 0) + (v?.width ?? innerWidth))
      let bottom = Math.min(r.bottom, (v?.offsetTop ?? 0) + (v?.height ?? innerHeight))
      for (let p = element.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p), b = p.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left,b.left); right = Math.min(right,b.right) }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top,b.top); bottom = Math.min(bottom,b.bottom) }
      }
      setRect(right > left && bottom > top ? { left, top, width: right-left, height: bottom-top } : null)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    const observer = new ResizeObserver(schedule); observer.observe(element)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize',schedule); window.visualViewport?.addEventListener('scroll',schedule)
    const timer = setTimeout(close,30000)
    schedule()
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); window.removeEventListener('scroll',schedule,true); window.removeEventListener('resize',schedule); window.visualViewport?.removeEventListener('resize',schedule); window.visualViewport?.removeEventListener('scroll',schedule) }
  }, [element, close])
  return createPortal(<div data-assistant-ui className="pointer-events-none fixed inset-0 z-[var(--z-popover)]">
    {rect && <div data-assistant-spotlight aria-hidden="true" className="fixed rounded-lg border-2 border-accent bg-accent/15 shadow-[0_0_0_4px_rgba(10,132,255,.12)]" style={rect}/>}
    <div className="pointer-events-auto fixed left-3 bottom-[calc(var(--mobile-tabbar-h,0px)+1rem)] max-w-[70vw] rounded-xl border border-accent/30 bg-white/90 p-3 text-sm shadow-lg backdrop-blur-md" role="status">
      <span>{label}</span><button type="button" onClick={close} aria-label="关闭助手标记" className="ml-3 rounded px-2 py-1 bg-black/5">关闭</button>
    </div>
  </div>, document.body)
}
