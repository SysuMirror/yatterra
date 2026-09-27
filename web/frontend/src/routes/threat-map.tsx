import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Shield, AlertTriangle, Ban, MapPin, Crosshair, Sparkles,
  Radar, Activity, Users, Globe2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { Select } from '@/components/ui/Select'
import { useCountUp } from '@/hooks/useCountUp'
import { ThreatGlobe, PATTERNS, patColor, patLabel } from '@/components/pod/ThreatGlobe'
import { ThreatHud } from '@/components/pod/ThreatHud'
import { api } from '@/api/client'
import { DOMAIN } from '@/lib/site'

interface Attack {
  banned: boolean
  city: string
  count: number
  country: string
  ip: string
  lat: number
  lon: number
  pattern: string
  proxy: string
  response: string
  ts: string
  llm_reasoning?: string
  llm_confidence?: number
}

interface ThreatData {
  updated?: string
  target?: { lat?: number; lon?: number; name?: string }
  attacks: Attack[]
  normal?: any[]
  stats?: {
    total_attacks?: number
    total_normal?: number
    total_banned?: number
    total_conns?: number
  }
  ai_summary?: string
}

const WINDOWS = [
  { value: '1h', label: '1 小时' },
  { value: '3h', label: '3 小时' },
  { value: '1d', label: '1 天' },
  { value: '3d', label: '3 天' },
  { value: '7d', label: '7 天' },
  { value: 'all', label: '全部' },
]

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'active', label: '活跃' },
  { value: 'banned', label: '已封禁' },
]

/** Escalating threat ramp — `tone` drives the glow, `text` stays readable. */
const LEVELS = [
  { min: 75, label: '严重', tone: '#ff453a', text: '#cf222e' },
  { min: 50, label: '高危', tone: '#ff6b35', text: '#c2410c' },
  { min: 25, label: '中危', tone: '#ff9f0a', text: '#9a6700' },
  { min: 0, label: '低危', tone: '#30d158', text: '#1a7f37' },
]

function levelOf(score: number) {
  return LEVELS.find((l) => score >= l.min) ?? LEVELS[LEVELS.length - 1]!
}

export default function ThreatMap() {
  const [patternFilter, setPatternFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [timeWindow, setTimeWindow] = useState('3d')

  const { data, isLoading } = useQuery<ThreatData>({
    queryKey: ['threat-map', timeWindow],
    queryFn: () => api.get(`/threat-map?window=${timeWindow}`),
    refetchInterval: 30_000,
  })

  const attacks = useMemo(() => data?.attacks ?? [], [data])
  const stats = data?.stats ?? {}

  const patternOptions = useMemo(() => {
    const patterns = [...new Set(attacks.map((a) => a.pattern))].filter(Boolean).sort()
    return [
      { value: '', label: '全部类型' },
      ...patterns.map((p) => ({ value: p, label: `${patLabel(p)} (${p})` })),
    ]
  }, [attacks])

  const filtered = useMemo(() => {
    let rows = patternFilter ? attacks.filter((a) => a.pattern === patternFilter) : attacks
    if (statusFilter === 'banned') rows = rows.filter((a) => a.banned)
    if (statusFilter === 'active') rows = rows.filter((a) => !a.banned)
    return rows
  }, [attacks, patternFilter, statusFilter])

  const totalAttacks = useMemo(() => attacks.reduce((s, a) => s + a.count, 0), [attacks])
  const uniqueIps = useMemo(() => new Set(attacks.map((a) => a.ip)).size, [attacks])
  const bannedCount = useMemo(() => attacks.filter((a) => a.banned).length, [attacks])

  const topPattern = useMemo(() => {
    if (!attacks.length) return '—'
    const counts: Record<string, number> = {}
    for (const a of attacks) counts[a.pattern] = (counts[a.pattern] || 0) + a.count
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]
    return top ? patLabel(top[0]) : '—'
  }, [attacks])

  /** 0–100 composite: how loud and how contained the current window is. */
  const riskScore = useMemo(() => {
    if (!attacks.length) return 0
    const src = Math.min(uniqueIps / 50, 1) * 50
    const vol = Math.min(totalAttacks / 200_000, 1) * 30
    const ban = Math.min(bannedCount / Math.max(uniqueIps, 1), 1) * 20
    return Math.max(0, Math.min(100, Math.round(src + vol + ban)))
  }, [attacks.length, uniqueIps, totalAttacks, bannedCount])

  const level = levelOf(riskScore)

  const patternStats = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of attacks) map.set(a.pattern, (map.get(a.pattern) || 0) + (a.count || 0))
    const total = [...map.values()].reduce((s, v) => s + v, 0) || 1
    return [...map.entries()]
      .map(([k, n]) => ({ key: k, label: patLabel(k), color: patColor(k), n, pct: (n / total) * 100 }))
      .sort((a, b) => b.n - a.n)
  }, [attacks])

  const recent = useMemo(
    () =>
      [...attacks]
        .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime())
        .slice(0, 14),
    [attacks],
  )

  const maxCount = useMemo(() => attacks.reduce((m, a) => Math.max(m, a.count || 0), 1), [attacks])

  const rows = useMemo(
    () => [...filtered].sort((a, b) => (b.count || 0) - (a.count || 0)),
    [filtered],
  )

  const columns = useMemo(
    () => [
      { key: 'ip', title: 'IP', sortable: true, width: '130px', render: (row: Attack) => <span className="font-mono text-[13px] font-medium">{row.ip}</span> },
      {
        key: 'city', title: '城市', sortable: true, width: '120px',
        render: (row: Attack) => (
          <span className="flex items-center gap-1 truncate">
            <MapPin size={12} className="text-muted flex-shrink-0" />
            {row.city || '-'} {row.country || ''}
          </span>
        ),
      },
      {
        key: 'count', title: '次数', sortable: true, width: '84px',
        render: (row: Attack) => {
          const pct = Math.min(100, ((row.count || 0) / maxCount) * 100)
          return (
            <span className="relative flex items-center justify-between gap-2 px-1.5 py-0.5 rounded-md overflow-hidden bg-black/[0.03]">
              <span
                className="absolute inset-y-0 left-0 rounded-md"
                style={{ width: `${pct}%`, background: 'rgba(255,69,58,0.16)' }}
              />
              <span className="relative font-mono font-bold text-bad tnum text-[13px]">{row.count}</span>
            </span>
          )
        },
      },
      {
        key: 'pattern', title: '模式', sortable: true, width: '96px',
        render: (row: Attack) => (
          <span className="inline-flex items-center gap-1.5 text-xs" title={row.llm_reasoning || ''}>
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: patColor(row.pattern), boxShadow: `0 0 5px ${patColor(row.pattern)}` }}
            />
            {patLabel(row.pattern)}
            {row.llm_reasoning && <Sparkles size={10} className="text-[#a78bfa] flex-shrink-0" />}
          </span>
        ),
      },
      {
        key: 'proxy', title: '入口', width: '140px',
        render: (row: Attack) => (
          <span className="text-xs text-muted truncate block max-w-[140px]" title={row.proxy}>
            {row.proxy || '-'}
          </span>
        ),
      },
      {
        key: 'response', title: '响应', sortable: true, width: '84px',
        render: (row: Attack) => <Badge variant={row.response === 'whitelist' ? 'ok' : 'default'}>{row.response}</Badge>,
      },
      {
        key: 'ts', title: '时间', sortable: true, width: '130px',
        render: (row: Attack) => <span className="text-xs text-muted tnum">{new Date(row.ts).toLocaleString('zh-CN')}</span>,
      },
      {
        key: 'banned', title: '状态', width: '80px',
        render: (row: Attack) =>
          row.banned ? <Badge variant="bad" dot>已封禁</Badge> : <Badge variant="warn" dot>活跃</Badge>,
      },
    ],
    [maxCount],
  )

  return (
    <>
      <PageHeader title="攻防态势" description="实时威胁地图与安全事件" doc={{ section: 'ops', item: 2, label: '威胁地图文档' }}>
        <ThreatPill score={riskScore} label={level.label} tone={level.tone} text={level.text} />
        <PageAiAssistant page="threat-map" context={attacks.length > 0 ? `威胁统计: 总攻击 ${stats.total_attacks ?? attacks.length}, 封禁 ${stats.total_banned ?? 0}\n攻击类型: ${[...new Set(attacks.map(a => a.pattern))].join(', ')}\n最近攻击:\n${attacks.slice(0, 15).map(a => `  ${a.ts ?? ''} ${a.ip ?? '?'} (${a.country ?? '?'}/${a.city ?? '?'}) x${a.count ?? 0} ${a.pattern}${a.banned ? ' [已封禁]' : ''}`).join('\n')}` : '暂无威胁数据'} />
        <Select onboardingTarget="threat-window" value={timeWindow} onChange={setTimeWindow} options={WINDOWS} className="w-[110px]" />
      </PageHeader>

      {/* ── Stat strip ── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-5">
        <StatCard
          delay={0} tone="#ff453a" icon={<Crosshair size={15} />} label="攻击连接数"
          value={totalAttacks}
          sub={`${uniqueIps} 个源 · 平均 ${uniqueIps ? Math.round(totalAttacks / uniqueIps) : 0} 次/源`}
        />
        <StatCard
          delay={60} tone="#f0a35e" icon={<Users size={15} />} label="攻击源 IP"
          value={uniqueIps}
          sub={`正常访问 ${stats.total_normal ?? 0} 个 IP`}
        />
        <StatCard
          delay={120} tone="#a78bfa" icon={<AlertTriangle size={15} />} label="主要模式"
          value={topPattern}
          sub={patternStats[0] ? `占攻击流量 ${patternStats[0].pct.toFixed(1)}%` : '暂无数据'}
        />
        <StatCard
          delay={180} tone="#30d158" icon={<Ban size={15} />} label="已封禁 IP"
          value={bannedCount}
          sub={`拦截率 ${uniqueIps ? Math.round((bannedCount / uniqueIps) * 100) : 0}%`}
          pct={uniqueIps ? Math.min(100, Math.round((bannedCount / uniqueIps) * 100)) : 0}
        />
      </div>

      {/* ── Map + side panels ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
        <Card padding="none" className="lg:col-span-2 overflow-hidden flex animate-fade-in-up">
          <div className="relative w-full h-[300px] sm:h-[440px] lg:h-auto lg:min-h-[560px] lg:flex-1 rounded-t-xl overflow-hidden bg-[#050507]">
            {data ? (
              <ThreatGlobe data={data} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/40 text-sm">
                <Radar size={24} className="animate-spin" />
                正在接入威胁情报…
              </div>
            )}
            {data && (
              <ThreatHud
                targetName={data.target?.name || DOMAIN}
                updated={data.updated}
                conns={totalAttacks}
                srcs={uniqueIps}
                banned={bannedCount}
                events={recent}
              />
            )}
          </div>
        </Card>

        <div className="lg:col-span-1 flex flex-col gap-5">
          <Card padding="lg" className="animate-fade-in-up" style={{ animationDelay: '60ms' }}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Radar size={15} className="text-muted" />
                <h2 className="text-sm font-semibold">威胁态势</h2>
              </div>
              <span className="font-mono text-[10px] tracking-wider text-muted">
                {WINDOWS.find((w) => w.value === timeWindow)?.label}
              </span>
            </div>

            <ThreatGauge score={riskScore} label={level.label} tone={level.tone} text={level.text} />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 mt-4 pt-4 border-t border-black/[0.06]">
              <MiniStat label="攻击源 IP" value={stats.total_attacks ?? attacks.length} />
              <MiniStat label="正常访问" value={stats.total_normal ?? 0} />
              <MiniStat label="已封禁" value={stats.total_banned ?? bannedCount} tone="#30d158" />
              <MiniStat label="连接总数" value={stats.total_conns ?? totalAttacks} />
            </dl>
          </Card>

          <Card padding="lg" className="flex-1 animate-fade-in-up" style={{ animationDelay: '120ms' }}>
            <div className="flex items-center gap-2 mb-4">
              <Activity size={15} className="text-muted" />
              <h2 className="text-sm font-semibold">攻击模式分布</h2>
            </div>
            {patternStats.length > 0 ? (
              <div className="space-y-3">
                {patternStats.map((p) => (
                  <div key={p.key} className="text-xs">
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: p.color }} />
                        <span className="truncate font-medium text-ink-2">{p.label}</span>
                      </span>
                      <span className="flex items-baseline gap-2 flex-shrink-0">
                        <span className="font-mono tnum text-ink">{p.n.toLocaleString('en-US')}</span>
                        <span className="font-mono tnum text-muted w-11 text-right">{p.pct.toFixed(1)}%</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-[width] duration-700 ease-out"
                        style={{ width: `${p.pct}%`, background: p.color, boxShadow: `0 0 8px ${p.color}66` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted py-6 text-center">暂无攻击样本</p>
            )}
          </Card>
        </div>
      </div>

      {/* ── AI brief ── */}
      {data?.ai_summary && (
        <Card padding="md" className="mb-5 animate-fade-in-up relative overflow-hidden" style={{ animationDelay: '160ms' }}>
          <span className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-[#a78bfa] to-[#0a84ff]" />
          <div className="flex items-start gap-3 pl-1">
            <Sparkles size={15} className="text-[#a78bfa] flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] tracking-wider text-muted mb-1 font-medium">AI 态势简报</p>
              <p className="text-sm text-ink leading-relaxed whitespace-pre-line">{data.ai_summary}</p>
            </div>
          </div>
        </Card>
      )}

      {/* ── Interactive AI insight ── */}
      {!isLoading && attacks.length > 0 && (
        <AiInsightPanel
          page="threat-map"
          title="威胁态势洞察"
          className="mb-5"
          promptHint="请根据以下威胁数据生成安全洞察摘要，包括：主要威胁来源、攻击模式分析、封禁状态、安全建议。控制在 3-5 行以内。"
          context={`威胁统计: 总攻击 ${stats.total_attacks ?? attacks.length}, 封禁 ${stats.total_banned ?? 0}, 攻击源IP ${uniqueIps}\n主要模式: ${topPattern}\n威胁等级: ${level.label} (${riskScore}/100)\n攻击类型分布: ${patternStats.map((p) => `${p.label}(${p.n})`).join(', ')}\n最近攻击:\n${attacks.slice(0, 15).map(a => `  ${a.ip} (${a.city ?? '?'}, ${a.country ?? '?'}) ${a.pattern} x${a.count} ${a.banned ? '[封禁]' : '[活跃]'}`).join('\n')}`}
        />
      )}

      {/* ── Threat events ── */}
      <Card padding="lg" className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-muted" />
            <h2 className="text-sm font-semibold">威胁事件</h2>
            <Badge variant="bad">{filtered.length}</Badge>
            {patternFilter && <Badge variant="muted">{patLabel(patternFilter)}</Badge>}
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
            <div className="inline-flex rounded-lg bg-black/[0.05] p-0.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setStatusFilter(f.value)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    statusFilter === f.value
                      ? 'bg-[var(--surface-3)] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="w-full sm:w-48">
              <Select onboardingTarget="threat-pattern" value={patternFilter} onChange={setPatternFilter} options={patternOptions} />
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-muted text-sm">加载中...</div>
        ) : filtered.length > 0 ? (
          <DataTable columns={columns} data={rows} keyFn={(row) => row.ip} />
        ) : (
          <div className="text-center py-10">
            <Globe2 size={32} className="mx-auto mb-2 text-ok opacity-50" />
            <p className="text-sm text-ok">无活跃威胁</p>
            <p className="text-xs text-muted mt-1">当前筛选条件下没有匹配的事件</p>
          </div>
        )}
      </Card>
    </>
  )
}

/* ───────────────────────── local pieces ───────────────────────── */

function ThreatPill({ score, label, tone, text }: { score: number; label: string; tone: string; text: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 pl-3 pr-2.5 py-1.5 rounded-full border text-xs font-semibold animate-fade-in"
      style={{ borderColor: `${tone}59`, background: `${tone}1a` }}
    >
      <span className="w-1.5 h-1.5 rounded-full hud-blink" style={{ background: tone, boxShadow: `0 0 6px ${tone}` }} />
      <span style={{ color: text }}>威胁等级 {label}</span>
      <span className="font-mono tnum px-1.5 py-0.5 rounded-full text-[11px]" style={{ background: `${tone}26`, color: text }}>
        {score}
      </span>
    </span>
  )
}

function StatCard({
  icon, label, value, sub, tone, pct, delay = 0,
}: {
  icon: React.ReactNode
  label: string
  value: number | string
  sub: string
  tone: string
  pct?: number
  delay?: number
}) {
  const isNum = typeof value === 'number'
  const animated = useCountUp(isNum ? (value as number) : 0, { duration: 600 })
  return (
    <div
      className="glass-card rounded-2xl p-4 relative overflow-hidden animate-fade-in-up hover:shadow-[0_4px_16px_rgba(0,0,0,0.07)] transition-shadow duration-200"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ background: `linear-gradient(90deg, ${tone}, transparent 75%)` }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="grid place-items-center w-7 h-7 rounded-[9px] flex-shrink-0"
            style={{ background: `${tone}1f`, color: tone }}
          >
            {icon}
          </span>
          <span className="text-xs font-medium text-muted truncate">{label}</span>
        </span>
        {pct != null && (
          <span className="font-mono text-[11px] tnum" style={{ color: tone }}>{pct}%</span>
        )}
      </div>
      <div className="mt-3 text-[26px] leading-none font-bold tracking-tight tnum text-ink break-words">
        {isNum ? animated : String(value)}
      </div>
      <div className="mt-2 text-[11px] text-muted truncate">{sub}</div>
    </div>
  )
}

function ThreatGauge({ score, label, tone, text }: { score: number; label: string; tone: string; text: string }) {
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const R = 46
  const C = 2 * Math.PI * R
  const offset = C * (1 - Math.max(0, Math.min(100, score)) / 100)
  return (
    <div className="relative grid place-items-center py-1">
      <svg viewBox="0 0 120 120" className="w-[136px] h-[136px] -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(127,127,127,0.14)" strokeWidth="9" />
        <circle
          className="hud-arc"
          cx="60" cy="60" r={R} fill="none" stroke={tone} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={drawn ? offset : C}
          style={{ filter: `drop-shadow(0 0 5px ${tone}80)` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-[30px] leading-none font-bold tnum" style={{ color: text }}>{score}</div>
          <div className="text-[10px] tracking-[0.18em] mt-1.5 font-medium" style={{ color: text }}>{label}</div>
        </div>
      </div>
    </div>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const animated = useCountUp(value, { duration: 600 })
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted truncate">{label}</dt>
      <dd className="text-[15px] font-semibold tnum mt-0.5" style={tone ? { color: tone } : undefined}>{animated}</dd>
    </div>
  )
}
