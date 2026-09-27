import { patColor, patLabel, PATTERNS } from '@/components/pod/ThreatGlobe'

export interface HudEvent {
  ts?: string
  ip?: string
  city?: string
  country?: string
  count?: number
  pattern?: string
  banned?: boolean
}

interface ThreatHudProps {
  targetName?: string
  updated?: string
  conns: number
  srcs: number
  banned: number
  events: HudEvent[]
}

function num(n: number) {
  return n.toLocaleString('en-US')
}

function clock(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** Group sources by country, biggest first — feeds the ORIGIN rail. */
function topOrigins(events: HudEvent[]) {
  const map = new Map<string, number>()
  for (const e of events) {
    const k = (e.country || '').trim()
    if (!k) continue
    map.set(k, (map.get(k) ?? 0) + (e.count ?? 0))
  }
  const list = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const max = list[0]?.[1] || 1
  return list.map(([name, n]) => ({ name, n, pct: (n / max) * 100 }))
}

function Brackets() {
  const base = 'absolute w-4 h-4 sm:w-5 sm:h-5 border-[#ff4a30]/70'
  return (
    <>
      <span className={`${base} top-0 left-0 border-t-2 border-l-2`} />
      <span className={`${base} top-0 right-0 border-t-2 border-r-2`} />
      <span className={`${base} bottom-0 left-0 border-b-2 border-l-2`} />
      <span className={`${base} bottom-0 right-0 border-b-2 border-r-2`} />
    </>
  )
}

/** HUD overlay for the threat globe: frame, telemetry, origin rail, ticker. */
export function ThreatHud({ targetName, updated, conns, srcs, banned, events }: ThreatHudProps) {
  const origins = topOrigins(events)
  const ticker = events.slice(0, 14)

  return (
    <div className="absolute inset-0 z-10 pointer-events-none font-mono select-none">
      {/* ── Map frame: grid, vignette, scan line, corners ── */}
      <div className="absolute inset-x-0 top-0 bottom-8 overflow-hidden">
        <div className="absolute inset-0 hud-grid" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.62)_100%)]" />
        <div className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-[#ff6a4d] to-transparent hud-scan" />
        <Brackets />
      </div>

      {/* ── Top-left: live chip ── */}
      <div className="absolute top-3 left-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg bg-black/50 border border-white/10 pl-2.5 pr-3 py-1.5 backdrop-blur-md text-[11px] max-w-[calc(100%-1.5rem)]">
        <span className="flex items-center gap-1.5 text-red-400 font-semibold tracking-[0.12em]">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 hud-blink" />
          LIVE
        </span>
        <span className="w-px h-3.5 bg-white/15" />
        <span className="text-white/90 font-semibold">{targetName}</span>
        <span className="hidden sm:inline text-white/35 tnum">
          {num(conns)} conns · {num(srcs)} srcs · {num(banned)} banned
        </span>
        {updated && (
          <span className="text-white/30 tnum hidden md:inline">upd {clock(updated)}</span>
        )}
      </div>

      {/* ── Right rail: top attack origins ── */}
      {origins.length > 0 && (
        <div className="hidden sm:block absolute right-3 top-14 w-[150px] rounded-lg bg-black/50 border border-white/10 backdrop-blur-md px-3 py-2.5">
          <div className="text-[9px] tracking-[0.2em] text-white/40 mb-2">TOP ORIGINS</div>
          <div className="space-y-2">
            {origins.map((o) => (
              <div key={o.name}>
                <div className="flex items-baseline justify-between gap-2 text-[10px]">
                  <span className="text-white/75 truncate">{o.name}</span>
                  <span className="text-white/45 tnum flex-shrink-0">{num(o.n)}</span>
                </div>
                <div className="mt-1 h-[3px] rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-700 ease-out"
                    style={{ width: `${o.pct}%`, background: '#ff4a30', boxShadow: '0 0 6px #ff4a3080' }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Bottom-left: legend (sits above the 32px ticker) ── */}
      <div className="absolute bottom-11 left-3 right-3 sm:right-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-black/50 border border-white/10 px-3 py-1.5 backdrop-blur-md text-[10px] text-white/65 max-h-[62px] overflow-hidden">
        {Object.entries(PATTERNS).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="w-2 h-0.5 rounded-full" style={{ background: v.color, boxShadow: `0 0 5px ${v.color}` }} />
            {v.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-0.5 rounded-full bg-[#6fbf8f]" />
          正常
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          本站
        </span>
      </div>

      {/* ── Bottom: live event ticker ── */}
      {ticker.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-8 overflow-hidden border-t border-white/10 bg-black/60 backdrop-blur-md pointer-events-auto">
          <div className="absolute left-0 top-0 h-full w-10 z-10 bg-gradient-to-r from-black/90 to-transparent" />
          <div className="absolute right-0 top-0 h-full w-10 z-10 bg-gradient-to-l from-black/90 to-transparent" />
          <span className="absolute left-2 top-1/2 -translate-y-1/2 z-20 text-[9px] tracking-[0.16em] text-red-400/90 bg-black/70 px-1.5 py-0.5 rounded">
            FEED
          </span>
          <div className="hud-ticker flex w-max items-center h-full pl-16 whitespace-nowrap will-change-transform">
            {[...ticker, ...ticker].map((e, i) => (
              <span key={i} className="inline-flex items-center gap-2 text-[10px] pr-4">
                <span className="text-white/35 tnum">{clock(e.ts)}</span>
                <span className="text-white/85 font-semibold">{e.ip}</span>
                <span className="text-white/40 hidden sm:inline">
                  {e.city || '—'} {e.country || ''}
                </span>
                <span className="flex items-center gap-1" style={{ color: patColor(e.pattern) }}>
                  <span className="w-1 h-1 rounded-full" style={{ background: patColor(e.pattern) }} />
                  {patLabel(e.pattern)}
                </span>
                <span className="text-white/55 tnum">×{e.count ?? 0}</span>
                {e.banned && (
                  <span className="text-[#ffd166] border border-[#ffd166]/40 rounded px-1 leading-[1.1]">BAN</span>
                )}
                <span className="text-white/15 pl-2">/</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
