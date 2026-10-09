import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowLeft, FileText, Orbit } from 'lucide-react'
import { reports } from './reports.data'
import { reportsZh, captionsZh } from './reports.data.zh'
import { reportDiagrams, type ReportDiagram } from './reports.diagrams'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { setLandingLang, useLandingLang } from './landing.i18n'

function TerraMark({ small = false }: { small?: boolean }) {
  const size = small ? 40 : 58
  return (
    <svg width={size} height={size} viewBox="0 0 58 58" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="terra-reports-mark" x1="8" y1="8" x2="50" y2="51" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9DEBFF" />
          <stop offset=".48" stopColor="#5C8BFF" />
          <stop offset="1" stopColor="#B56DFF" />
        </linearGradient>
      </defs>
      <circle cx="29" cy="29" r="22" stroke="url(#terra-reports-mark)" strokeWidth="1.4" strokeDasharray="2 4" opacity=".7" />
      <path d="M16 25.2 29 16l13 9.2v14.1L29 47l-13-7.7V25.2Z" stroke="url(#terra-reports-mark)" strokeWidth="2" />
      <path d="m16.5 25.5 12.7 7.8 12.4-7.8M29.2 33.3V47" stroke="url(#terra-reports-mark)" strokeWidth="1.7" />
      <circle cx="29" cy="15.8" r="3" fill="#B9F4FF" />
      <circle cx="16" cy="25.4" r="2.2" fill="#789BFF" />
      <circle cx="42" cy="25.4" r="2.2" fill="#C183FF" />
    </svg>
  )
}

/** 报告页只提供 en / 繁體書面語 两语;全局偏好里的 zh-CN 一律归入繁中 */
const UI = {
  en: { back: 'Back to Home', home: 'Home', abstract: 'Abstract', footer: 'YatTerra Technical Reports', langLabel: 'EN' },
  zh: { back: '返回首頁', home: '首頁', abstract: '摘要', footer: 'YatTerra 技術報告', langLabel: '繁中' },
} as const

function LangToggle({ zh, ui }: { zh: boolean; ui: (typeof UI)['en'] | (typeof UI)['zh'] }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-white/[.1] bg-white/[.04] p-1" role="group" aria-label="Language / 語言">
      <button
        type="button"
        aria-pressed={!zh}
        onClick={() => setLandingLang('en')}
        className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${!zh ? 'bg-cyan-300/15 text-cyan-100' : 'text-slate-400 hover:text-slate-200'}`}
      >
        EN
      </button>
      <button
        type="button"
        aria-pressed={zh}
        onClick={() => setLandingLang('zh-HK')}
        className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${zh ? 'bg-cyan-300/15 text-cyan-100' : 'text-slate-400 hover:text-slate-200'}`}
      >
        繁中
      </button>
    </div>
  )
}

export default function Reports() {
  const stored = useLandingLang()
  const zh = stored !== 'en'
  const ui = zh ? UI.zh : UI.en
  const list = zh ? reportsZh : reports
  const [activeReport, setActiveReport] = useState(list[0].id)
  const narrow = useMediaQuery('(max-width: 640px)')
  const [activeSub, setActiveSub] = useState<string | null>(null)
  const articleRef = useRef<HTMLElement>(null)

  const report = list.find(r => r.id === activeReport) ?? list[0]
  const diagrams = reportDiagrams[report.id] ?? []
  // 繁中模式下按索引替换图注(SVG 内部标签保留英文)
  const zhCaps = zh ? captionsZh[report.id] : undefined
  const captionOf = (d: ReportDiagram) => zhCaps?.[diagrams.indexOf(d)] ?? d.caption
  const firstSub = report.sections[0]?.subsections[0]
  const firstSubId = firstSub ? `${report.sections[0].id}-0` : null

  // 页面语言跟随所选语言(浏览器自动翻译/读屏按此判断),离开时还原
  useEffect(() => {
    const prev = document.documentElement.lang
    document.documentElement.lang = zh ? 'zh-HK' : 'en'
    return () => { document.documentElement.lang = prev }
  }, [zh])

  // 切换报告后回到顶部
  useEffect(() => {
    articleRef.current?.scrollTo({ top: 0 })
    setActiveSub(firstSubId)
  }, [activeReport]) // eslint-disable-line react-hooks/exhaustive-deps

  // 滚动侦测当前小节(subsection 粒度)
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const subs = Array.from(article.querySelectorAll<HTMLElement>('[data-sub-id]'))
    const onScroll = () => {
      const top = article.scrollTop
      let current: string | null = null
      for (const el of subs) {
        if (el.offsetTop - 130 <= top) current = el.dataset.subId ?? null
      }
      if (current) setActiveSub(current)
    }
    article.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => article.removeEventListener('scroll', onScroll)
  }, [activeReport])

  const scrollTo = (selector: string) => {
    const el = articleRef.current?.querySelector<HTMLElement>(selector)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <main
      className="relative h-screen overflow-hidden bg-[#070B18] text-[#F5F7FF]"
      style={{ backgroundImage: 'radial-gradient(circle at 15% 10%, rgba(71, 103, 210, .23), transparent 36%), radial-gradient(circle at 84% 85%, rgba(108, 68, 184, .2), transparent 34%)' }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[.18]"
        style={{
          backgroundImage: 'linear-gradient(rgba(150,180,255,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(150,180,255,.12) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'linear-gradient(to bottom, black, transparent 75%)',
        }}
      />

      <div className="relative flex h-full">
        {/* ── 左侧导览(报告 → 章节 → 小节) ── */}
        <aside className="hidden w-[300px] shrink-0 flex-col border-r border-white/[.07] bg-[#0a1020]/[.6] backdrop-blur-xl lg:flex">
          <div className="flex items-center gap-3 px-6 pb-5 pt-6">
            <TerraMark small />
            <div className="leading-tight">
              <div className="text-[15px] font-semibold tracking-[.18em] text-white">YATERRA</div>
              <div className="text-[9px] font-medium tracking-[.2em] text-cyan-100/60">TECHNICAL REPORTS</div>
            </div>
          </div>
          <div className="flex items-center justify-between px-6 pb-3">
            <Link to="/" className="flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-cyan-200">
              <ArrowLeft size={13} />
              {ui.back}
            </Link>
            <LangToggle zh={zh} ui={ui} />
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-4 pb-6">
            {list.map(r => {
              const isActive = r.id === activeReport
              return (
                <div key={r.id}>
                  <button
                    type="button"
                    onClick={() => setActiveReport(r.id)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      isActive ? 'bg-white/[.06] text-white' : 'text-slate-400 hover:bg-white/[.03] hover:text-slate-200'
                    }`}
                  >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${isActive ? 'border-cyan-200/25 bg-cyan-300/[.1]' : 'border-white/[.09] bg-white/[.03]'}`}>
                      <FileText size={15} className={isActive ? 'text-cyan-200' : 'text-slate-500'} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[10px] font-semibold tracking-[.16em] text-cyan-100/60">{r.label}</span>
                      <span className="mt-0.5 block truncate text-[13px] font-medium">{r.title}</span>
                    </span>
                  </button>
                  {isActive && (
                    <div className="mt-1 mb-2 ml-[27px] space-y-px border-l border-white/[.08] pl-3">
                      {r.sections.map(sec => (
                        <div key={sec.id}>
                          <button
                            type="button"
                            onClick={() => scrollTo(`section[data-section-id="${sec.id}"]`)}
                            className="block w-full rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-slate-300 transition-colors hover:bg-white/[.03] hover:text-white"
                          >
                            {sec.heading}
                          </button>
                          <div className="space-y-px border-l border-white/[.06] pl-2.5">
                            {sec.subsections.map((sub, j) => {
                              const subId = `${sec.id}-${j}`
                              return (
                                <button
                                  key={subId}
                                  type="button"
                                  onClick={() => scrollTo(`[data-sub-id="${subId}"]`)}
                                  className={`block w-full truncate rounded-md px-2 py-1 text-left text-[11px] leading-snug transition-colors ${
                                    activeSub === subId
                                      ? 'bg-cyan-300/[.08] text-cyan-100'
                                      : 'text-slate-500 hover:bg-white/[.03] hover:text-slate-300'
                                  }`}
                                >
                                  {sub.title}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </nav>

          <footer className="border-t border-white/[.07] px-6 py-4 text-[10px] tracking-wide text-slate-600">
            YatTerra — The Soil for AI · © {new Date().getFullYear()}
          </footer>
        </aside>

        {/* ── 右侧正文 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 移动端报告切换 */}
          <div className="flex items-center gap-2 overflow-x-auto border-b border-white/[.07] px-5 py-3 lg:hidden">
            {list.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => setActiveReport(r.id)}
                className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
                  r.id === activeReport
                    ? 'border-cyan-200/30 bg-cyan-300/[.1] text-cyan-100'
                    : 'border-white/[.1] text-slate-400'
                }`}
              >
                {r.label}
              </button>
            ))}
            <Link to="/" className="ml-auto flex shrink-0 items-center gap-1 text-xs text-slate-500">
              <ArrowLeft size={13} /> {ui.home}
            </Link>
            <LangToggle zh={zh} ui={ui} />
          </div>

          <article ref={articleRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[760px] px-6 py-12 sm:px-10 sm:py-16 xl:max-w-[1220px] xl:px-16">
              <motion.div
                key={report.id + (zh ? '-zh' : '-en')}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: .45, ease: [.23, 1, .32, 1] }}
              >
                <p className="mb-5 flex items-center gap-2 text-xs font-medium uppercase tracking-[.28em] text-cyan-200/70">
                  <Orbit size={14} />
                  {report.label} · {report.date}
                </p>
                <h1 className="text-3xl font-semibold leading-[1.15] text-white sm:text-[38px]">{report.title}</h1>
                {report.subtitle && (
                  <p className="mt-3 text-[15px] leading-relaxed text-slate-400">{report.subtitle}</p>
                )}

                <div className="mt-6 rounded-2xl border border-white/[.09] bg-white/[.03] p-5">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[.26em] text-slate-500">{ui.abstract}</p>
                  <p className="text-[14px] leading-7 text-slate-300">{report.abstract}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {report.tags.map(tag => (
                      <span key={tag} className="rounded-full border border-white/[.09] bg-white/[.04] px-2.5 py-1 text-[11px] text-slate-300">{tag}</span>
                    ))}
                  </div>
                </div>

                {(() => {
                  const overview = diagrams.find(d => d.sectionId === 'overview')
                  return overview ? (
                    <figure className="mt-8 overflow-hidden rounded-2xl border border-white/[.09] bg-white/[.02] p-4 sm:p-6">
                      <div
                        className="[&_svg]:h-auto [&_svg]:w-full"
                        dangerouslySetInnerHTML={{ __html: (narrow && overview.svgNarrow) || overview.svg }}
                      />
                      <figcaption className="mt-3 text-[11px] leading-relaxed text-slate-500">{captionOf(overview)}</figcaption>
                    </figure>
                  ) : null
                })()}

                <div className="mt-12 space-y-14">
                  {report.sections.map(sec => {
                    const secDiagrams = diagrams.filter(d => d.sectionId === sec.id)
                    return (
                    <section key={sec.id} data-section-id={sec.id} className="scroll-mt-8">
                      <h2 className="mb-6 text-xl font-semibold text-white sm:text-[22px]">{sec.heading}</h2>
                      {secDiagrams.map(diagram => (
                        <figure key={diagram.sectionId + diagram.caption} className="mb-8 overflow-hidden rounded-2xl border border-white/[.09] bg-white/[.02] p-4 sm:p-6">
                          <div
                            className="[&_svg]:h-auto [&_svg]:w-full"
                            dangerouslySetInnerHTML={{ __html: (narrow && diagram.svgNarrow) || diagram.svg }}
                          />
                          <figcaption className="mt-3 text-[11px] leading-relaxed text-slate-500">{captionOf(diagram)}</figcaption>
                        </figure>
                      ))}
                      <div className="space-y-8">
                        {sec.subsections.map((sub, j) => (
                          <div key={j} data-sub-id={`${sec.id}-${j}`} className="scroll-mt-24 space-y-4">
                            <h3 className="flex items-baseline gap-2 text-[16px] font-semibold text-cyan-100/90">
                              <span className="text-[11px] font-bold tabular-nums text-cyan-300/50">{sec.heading.split('.')[0]}.{j + 1}</span>
                              {sub.title}
                            </h3>
                            {sub.paragraphs.map((p, k) => (
                              <p key={k} className="text-[15px] leading-[1.85] text-slate-300/90">{p}</p>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                    )
                  })}
                </div>

                <footer className="mt-16 border-t border-white/[.07] pt-6 text-xs text-slate-600">
                  {ui.footer} · {report.label} · {report.date}
                </footer>
              </motion.div>
            </div>
          </article>
        </div>
      </div>
    </main>
  )
}
