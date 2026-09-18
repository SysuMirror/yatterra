import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Shield, AlertTriangle, Ban, Hash, MapPin, Crosshair, Sparkles } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { Select } from '@/components/ui/Select'
import { MetricCard } from '@/components/domain/MetricCard'
import { ThreatGlobe, PATTERNS, patColor, patLabel } from '@/components/pod/ThreatGlobe'
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

export default function ThreatMap() {
  const [patternFilter, setPatternFilter] = useState('')
  const [window, setWindow] = useState('3d')

  const { data, isLoading } = useQuery<ThreatData>({
    queryKey: ['threat-map', window],
    queryFn: () => api.get(`/threat-map?window=${window}`),
    refetchInterval: 30_000,
  })

  const attacks = data?.attacks ?? []
  const stats = data?.stats ?? {}

  const patternOptions = useMemo(() => {
    const patterns = [...new Set(attacks.map((a) => a.pattern))].filter(Boolean).sort()
    return [
      { value: '', label: '全部类型' },
      ...patterns.map((p) => ({ value: p, label: `${patLabel(p)} (${p})` })),
    ]
  }, [attacks])

  const filtered = useMemo(
    () => (patternFilter ? attacks.filter((a) => a.pattern === patternFilter) : attacks),
    [attacks, patternFilter],
  )

  const totalAttacks = useMemo(() => attacks.reduce((s, a) => s + a.count, 0), [attacks])
  const uniqueIps = useMemo(() => new Set(attacks.map((a) => a.ip)).size, [attacks])
  const topPattern = useMemo(() => {
    if (!attacks.length) return '—'
    const counts: Record<string, number> = {}
    for (const a of attacks) counts[a.pattern] = (counts[a.pattern] || 0) + a.count
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]
    return top ? patLabel(top[0]) : '—'
  }, [attacks])
  const bannedCount = useMemo(() => attacks.filter((a) => a.banned).length, [attacks])

  const columns = useMemo(
    () => [
      { key: 'ip', title: 'IP', sortable: true, width: '130px', render: (row: Attack) => <span className="font-mono text-[13px]">{row.ip}</span> },
      {
        key: 'city', title: '城市', sortable: true, width: '110px',
        render: (row: Attack) => (
          <span className="flex items-center gap-1 truncate">
            <MapPin size={12} className="text-muted flex-shrink-0" />
            {row.city || '-'} {row.country || ''}
          </span>
        ),
      },
      { key: 'count', title: '次数', sortable: true, width: '70px', render: (row: Attack) => <span className="font-semibold text-bad tnum">{row.count}</span> },
      {
        key: 'pattern', title: '模式', sortable: true, width: '90px',
        render: (row: Attack) => (
          <span className="inline-flex items-center gap-1.5 text-xs" title={row.llm_reasoning || ''}>
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: patColor(row.pattern) }} />
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
        key: 'response', title: '响应', sortable: true, width: '80px',
        render: (row: Attack) => <Badge variant={row.response === 'whitelist' ? 'ok' : 'default'}>{row.response}</Badge>,
      },
      {
        key: 'ts', title: '时间', sortable: true, width: '130px',
        render: (row: Attack) => <span className="text-xs text-muted tnum">{new Date(row.ts).toLocaleString('zh-CN')}</span>,
      },
      {
        key: 'banned', title: '状态', width: '76px',
        render: (row: Attack) =>
          row.banned ? <Badge variant="bad" dot>已封禁</Badge> : <Badge variant="default">活跃</Badge>,
      },
    ],
    [],
  )

  const usedPatterns = useMemo(() => {
    const present = new Set(attacks.map((a) => a.pattern))
    return Object.entries(PATTERNS).filter(([k]) => present.has(k))
  }, [attacks])

  return (
    <>
      <PageHeader title="攻防态势" description="实时威胁地图与安全事件" doc={{ section: 'ops', item: 2, label: '威胁地图文档' }}>
        <PageAiAssistant page="threat-map" context={attacks.length > 0 ? `威胁统计: 总攻击 ${stats.total_attacks ?? attacks.length}, 封禁 ${stats.total_banned ?? 0}\n攻击类型: ${[...new Set(attacks.map(a => a.pattern))].join(', ')}\n最近攻击:\n${attacks.slice(0, 15).map(a => `  ${a.ts ?? ''} ${a.ip ?? '?'} (${a.country ?? '?'}/${a.city ?? '?'}) x${a.count ?? 0} ${a.pattern}${a.banned ? ' [已封禁]' : ''}`).join('\n')}` : '暂无威胁数据'} />
        <Select onboardingTarget="threat-window" value={window} onChange={setWindow} options={WINDOWS} className="w-[110px]" />
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && attacks.length > 0 && (
        <AiInsightPanel
          page="threat-map"
          title="威胁态势洞察"
          className="mb-5"
          promptHint="请根据以下威胁数据生成安全洞察摘要，包括：主要威胁来源、攻击模式分析、封禁状态、安全建议。控制在 3-5 行以内。"
          context={`威胁统计: 总攻击 ${stats.total_attacks ?? attacks.length}, 封禁 ${stats.total_banned ?? 0}, 攻击源IP ${uniqueIps}\n主要模式: ${topPattern}\n攻击类型分布: ${usedPatterns.map(([k, v]) => `${v.label}(${attacks.filter(a => a.pattern === k).length})`).join(', ')}\n最近攻击:\n${attacks.slice(0, 15).map(a => `  ${a.ip} (${a.city ?? '?'}, ${a.country ?? '?'}) ${a.pattern} x${a.count} ${a.banned ? '[封禁]' : '[活跃]'}`).join('\n')}`}
        />
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <MetricCard icon={<Crosshair size={16} className="text-muted" />} label="攻击连接数" value={totalAttacks} />
        <MetricCard icon={<Hash size={16} className="text-muted" />} label="攻击源 IP" value={uniqueIps} />
        <MetricCard icon={<AlertTriangle size={16} className="text-muted" />} label="主要模式" value={topPattern} />
        <MetricCard icon={<Ban size={16} className="text-muted" />} label="已封禁 IP" value={bannedCount} />
      </div>

      {/* AI Threat Summary */}
      {data?.ai_summary && (
        <Card padding="lg" className="mb-6 border-l-2 border-l-[#a78bfa]">
          <div className="flex items-start gap-3">
            <Sparkles size={16} className="text-[#a78bfa] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-muted mb-1 font-medium">AI 态势分析</p>
              <p className="text-sm text-ink leading-relaxed whitespace-pre-line">{data.ai_summary}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 3D Globe — ops HUD treatment */}
        <Card padding="none" className="lg:col-span-2 overflow-hidden">
          <div className="relative h-[280px] sm:h-[440px] lg:h-[540px] rounded-t-xl overflow-hidden bg-[#050507]">
            {data ? (
              <ThreatGlobe data={data} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">加载中…</div>
            )}

            {/* Minimal HUD — one compact telemetry chip, nothing else */}
            <div className="absolute inset-0 z-10 pointer-events-none">
              <div className="absolute top-3 left-3 flex items-center gap-2.5 rounded-lg bg-black/45 border border-white/10 pl-2.5 pr-3 py-1.5 backdrop-blur-md font-mono text-[11px]">
                <span className="flex items-center gap-1.5 text-red-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 hud-blink" />
                  LIVE
                </span>
                <span className="w-px h-3.5 bg-white/15" />
                <span className="text-white/90">{data?.target?.name || DOMAIN}</span>
                <span className="text-white/40 tnum">
                  {totalAttacks} conns · {uniqueIps} srcs
                </span>
              </div>
              {data?.updated && (
                <div className="absolute top-3 right-3 font-mono text-[10px] text-white/35 tnum">
                  {new Date(data.updated).toLocaleTimeString('zh-CN')}
                </div>
              )}
              {/* Legend */}
              <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-black/45 border border-white/10 px-3 py-1.5 backdrop-blur-md font-mono text-[10px] text-white/65">
                {usedPatterns.map(([k, v]) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className="w-2 h-0.5 rounded-full" style={{ background: v.color }} />
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
            </div>
          </div>
        </Card>

        {/* Quick panel: pattern breakdown + honeypot stats */}
        <Card padding="lg" className="lg:col-span-1">
          <h2 className="text-sm font-semibold mb-4">蜜罐统计 <span className="text-xs text-muted font-normal">({WINDOWS.find((w) => w.value === window)?.label})</span></h2>
          <dl className="space-y-3 text-sm">
            <Row label="攻击源 IP">{stats.total_attacks ?? attacks.length}</Row>
            <Row label="正常访问 IP">{stats.total_normal ?? 0}</Row>
            <Row label="已封禁">{stats.total_banned ?? bannedCount}</Row>
            <Row label="连接总数">{stats.total_conns ?? totalAttacks}</Row>
          </dl>
          {usedPatterns.length > 0 && (
            <>
              <div className="h-px bg-black/[0.06] my-4" />
              <p className="text-xs text-muted mb-2">攻击模式分布</p>
              <div className="space-y-2">
                {usedPatterns.map(([k, v]) => {
                  const cnt = attacks.filter((a) => a.pattern === k).length
                  const max = Math.max(...usedPatterns.map(([k2]) => attacks.filter((a) => a.pattern === k2).length), 1)
                  return (
                    <div key={k} className="flex items-center gap-2 text-xs">
                      <span className="w-8 text-right text-muted flex-shrink-0">{v.label}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-black/[0.05] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(cnt / max) * 100}%`, background: v.color }} />
                      </div>
                      <span className="w-7 text-right tnum text-ink-2 flex-shrink-0">{cnt}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </Card>

        {/* Threat Table */}
        <Card padding="lg" className="lg:col-span-3">
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-muted" />
              <h2 className="text-sm font-semibold">威胁事件</h2>
              <Badge variant="bad">{filtered.length}</Badge>
            </div>
            <div className="w-full sm:w-48">
              <Select onboardingTarget="threat-pattern" value={patternFilter} onChange={setPatternFilter} options={patternOptions} />
            </div>
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-muted text-sm">加载中...</div>
          ) : filtered.length > 0 ? (
            <DataTable columns={columns} data={filtered} keyFn={(row) => row.ip} />
          ) : (
            <div className="text-center py-8">
              <Shield size={32} className="mx-auto mb-2 text-ok opacity-50" />
              <p className="text-sm text-ok">无活跃威胁</p>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted text-[13px]">{label}</dt>
      <dd className="text-sm tnum">{children}</dd>
    </div>
  )
}
