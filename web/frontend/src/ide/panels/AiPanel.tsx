/**
 * IDE AI 助手面板(registry id: 'ai';手机上由布局内核吸附为底部抽屉)。
 *
 * 行为(参考 GlobalAiAssistant 的后台 run 模式,page 名固定 'pod_ide'):
 *  - 发送: POST /api/ai/page/run 拿 run_id 立即返回,GET /api/ai/page/stream
 *    ?run_id&offset SSE 断线续传(3 次重试);刷新/切走回来凭 localStorage
 *    记录的 active run + /ai/page/runs?active=1 自动重接;
 *  - 上下文自动注入: 每次发送前把 {当前打开文件+光标±50行(ideBus.editorContext),
 *    最近编辑动作(ideBus.recentEdits), podcode 项目画像(GET /api/pods/<name>/profile)}
 *    组装为 context,用户零操作;
 *  - 「选中即问」: 消费 ideBus.askRequest(action+代码+路径),组装成首条用户消息;
 *  - diff 接受卡片: AI 通过 pod_edit_file 工具给出修改(工具参数/结果里带
 *    path+new_content 或 diff)时渲染成折叠 unified diff 卡片(上下堆叠),
 *    接受=PUT files/save 写入并 ideBus.notifySaved() 通知 EditorPanel 刷新,
 *    拒绝=丢弃;结果经 /api/ai/page/action_result 回传(action_id=tool_call_id);
 *  - 语音输入: Web Speech API(webkitSpeechRecognition, lang zh-CN),不支持时隐藏;
 *  - 手机: 输入框固定底部、消息字号 var(--ide-fs)、流式输出自动吸底可暂停跟随、
 *    工具过程折叠行、按钮命中区 ≥44px;面板被卸载时 SSE/语音识别全部释放,
 *    消息快照与 diff 卡片持久化到 localStorage,重挂载即恢复。
 */
import { Fragment, useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  Send, StopCircle, Plus, Mic, MicOff,
  ChevronDown, ChevronRight, FileDiff, ArrowDown, ShieldAlert, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { apiFetch } from '@/api/client'
import { aiApi } from '@/api/ai'
import type { AiPageRequest, PageRunInfo, ToolCall, ToolResult } from '@/api/ai'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { usePageAiAllowed } from '@/lib/pagePerms'
import { haptic } from '@/lib/haptic'
import { useIdeBusStore } from '../ideBus'
import type { PanelProps } from '../types'
import {
  MarkdownContent,
  appendText, appendTool, settleTool,
  segmentsText, segmentsReasoning, segmentsTools, fallbackSegments,
} from '@/components/ai'
import type { Segment, ToolCallEntry } from '@/components/ai'

// ── 类型 ────────────────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ToolCallEntry[]
  /** 流式时间线(text/reasoning/tools 按到达顺序);恢复自 localStorage 时缺省 */
  segments?: Segment[]
  runId?: string
}

/** unified diff 的单行(hunk 头 / 上下文 / 新增 / 删除) */
interface DiffLine {
  kind: 'hunk' | 'ctx' | 'add' | 'del'
  text: string
}

/** pod_edit_file 工具产生的修改建议卡片 */
interface DiffCard {
  /** 卡片主键:先到的 tool_call_id,或 file_edit 事件的 action_id */
  id: string
  runId: string
  /** 绝对路径(/home/cloud/… 或 /shared/…),与文件 REST API 一致 */
  path: string
  /** file_edit 事件的 action_id(action_result 回传用它,断线重放去重也靠它) */
  actionId?: string
  /** 走后端 rendezvous 流程(接受后由服务端备份+写入,前端不自行 PUT) */
  serverWrite?: boolean
  /** 修改理由(file_edit 事件带) */
  reason?: string
  /** 全量新内容(工具给 new_content 时) */
  newContent?: string
  /** unified diff 文本(工具给 diff 时;或由 new_content 对比旧内容算出) */
  diffText?: string
  /** 渲染用,由 diffText 解析/计算而来,不持久化 */
  diffLines?: DiffLine[]
  addCount: number
  delCount: number
  status: 'pending' | 'accepted' | 'rejected'
  outcome?: string
}

/** ide_agent 的 pod_bash 确认卡(高危命令弹卡) */
interface BashAsk {
  runId: string
  actionId: string
  command: string
  resolved: '' | 'allowed' | 'denied' | 'timeout'
}

/** ide_agent 的 pod_bash 实时输出流(opencode bash.ts 风格) */
interface BashStream {
  runId: string
  command: string
  output: string
  done: boolean
  exit?: number | null
}

interface StoredRun {
  run_id: string
  question: string
  started: number
}

// ── localStorage(按 用户+Pod 隔离)──────────────────────────────

const lsKeys = {
  sid: (u: string, p: string) => `yatterra.ide.ai.sid.${encodeURIComponent(u)}.${encodeURIComponent(p)}`,
  runs: (u: string, p: string) => `yatterra.ide.ai.runs.${encodeURIComponent(u)}.${encodeURIComponent(p)}`,
  msgs: (u: string, p: string) => `yatterra.ide.ai.msgs.${encodeURIComponent(u)}.${encodeURIComponent(p)}`,
  auto: (u: string, p: string) => `yatterra.ide.ai.auto.${encodeURIComponent(u)}.${encodeURIComponent(p)}`,
}

/** AI 确认策略(后端 ide_agent.AUTO_MODES 对应) */
type AutoMode = 'all' | 'smart' | 'none'
const AUTO_ORDER: AutoMode[] = ['all', 'smart', 'none']
const AUTO_LABEL: Record<AutoMode, string> = {
  all: '全部确认',
  smart: '仅危险确认',
  none: '全自动',
}
const AUTO_DESC: Record<AutoMode, string> = {
  all: '所有命令和修改都需要你确认',
  smart: '修改与普通命令自动执行,删除/强推/卸载等危险操作仍需确认',
  none: '所有命令和修改自动执行,不弹任何确认',
}

const readLS = <T,>(key: string): T | null => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null')
    return (v as T) ?? null
  } catch {
    return null
  }
}
const saveLS = (key: string, v: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* private mode */ }
}
const removeLS = (key: string) => {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

// ── diff 计算(LCS 行级 diff → unified hunks)──────────────────

const MAX_DIFF_CELLS = 4_000_000
const DIFF_CTX = 3

type LcsOp = { op: '=' | '-' | '+'; text: string }

function lcsOps(a: string[], b: string[]): LcsOp[] | null {
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
        : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0)
    }
  }
  const ops: LcsOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: '=', text: a[i] as string })
      i++; j++
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      ops.push({ op: '-', text: a[i] as string })
      i++
    } else {
      ops.push({ op: '+', text: b[j] as string })
      j++
    }
  }
  while (i < n) { ops.push({ op: '-', text: a[i] as string }); i++ }
  while (j < m) { ops.push({ op: '+', text: b[j] as string }); j++ }
  return ops
}

/** 把 op 序列折叠成带 ±DIFF_CTX 行上下文的 unified hunks。 */
function buildUnified(ops: LcsOp[], path: string): { lines: DiffLine[]; text: string; add: number; del: number } {
  const changes: number[] = []
  for (let i = 0; i < ops.length; i++) if (ops[i]?.op !== '=') changes.push(i)
  if (!changes.length) return { lines: [], text: '', add: 0, del: 0 }
  const keep = new Set<number>()
  for (const c of changes) {
    for (let k = Math.max(0, c - DIFF_CTX); k <= Math.min(ops.length - 1, c + DIFF_CTX); k++) keep.add(k)
  }
  const lines: DiffLine[] = []
  const textParts: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let add = 0
  let del = 0
  let oldNo = 1
  let newNo = 1
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (!op || !keep.has(i)) {
      if (op) {
        if (op.op === '=') { oldNo++; newNo++ }
        else if (op.op === '-') { oldNo++; del++ }
        else { newNo++; add++ }
      }
      i++
      continue
    }
    const hunkOldStart = oldNo
    const hunkNewStart = newNo
    let oldCount = 0
    let newCount = 0
    const body: DiffLine[] = []
    while (i < ops.length && keep.has(i)) {
      const o = ops[i]
      if (!o) break
      if (o.op === '=') {
        body.push({ kind: 'ctx', text: o.text })
        oldCount++; newCount++; oldNo++; newNo++
      } else if (o.op === '-') {
        body.push({ kind: 'del', text: o.text })
        oldCount++; oldNo++; del++
      } else {
        body.push({ kind: 'add', text: o.text })
        newCount++; newNo++; add++
      }
      i++
    }
    const header = `@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`
    lines.push({ kind: 'hunk', text: header }, ...body)
    textParts.push(header, ...body.map((l) => (l.kind === 'ctx' ? ' ' : l.kind === 'del' ? '-' : '+') + l.text))
  }
  return { lines, text: textParts.join('\n'), add, del }
}

/** 解析现成的 unified diff 文本为可渲染行。 */
function parseUnifiedDiff(text: string): { lines: DiffLine[]; add: number; del: number } {
  const lines: DiffLine[] = []
  let add = 0
  let del = 0
  for (const l of text.split('\n')) {
    if (l.startsWith('@@')) { lines.push({ kind: 'hunk', text: l }); continue }
    if (l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('diff ') || l.startsWith('index ')) continue
    if (l.startsWith('\\')) continue // "\ No newline at end of file"
    if (l.startsWith('+')) { lines.push({ kind: 'add', text: l.slice(1) }); add++ }
    else if (l.startsWith('-')) { lines.push({ kind: 'del', text: l.slice(1) }); del++ }
    else lines.push({ kind: 'ctx', text: l.slice(1) })
  }
  return { lines, add, del }
}

/** 把 unified diff 应用到旧文本;上下文不匹配/格式坏返回 null。 */
function applyUnifiedDiff(oldText: string, diffText: string): string | null {
  const oldLines = oldText.split('\n')
  const raw = diffText.split('\n')
  const out: string[] = []
  let pos = 0
  let i = 0
  let sawHunk = false
  while (i < raw.length) {
    const line = raw[i]
    if (line === undefined) break
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) { i++; continue }
    sawHunk = true
    const startIdx = Math.max(1, parseInt(m[1] as string, 10)) - 1
    if (startIdx < pos || startIdx > oldLines.length) return null
    out.push(...oldLines.slice(pos, startIdx))
    let idx = startIdx
    i++
    while (i < raw.length && !raw[i]?.startsWith('@@')) {
      const bl = raw[i] as string
      if (bl.startsWith('\\')) { i++; continue }
      const ch = bl.charAt(0)
      const text = bl.slice(1)
      if (ch === '+') {
        out.push(text)
      } else if (ch === '-' || ch === ' ') {
        if (idx >= oldLines.length || oldLines[idx] !== text) return null
        if (ch === ' ') out.push(text)
        idx++
      } else {
        // 无前缀行(罕见): 当作上下文
        if (idx >= oldLines.length || oldLines[idx] !== bl) return null
        out.push(bl)
        idx++
      }
      i++
    }
    pos = idx
  }
  if (!sawHunk) return null
  out.push(...oldLines.slice(pos))
  return out.join('\n')
}

// ── pod_edit_file 载荷提取 ──────────────────────────────────────

interface EditPayload { path?: string; newContent?: string; diff?: string; reason?: string }

/** 归一成文件 REST API 认的绝对路径。
 *  后端 pod_edit_file 的 path 相对 /home/cloud(如 "app.py"),
 *  files/content|save 只认 /home/cloud/… 或 /shared/… 开头。 */
function normalizePodPath(p: string | undefined): string | undefined {
  if (!p) return undefined
  const s = p.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!s) return undefined
  if (s === 'home/cloud' || s.startsWith('home/cloud/') || s === 'shared' || s.startsWith('shared/')) {
    return `/${s}`
  }
  if (p.trim().startsWith('/')) return p.trim() // 已是绝对路径,原样透传
  return `/home/cloud/${s}`
}

/** 从工具参数/结果对象里提取 {path, new_content, diff}(容忍字段别名)。 */
function extractEditPayload(data: unknown): EditPayload {
  if (!data || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    path: str(d.path) ?? str(d.file) ?? str(d.file_path),
    newContent: str(d.new_content) ?? str(d.content) ?? str(d.newContent),
    diff: str(d.diff) ?? str(d.unified_diff),
  }
}

/** 工具结果字符串 → 载荷:JSON 对象 / 裸 unified diff / 其它(空)。 */
function payloadFromResult(result: unknown): EditPayload {
  if (typeof result !== 'string') return extractEditPayload(result)
  const s = result.trim()
  if (!s) return {}
  try {
    const parsed: unknown = JSON.parse(s)
    if (parsed && typeof parsed === 'object') return extractEditPayload(parsed)
  } catch { /* not json */ }
  if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(s)) return { diff: s }
  return {}
}

// ── 项目画像格式化 ──────────────────────────────────────────────

interface ProfileResponse {
  profile?: Record<string, unknown> | null
  changes?: Array<Record<string, unknown>> | null
}

function formatProfile(data: ProfileResponse | null): string {
  const p = data?.profile
  if (!p) return ''
  const lines: string[] = []
  const push = (label: string, v: unknown) => {
    if (typeof v === 'string' && v.trim()) lines.push(`${label}: ${v.slice(0, 600)}`)
  }
  push('用途', p.purpose)
  push('技术栈', p.stack)
  push('入口', p.entrypoints)
  push('模块', p.modules)
  push('概要', p.summary)
  const ch = data?.changes
  if (Array.isArray(ch) && ch.length) {
    const recent = ch.slice(0, 3)
      .map((c) => (typeof c.summary === 'string' ? c.summary : ''))
      .filter(Boolean)
    if (recent.length) lines.push(`近期变更: ${recent.join(' / ')}`)
  }
  return lines.join('\n')
}

// ── 消息体渲染(IDE 设计语言:工具过程行 / 思考注释 / markdown)────

/** 工具名 → 过程行动词(IDE 助手栏的紧凑展示)。 */
const TOOL_VERBS: Record<string, string> = {
  run: '执行命令', run_remote: '远程执行', shell_exec: '执行命令',
  read_file: '读文件', write_file: '写文件', edit_file: '编辑文件',
  pod_bash: '执行命令', read: '读文件', edit: '编辑文件', glob: '找文件',
  grep: '搜索', list_dir: '列目录', spawn_agent: '派出子代理',
  web_search: '搜索网页', fetch_url: '抓取网页',
  inspect: 'K8s 查询', pod_file: '读文件', pod_logs: '看日志',
  list_pods: '列 Pod', get_pod: '查 Pod', cluster_status: '查集群',
  pod_code_search: '代码检索', pod_code_read: '读代码', pod_code_symbols: '查符号',
  screenshot: '截图', browser_navigate: '导航', browser_click: '点击',
  vision: '视觉分析', ai_chat: 'AI 子调用',
}

/** 工具调用过程行:mono 11.5px muted,▸ 前缀,运行中尾部三个跳动点;点击展开结果。 */
function IdeToolLines({ calls }: { calls: ToolCallEntry[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (!calls.length) return null
  return (
    <div className="my-1">
      {calls.map((tc) => {
        const isOpen = open[tc.id] ?? false
        const verb = TOOL_VERBS[tc.name] || tc.name
        const mainArg =
          typeof tc.args.path === 'string' ? tc.args.path
          : typeof tc.args.file === 'string' ? tc.args.file
          : typeof tc.args.query === 'string' ? tc.args.query
          : typeof tc.args.cmd === 'string' ? tc.args.cmd
          : typeof tc.args.command === 'string' ? tc.args.command
          : ''
        const expandable = Boolean(tc.result)
        return (
          <div key={tc.id}>
            <button
              type="button"
              className="ide-tool-line"
              onClick={() => expandable && setOpen((p) => ({ ...p, [tc.id]: !p[tc.id] }))}
              disabled={!expandable}
            >
              <span aria-hidden>▸</span>
              <span className="ide-tool-line-name">{verb}</span>
              {mainArg && <span className="ide-tool-line-arg">{mainArg}</span>}
              {tc.status === 'running' && (
                <span className="ide-dots" aria-label="运行中">
                  <i /><i /><i />
                </span>
              )}
              {expandable && (isOpen
                ? <ChevronDown size={11} className="flex-none self-center" />
                : <ChevronRight size={11} className="flex-none self-center" />)}
            </button>
            {isOpen && tc.result && (
              <pre className="ide-tool-line-result">{tc.result}</pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 思考过程:mono 注释风折叠块。 */
function IdeReasoning({ text, loading }: { text: string; loading?: boolean }) {
  const [open, setOpen] = useState(() => Boolean(loading))
  useEffect(() => { setOpen(Boolean(loading)) }, [loading])
  if (!text) return null
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="ide-tool-line"
        style={{ width: 'auto' }}
      >
        <span aria-hidden>//</span>
        <span className="ide-tool-line-name">{loading ? '思考中…' : '思考过程'}</span>
        {loading && (
          <span className="ide-dots" aria-label="运行中"><i /><i /><i /></span>
        )}
        {!loading && (open
          ? <ChevronDown size={11} className="flex-none self-center" />
          : <ChevronRight size={11} className="flex-none self-center" />)}
      </button>
      {open && (
        <pre className="ide-tool-line-result" style={{ maxHeight: 180 }}>{text}</pre>
      )}
    </div>
  )
}

function AssistantBody({ msg, streaming, overlay }: {
  msg: ChatMsg
  streaming: boolean
  /** 把确认卡/控制台按到达锚点插进时间线: overlay(n) = 第 n 段之后要渲染的挂件。 */
  overlay?: (n: number) => ReactNode
}) {
  const segs = msg.segments?.length ? msg.segments : fallbackSegments(msg)
  const hasText = segs.some((s) => s.kind === 'text')
  const hasTools = segs.some((s) => s.kind === 'tools')
  return (
    <>
      {overlay?.(0)}
      {segs.map((seg, i) => {
        const isLast = i === segs.length - 1
        let node: ReactNode = null
        if (seg.kind === 'reasoning') {
          node = <IdeReasoning text={seg.text} loading={streaming && isLast} />
        } else if (seg.kind === 'tools') {
          const calls = seg.calls.filter((c) => c.name !== 'pod_edit_file')
          node = calls.length ? <IdeToolLines calls={calls} /> : null
        } else {
          node = (
            <div className="ide-ai-md [&>div]:text-[length:inherit]">
              <MarkdownContent content={seg.text} />
            </div>
          )
        }
        return (
          <Fragment key={i}>
            {node}
            {overlay?.(i + 1)}
          </Fragment>
        )
      })}
      {overlay?.(Number.POSITIVE_INFINITY)}
      {streaming && !hasText && (
        <div className="ide-tool-line" style={{ width: 'auto' }}>
          <span className="ide-dots" aria-label="运行中"><i /><i /><i /></span>
          <span>{hasTools ? '执行工具中…' : '思考中…'}</span>
        </div>
      )}
    </>
  )
}

// ── diff 卡片 ───────────────────────────────────────────────────

const DIFF_LINE_CLS: Record<DiffLine['kind'], string> = {
  hunk: 'ide-diff-l-hunk',
  ctx: 'ide-diff-l-ctx',
  add: 'ide-diff-l-add',
  del: 'ide-diff-l-del',
}
const DIFF_PREFIX: Record<DiffLine['kind'], string> = { hunk: '@', ctx: ' ', add: '+', del: '-' }

function DiffCardView({
  card, onAccept, onReject, mobile,
}: {
  card: DiffCard
  onAccept: (c: DiffCard) => void
  onReject: (c: DiffCard) => void
  mobile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const base = card.path.split('/').pop() || card.path
  const busy = card.status === 'pending' && card.outcome === '写入中…'
  return (
    <div className="ide-diff-card">
      <div className="ide-diff-head">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ide-diff-headbtn"
          aria-expanded={open}
          title={card.reason ? `${card.path} — ${card.reason}` : card.path}
        >
          <FileDiff size={12} className="flex-none" style={{ color: 'var(--ide-accent)' }} />
          <span className="min-w-0 flex-1 truncate">{base}</span>
          {card.reason && (
            <span className="ide-diff-reason min-w-0 flex-1 truncate">{card.reason}</span>
          )}
          <span className="flex-none" style={{ color: 'var(--ide-diff-add)' }}>+{card.addCount}</span>
          <span className="flex-none" style={{ color: 'var(--ide-diff-del)' }}>-{card.delCount}</span>
          {open ? <ChevronDown size={12} className="flex-none" /> : <ChevronRight size={12} className="flex-none" />}
        </button>
        {card.status === 'pending' && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReject(card)}
              className="ide-btn ide-btn-ghost"
              style={mobile ? { height: 36, width: 44 } : undefined}
              title="拒绝修改"
            >
              ✕
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAccept(card)}
              className="ide-btn ide-btn-accent"
              style={mobile ? { height: 36, width: 44 } : undefined}
              title={busy ? '写入中…' : '接受修改'}
            >
              {busy ? '…' : '✓'}
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="ide-diff-code">
          {card.diffLines?.length ? (
            card.diffLines.map((l, i) => (
              <div key={i} className={cn('ide-diff-l', DIFF_LINE_CLS[l.kind])}>
                <span className="ide-diff-sign">{DIFF_PREFIX[l.kind]}</span>
                <span className="min-w-0 flex-1">{l.text}</span>
              </div>
            ))
          ) : card.newContent != null ? (
            <pre className="whitespace-pre-wrap break-all px-2 py-2">{card.newContent}</pre>
          ) : (
            <p className="px-2 py-2" style={{ color: 'var(--ide-mut)' }}>（无内容预览）</p>
          )}
        </div>
      )}
      {card.status !== 'pending' && (
        <p
          className="px-2 py-1 font-mono text-[11px]"
          style={{ color: card.status === 'accepted' ? 'var(--ide-diff-add)' : 'var(--ide-mut)' }}
        >
          {card.status === 'accepted' ? '✓ ' : ''}{card.outcome}
        </p>
      )}
    </div>
  )
}

// ── 语音输入(Web Speech API, 不支持时按钮不渲染)───────────────

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechCtor = new () => SpeechRecognitionLike

function getSpeechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.webkitSpeechRecognition as SpeechCtor | undefined) ?? (w.SpeechRecognition as SpeechCtor | undefined) ?? null
}

// ── 主组件 ──────────────────────────────────────────────────────

const IDE_HINTS = ['解释当前打开的文件', '修复最近的报错', '审查我的代码并提建议', '帮我写单元测试', '这个项目的架构是什么？', '/goal 帮我把首页改成暗色主题']

// ── slash 命令(Claude Code / opencode 风格: 输入 / 弹选择框)────────
interface SlashCmd {
  /** 命令名(不含 /) */
  name: string
  /** 参数提示(选择框里灰显) */
  argsHint?: string
  desc: string
  /** 选中后的行为: complete=补全到输入框继续输入; action=立即执行 */
  behavior: 'complete' | 'action'
}

const SLASH_CMDS: SlashCmd[] = [
  {
    name: 'fix',
    desc: '修复最近的报错(自动带上终端里的真实报错)',
    behavior: 'action',
  },
  {
    name: 'explain',
    desc: '解释当前打开的文件(自动带上文件内容)',
    behavior: 'action',
  },
  {
    name: 'run',
    desc: '把项目跑起来,报错就修,直到能正常运行',
    behavior: 'action',
  },
  {
    name: 'plan',
    argsHint: '<需求>',
    desc: '计划模式:AI 只调研并给出分步计划,你确认后才动手改',
    behavior: 'complete',
  },
  {
    name: 'goal',
    argsHint: '<需求>',
    desc: '目标模式:持续推进并自动核查完成度;目标会存盘,平台重启后自动继续;发 /goal off 取消',
    behavior: 'complete',
  },
  {
    name: 'new',
    desc: '开始新对话(清空当前会话)',
    behavior: 'action',
  },
  {
    name: 'auto',
    desc: '切换 AI 确认策略(全部确认 / 仅危险确认 / 全自动)',
    behavior: 'action',
  },
]

/** 动作命令展开成的一句话模板(context 注入会自动补上报错/文件/画像) */
const ACTION_TEMPLATES: Record<string, string> = {
  fix: '修复最近的报错:查看上面提供的终端输出,定位原因并直接修改代码修好它。',
  explain: '解释当前打开的文件:它做什么、整体结构如何、关键逻辑在哪,用通俗的语言。',
  run: '把项目跑起来:根据项目画像找到入口和启动方式并运行它;有报错就修复再试,直到项目能正常运行。',
}

export function AiPanel(props: PanelProps) {
  const { podName, activate, surface } = props
  const mobile = surface === 'mobile'
  const user = useAuthStore((s) => s.user)
  const aiAllowed = usePageAiAllowed('pod_ide')
  const toast = useToastStore((s) => s.add)

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [cards, setCards] = useState<DiffCard[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [activeRunIds, setActiveRunIds] = useState<Set<string>>(() => new Set())
  const [listening, setListening] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  /** 输入框聚焦态:context chips 聚焦时才淡入 */
  const [inputFocused, setInputFocused] = useState(false)
  /** 项目画像是否已就位(输入区 context chips 展示用,纯展示状态) */
  const [profileReady, setProfileReady] = useState(false)
  /** AI 确认策略(all/smart/none),按 用户+Pod 持久化 */
  const [autoMode, setAutoMode] = useState<AutoMode>('all')
  /** 本会话挂着的 /goal 目标(服务端落盘, 平台重启会自动拉起复核; 完成即消失) */
  const [goal, setGoal] = useState<{ text: string; resumes: number } | null>(null)
  /** slash 命令选择框: 当前高亮项;slashOff=Esc 关闭(输入变化后自动复位) */
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashOff, setSlashOff] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  // 每个 run 一份: 流式段缓冲 + 停止控制器(后台执行, 卸载不中止服务端任务)
  const runSegments = useRef(new Map<string, Segment[]>())
  const runCtrls = useRef(new Map<string, AbortController>())
  /** run 开始时间(顶栏计时器用) */
  const runStarts = useRef(new Map<string, number>())
  const cardsRef = useRef<DiffCard[]>([])
  /** 确认卡/控制台在消息时间线里的插入锚点: `runId|id` → 到达时已有的段数。
   *  流式期间按到达顺序记录(只记第一次),渲染时插到第 n 段之后——而不是
   *  全部堆在消息末尾(那样展开的工具输出会吊在最新回答下面)。 */
  const itemAnchor = useRef(new Map<string, number>())
  const profileRef = useRef<ProfileResponse | null>(null)
  const attachRef = useRef<((runId: string, question: string, resume: boolean) => Promise<void>) | null>(null)
  const sendRef = useRef<(text?: string) => void>(() => {})
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const recBaseRef = useRef('')
  const activateRef = useRef(activate)
  activateRef.current = activate

  const speechSupported = useMemo(() => getSpeechCtor() !== null, [])
  const loading = activeRunIds.size > 0

  useEffect(() => { cardsRef.current = cards }, [cards])

  // ── ide_agent harness 的确认卡 + 实时输出流 ──
  const [bashAsks, setBashAsks] = useState<BashAsk[]>([])
  const [bashStreams, setBashStreams] = useState<Record<string, BashStream>>({})

  /** 记录挂件(卡/弹卡/控制台)的到达锚点;同一 id 只记第一次(事件是增量到达的)。 */
  const markAnchor = useCallback((runId: string, id: string) => {
    const k = `${runId}|${id}`
    if (!itemAnchor.current.has(k)) {
      itemAnchor.current.set(k, (runSegments.current.get(runId) || []).length)
    }
  }, [])

  /** 取挂件锚点。id 可能先是 tool_call_id、之后才绑定成 action_id,两个都查;
   *  都没有(如 localStorage 恢复的旧卡)→ Infinity,退回消息末尾渲染。 */
  const anchorFor = (runId: string, ...ids: (string | undefined)[]) => {
    for (const id of ids) {
      if (!id) continue
      const v = itemAnchor.current.get(`${runId}|${id}`)
      if (v != null) return v
    }
    return Number.POSITIVE_INFINITY
  }

  /** 同步变更 cards:基于 cardsRef.current 立即计算并先更新 ref,再提交 state。
   *  不能把赋值写进 setCards 的 updater 再在外层同步读——流式期间 fiber 有 pending
   *  updates,updater 会被推迟到 render 阶段执行,外层读到的还是旧值
   *  (notifySaved/activate 会被跳过)。compute 在这里被直接调用,同步执行一次。 */
  const applyCards = useCallback((compute: (prev: DiffCard[]) => DiffCard[]) => {
    const next = compute(cardsRef.current)
    cardsRef.current = next
    setCards(next)
  }, [])

  // ── 文件 REST 帮助 ──
  const fetchFileContent = useCallback(async (path: string): Promise<string | null> => {
    try {
      const data = await apiFetch<{ ok?: boolean; content?: string; binary?: boolean }>(
        `/pods/${encodeURIComponent(podName)}/files/content?path=${encodeURIComponent(path)}`)
      if (!data?.ok || data.binary) return null
      return data.content ?? null
    } catch {
      return null
    }
  }, [podName])

  const updateCard = useCallback((id: string, patch: Partial<DiffCard>) => {
    applyCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }, [applyCards])

  /** pod_bash 弹卡:允许 / 总是允许(本次会话) / 总是允许该前缀 / 拒绝,结果走 rendezvous。 */
  const resolveBashAsk = useCallback(
    (ask: BashAsk, allowed: boolean, always: boolean, alwaysPrefix = false) => {
      setBashAsks((prev) => prev.map((a) =>
        a.actionId === ask.actionId ? { ...a, resolved: allowed ? 'allowed' : 'denied' } : a))
      aiApi.submitPageActionResult(
        ask.runId, [{ allowed, always, always_prefix: alwaysPrefix }], ask.actionId,
      ).catch(() => {})
    }, [])

  /** 卡片就位后异步补齐 diffLines(拉旧文件算 LCS,或解析现成 diff)。 */
  const materializeCard = useCallback(async (id: string) => {
    const card = cardsRef.current.find((c) => c.id === id)
    if (!card) return
    if (card.diffLines?.length) return
    if (card.diffText) {
      const { lines, add, del } = parseUnifiedDiff(card.diffText)
      updateCard(id, {
        diffLines: lines,
        addCount: card.addCount || add,
        delCount: card.delCount || del,
      })
      return
    }
    if (card.newContent != null) {
      const old = await fetchFileContent(card.path)
      if (old != null) {
        const ops = lcsOps(old.split('\n'), card.newContent.split('\n'))
        if (ops) {
          const u = buildUnified(ops, card.path)
          updateCard(id, { diffText: u.text, diffLines: u.lines, addCount: u.add, delCount: u.del })
          return
        }
      }
      // 兜底: 拿不到旧文件/太大 → 直接展示全量新内容
      const lines: DiffLine[] = card.newContent.split('\n').map((t) => ({ kind: 'add' as const, text: t }))
      updateCard(id, {
        diffLines: [{ kind: 'hunk', text: '@@ 新文件内容 @@' }, ...lines],
        addCount: lines.length,
        delCount: 0,
      })
    }
  }, [fetchFileContent, updateCard])

  // 兜底:pending 卡片缺渲染行(创建时 cardsRef 尚未提交/file_edit 补 diff 后) → 补算。
  // materializeCard 对已有 diffLines 的卡片早退,不会循环。
  useEffect(() => {
    for (const c of cards) {
      if (c.status === 'pending' && !c.diffLines?.length && (c.diffText || c.newContent != null)) {
        void materializeCard(c.id)
      }
    }
  }, [cards, materializeCard])

  /** tool_call 参数 / tool_result → upsert 一张 pending 卡片。 */
  const upsertDiffCard = useCallback((runId: string, id: string, payload: EditPayload) => {
    let created = false
    applyCards((prev) => {
      const existing = prev.find((c) => c.id === id)
      const path = normalizePodPath(payload.path) ?? existing?.path
      if (!path) return prev
      created = !existing
      const merged: DiffCard = {
        ...(existing ?? { id, runId, path, addCount: 0, delCount: 0, status: 'pending' as const }),
        id,
        runId,
        path,
        newContent: payload.newContent ?? existing?.newContent,
        diffText: payload.diff ?? existing?.diffText,
      }
      return existing ? prev.map((c) => (c.id === id ? merged : c)) : [...prev, merged]
    })
    if (created) {
      // AI 给出修改建议 → 把本面板带到用户眼前(桌面切 tab,手机展开抽屉)
      activateRef.current()
    }
    void materializeCard(id)
  }, [materializeCard, applyCards])

  /** file_edit 事件(服务端算好 diff,等用户在卡片上接受/拒绝)→ upsert 卡片。
   *  先绑定同路径、还没绑过 file_edit 的 pending 卡(tool_call 先到时创建的那张),
   *  避免同一修改出两张卡;断线重放按 action_id 幂等。 */
  const upsertFileEditCard = useCallback(
    (runId: string, actionId: string, payload: { path: string; diff?: string; diffSummary?: string; reason?: string }) => {
      let targetId = actionId
      let created = false
      applyCards((prev) => {
        const m = payload.diffSummary?.match(/\+(\d+)\s*-\s*(\d+)/)
        const add = m ? Number(m[1]) : 0
        const del = m ? Number(m[2]) : 0
        // 重放:已绑过同一 action_id 的卡 → 只刷新 diff,不动 status
        const byAction = prev.find((c) => c.actionId === actionId || c.id === actionId)
        if (byAction) {
          targetId = byAction.id
          return prev.map((c) =>
            c.id === byAction.id
              ? {
                  ...c,
                  actionId,
                  serverWrite: true,
                  reason: payload.reason ?? c.reason,
                  diffText: payload.diff ?? c.diffText,
                  // 换成服务端权威 diff 后重算渲染行
                  diffLines: payload.diff ? undefined : c.diffLines,
                  addCount: add || c.addCount,
                  delCount: del || c.delCount,
                }
              : c,
          )
        }
        // tool_call 先到、同路径、尚未绑定 file_edit 的 pending 卡 → 原地绑定
        const cand = prev.find(
          (c) => c.runId === runId && c.status === 'pending' && !c.actionId && c.path === payload.path,
        )
        if (cand) {
          targetId = cand.id
          return prev.map((c) =>
            c.id === cand.id
              ? {
                  ...c,
                  actionId,
                  serverWrite: true,
                  reason: payload.reason,
                  diffText: payload.diff ?? c.diffText,
                  diffLines: payload.diff ? undefined : c.diffLines,
                  addCount: add || c.addCount,
                  delCount: del || c.delCount,
                }
              : c,
          )
        }
        created = true
        return [
          ...prev,
          {
            id: actionId,
            runId,
            path: payload.path,
            actionId,
            serverWrite: true,
            reason: payload.reason,
            diffText: payload.diff,
            addCount: add,
            delCount: del,
            status: 'pending' as const,
          },
        ]
      })
      if (created) activateRef.current()
      void materializeCard(targetId)
    },
    [materializeCard, applyCards],
  )

  /** pod_edit_file 的 tool_result → 落定对应卡片。
   *  成功结果是 JSON {path, diff_summary, backup_path};拒绝/超时/权限不足是纯文本。
   *  服务端 rendezvous 流程下文件由后端写入,这里只落定卡片并通知编辑器刷新。 */
  const settleEditCard = useCallback((runId: string, toolCallId: string, result: unknown) => {
    const payload = payloadFromResult(result)
    const path = normalizePodPath(payload.path)
    const success = !!path
    const message = typeof result === 'string' ? result.trim().slice(0, 300) : ''
    let matched: DiffCard | null = null
    // applyCards 同步执行 compute:matched 在下方 if 处已可靠赋值
    applyCards((prev) => {
      const cand =
        prev.find(
          (c) => c.runId === runId && c.status === 'pending' && (c.id === toolCallId || c.actionId === toolCallId),
        ) ??
        (path
          ? prev.find((c) => c.runId === runId && c.status === 'pending' && c.path === path)
          : undefined)
      if (!cand) return prev
      matched = cand
      return prev.map((c) =>
        c.id === cand!.id
          ? success
            ? { ...c, status: 'accepted' as const, outcome: '已写入文件' }
            : { ...c, status: 'rejected' as const, outcome: message || '修改未生效' }
          : c,
      )
    })
    if (matched && success && path) {
      const bus = useIdeBusStore.getState()
      bus.notifySaved(path)
      bus.pushEdit({ path, kind: 'save' })
    }
  }, [applyCards])

  // ── 接受 / 拒绝 ──
  const resolveCard = useCallback(async (card: DiffCard, accept: boolean) => {
    if (card.status !== 'pending') return
    if (!accept) {
      haptic('light')
      updateCard(card.id, { status: 'rejected', outcome: '已拒绝，未做任何修改' })
      // 回传 accepted:false 唤醒等待中的工具(仅 rendezvous 流程的卡片;
      // 无 action_id 时不回传,避免误唤醒别的等待中的工具)
      if (card.actionId) {
        aiApi.submitPageActionResult(
          card.runId,
          [{ accepted: false, detail: '用户拒绝了修改' }],
          card.actionId,
        ).catch(() => {})
      }
      return
    }
    haptic('selection')
    // 服务端 rendezvous 流程:接受后由后端备份+写入(备份的是真正的旧内容),
    // tool_result 事件回来再落定卡片并通知编辑器刷新;前端不自行 PUT。
    if (card.actionId && card.serverWrite) {
      updateCard(card.id, { outcome: '写入中…' })
      try {
        await aiApi.submitPageActionResult(
          card.runId,
          [{ accepted: true, detail: '用户已接受修改' }],
          card.actionId,
        )
      } catch {
        updateCard(card.id, { outcome: undefined })
        toast({ type: 'error', message: '确认回传失败，请重试' })
      }
      return
    }
    // 兜底(没收到 file_edit 事件,如旧后端):前端自行应用 diff 并写入
    updateCard(card.id, { outcome: '写入中…' })
    let content: string | null = card.newContent ?? null
    if (content == null && card.diffText) {
      const old = await fetchFileContent(card.path)
      content = old != null ? applyUnifiedDiff(old, card.diffText) : null
    }
    if (content == null) {
      updateCard(card.id, { outcome: undefined })
      toast({ type: 'error', message: '无法应用修改：缺少新内容或 diff 与当前文件不匹配' })
      return
    }
    try {
      await apiFetch(`/pods/${encodeURIComponent(podName)}/files/save`, {
        method: 'PUT',
        body: JSON.stringify({ path: card.path, content }),
      })
      updateCard(card.id, { status: 'accepted', outcome: '已写入文件' })
      // 通知 EditorPanel 刷新该文件 + 记入最近编辑
      const bus = useIdeBusStore.getState()
      bus.notifySaved(card.path)
      bus.pushEdit({ path: card.path, kind: 'save' })
      toast({ type: 'success', message: `已写入 ${card.path.split('/').pop() || card.path}` })
    } catch (e) {
      updateCard(card.id, { outcome: undefined })
      toast({ type: 'error', message: `写入失败：${e instanceof Error ? e.message : '未知错误'}` })
    }
  }, [podName, fetchFileContent, updateCard, toast])

  // ── 消息更新 + 事件流跟随(后台 run, offset 断线续传)──
  const updateRunMsg = useCallback((runId: string, updates: Partial<ChatMsg>) => {
    setMessages((prev) => prev.map((m) => (m.runId === runId ? { ...m, ...updates, role: 'assistant' as const } : m)))
  }, [])

  const attachRun = useCallback(async (runId: string, question: string, resume: boolean) => {
    runSegments.current.set(runId, [])
    runStarts.current.set(runId, Date.now())
    setActiveRunIds((prev) => new Set(prev).add(runId))
    stickRef.current = true
    setMessages((prev) => [
      // 重接时先清掉快照里同 runId 的半成品消息,避免重复
      ...prev.filter((m) => m.runId !== runId),
      ...(resume ? [] : [{ role: 'user' as const, content: question }]),
      { role: 'assistant' as const, content: '', runId },
    ])
    const ctrl = new AbortController()
    runCtrls.current.set(runId, ctrl)

    const commit = () => {
      const segments = runSegments.current.get(runId) || []
      updateRunMsg(runId, {
        content: segmentsText(segments),
        reasoning: segmentsReasoning(segments),
        toolCalls: segmentsTools(segments),
        segments,
      })
    }
    const push = (kind: 'reasoning' | 'text', data: string) => {
      runSegments.current.set(runId, appendText(runSegments.current.get(runId) || [], kind, data))
      commit()
    }

    let offset = 0
    let terminal = false
    try {
      for (let attempt = 0; attempt < 8 && !terminal; attempt++) {
        const resp = await fetch(
          `/api/ai/page/stream?run_id=${encodeURIComponent(runId)}&offset=${offset}`,
          { credentials: 'same-origin', signal: ctrl.signal })
        if (!resp.ok || !resp.body) throw new Error('Stream failed')
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          while (!terminal) {
            const chunk = await reader.read()
            buffer += decoder.decode(chunk.value, { stream: !chunk.done })
            const frames = buffer.replace(/\r\n/g, '\n').split('\n\n')
            buffer = frames.pop() || ''
            if (chunk.done && buffer.trim()) { frames.push(buffer); buffer = '' }
            for (const frame of frames) {
              const lines = frame.split('\n')
              const idLine = lines.find((l) => l.startsWith('id:'))
              const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
              if (!data) continue
              const id = idLine ? Number(idLine.slice(3)) : offset
              if (!Number.isInteger(id) || id < offset) continue
              let ev: { type?: string; data?: unknown; cancelled?: boolean }
              try { ev = JSON.parse(data) } catch { continue }
              if (ev.type === 'reasoning') push('reasoning', String(ev.data ?? ''))
              else if (ev.type === 'content') push('text', String(ev.data ?? ''))
              else if (ev.type === 'tool_call') {
                const tc = ev.data as ToolCall
                runSegments.current.set(runId, appendTool(runSegments.current.get(runId) || [], {
                  id: tc.id, name: tc.name, args: tc.arguments, status: 'running',
                }))
                if (tc.name === 'pod_edit_file') {
                  const payload = extractEditPayload(tc.arguments)
                  if (payload.path) upsertDiffCard(runId, tc.id, payload)
                }
                // 该工具的卡片/控制台应插在这条工具行之后
                markAnchor(runId, tc.id)
                commit()
              } else if (ev.type === 'tool_result') {
                const tr = ev.data as ToolResult
                runSegments.current.set(runId, settleTool(runSegments.current.get(runId) || [], tr.tool_call_id, {
                  result: tr.result, status: 'done',
                }))
                if (tr.name === 'pod_edit_file' || tr.name === 'edit') {
                  // rendezvous 落定:成功=JSON{path,diff_summary,backup},
                  // 拒绝/超时/权限不足=纯文本
                  settleEditCard(runId, tr.tool_call_id, tr.result)
                }
                commit()
              }
              // file_edit(pod_edit_file):服务端算好的 diff + action_id,渲染卡片等用户决定
              else if (ev.type === 'file_edit') {
                const fe = (ev.data ?? {}) as Record<string, unknown>
                const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
                const fePath = normalizePodPath(str(fe.path))
                const actionId = str(fe.action_id)
                if (fePath && actionId) {
                  upsertFileEditCard(runId, actionId, {
                    path: fePath,
                    diff: str(fe.diff),
                    diffSummary: str(fe.diff_summary),
                    reason: str(fe.reason),
                  })
                  markAnchor(runId, actionId)
                }
              }
              // ── ide_agent harness 事件 ──
              // edit_confirm: 每次 edit 即时弹 diff 卡(opencode Permission.ask 风格),
              // 接受=后端当场写入,拒绝=丢弃并回告模型
              else if (ev.type === 'edit_confirm') {
                const es = (ev.data ?? {}) as Record<string, unknown>
                const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
                const rel = str(es.path)
                const aid = str(es.action_id)
                if (rel && aid) {
                  const abs = rel.startsWith('/home/cloud/') ? rel : `/home/cloud/${rel.replace(/^\//, '')}`
                  upsertFileEditCard(runId, aid, {
                    path: abs,
                    diff: str(es.diff),
                    diffSummary: str(es.summary),
                    reason: str(es.reason),
                  })
                  markAnchor(runId, aid)
                }
              }
              // bash_confirm: 高危 pod_bash 命令弹卡(允许/总是允许/拒绝)
              else if (ev.type === 'bash_confirm') {
                const bc = (ev.data ?? {}) as { action_id?: string; command?: string }
                const aid = bc?.action_id
                if (aid) {
                  setBashAsks((prev) => prev.some((a) => a.actionId === aid)
                    ? prev
                    : [...prev, { runId, actionId: aid, command: String(bc.command || ''), resolved: '' }])
                  markAnchor(runId, aid)
                  activateRef.current()
                }
              }
              // bash_confirm_result: 后端确认等待超时(180s)→ 卡片标记已超时
              else if (ev.type === 'bash_confirm_result') {
                const bcr = (ev.data ?? {}) as { action_id?: string; outcome?: string }
                if (bcr?.action_id && bcr.outcome === 'timeout') {
                  setBashAsks((prev) => prev.map((a) =>
                    a.actionId === bcr.action_id && !a.resolved ? { ...a, resolved: 'timeout' } : a))
                }
              }
              // bash_output: pod_bash 实时输出流(增量 delta 追加,done=true 收尾带全文)
              else if (ev.type === 'bash_output') {
                const bo = (ev.data ?? {}) as { action_id?: string; command?: string; output?: string; delta?: string; done?: boolean; exit?: number | null }
                const aid = bo?.action_id
                if (aid) {
                  setBashStreams((prev) => ({
                    ...prev,
                    [aid]: {
                      runId,
                      command: String(bo.command || prev[aid]?.command || ''),
                      output: bo.delta != null
                        ? (prev[aid]?.output || '') + String(bo.delta)
                        : String(bo.output ?? (prev[aid]?.output || '')),
                      done: !!bo.done,
                      exit: bo.exit ?? null,
                    },
                  }))
                  markAnchor(runId, aid)
                }
              }
              // page_action(browser_control)在 IDE 面板不执行,忽略(服务端自行超时)
              else if (ev.type === 'done') {
                if (ev.cancelled) push('text', '\n\n[已停止]')
                // run 结束:清掉未决的 bash 弹卡(后端等待已超时/已收到结果,
                // 再点也不会送达);未决的 edit 卡冻结为拒绝态
                setBashAsks((prev) => prev.filter((a) => a.runId !== runId || a.resolved !== ''))
                applyCards((prev) => prev.map((c) =>
                  c.runId === runId && c.status === 'pending'
                    ? { ...c, status: 'rejected' as const, outcome: '会话已结束,未写入' }
                    : c))
                terminal = true
              } else if (ev.type === 'error') {
                push('text', `\n\n${typeof ev.data === 'string' ? ev.data : '任务失败'}`)
                terminal = true
              }
              offset = id + 1
            }
            if (chunk.done) break
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        // 断线重试: 退避拉长(500ms → 4s),覆盖平台重启窗口(~15s);
        // run 已结束/被重启杀掉时, stream 端点支持 jsonl 静态回放, 同样能续上
        if (!terminal && attempt < 7 && !ctrl.signal.aborted) {
          await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)))
        }
      }
      if (!terminal && !ctrl.signal.aborted) throw new Error('Connection interrupted')
      const segments = runSegments.current.get(runId) || []
      if (!segmentsText(segments).trim() && segmentsTools(segments).length === 0) {
        if (!segmentsReasoning(segments)) {
          updateRunMsg(runId, { content: 'AI 已完成，无输出', segments: undefined })
        } else {
          push('text', '(思考完成，无文字输出)')
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        // 查一下 run 真实状态: 平台重启会把进行中的 run 杀掉,
        // 这种情况不能再声称"仍在后台执行"
        let stillRunning = true
        try {
          const all = (await aiApi.pageRuns()).runs || []
          const meta = all.find((r) => r.run_id === runId)
          stillRunning = !meta || meta.status === 'running'
        } catch { /* 查询也失败则维持乐观提示 */ }
        push('text', stillRunning
          ? `\n\n连接中断: ${e instanceof Error ? e.message : '未知'}。任务仍在后台执行，切回本面板会自动续上。`
          : `\n\n连接中断: ${e instanceof Error ? e.message : '未知'}。任务已结束(可能被平台重启中断),以上为已完成的记录;可继续发消息接上。`)
      }
    } finally {
      runCtrls.current.delete(runId)
      runSegments.current.delete(runId)
      runStarts.current.delete(runId)
      setActiveRunIds((prev) => {
        const n = new Set(prev)
        n.delete(runId)
        return n
      })
      if (user) {
        const stored: StoredRun[] = readLS(lsKeys.runs(user, podName)) || []
        saveLS(lsKeys.runs(user, podName), stored.filter((s) => s.run_id !== runId))
      }
    }
  }, [podName, user, updateRunMsg, upsertDiffCard, upsertFileEditCard, settleEditCard, applyCards, markAnchor])
  attachRef.current = attachRun

  // ── 上下文自动注入(发送时组装, 用户零操作)──
  const buildContext = useCallback(async (): Promise<string> => {
    const parts: string[] = []
    parts.push(`[环境] YatTerra Web IDE。用户正在 Pod「${podName}」的家目录里开发,所有问题都围绕这个项目。`)
    const bus = useIdeBusStore.getState()
    const ec = bus.editorContext
    if (ec?.path) {
      parts.push(`[当前打开文件] ${ec.path}${ec.cursorLine ? `(光标约在第 ${ec.cursorLine} 行)` : ''}`)
      let snippet = ec.snippet
      if (!snippet) {
        const full = await fetchFileContent(ec.path)
        if (full != null) {
          const lines = full.split('\n')
          const cur = ec.cursorLine ?? 1
          const from = Math.max(0, cur - 51)
          const to = Math.min(lines.length, cur + 50)
          snippet = lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join('\n')
        }
      }
      if (snippet) parts.push(`[光标上下文(±50行)]\n${snippet.slice(0, 12000)}`)
    }
    const edits = bus.recentEdits.slice(0, 5)
    if (edits.length) {
      parts.push(`[最近编辑] ${edits.map((e) => `${e.path}(${e.kind})`).join('; ')}`)
    }
    // 最近终端输出(多终端取最新一条):「修复最近的报错」类问题靠它看到真实报错
    const tail = bus.terminalTail
    if (tail?.text) {
      parts.push(`[最近终端输出(面板 ${tail.panelKey},尾部截取)]\n${tail.text.slice(-4000)}`)
    }
    const prof = formatProfile(profileRef.current)
    if (prof) parts.push(`[项目画像(podcode/podwatch 维护)]\n${prof}`)
    parts.push(
      '[工具] 你有 read/grep/glob/list_dir/pod_bash 工具直接查看与运行该 Pod 的项目;'
      + '修改代码用 edit 工具(old_string 唯一匹配替换,留空 old_string 创建新文件),'
      + '修改会先暂存,任务结束时用户批量确认后才写入。',
    )
    return parts.join('\n\n')
  }, [podName, fetchFileContent])

  // ── /goal 目标 chip ──
  // 服务端按会话存最新一个目标, 平台重启后会自动拉起复核; 目标一旦被
  // 判定完成就会被删除, 所以这里定期回读, chip 也就自动消失了。
  const refreshGoal = useCallback(async (sidArg?: string) => {
    const sid = sidArg ?? sessionId
    try {
      const res = await apiFetch<{ goal: string | null; resumes?: number }>(
        `/ai/page/goal?pod=${encodeURIComponent(podName)}`
        + (sid ? `&session_id=${encodeURIComponent(sid)}` : ''))
      setGoal(res.goal ? { text: res.goal, resumes: res.resumes || 0 } : null)
    } catch { /* 读不到就当没有目标 */ }
  }, [podName, sessionId])

  const clearGoal = useCallback(async () => {
    try {
      await apiFetch('/ai/page/goal/clear', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, pod: podName }),
      })
      setGoal(null)
      toast({ type: 'info', message: '已取消目标' })
    } catch {
      toast({ type: 'error', message: '取消目标失败' })
    }
  }, [sessionId, podName, toast])

  // 切会话 / 一个 run 结束(loading 落回)时回读一次目标
  useEffect(() => { void refreshGoal() }, [refreshGoal, loading])

  // ── 发送 ──
  const [submitting, setSubmitting] = useState(false)
  const handleSend = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || loading || submitting) return
    stickRef.current = true
    setInput('')
    // 立刻可见的反馈:提交 → run 建立之间原本是一片安静, 前 5-10s
    // 用户不知道点没点上
    setMessages((prev) => [...prev, { role: 'user', content: msg }])
    setSubmitting(true)
    const done = () => setSubmitting(false)

    // 确保有一个持久会话(服务端按会话加载历史, 客户端不发历史)
    let sid = sessionId
    if (!sid) {
      try {
        sid = (await aiApi.newPageSession('pod_ide')).session_id
        setSessionId(sid)
        if (user) saveLS(lsKeys.sid(user, podName), sid)
      } catch { sid = '' }
    }

    let runId = ''
    try {
      const context = await buildContext()
      const res = await aiApi.startPageRun({
        page: 'pod_ide' as unknown as AiPageRequest['page'],
        question: msg,
        context,
        session_id: sid || undefined,
        route: `/pods/${podName}/ide`,
        pod: podName,
        auto: autoMode,
      })
      runId = res.run_id
      // /goal 目标在服务端是随请求就落盘的, 这里立刻回读让 chip 上屏
      if (msg.startsWith('/goal')) void refreshGoal(sid)
      if (user) {
        const stored: StoredRun[] = readLS(lsKeys.runs(user, podName)) || []
        stored.push({ run_id: runId, question: msg, started: Date.now() })
        saveLS(lsKeys.runs(user, podName), stored)
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `任务启动失败: ${e instanceof Error ? e.message : '未知'}` },
      ])
      done()
      return
    }
    // 用户消息已在上面即时上屏, 这里传 resume=true 只是不让它再补一条
    await attachRef.current?.(runId, msg, true)
    done()
  }, [input, loading, submitting, sessionId, user, podName, buildContext, autoMode, refreshGoal])
  // slash 动作命令拦截(菜单外直接输入 /new、/auto 也能生效)
  sendRef.current = (text) => {
    const t = (text ?? input).trim()
    if (t === '/new') { setInput(''); newConversation(); return }
    if (t === '/auto') { setInput(''); cycleAutoMode(); return }
    void handleSend(text)
  }

  // ── 恢复 + 重接(挂载时一次)──
  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      // 1) 消息快照 + diff 卡片
      const snap = readLS<{ messages?: ChatMsg[]; cards?: DiffCard[] }>(lsKeys.msgs(user, podName))
      if (!cancelled && snap?.messages?.length) setMessages(snap.messages)
      if (!cancelled && snap?.cards?.length) {
        applyCards(() => snap.cards!.map((c) => ({ ...c, diffLines: undefined })))
        // 恢复的卡片异步补 diffLines
        for (const c of snap.cards) void materializeCard(c.id)
      }
      // 2) 会话 id + 确认策略
      const sid = readLS<string>(lsKeys.sid(user, podName))
      if (!cancelled && sid) setSessionId(sid)
      const savedAuto = readLS<AutoMode>(lsKeys.auto(user, podName))
      if (!cancelled && savedAuto && AUTO_ORDER.includes(savedAuto)) setAutoMode(savedAuto)
      // 3) 项目画像
      try {
        const prof = await apiFetch<ProfileResponse>(`/pods/${encodeURIComponent(podName)}/profile`)
        if (!cancelled) { profileRef.current = prof; setProfileReady(true) }
      } catch { /* 画像缺失不阻塞 */ }
      // 4) 重接 run:进行中的走实时 SSE;面板卸载期间已结束的走 jsonl 静态回放
      //    (后端 stream() 对非内存 run 也支持),让迟到的 tool_result 落定快照里
      //    pending 的 diff 卡片并 notifySaved 通知编辑器刷新——否则卡片永久卡在
      //    「写入中…」、编辑器一直展示旧内容。
      const stored: StoredRun[] = readLS(lsKeys.runs(user, podName)) || []
      // 快照里仍挂着 pending 卡片的 run 也纳入回放(stored 记录可能已丢)
      const pendingRunIds = new Set(
        (snap?.cards || [])
          .filter((c) => c.status === 'pending' && c.runId)
          .map((c) => c.runId),
      )
      for (const s of stored) pendingRunIds.add(s.run_id)
      let all: PageRunInfo[] = []
      try {
        all = (await aiApi.pageRuns()).runs || []
      } catch {
        return
      }
      if (cancelled) return
      const mine = all.filter((r) => r.page === 'pod_ide')
      const running = mine.filter((r) => r.status === 'running')
      const finished = mine.filter(
        (r) => r.status !== 'running' && pendingRunIds.has(r.run_id),
      )
      const runningIds = new Set(running.map((r) => r.run_id))
      saveLS(lsKeys.runs(user, podName), stored.filter((s) => runningIds.has(s.run_id)))
      for (const r of [...running, ...finished]) {
        const meta = stored.find((s) => s.run_id === r.run_id)
        void attachRef.current?.(r.run_id, meta?.question || r.question || '(后台任务)', true)
      }
    })()
    return () => {
      cancelled = true
      // 卸载(切 tab/抽屉收起): 释放 SSE 与语音识别;服务端任务继续跑
      for (const [, ctrl] of runCtrls.current) ctrl.abort()
      runCtrls.current.clear()
      recRef.current?.abort()
      recRef.current = null
      setListening(false)
    }
  }, [user, podName, materializeCard, applyCards])

  // ── 消息/卡片快照持久化(防抖;手机切走重挂载能续上)──
  useEffect(() => {
    if (!user) return
    const t = setTimeout(() => {
      const liteMsgs = messages.slice(-40).map((m) => ({
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        runId: m.runId,
        toolCalls: m.toolCalls?.map((tc) => ({
          ...tc,
          result: typeof tc.result === 'string' ? tc.result.slice(0, 2000) : tc.result,
        })),
      }))
      const liteCards = cards.map((c) => ({
        id: c.id, runId: c.runId, path: c.path,
        actionId: c.actionId, serverWrite: c.serverWrite, reason: c.reason,
        newContent: c.newContent?.slice(0, 200_000),
        diffText: c.diffText?.slice(0, 200_000),
        addCount: c.addCount, delCount: c.delCount,
        status: c.status, outcome: c.outcome,
      }))
      saveLS(lsKeys.msgs(user, podName), { messages: liteMsgs, cards: liteCards })
    }, 400)
    return () => clearTimeout(t)
  }, [messages, cards, user, podName])

  // ── 「选中即问」(EditorPanel → 本面板)──
  const askRequest = useIdeBusStore((s) => s.askRequest)
  useEffect(() => {
    if (!askRequest) return
    useIdeBusStore.getState().consumeAsk()
    activateRef.current()
    const q = askRequest.code
      ? `${askRequest.question}\n\n[选中代码] ${askRequest.path ?? ''}\n\`\`\`\n${askRequest.code}\n\`\`\``
      : askRequest.question
    sendRef.current(q)
  }, [askRequest])

  // ── 吸底跟随(可暂停)──
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 56
    stickRef.current = stick
    setAtBottom(stick)
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, cards])
  const scrollToBottom = () => {
    stickRef.current = true
    setAtBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // 确认卡(bash 弹卡 / 即时 edit diff 卡)出现时强制吸底:手机抽屉只有
  // 25% 高,不滚到底用户根本看不到在等他确认,任务会一直挂着。
  const pendingAskCount = bashAsks.filter((a) => !a.resolved).length
    + cards.filter((c) => c.status === 'pending' && activeRunIds.has(c.runId)).length
  const lastAskRef = useRef(0)
  useEffect(() => {
    const grew = pendingAskCount > lastAskRef.current
    lastAskRef.current = pendingAskCount
    if (!grew) return
    const t = setTimeout(scrollToBottom, 80)
    return () => clearTimeout(t)
  }, [pendingAskCount])

  const handleStop = useCallback(() => {
    for (const [rid, ctrl] of runCtrls.current) {
      ctrl.abort()
      aiApi.stopPageRun(rid).catch(() => {})
    }
  }, [])

  const newConversation = useCallback(() => {
    if (loading) return
    setSessionId('')
    setMessages([])
    applyCards(() => [])
    itemAnchor.current.clear()
    if (user) {
      removeLS(lsKeys.sid(user, podName))
      removeLS(lsKeys.msgs(user, podName))
    }
  }, [loading, user, podName])

  // ── slash 命令选择框(Claude Code 风格)──
  const cycleAutoMode = useCallback(() => {
    const next = AUTO_ORDER[(AUTO_ORDER.indexOf(autoMode) + 1) % AUTO_ORDER.length] as AutoMode
    setAutoMode(next)
    if (user) saveLS(lsKeys.auto(user, podName), next)
    toast({ type: 'info', message: `AI 确认策略: ${AUTO_LABEL[next]}` })
    haptic('light')
  }, [autoMode, user, podName, toast])

  const slashMatches = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return []
    const q = input.slice(1).toLowerCase()
    return SLASH_CMDS.filter((c) => c.name.startsWith(q))
  }, [input])
  const slashOpen = slashMatches.length > 0 && !slashOff
  // 输入变化 → 复位高亮与 Esc 关闭态
  useEffect(() => { setSlashIdx(0); setSlashOff(false) }, [input])
  useEffect(() => { if (slashIdx >= slashMatches.length) setSlashIdx(0) }, [slashMatches.length, slashIdx])

  const selectSlash = useCallback((cmd: SlashCmd) => {
    haptic('light')
    if (cmd.behavior === 'complete') {
      setInput(`/${cmd.name} `)
      return
    }
    // 动作命令: 选中即执行
    setInput('')
    if (cmd.name === 'new') newConversation()
    else if (cmd.name === 'auto') cycleAutoMode()
    else if (ACTION_TEMPLATES[cmd.name]) sendRef.current(ACTION_TEMPLATES[cmd.name])
  }, [newConversation, cycleAutoMode])

  // ── 顶栏计时器: 任务进行中每秒刷新, 显示最早一个活跃 run 的已耗时 ──
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [loading])
  const elapsedText = useMemo(() => {
    let earliest = Infinity
    for (const [, ts] of runStarts.current) earliest = Math.min(earliest, ts)
    if (!Number.isFinite(earliest)) return ''
    const s = Math.max(0, Math.floor((Date.now() - earliest) / 1000))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, tick, activeRunIds])

  // ── 语音输入 ──
  const toggleMic = useCallback(() => {
    if (listening) {
      recRef.current?.stop()
      return
    }
    const Ctor = getSpeechCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = false
    rec.interimResults = true
    recBaseRef.current = input
    rec.onresult = (e) => {
      let final = ''
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (!r) continue
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) final += t
        else interim += t
      }
      const base = recBaseRef.current
      setInput((base ? base + ' ' : '') + final + interim)
    }
    rec.onerror = (e) => {
      setListening(false)
      recRef.current = null
      if (e?.error === 'not-allowed') toast({ type: 'warning', message: '浏览器未授权麦克风' })
    }
    rec.onend = () => {
      setListening(false)
      recRef.current = null
    }
    recRef.current = rec
    try {
      rec.start()
      setListening(true)
      haptic('light')
    } catch {
      recRef.current = null
      setListening(false)
    }
  }, [listening, input, toast])

  // ── 渲染 ──
  const editorContext = useIdeBusStore((s) => s.editorContext)

  // ── pod_bash 确认卡 / 输出控制台:内嵌渲染在对应 run 的 assistant 消息后 ──
  // (以前吊在整个消息流末尾, 和产生它的对话脱节; run 消息已不在流里的
  //  孤儿卡片/控制台仍兜底渲染在流末尾, 不会凭空消失)
  const renderAskCard = (a: BashAsk) => (
            <div key={a.actionId} className="ide-ai-block">
              <div className="ide-diff-card">
                <div className="ide-diff-head">
                  <ShieldAlert size={12} className="flex-none" style={{ color: 'var(--bad, #e5484d)' }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={a.command}>
                    AI 请求执行命令
                  </span>
                </div>
                <pre
                  className="ide-diff-code whitespace-pre-wrap break-all px-2 py-2 font-mono text-[11px]"
                  style={mobile ? { maxHeight: 120 } : undefined}
                >
                  {a.command}
                </pre>
                <div className={cn('gap-1.5 px-2 py-1.5', mobile ? 'flex flex-col' : 'flex items-center')}>
                  {a.resolved === 'timeout' ? (
                    <span className="text-[11px]" style={{ color: 'var(--ide-ink-3, #8b949e)' }}>
                      等待确认超时(180 秒),该命令未执行。
                    </span>
                  ) : mobile ? (
                    <>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => resolveBashAsk(a, false, false)}
                          className="ide-btn ide-btn-ghost flex-1"
                          style={{ height: 42 }}
                        >
                          拒绝
                        </button>
                        <button
                          type="button"
                          onClick={() => resolveBashAsk(a, true, false)}
                          className="ide-btn ide-btn-accent flex-1"
                          style={{ height: 42 }}
                        >
                          允许一次
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => resolveBashAsk(a, true, true)}
                        className="ide-btn ide-btn-ghost w-full"
                        style={{ height: 42 }}
                      >
                        本次会话总是允许
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveBashAsk(a, true, false, true)}
                        className="ide-btn ide-btn-ghost w-full"
                        style={{ height: 42 }}
                      >
                        总是允许该命令前缀
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => resolveBashAsk(a, false, false)} className="ide-btn ide-btn-ghost">
                        拒绝
                      </button>
                      <button type="button" onClick={() => resolveBashAsk(a, true, false)} className="ide-btn ide-btn-accent">
                        允许一次
                      </button>
                      <button type="button" onClick={() => resolveBashAsk(a, true, true)} className="ide-btn ide-btn-ghost">
                        本次会话总是允许
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveBashAsk(a, true, false, true)}
                        className="ide-btn ide-btn-ghost"
                        title="本会话内同前缀(前 2 个词)的命令不再弹卡"
                      >
                        总是允许该前缀
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
  )
  const renderStreamConsole = (aid: string, s: BashStream) => (
            <div key={aid} className="ide-ai-block">
              <div className="ide-diff-card">
                <div className="ide-diff-head">
                  <span
                    className="flex-none font-mono text-[10px]"
                    style={{ color: s.done ? 'var(--ide-mut)' : 'var(--ide-diff-add)' }}
                  >
                    {s.done ? (s.exit === 0 || s.exit == null ? '✓' : `exit ${s.exit}`) : '▶ 运行中'}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={s.command}>
                    {s.command}
                  </span>
                </div>
                {(s.output || !s.done) && (
                  <pre
                    className="ide-diff-code whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[11px]"
                    style={{ maxHeight: mobile ? 160 : 220, overflowY: 'auto' }}
                  >
                    {s.output || '…'}
                  </pre>
                )}
              </div>
            </div>
  )


  if (!aiAllowed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
        <ShieldAlert size={20} style={{ color: 'var(--ide-mut)' }} />
        <p className="text-[13px]" style={{ color: 'var(--ide-mut)' }}>当前页面无 AI 助手权限</p>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col" style={{ background: 'var(--ide-panel)' }}>
      {/* 顶栏: 状态 + 新对话(紧凑工具条;标题由布局层 Tab 条承载)。
          手机并入其它面板共用的 44px 面板头(见 ide-theme.css),输入区上方还有
          Tab 条,不垫安全区 */}
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 px-2',
          // 手机:并入 44px 面板头(透明无边框,见 ide-theme.css);
          // 桌面:仍是 32px 紧凑条,保留发丝下边框与面板区分
          mobile ? 'ide-m-panelhead' : 'h-8 border-b',
        )}
        style={mobile ? undefined : { borderColor: 'var(--ide-line)' }}
      >
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full', loading && 'animate-pulse')}
          style={{ background: pendingAskCount > 0 ? 'var(--ide-accent)' : (loading || submitting) ? 'var(--ide-diff-add)' : 'var(--ide-line-strong)' }}
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          style={{ color: pendingAskCount > 0 ? 'var(--ide-accent)' : 'var(--ide-mut)' }}
        >
          {pendingAskCount > 0
            ? `⚠ 等待你确认 · ${pendingAskCount}`
            : submitting ? '已收到,正在准备任务…'
            : loading ? `⏱ ${elapsedText} · 任务进行中 · ${activeRunIds.size}` : `Pod ${podName}`}
        </span>
        <button
          type="button"
          onClick={() => {
            const next = AUTO_ORDER[(AUTO_ORDER.indexOf(autoMode) + 1) % AUTO_ORDER.length] as AutoMode
            setAutoMode(next)
            if (user) saveLS(lsKeys.auto(user, podName), next)
            haptic('light')
          }}
          title={`AI 确认策略: ${AUTO_LABEL[autoMode]} — ${AUTO_DESC[autoMode]}(点击切换)`}
          aria-label={`AI 确认策略: ${AUTO_LABEL[autoMode]}`}
          className="ide-ghost-btn flex-none font-mono text-[10px] gap-1"
          style={{
            // 手机只显图标(文字标签 sm 起才出现)→ 让出 44×44 方靶,
            // 与 .ide-m-actbtn 同尺寸;桌面按文字自适应宽。
            // 高度要显式给:.ide-ghost-btn 只有 28,竖屏靠 globals 兜到 44,
            // 横屏兜底失效会塌回 28
            width: mobile ? 44 : 'auto',
            ...(mobile ? { height: 44 } : {}),
            padding: mobile ? 0 : '0 8px',
            color: autoMode === 'all' ? 'var(--ide-mut)' : 'var(--ide-accent)',
          }}
        >
          <ShieldCheck size={mobile ? 15 : 13} className="flex-none" />
          <span className="hidden sm:inline">{AUTO_LABEL[autoMode]}</span>
        </button>
        <button
          type="button"
          onClick={newConversation}
          title="新对话"
          aria-label="新对话"
          className="ide-ghost-btn"
          style={mobile ? { width: 44, height: 44 } : undefined}
        >
          <Plus size={mobile ? 16 : 15} />
        </button>
      </div>

      {/* 消息流:用户右对齐气泡 / AI 左侧正文流,块间纯间距 */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="ide-ai-msgs h-full">
          {messages.length === 0 && (
            <div className="ide-empty flex min-h-full flex-col items-start justify-center gap-2 px-3 py-6 select-none">
              <p className="ide-cmt text-[12px]">// 问点什么,或试试:</p>
              <div className="flex max-w-full flex-wrap gap-1">
                {IDE_HINTS.slice(0, 4).map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    onClick={() => sendRef.current(hint)}
                    className="ide-chip ide-press"
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const streaming = !!msg.runId && activeRunIds.has(msg.runId)
            if (msg.role === 'user') {
              return (
                <div key={i} className="ide-ai-block ide-ai-user">
                  <span className="ide-ai-user-prompt" aria-hidden>❯</span>
                  <p className="ide-ai-user-body">{msg.content}</p>
                </div>
              )
            }
            const runId = msg.runId
            /** 属于该 run、锚点正好是 n 的挂件(编辑卡/命令确认卡/实时输出控制台)。
             *  按到达位置插回时间线,而不是统统堆在消息末尾。 */
            const overlaysAt = (n: number) => (
              <>
                {cards.filter((c) => c.runId === runId && anchorFor(c.runId, c.id, c.actionId) === n).map((c) => (
                  <DiffCardView
                    key={c.id}
                    card={c}
                    mobile={mobile}
                    onAccept={(card) => void resolveCard(card, true)}
                    onReject={(card) => void resolveCard(card, false)}
                  />
                ))}
                {bashAsks
                  .filter((a) => a.runId === runId && (a.resolved === '' || a.resolved === 'timeout')
                    && anchorFor(a.runId, a.actionId) === n)
                  .map(renderAskCard)}
                {Object.entries(bashStreams)
                  .filter(([aid, s]) => s.runId === runId && anchorFor(runId, aid) === n)
                  .map(([aid, s]) => renderStreamConsole(aid, s))}
              </>
            )
            return (
              <div key={i} className="ide-ai-block">
                <div className="ide-ai-assistant">
                  <AssistantBody
                    msg={msg}
                    streaming={streaming}
                    overlay={runId ? overlaysAt : undefined}
                  />
                </div>
              </div>
            )
          })}

          {/* 兜底:run 消息已不在流里(新对话清空等)的确认卡/控制台,仍渲染在末尾 */}
          {bashAsks.filter((a) => (a.resolved === '' || a.resolved === 'timeout') && !messages.some((m) => m.runId === a.runId)).map(renderAskCard)}
          {Object.entries(bashStreams).filter(([, s]) => !messages.some((m) => m.runId === s.runId)).map(([aid, s]) => renderStreamConsole(aid, s))}
        </div>

        {/* 暂停跟随时提供「回到底部」 */}
        {!atBottom && messages.length > 0 && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="回到底部"
            className="ide-ghost-btn absolute bottom-3 right-3 shadow-2"
            style={{ background: 'var(--ide-elev)', width: 32, height: 32 }}
          >
            <ArrowDown size={15} />
          </button>
        )}
      </div>

      {/* 输入区:顶部 1px line 分隔,panel 底;context chips 聚焦才淡入 + 无边框 textarea */}
      <div className="ide-ai-inputwrap">
        {/* /goal 目标: 常显(不受聚焦淡入影响)——平台重启会自动拉起复核, 想撤掉点 × */}
        {goal && (
          <div className="ide-ai-goalrow">
            <span
              className="ide-chip"
              style={{ color: 'var(--ide-accent)' }}
              title={`当前目标: ${goal.text}${goal.resumes ? `（已自动复核拉起 ${goal.resumes} 次）` : ''}`}
            >
              🎯 {goal.text.length > 20 ? goal.text.slice(0, 20) + '…' : goal.text}
              {goal.resumes > 0 && (
                <span style={{ color: 'var(--ide-mut)' }}>↻{goal.resumes}</span>
              )}
              <button
                type="button"
                className="ide-goal-x"
                title="取消该目标"
                aria-label="取消目标"
                onClick={() => void clearGoal()}
              >
                ×
              </button>
            </span>
          </div>
        )}
        <div className={cn('ide-ai-context', inputFocused && 'ide-ai-context-on')} aria-hidden={!inputFocused}>
          {editorContext?.path && (
            <span className="ide-chip" title={editorContext.path}>
              📄 {editorContext.path.split('/').pop()}
              {editorContext.cursorLine ? `:${editorContext.cursorLine}` : ''}
            </span>
          )}
          {profileReady && <span className="ide-chip">📋 项目画像</span>}
          <span className="ide-chip" title={AUTO_DESC[autoMode]}>
            🛡 AI 确认: {AUTO_LABEL[autoMode]}
          </span>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); sendRef.current() }}
          className="relative flex items-end gap-1.5"
        >
          {/* slash 命令选择框: 输入 / 开头且未空格时弹出,↑↓ 选择,Tab/Enter 补全或执行 */}
          {slashOpen && (
            <div
              className="absolute bottom-full left-0 z-20 mb-1 w-[min(340px,90%)] overflow-hidden rounded-md border shadow-2"
              style={{ background: 'var(--ide-elev)', borderColor: 'var(--ide-line-strong)' }}
            >
              {slashMatches.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); selectSlash(c) }}
                  onMouseEnter={() => setSlashIdx(i)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left',
                    i === slashIdx && 'ide-ai-slash-active',
                  )}
                >
                  <span className="font-mono text-[12px]" style={{ color: 'var(--ide-ink)' }}>
                    /{c.name}
                    {c.argsHint && (
                      <span className="ml-1 font-mono text-[11px]" style={{ color: 'var(--ide-mut)' }}>
                        {c.argsHint}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] leading-snug" style={{ color: 'var(--ide-mut)' }}>
                    {c.desc}
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
                  e.preventDefault()
                  setSlashIdx((i) => (i + 1) % slashMatches.length)
                  return
                }
                if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                  e.preventDefault()
                  setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  selectSlash(slashMatches[slashIdx] as SlashCmd)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashOff(true)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                sendRef.current()
              }
            }}
            placeholder="问点关于这个项目的问题…(输入 / 查看命令)"
            rows={1}
            className="ide-ai-textarea min-w-0 flex-1"
            style={mobile ? { maxHeight: 120, fontSize: 16 } : { maxHeight: 120 }}
          />
          {speechSupported && (
            <button
              type="button"
              onClick={toggleMic}
              title={listening ? '停止语音输入' : '语音输入'}
              aria-label={listening ? '停止语音输入' : '语音输入'}
              className="ide-ghost-btn"
              style={{
                ...(mobile ? { width: 44, height: 44 } : {}),
                ...(listening ? { color: 'var(--ide-diff-del)' } : {}),
              }}
            >
              {listening ? <MicOff size={mobile ? 18 : 15} /> : <Mic size={mobile ? 18 : 15} />}
            </button>
          )}
          {loading ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label="停止生成"
              className="ide-send-btn"
              style={{
                background: 'transparent', border: '1px solid var(--ide-line-strong)',
                color: 'var(--ide-diff-del)',
                ...(mobile ? { width: 44, height: 44 } : {}),
              }}
            >
              <StopCircle size={mobile ? 18 : 15} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || loading || submitting}
              aria-label="发送"
              className="ide-send-btn"
              style={mobile ? { width: 44, height: 44 } : undefined}
            >
              <Send size={mobile ? 18 : 15} />
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
