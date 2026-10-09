/**
 * IDE 编辑器面板:多标签文件编辑(CodeMirror 6)。
 *
 * 桌面:顶部文件标签栏(文件名 + 未保存圆点 + 关闭),同时只渲染激活标签
 *       的编辑器,其余标签内容留在 editorBus store 里,切回即恢复。
 * 手机:单文件视图 + 顶部文件栏(返回/保存),编辑区左滑返回上一个打开的
 *       文件;聚焦时底部浮出键盘辅助条(Tab/{}/()/缩进/光标/撤销/保存),
 *       用 visualViewport 跟随软键盘;修改 1.5s 后自动保存(防误退),面板
 *       卸载前对未保存内容兜底保存(内容本身留在模块级 store,不怕重建)。
 *
 * 通用:Cmd/Ctrl+S 保存;>512KB 文件以只读模式打开并提示(沿用 FilesTab
 *       策略);二进制文件拒绝编辑;选中文本浮出 AI chip 条(解释/修复/
 *       优化/测试),点击后经 ideBus.ask 发给 AI 面板,布局里没有 ai
 *       面板时回退到全局 AI 助手(sendFromPage('pod_ide', ...))。
 *
 * 跨面板通信走 src/ide/editorBus.ts 与 src/ide/ideBus.ts(勿直接 import 其它面板):
 *   - files 面板:editorBus.openFile(pod, path) 在此打开文件(openSeq 变化时本面板
 *     自行 activate() 请求布局层定位)。
 *   - ai 面板:消费 ideBus.askRequest 拿「选中即问」;本面板发布 ideBus.editorContext
 *     (路径+光标±50行)与 pushEdit(保存动作),并消费 ideBus.savedSignal 重载
 *     AI 写入的文件。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileWarning,
  Loader2,
  Save,
  TestTube2,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { EditorSelection, Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { StreamLanguage } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { cursorCharLeft, cursorCharRight, indentMore, insertTab, undo } from '@codemirror/commands'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useEditorPrefsStore } from '@/stores/editorPrefs'
import { useAiAssistantStore } from '@/stores/aiAssistant'
import { useSwipeGesture } from '@/hooks/useSwipeGesture'
import { cn } from '@/lib/cn'
import { panelsInTree } from '../layout'
import type { LayoutNode, PanelProps } from '../types'
import {
  EMPTY_POD_STATE,
  useEditorBusStore,
  type EditorAskAction,
  type EditorDoc,
} from '../editorBus'
import { useIdeBusStore } from '../ideBus'

// ── 常量(策略沿用 FilesTab) ────────────────────────────────────────────────

/** 与后端 GET files/content 的 head -c 262144 截断上限一致,超过即只读 */
const MAX_EDIT_BYTES = 256 * 1024
const MAX_ASK_CHARS = 8000
const AUTOSAVE_MS = 1500
const TEXT_EXT =
  /\.(txt|md|json|ya?ml|toml|ini|conf|cfg|env|sh|bash|py|js|ts|jsx|tsx|css|html|htm|xml|sql|c|h|cpp|go|rs|java|log|gitignore|dockerfile)$/i

const baseName = (path: string) => path.split('/').pop() || path

/** 扩展名 → 状态条语言名(纯展示)。 */
const LANG_BY_EXT: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', json: 'json', html: 'html', css: 'css',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', sql: 'sql', txt: 'text',
}
const langOf = (path: string | null | undefined) =>
  path ? (LANG_BY_EXT[path.split('.').pop() ?? ''] ?? 'text') : 'text'

/** 光标 ±50 行窗口(带行号),发布给 AI 面板做上下文;与 AiPanel 自行切片格式一致 */
function snippetAround(content: string | undefined, line: number): string | undefined {
  if (!content) return undefined
  const lines = content.split('\n')
  const from = Math.max(0, line - 51)
  const to = Math.min(lines.length, line + 50)
  return lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join('\n')
}

/** 布局树里是否有某面板(读持久化布局,判断「选中即问」发给谁) */
function layoutHasPanel(podName: string, panelId: string): boolean {
  try {
    const raw = localStorage.getItem(`yatterra.ide.layout.${podName}`)
    if (!raw) return false
    const data = JSON.parse(raw) as { tree?: unknown }
    if (!data?.tree) return false
    return panelsInTree(data.tree as LayoutNode).includes(panelId)
  } catch {
    return false
  }
}

// ── 语言支持:python/js/json 用现成包,css/html/md 用极简 StreamLanguage ────

/** 极简 CSS 流式高亮(不追求精确,够看即可) */
const cssStream = StreamLanguage.define<{ block: boolean }>({
  startState: () => ({ block: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (stream.match('/*')) {
      while (!stream.eol()) {
        if (stream.match('*/')) break
        stream.next()
      }
      return 'comment'
    }
    if (state.block) {
      if (stream.match('}')) {
        state.block = false
        return null
      }
      const q = stream.peek()
      if (q === '"' || q === "'") {
        stream.next()
        while (!stream.eol() && stream.next() !== q) { /* 读到闭引号 */ }
        return 'string'
      }
      if (stream.match(/^!important\b/)) return 'keyword'
      if (stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return 'number'
      if (stream.match(/^-?(\d+\.?\d*|\.\d+)[a-zA-Z%]*/)) return 'number'
      if (stream.match(/^[\w-]+(?=\s*:)/)) return 'propertyName'
      if (stream.match(/^[\w-]+/)) return 'variableName'
      stream.next()
      return null
    }
    if (stream.match('{')) {
      state.block = true
      return null
    }
    if (stream.match(/^@[\w-]+/)) return 'keyword'
    if (stream.match(/^[.#&:][\w-]+/)) return 'keyword'
    if (stream.match(/^[\w-]+/)) return 'tagName'
    stream.next()
    return null
  },
})

/** 极简 HTML 流式高亮 */
const htmlStream = StreamLanguage.define<{ inTag: boolean; seenName: boolean }>({
  startState: () => ({ inTag: false, seenName: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (!state.inTag) {
      if (stream.match('<!--')) {
        stream.skipToEnd()
        return 'comment'
      }
      if (stream.match('<!')) {
        stream.skipToEnd()
        return 'meta'
      }
      if (stream.peek() === '<') {
        stream.next()
        stream.match('/')
        state.inTag = true
        state.seenName = false
        return 'meta'
      }
      if (!stream.skipTo('<')) stream.skipToEnd()
      return null
    }
    if (stream.match('/>') || stream.match('>')) {
      state.inTag = false
      return 'meta'
    }
    const q = stream.peek()
    if (q === '"' || q === "'") {
      stream.next()
      while (!stream.eol() && stream.next() !== q) { /* 读到闭引号 */ }
      return 'string'
    }
    if (stream.match(/^=/)) return null
    if (stream.match(/^[\w-:.]+/)) {
      const t = state.seenName ? 'attributeName' : 'tagName'
      state.seenName = true
      return t
    }
    stream.next()
    return null
  },
})

/** 极简 Markdown 流式高亮 */
const mdStream = StreamLanguage.define<Record<string, never>>({
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^#{1,6}\s/)) {
        stream.skipToEnd()
        return 'heading'
      }
      if (stream.match(/^>\s?/)) {
        stream.skipToEnd()
        return 'quote'
      }
      if (stream.match(/^```/)) {
        stream.skipToEnd()
        return 'monospace'
      }
      if (stream.match(/^([-*+]|\d+\.)\s/)) return 'keyword'
    }
    if (stream.match('`')) {
      while (!stream.eol()) {
        if (stream.match('`')) break
        stream.next()
      }
      return 'monospace'
    }
    if (stream.match('**')) {
      while (!stream.eol()) {
        if (stream.match('**')) break
        stream.next()
      }
      return 'strong'
    }
    if (stream.match('*')) {
      while (!stream.eol()) {
        if (stream.match('*')) break
        stream.next()
      }
      return 'emphasis'
    }
    if (stream.match(/^!?\[[^\]]*\]\([^)]*\)/)) return 'link'
    stream.next()
    return null
  },
})

function langFor(path: string): Extension[] {
  const name = path.split('/').pop() ?? ''
  if (/\.py$/i.test(name)) return [python()]
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(name)) return [javascript({ jsx: true })]
  // lang-javascript 未导出独立 json,沿用 CodeEditor 的做法
  if (/\.json$/i.test(name)) return [javascript()]
  if (/\.css$/i.test(name)) return [cssStream]
  if (/\.html?$/i.test(name)) return [htmlStream]
  if (/\.(md|markdown)$/i.test(name)) return [mdStream]
  return []
}

/** 字号走全局 CSS 变量 --ide-fs(editorPrefs store 写入),捏合缩放改 store */
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--ide-fs)' },
  '.cm-scroller': {
    fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
    overflow: 'auto',
  },
})

function touchDistance(touches: TouchList): number {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return 0
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

// ── 选中即问 chip 条 ────────────────────────────────────────────────────────

const ASK_ACTIONS: Array<{ action: EditorAskAction; label: string; icon: LucideIcon }> = [
  { action: 'explain', label: '解释', icon: BookOpen },
  { action: 'fix', label: '修复', icon: Wrench },
  { action: 'optimize', label: '优化', icon: Zap },
  { action: 'test', label: '测试', icon: TestTube2 },
]

const ASK_TEXT: Record<EditorAskAction, string> = {
  explain: '请解释这段代码',
  fix: '请修复这段代码的问题',
  optimize: '请优化这段代码',
  test: '请为这段代码生成测试',
}

interface SelInfo {
  text: string
  line: number
  /** 相对编辑器容器的坐标(px) */
  top: number
  left: number
}

interface CodeMirrorHostProps {
  doc: EditorDoc
  isMobile: boolean
  viewRef: MutableRefObject<EditorView | null>
  onChange: (content: string) => void
  onSave: () => void
  onFocusChange: (focused: boolean) => void
  /** 「选中即问」回调(action + 选中文本 + 首行行号) */
  onAsk: (action: EditorAskAction, text: string, line: number) => void
  /** 光标行变化(发布编辑上下文用),1 起 */
  onCursor?: (line: number) => void
}

/** 单个文件的 CodeMirror 6 编辑器(含选中 chip 条 + 捏合缩放) */
function CodeMirrorHost({ doc, isMobile, viewRef, onChange, onSave, onFocusChange, onAsk, onCursor }: CodeMirrorHostProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<SelInfo | null>(null)
  // 回调走 ref,避免重建 EditorView
  const cbRef = useRef({ onChange, onSave, onFocusChange, onAsk, onCursor })
  cbRef.current = { onChange, onSave, onFocusChange, onAsk, onCursor }

  /** 把当前选区(或 null)发布成 chip 条定位信息 */
  const publishSel = (view: EditorView) => {
    const container = containerRef.current
    if (!container) return
    const s = view.state.selection.main
    if (s.empty) {
      setSel(null)
      return
    }
    const text = view.state.sliceDoc(s.from, s.to)
    if (!text.trim() || text.length > MAX_ASK_CHARS) {
      setSel(null)
      return
    }
    const a = view.coordsAtPos(s.from)
    const b = view.coordsAtPos(s.to)
    const rect = container.getBoundingClientRect()
    if (!a || !b) {
      setSel(null)
      return
    }
    const next: SelInfo = {
      text,
      line: view.state.doc.lineAt(s.from).number,
      top: Math.min(a.top, b.top) - rect.top,
      left: Math.min(a.left, b.left) - rect.left,
    }
    // 滚动会触发 viewportChanged,坐标没变就不重渲
    setSel((prev) =>
      prev &&
      prev.text === next.text &&
      prev.line === next.line &&
      Math.abs(prev.top - next.top) < 1 &&
      Math.abs(prev.left - next.left) < 1
        ? prev
        : next,
    )
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const readOnly = doc.readOnly
    const view = new EditorView({
      doc: doc.content,
      parent: container,
      extensions: [
        basicSetup,
        ...langFor(doc.path),
        oneDark,
        editorTheme,
        EditorView.editable.of(!readOnly),
        Prec.high(
          keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              cbRef.current.onSave()
              return true
            },
          },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          const v = viewRef.current
          if (!v) return
          if (u.docChanged) cbRef.current.onChange(u.state.doc.toString())
          if (u.focusChanged) cbRef.current.onFocusChange(v.hasFocus)
          if (u.selectionSet || u.docChanged) {
            cbRef.current.onCursor?.(v.state.doc.lineAt(v.state.selection.main.head).number)
          }
          if (u.selectionSet || u.docChanged || u.viewportChanged) publishSel(v)
        }),
      ],
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 切文件由父组件 key 重挂载保证;readOnly 变化需重建编辑器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, doc.readOnly])

  // 外部内容变化(目前只有初次加载)同步进编辑器
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== doc.content) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: doc.content } })
    }
  }, [doc.content, viewRef])

  // 双指捏合调字号(改全局 editorPrefs,--ide-fs 生效)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let startDist = 0
    let startFont = 14
    const { setEditorFontSize } = useEditorPrefsStore.getState()
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = touchDistance(e.touches)
        startFont = useEditorPrefsStore.getState().editorFontSize
      } else {
        startDist = 0
      }
    }
    const onMove = (e: TouchEvent) => {
      if (!startDist || e.touches.length !== 2) return
      // 阻止浏览器整页缩放
      e.preventDefault()
      setEditorFontSize(startFont * (touchDistance(e.touches) / startDist))
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) startDist = 0
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  const containerH = containerRef.current?.clientHeight ?? 0
  const containerW = containerRef.current?.clientWidth ?? 0

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />
      {/* 选中即问 chip 条(暗色,贴合 oneDark 编辑器) */}
      {sel && (
        <div
          className="absolute z-20 flex items-center gap-0.5 p-1 rounded-xl border border-white/10 bg-[#21252b]/95 backdrop-blur shadow-lg"
          style={{
            top: Math.max(2, Math.min(sel.top - 48, Math.max(2, containerH - 48))),
            left: Math.max(2, Math.min(sel.left, Math.max(2, containerW - 264))),
          }}
        >
          {ASK_ACTIONS.map(({ action, label, icon: Icon }) => (
            <button
              key={action}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                cbRef.current.onAsk(action, sel.text, sel.line)
                setSel(null)
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded-lg text-[11px] font-medium text-white/85 hover:bg-white/10 active:bg-white/20 transition-colors',
                isMobile ? 'h-11 px-3' : 'h-7 px-2',
              )}
            >
              <Icon size={12} className="text-[#61afef]" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 面板本体 ────────────────────────────────────────────────────────────────

export function EditorPanel({ podName, surface, activate }: PanelProps) {
  const isMobile = surface === 'mobile'
  const podState = useEditorBusStore((s) => s.pods[podName] ?? EMPTY_POD_STATE)
  const openSeq = useEditorBusStore((s) => s.openSeq[podName] ?? 0)
  const toast = useToastStore((s) => s.add)
  const [focused, setFocused] = useState(false)
  /** 软键盘高度(visualViewport 与 layout viewport 底边的距离) */
  const [kbOffset, setKbOffset] = useState(0)
  const [savingPath, setSavingPath] = useState<string | null>(null)
  // 光标行(纯展示:底部状态条用;逻辑仍走 ideBus.editorContext)
  const [cursorLine, setCursorLine] = useState(1)
  const viewRef = useRef<EditorView | null>(null)

  const activePath = podState.active
  const activeDoc = activePath ? podState.docs[activePath] : undefined
  const dirty = (path: string) => {
    const d = podState.docs[path]
    return !!d && d.loaded && !d.readOnly && d.content !== d.saved
  }

  // ── 保存 ────────────────────────────────────────────────────────────────

  const saveDoc = useCallback(
    async (path: string, opts?: { silent?: boolean }) => {
      const doc = useEditorBusStore.getState().pods[podName]?.docs[path]
      if (!doc || !doc.loaded || doc.readOnly || doc.content === doc.saved) return
      setSavingPath(path)
      try {
        await api.put(`/pods/${podName}/files/save`, { path, content: doc.content })
        // 保存期间又改过的话 dirty 保留(saved 只推进到已提交版本)
        useEditorBusStore.getState().patchDoc(podName, path, { saved: doc.content })
        // 上报给 AI 面板做「最近编辑」上下文
        useIdeBusStore.getState().pushEdit({ path, kind: 'save' })
        if (!opts?.silent) toast({ type: 'success', message: `已保存 ${baseName(path)}` })
      } catch (e: any) {
        toast({ type: 'error', message: e?.message || '保存失败' })
      } finally {
        setSavingPath((p) => (p === path ? null : p))
      }
    },
    [podName, toast],
  )

  const saveActive = useCallback(() => {
    if (activePath) void saveDoc(activePath)
  }, [activePath, saveDoc])

  // 手机:修改后自动保存(防误退);面板卸载前对所有未保存文件兜底保存
  useEffect(() => {
    if (!isMobile) return
    const dirtyPaths = Object.values(podState.docs)
      .filter((d) => d.loaded && !d.readOnly && d.content !== d.saved)
      .map((d) => d.path)
    if (dirtyPaths.length === 0) return
    const t = window.setTimeout(() => {
      dirtyPaths.forEach((p) => void saveDoc(p, { silent: true }))
    }, AUTOSAVE_MS)
    return () => window.clearTimeout(t)
  }, [isMobile, podState, saveDoc])

  useEffect(() => {
    // 卸载(手机切 tab/最大化其它面板)时 fire-and-forget 兜底保存
    return () => {
      const pods = useEditorBusStore.getState().pods[podName]
      if (!pods) return
      for (const d of Object.values(pods.docs)) {
        if (d.loaded && !d.readOnly && d.content !== d.saved) void saveDoc(d.path, { silent: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 打开/加载文件 ───────────────────────────────────────────────────────

  // 外部(files 面板)openFile → 请求布局层定位到编辑器。
  // activate 是布局层内联箭头函数(每次渲染新引用),走 ref 防止误触发。
  const activateRef = useRef(activate)
  activateRef.current = activate
  const firstSeq = useRef(true)
  useEffect(() => {
    if (firstSeq.current) {
      firstSeq.current = false
      return
    }
    activateRef.current()
  }, [openSeq])

  // 切换/关闭标签会卸载编辑器(blur 事件不可靠),重置聚焦态
  useEffect(() => {
    setFocused(false)
  }, [activePath])

  // 激活标签未加载 → 拉内容(>256KB 或被后端截断 → 只读,二进制拒绝)
  useEffect(() => {
    const path = activePath
    if (!path) return
    const doc = useEditorBusStore.getState().pods[podName]?.docs[path]
    if (doc?.loaded) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.get<
          string | { content?: string; truncated?: boolean }
        >(`/pods/${podName}/files/content?path=${encodeURIComponent(path)}`)
        if (cancelled) return
        const t =
          typeof res === 'string' ? res : (res?.content ?? JSON.stringify(res, null, 2))
        // 后端 head -c 256KB 截断标记;再按字节(而非字符)兜底,UTF-8 多字节时字符数会偏小
        const truncated =
          typeof res === 'object' && res !== null && res.truncated === true
        const byteLen = truncated ? Infinity : new TextEncoder().encode(t).length
        if (!TEXT_EXT.test(path) && /\0/.test(t.slice(0, 4096))) {
          useEditorBusStore.getState().patchDoc(podName, path, {
            loaded: true,
            error: '二进制文件不支持在线编辑',
          })
        } else if (truncated || byteLen > MAX_EDIT_BYTES) {
          useEditorBusStore.getState().patchDoc(podName, path, {
            loaded: true,
            readOnly: true,
            truncated: true,
            content: t,
            saved: t,
          })
        } else {
          useEditorBusStore.getState().patchDoc(podName, path, {
            loaded: true,
            content: t,
            saved: t,
            error: '',
          })
        }
      } catch (e: any) {
        if (!cancelled) {
          useEditorBusStore
            .getState()
            .patchDoc(podName, path, { loaded: true, error: e?.message || '读取失败' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activePath, podName])

  // ── 标签操作 ────────────────────────────────────────────────────────────

  const closeTab = (path: string) => {
    if (dirty(path) && !window.confirm(`${baseName(path)} 有未保存的修改,关闭将丢弃。确定关闭?`)) return
    useEditorBusStore.getState().closeTab(podName, path)
  }

  const selectTab = (path: string) => {
    useEditorBusStore.getState().setActive(podName, path)
  }

  // 手机左滑返回上一个文件
  const swipe = useSwipeGesture({
    axis: 'x',
    enabled: isMobile && podState.history.length > 0,
    onSwipeLeft: () => useEditorBusStore.getState().goBack(podName),
  })

  // ── 选中即问 ────────────────────────────────────────────────────────────

  const handleAsk = useCallback(
    (action: EditorAskAction, text: string, line: number) => {
      if (!activePath) return
      // 写入 ideBus,AI 面板消费 askRequest 后 activate() 自己并发送
      useIdeBusStore
        .getState()
        .ask({ question: `${ASK_TEXT[action]}(第 ${line} 行起)`, path: activePath, code: text })
      // 布局里没有 ai 面板 → 回退全局 AI 助手
      if (!layoutHasPanel(podName, 'ai')) {
        const prompt = `${ASK_TEXT[action]}(文件 ${activePath} 第 ${line} 行起):\n\n\`\`\`\n${text.slice(0, 4000)}\n\`\`\``
        useAiAssistantStore.getState().sendFromPage('pod_ide', `Pod ${podName} · 文件编辑`, prompt)
      }
    },
    [activePath, podName],
  )

  // ── 编辑上下文发布 + AI 写入信号消费(ideBus,与 AI 面板对接) ──────────

  /** 光标行变化 → 更新 ideBus.editorContext(发送问题时 AI 面板自动注入) */
  const handleCursor = useCallback(
    (line: number) => {
      setCursorLine(line)
      const bus = useIdeBusStore.getState()
      if (bus.editorContext?.path !== activePath) return
      const doc = useEditorBusStore.getState().pods[podName]?.docs[activePath]
      bus.setEditorContext({ path: activePath, cursorLine: line, snippet: snippetAround(doc?.content, line) })
    },
    [activePath, podName],
  )

  // 切换激活文件 → 发布新上下文(内容未加载时 snippet 缺省,AI 面板自行拉取)
  useEffect(() => {
    const bus = useIdeBusStore.getState()
    if (!activePath) {
      bus.setEditorContext(null)
      return
    }
    const doc = useEditorBusStore.getState().pods[podName]?.docs[activePath]
    bus.setEditorContext({ path: activePath, cursorLine: 1, snippet: snippetAround(doc?.content, 1) })
    setCursorLine(1)
  }, [activePath, podName])

  // AI 面板接受 diff 写入成功(savedSignal)→ 重载对应文件;
  // 本地有未保存修改时保留本地内容(用户后续保存覆盖,不静默丢改动)
  const savedSignal = useIdeBusStore((s) => s.savedSignal)
  const savedTsRef = useRef(0)
  useEffect(() => {
    if (!savedSignal || savedSignal.ts === savedTsRef.current) return
    savedTsRef.current = savedSignal.ts
    const path = savedSignal.path
    const doc = useEditorBusStore.getState().pods[podName]?.docs[path]
    if (!doc?.loaded) return
    if (doc.content !== doc.saved) {
      toast({ type: 'warning', message: `${baseName(path)} 已被 AI 修改;本地有未保存更改,已保留本地内容` })
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.get<string | { content?: string; truncated?: boolean }>(
          `/pods/${podName}/files/content?path=${encodeURIComponent(path)}`,
        )
        if (cancelled) return
        // await 期间用户可能又敲了字 → 复查脏状态,脏则保留本地,不覆盖
        const cur = useEditorBusStore.getState().pods[podName]?.docs[path]
        if (cur && cur.content !== cur.saved) {
          toast({ type: 'warning', message: `${baseName(path)} 已被 AI 修改;本地有未保存更改,已保留本地内容` })
          return
        }
        const t = typeof res === 'string' ? res : (res?.content ?? '')
        // AI 把文件改大到超过 256KB 时,刷新拿到的是截断内容 → 强制只读,防止保存覆盖
        const truncated =
          typeof res === 'object' && res !== null && res.truncated === true
        const byteLen = truncated ? Infinity : new TextEncoder().encode(t).length
        if (truncated || byteLen > MAX_EDIT_BYTES) {
          useEditorBusStore.getState().patchDoc(podName, path, {
            content: t,
            saved: t,
            readOnly: true,
            truncated: true,
          })
          toast({ type: 'warning', message: `${baseName(path)} 已超过 256 KB,切换为只读` })
          return
        }
        useEditorBusStore.getState().patchDoc(podName, path, { content: t, saved: t })
      } catch {
        /* 拉取失败保留旧内容,用户手动刷新 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [savedSignal, podName, toast])

  // ── 手机键盘辅助条 ──────────────────────────────────────────────────────

  // visualViewport 跟随软键盘:键盘高度 = layout viewport 底边 - 可视区底边
  useEffect(() => {
    if (!isMobile || !focused) {
      setKbOffset(0)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const off = window.innerHeight - (vv.offsetTop + vv.height)
      setKbOffset(off > 80 ? off : 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [isMobile, focused])

  const runCmd = (fn: (view: EditorView) => boolean) => {
    const v = viewRef.current
    if (v) fn(v)
  }

  /** 在光标处插入配对符号;有选区时包裹并保持选区 */
  const insertPair = (open: string, close: string) => {
    const v = viewRef.current
    if (!v) return
    const s = v.state.selection.main
    const inner = v.state.sliceDoc(s.from, s.to)
    v.dispatch({
      changes: { from: s.from, to: s.to, insert: open + inner + close },
      selection: EditorSelection.range(s.from + open.length, s.from + open.length + inner.length),
      scrollIntoView: true,
    })
  }

  const toolBtn =
    'flex-1 h-11 min-w-[44px] flex items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium text-ink-2 active:bg-ink/10 select-none'
  const toolDown = (e: React.PointerEvent) => e.preventDefault() // 不抢编辑器焦点

  // ── 渲染 ────────────────────────────────────────────────────────────────

  const tabs = podState.tabs

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-surface-1 overflow-hidden">
      {/* 文件栏:桌面=多标签,手机=单文件 + 返回/保存 */}
      {isMobile ? (
        <div className="flex items-center gap-1 h-10 shrink-0 px-1 border-b" style={{ background: 'var(--ide-bg)', borderColor: 'var(--ide-line)' }}>
          {podState.history.length > 0 && (
            <button
              type="button"
              aria-label="返回上一个文件"
              onClick={() => useEditorBusStore.getState().goBack(podName)}
              className="w-10 h-10 flex items-center justify-center rounded-lg text-muted active:bg-ink/10"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <FileCode2 size={14} className="shrink-0 text-muted" />
          <span className="flex-1 min-w-0 truncate text-xs font-mono text-ink-2" title={activePath ?? undefined}>
            {activePath ? baseName(activePath) : '编辑器'}
          </span>
          {activePath && dirty(activePath) && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-label="未保存" />
          )}
          <button
            type="button"
            aria-label="保存"
            disabled={!activePath || !dirty(activePath)}
            onClick={saveActive}
            className="w-10 h-10 flex items-center justify-center rounded-lg text-accent active:bg-accent/10 disabled:opacity-30"
          >
            {savingPath === activePath ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
          </button>
        </div>
      ) : (
        <div className="ide-ed-tabbar">
          <div className="flex items-stretch overflow-x-auto no-scrollbar flex-1 min-w-0">
            {tabs.map((path) => (
              <div
                key={path}
                onClick={() => selectTab(path)}
                title={path}
                className={cn(
                  'ide-ed-tab ide-hov',
                  path === activePath && 'ide-ed-tab-active',
                )}
              >
                <span className="truncate">{baseName(path)}</span>
                {dirty(path) && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--ide-accent)' }} />}
                <button
                  type="button"
                  aria-label={`关闭 ${baseName(path)}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(path)
                  }}
                  className="grid place-items-center w-[14px] h-[14px] rounded-[3px] shrink-0"
                  style={{ color: 'var(--ide-mut)' }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {tabs.length === 0 && (
              <span className="ide-cmt px-3 self-center text-[11px]">暂无打开的文件</span>
            )}
          </div>
          <button
            type="button"
            aria-label="保存当前文件"
            title="保存 (Ctrl/Cmd+S)"
            disabled={!activePath || !dirty(activePath)}
            onClick={saveActive}
            className="ide-ghost-btn shrink-0"
            style={{ width: 34, height: 34, borderRadius: 0, color: 'var(--ide-accent)' }}
          >
            {savingPath === activePath ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
          </button>
        </div>
      )}

      {/* 编辑区 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeDoc?.loaded && activeDoc.readOnly && (
          <div className="flex items-center gap-1.5 px-3 h-8 shrink-0 text-[11px] text-warn bg-warn/10 border-b border-warn/20">
            <FileWarning size={12} className="shrink-0" />
            {activeDoc.truncated
              ? '文件超过 256 KB,仅加载前 256 KB,已只读打开(保存会丢失剩余内容)'
              : `文件较大(${Math.round(activeDoc.content.length / 1024)} KB),已用只读模式打开`}
          </div>
        )}
        <div className="flex-1 min-h-0 relative" {...(isMobile ? swipe : {})}>
          {activeDoc && activeDoc.loaded && !activeDoc.error ? (
            <CodeMirrorHost
              key={activeDoc.path}
              doc={activeDoc}
              isMobile={isMobile}
              viewRef={viewRef}
              onChange={(content) =>
                useEditorBusStore.getState().patchDoc(podName, activeDoc.path, { content })
              }
              onSave={saveActive}
              onFocusChange={setFocused}
              onAsk={handleAsk}
              onCursor={handleCursor}
            />
          ) : activeDoc?.error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <FileWarning size={24} className="text-bad/60" />
              <p className="text-sm text-bad">{activeDoc.error}</p>
              <button
                type="button"
                onClick={() => closeTab(activeDoc.path)}
                className="px-4 h-11 rounded-lg text-xs font-medium bg-ink/5 active:bg-ink/10"
              >
                关闭此文件
              </button>
            </div>
          ) : activeDoc ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-muted" />
            </div>
          ) : (
            <div className="absolute inset-0 ide-empty flex flex-col items-center justify-center gap-3 select-none px-6 text-center">
              <p className="ide-cmt text-[13px]">// 尚未打开文件</p>
              <p className="ide-cmt ide-cmt-dim text-[12px]">// 从左侧文件树选择,或点击最近打开:</p>
              {podState.history.length > 0 && (
                <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                  {podState.history.slice(-4).reverse().map((p) => (
                    <button
                      key={p}
                      type="button"
                      title={p}
                      onClick={() => useEditorBusStore.getState().openFile(podName, p)}
                      className="ide-chip ide-press max-w-[160px] truncate"
                    >
                      {baseName(p)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部状态条:行号 / 语言 / 保存态(桌面;纯展示) */}
      {!isMobile && (
        <div className="ide-statusbar shrink-0">
          {activePath && <span>Ln {cursorLine}</span>}
          <span>{langOf(activePath)}</span>
          <span className="flex-1" />
          {activePath && (
            <span style={dirty(activePath) ? { color: 'var(--ide-ink-2)' } : undefined}>
              {dirty(activePath) ? '未保存' : '已保存'}
            </span>
          )}
        </div>
      )}

      {/* 手机键盘辅助条:编辑器聚焦时浮在软键盘上方 */}
      {isMobile && focused && activeDoc?.loaded && !activeDoc.error && !activeDoc.readOnly && (
        <div
          className="fixed left-0 right-0 z-[80] flex items-stretch gap-1 px-2 h-11 border-t border-line bg-surface-1/95 backdrop-blur"
          style={{ bottom: kbOffset }}
        >
          <button type="button" className={toolBtn} onPointerDown={toolDown} onClick={() => runCmd(insertTab)}>Tab</button>
          <button type="button" className={toolBtn} onPointerDown={toolDown} onClick={() => insertPair('{', '}')}>{'{ }'}</button>
          <button type="button" className={toolBtn} onPointerDown={toolDown} onClick={() => insertPair('(', ')')}>( )</button>
          <button type="button" className={toolBtn} onPointerDown={toolDown} onClick={() => runCmd(indentMore)}>缩进</button>
          <button type="button" aria-label="光标左移" className={toolBtn} onPointerDown={toolDown} onClick={() => runCmd(cursorCharLeft)}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" aria-label="光标右移" className={toolBtn} onPointerDown={toolDown} onClick={() => runCmd(cursorCharRight)}>
            <ChevronRight size={16} />
          </button>
          <button type="button" className={toolBtn} onPointerDown={toolDown} onClick={() => runCmd(undo)}>撤销</button>
          <button
            type="button"
            aria-label="保存"
            className={cn(toolBtn, 'text-accent')}
            onPointerDown={toolDown}
            onClick={saveActive}
          >
            {savingPath === activePath ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          </button>
        </div>
      )}
    </div>
  )
}
