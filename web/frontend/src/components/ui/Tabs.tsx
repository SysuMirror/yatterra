import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

interface Tab {
  key: string
  label: string
  icon?: React.ReactNode
}

interface TabsProps {
  tabs: Tab[]
  active: string
  onChange: (key: string) => void
  className?: string
  /** Enable horizontal swipe to switch tabs (mobile-friendly). */
  swipeable?: boolean
}

export function Tabs({ tabs, active, onChange, className, swipeable = false }: TabsProps) {
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })
  const [showScrollHint, setShowScrollHint] = useState(false)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const containerRef = useRef<HTMLDivElement>(null)

  const activeIndex = tabs.findIndex((t) => t.key === active)

  useEffect(() => {
    const el = refs.current[active]
    if (el) {
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
      // Scroll active tab into view
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [active, tabs])

  // Detect horizontal overflow for scroll hint
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const checkOverflow = () => {
      const hasOverflow = container.scrollWidth > container.clientWidth + 4
      const atEnd = container.scrollLeft + container.clientWidth >= container.scrollWidth - 4
      setShowScrollHint(hasOverflow && !atEnd)
    }

    checkOverflow()
    container.addEventListener('scroll', checkOverflow, { passive: true })

    // Re-check on resize
    const ro = new ResizeObserver(checkOverflow)
    ro.observe(container)

    return () => {
      container.removeEventListener('scroll', checkOverflow)
      ro.disconnect()
    }
  }, [tabs])

  // ── Swipe-to-switch-tab gesture ──
  const swipeBind = useDrag(
    ({ movement: [mx], velocity: [vx], active: dragging, cancel }) => {
      if (!swipeable || !dragging) return
      // Only fire on release
      if (dragging) return

      // Swipe left → next tab, swipe right → prev tab
      if (mx < -40 || (mx < -20 && vx < -0.3)) {
        const next = tabs[activeIndex + 1]
        if (next) onChange(next.key)
      } else if (mx > 40 || (mx > 20 && vx > 0.3)) {
        const prev = tabs[activeIndex - 1]
        if (prev) onChange(prev.key)
      }
    },
    {
      axis: 'x',
      enabled: swipeable,
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  return (
    <div className={cn('relative', className)} {...(swipeable ? swipeBind() : {})}>
      <div
        ref={containerRef}
        className="relative flex gap-0.5 p-1 rounded-xl bg-black/[0.03] overflow-x-auto"
        role="tablist"
        style={{ scrollbarWidth: 'none' }}
      >
        {/* Sliding indicator */}
        <motion.div
          className="absolute top-1 bottom-1 rounded-lg bg-white/90 shadow-1"
          animate={{ left: indicator.left, width: indicator.width }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        />

        {tabs.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => { refs.current[tab.key] = el }}
            onClick={() => { haptic('selection'); onChange(tab.key) }}
            role="tab"
            aria-selected={active === tab.key}
            className={cn(
              'relative z-10 flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 whitespace-nowrap flex-shrink-0',
              active === tab.key ? 'text-ink' : 'text-muted hover:text-ink-2 active:text-ink',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scroll hint gradient on right edge */}
      {showScrollHint && (
        <div
          className="absolute top-1 bottom-1 right-1 w-6 rounded-r-lg pointer-events-none"
          style={{
            background: 'linear-gradient(to right, transparent, rgba(0,0,0,0.04))',
          }}
        />
      )}
    </div>
  )
}
