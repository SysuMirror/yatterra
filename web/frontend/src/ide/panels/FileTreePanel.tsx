/**
 * IDE 文件树面板(registry id: 'files')。
 *
 * 功能:
 *  - GET /api/pods/<podName>/files 逐层懒加载目录树(根:/home/cloud 与 /shared)
 *  - 面包屑 + 当前路径导航;按扩展名显示图标(有 size 字段时显示大小)
 *  - 新建文件/目录(POST files/create)、删除(DELETE files,二次确认)、
 *    重命名(POST files/move,后端 mv 保内容;文件/目录均可)
 *  - 点击文件 → editorBus.openFile() 通知 EditorPanel 打开
 *  - 手机:行高 ≥44px、长按弹 ActionSheet、目录缩进收敛
 *
 * 路径防呆:前端只允许操作 /home/cloud/ 与 /shared/ 之下,拼接时拒绝
 * 空名、'/'、'.'、'..'(后端另有校验)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Loader2,
  Lock,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { PanelProps } from '../types'
import { useEditorBusStore } from '../editorBus'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { useLongPress } from '@/hooks/useLongPress'
import { haptic } from '@/lib/haptic'
import { cn } from '@/lib/cn'

// ── 常量 ────────────────────────────────────────────────────────────────────

const POD_HOME = '/home/cloud'
const SHARED = '/shared'
/** 树的两个固定根(后端 browse 只允许这两个前缀)。 */
const TREE_ROOTS = [POD_HOME, SHARED] as const
const STORAGE_PREFIX = 'yatterra.ide.filetree.'

/** 后端 browse() 返回的条目(size 为可选:当前后端未返回,返回即显示)。 */
interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_exec: boolean
  size?: number
}

interface ListResponse {
  ok: boolean
  entries: FileEntry[]
  error: string
}

type DirState =
  | { status: 'loading'; entries: FileEntry[] }
  | { status: 'ready'; entries: FileEntry[] }
  | { status: 'error'; entries: FileEntry[]; error: string }

// ── 路径工具(防呆:只放行 /home/cloud 与 /shared 之下) ─────────────────────

/** 规范化并校验路径在允许根之下;非法返回 null。 */
function normalizeUnderRoots(p: string): string | null {
  if (!p.startsWith('/')) return null
  const segs: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null // 防呆:直接拒绝,不做回溯
    segs.push(seg)
  }
  const norm = '/' + segs.join('/')
  return TREE_ROOTS.some((r) => norm === r || norm.startsWith(r + '/')) ? norm : null
}

/** dir + name 拼接;名字非法(空/含 '/'/./..)或结果越界返回 null。 */
function joinPath(dir: string, name: string): string | null {
  const n = name.trim()
  if (!n || n.includes('/') || n === '.' || n === '..') return null
  return normalizeUnderRoots(dir.replace(/\/+$/, '') + '/' + n)
}

/** 父目录(越界返回 null)。 */
function parentOf(p: string): string | null {
  const norm = normalizeUnderRoots(p)
  if (!norm) return null
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? null : norm.slice(0, idx)
}

/** 祖先目录链(含所在根,不含自身),用于面包屑导航时展开路径。 */
function ancestorsOf(p: string): string[] {
  const norm = normalizeUnderRoots(p)
  if (!norm) return []
  const segs = norm.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < segs.length; i++) {
    const pre = '/' + segs.slice(0, i).join('/')
    if (normalizeUnderRoots(pre)) out.push(pre)
  }
  return out
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

// ── 扩展名 → 图标 ───────────────────────────────────────────────────────────

const EXT_ICON: Record<string, LucideIcon> = {
  js: FileCode2, mjs: FileCode2, cjs: FileCode2, ts: FileCode2, tsx: FileCode2,
  jsx: FileCode2, vue: FileCode2, svelte: FileCode2,
  html: FileCode2, css: FileCode2, scss: FileCode2, less: FileCode2,
  py: FileCode2, rs: FileCode2, go: FileCode2, java: FileCode2,
  c: FileCode2, h: FileCode2, cpp: FileCode2, cs: FileCode2, rb: FileCode2,
  php: FileCode2, swift: FileCode2, kt: FileCode2, sh: FileCode2, bash: FileCode2,
  sql: FileCode2,
  json: FileJson,
  md: FileText, markdown: FileText, txt: FileText, log: FileText, pdf: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage,
  svg: FileImage, ico: FileImage, bmp: FileImage,
  zip: FileArchive, tar: FileArchive, gz: FileArchive, tgz: FileArchive,
  bz2: FileArchive, xz: FileArchive, '7z': FileArchive, rar: FileArchive,
  yaml: FileText, yml: FileText, toml: FileText, ini: FileText, conf: FileText,
  cfg: FileText, env: FileText,
  lock: Lock,
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function iconFor(entry: FileEntry): LucideIcon {
  if (entry.is_dir) return Folder
  return EXT_ICON[extOf(entry.name)] ?? File
}

// ── 展开状态持久化(手机切 tab 会卸载面板,重挂载后恢复) ───────────────────

interface StoredTreeState {
  expanded: string[]
  currentDir: string
}

function readStored(podName: string): StoredTreeState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + podName)
    if (raw) {
      const parsed = JSON.parse(raw) as { expanded?: unknown; currentDir?: unknown }
      const expanded = Array.isArray(parsed.expanded)
        ? parsed.expanded.filter(
            (s): s is string => typeof s === 'string' && normalizeUnderRoots(s) !== null,
          )
        : []
      const currentDir =
        typeof parsed.currentDir === 'string'
          ? normalizeUnderRoots(parsed.currentDir) ?? POD_HOME
          : POD_HOME
      return { expanded, currentDir }
    }
  } catch {
    /* 损坏的存储当不存在 */
  }
  return { expanded: [], currentDir: POD_HOME }
}

// ── 树行模型 ────────────────────────────────────────────────────────────────

type Row =
  | { kind: 'entry'; entry: FileEntry; depth: number }
  | { kind: 'loading'; depth: number; dirPath: string }
  | { kind: 'error'; depth: number; message: string; dirPath: string }
  | { kind: 'empty'; depth: number }

function buildRows(dirs: Record<string, DirState>, expanded: string[]): Row[] {
  const rows: Row[] = []
  const walk = (dirPath: string, depth: number) => {
    const st = dirs[dirPath]
    if (!st || st.status === 'loading') {
      rows.push({ kind: 'loading', depth, dirPath })
      return
    }
    if (st.status === 'error') {
      rows.push({ kind: 'error', depth, message: st.error, dirPath })
      return
    }
    if (st.entries.length === 0) {
      rows.push({ kind: 'empty', depth })
      return
    }
    for (const e of st.entries) {
      rows.push({ kind: 'entry', entry: e, depth })
      if (e.is_dir && expanded.includes(e.path)) walk(e.path, depth + 1)
    }
  }
  for (const root of TREE_ROOTS) {
    rows.push({
      kind: 'entry',
      entry: {
        name: root === POD_HOME ? 'home' : 'shared',
        path: root,
        is_dir: true,
        is_exec: false,
      },
      depth: 0,
    })
    if (expanded.includes(root)) walk(root, 1)
  }
  return rows
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

/** 名称输入弹窗(新建文件/目录、重命名共用)。 */
interface NameDialogState {
  mode: 'newfile' | 'newdir' | 'rename'
  baseDir: string
  target?: FileEntry
}

export function FileTreePanel({ podName, surface }: PanelProps) {
  const isMobile = surface === 'mobile'
  const toast = useToastStore((s) => s.add)
  // 走 editorBus.openFile:EditorPanel 订阅 openSeq 变化打开文件并 activate() 自己
  const requestOpen = useCallback(
    (pod: string, path: string) => useEditorBusStore.getState().openFile(pod, path),
    [],
  )

  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<string[]>(() => readStored(podName).expanded)
  const [currentDir, setCurrentDir] = useState<string>(() => readStored(podName).currentDir)
  const [selected, setSelected] = useState<string | null>(null)
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<FileEntry | null>(null)
  const [sheetTarget, setSheetTarget] = useState<FileEntry | null>(null)

  // 去重/已完成标记(组件内 ref,重挂载后自然重置)
  const inflight = useRef<Set<string>>(new Set())
  const loadedOk = useRef<Set<string>>(new Set())

  // 展开状态落盘(手机卸载重挂载后恢复展开位置)
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_PREFIX + podName,
        JSON.stringify({ expanded, currentDir } satisfies StoredTreeState),
      )
    } catch {
      /* private mode */
    }
  }, [podName, expanded, currentDir])

  /** 拉取某目录列表(幂等:进行中/已成功则跳过,force 强制刷新)。 */
  const loadDir = useCallback(
    async (dir: string, force = false) => {
      if (!force && (inflight.current.has(dir) || loadedOk.current.has(dir))) return
      if (force) loadedOk.current.delete(dir)
      inflight.current.add(dir)
      setDirs((prev) => ({
        ...prev,
        [dir]: force || !prev[dir] ? { status: 'loading', entries: [] } : prev[dir],
      }))
      try {
        const res = await api.get<ListResponse>(
          `/pods/${podName}/files?path=${encodeURIComponent(dir)}`,
        )
        if (res.ok) {
          loadedOk.current.add(dir)
          setDirs((prev) => ({ ...prev, [dir]: { status: 'ready', entries: res.entries ?? [] } }))
        } else {
          setDirs((prev) => ({
            ...prev,
            [dir]: { status: 'error', entries: [], error: res.error || '读取失败' },
          }))
        }
      } catch (e) {
        setDirs((prev) => ({
          ...prev,
          [dir]: { status: 'error', entries: [], error: (e as Error)?.message || '读取失败' },
        }))
      } finally {
        inflight.current.delete(dir)
      }
    },
    [podName],
  )

  // 根 + 已展开目录懒加载(expanded 变化时补拉新增的;loadDir 自身幂等)
  useEffect(() => {
    for (const p of [POD_HOME, SHARED, ...expanded]) loadDir(p)
  }, [expanded, loadDir])

  // ── 交互 ──────────────────────────────────────────────────────────────

  const toggleDir = useCallback(
    (entry: FileEntry) => {
      setExpanded((prev) =>
        prev.includes(entry.path) ? prev.filter((p) => p !== entry.path) : [...prev, entry.path],
      )
      if (!expanded.includes(entry.path)) loadDir(entry.path)
      setCurrentDir(entry.path)
      haptic('selection')
    },
    [expanded, loadDir],
  )

  const openFile = useCallback(
    (entry: FileEntry) => {
      setSelected(entry.path)
      requestOpen(podName, entry.path)
      haptic('light')
    },
    [podName, requestOpen],
  )

  /** 面包屑导航:切当前目录并展开祖先链。 */
  const navigateTo = useCallback((dir: string) => {
    const norm = normalizeUnderRoots(dir)
    if (!norm) return
    setCurrentDir(norm)
    setExpanded((prev) => {
      const need = ancestorsOf(norm).filter((p) => !prev.includes(p))
      return need.length ? [...prev, ...need] : prev
    })
    haptic('selection')
  }, [])

  const createEntry = useCallback(
    async (baseDir: string, name: string, type: 'file' | 'folder') => {
      const path = joinPath(baseDir, name)
      if (!path) throw new Error('非法路径(仅允许在 /home/cloud 或 /shared 下)')
      await api.post(`/pods/${podName}/files/create`, { path, type })
      toast({ type: 'success', message: `已创建 ${name}` })
      await loadDir(baseDir, true)
      setExpanded((prev) => (prev.includes(baseDir) ? prev : [...prev, baseDir]))
    },
    [podName, toast, loadDir],
  )

  /** 重命名 = 后端 files/move(mv,内容完整保留;文件/目录均可)。 */
  const renameEntry = useCallback(
    async (entry: FileEntry, newName: string) => {
      const parent = parentOf(entry.path)
      if (!parent) throw new Error('非法路径')
      const newPath = joinPath(parent, newName)
      if (!newPath) throw new Error('非法名称')
      if (newPath === entry.path) return
      await api.post(`/pods/${podName}/files/move`, { path: entry.path, new_path: newPath })
      toast({ type: 'success', message: `已重命名为 ${newName}` })
      // 修正选中/展开/当前目录中被改名子树引用的旧路径
      const remap = (p: string) =>
        p === entry.path ? newPath : p.startsWith(entry.path + '/') ? newPath + p.slice(entry.path.length) : p
      setSelected((s) => (s != null ? remap(s) : s))
      if (entry.is_dir) {
        setExpanded((prev) => prev.map(remap))
        setCurrentDir((d) => remap(d))
      }
      await loadDir(parent, true)
    },
    [podName, toast, loadDir],
  )

  const deleteEntry = useCallback(
    async (entry: FileEntry) => {
      await api.del(`/pods/${podName}/files?path=${encodeURIComponent(entry.path)}`)
      toast({ type: 'success', message: `已删除 ${entry.name}` })
      const parent = parentOf(entry.path)
      if (parent) await loadDir(parent, true)
      // 收起被删子树、修正选中与当前目录
      setExpanded((prev) => prev.filter((p) => p !== entry.path && !p.startsWith(entry.path + '/')))
      setSelected((s) =>
        s === entry.path || (s != null && s.startsWith(entry.path + '/')) ? null : s,
      )
      setCurrentDir((d) =>
        d === entry.path || d.startsWith(entry.path + '/') ? (parent ?? POD_HOME) : d,
      )
    },
    [podName, toast, loadDir],
  )

  // ── 渲染 ──────────────────────────────────────────────────────────────

  const rows = useMemo(() => buildRows(dirs, expanded), [dirs, expanded])
  const indentStep = isMobile ? 10 : 14 // 窄屏缩进收敛

  // 面包屑相对所在根(/home/cloud 或 /shared)计算,避免出现不可点击的中间段
  const rootOfCurrent = currentDir === SHARED || currentDir.startsWith(SHARED + '/') ? SHARED : POD_HOME
  const RootIcon = rootOfCurrent === SHARED ? HardDrive : Home
  const crumbs = currentDir.slice(rootOfCurrent.length).split('/').filter(Boolean)

  const sheetItems: ActionSheetItem[] = useMemo(() => {
    const e = sheetTarget
    if (!e) return []
    const isRoot = (TREE_ROOTS as readonly string[]).includes(e.path)
    const items: ActionSheetItem[] = []
    if (e.is_dir) {
      items.push({
        key: 'toggle',
        label: expanded.includes(e.path) ? '收起' : '展开',
        icon: <ChevronDown size={16} />,
        onClick: () => toggleDir(e),
      })
      if (!isRoot) {
        items.push({
          key: 'newfile',
          label: '在此新建文件',
          icon: <FilePlus size={16} />,
          onClick: () => setNameDialog({ mode: 'newfile', baseDir: e.path }),
        })
        items.push({
          key: 'newdir',
          label: '在此新建目录',
          icon: <FolderPlus size={16} />,
          onClick: () => setNameDialog({ mode: 'newdir', baseDir: e.path }),
        })
        items.push({
          key: 'rename',
          label: '重命名',
          icon: <Pencil size={16} />,
          onClick: () => setNameDialog({ mode: 'rename', baseDir: parentOf(e.path) ?? POD_HOME, target: e }),
        })
      }
    } else {
      items.push({
        key: 'open',
        label: '打开',
        icon: <FileCode2 size={16} />,
        onClick: () => openFile(e),
      })
      items.push({
        key: 'rename',
        label: '重命名',
        icon: <Pencil size={16} />,
        onClick: () => setNameDialog({ mode: 'rename', baseDir: parentOf(e.path) ?? POD_HOME, target: e }),
      })
    }
    if (!isRoot) {
      items.push({
        key: 'del',
        label: e.is_dir ? '删除目录' : '删除文件',
        icon: <Trash2 size={16} />,
        danger: true,
        onClick: () => setConfirmTarget(e),
      })
    }
    return items
  }, [sheetTarget, expanded, toggleDir, openFile])

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-surface-1">
      {/* 工具栏:面包屑 + 刷新/新建 */}
      <div
        className={cn(
          'flex items-center gap-1 shrink-0 border-b px-1.5',
          isMobile ? 'h-10 border-line' : 'ide-ft-toolbar',
        )}
      >
        <nav
          aria-label="当前目录"
          className={cn(
            'flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto no-scrollbar',
            isMobile ? 'text-xs font-mono' : 'ide-ft-crumb',
          )}
        >
          <button
            onClick={() => navigateTo(rootOfCurrent)}
            title={rootOfCurrent}
            className={cn(
              'flex items-center rounded-md text-muted hover:text-ink hover:bg-ink/5 transition-colors',
              isMobile ? 'h-9 w-9 justify-center' : 'h-7 w-7',
            )}
          >
            <RootIcon size={isMobile ? 15 : 13} />
          </button>
          {crumbs.map((c, i) => {
            const prefix = rootOfCurrent + '/' + crumbs.slice(0, i + 1).join('/')
            const isLast = i === crumbs.length - 1
            return (
              <span key={prefix} className="flex items-center whitespace-nowrap">
                <button
                  onClick={() => navigateTo(prefix)}
                  title={prefix}
                  className={cn(
                    'rounded px-1 transition-colors',
                    isLast ? 'text-ink font-medium' : 'text-muted hover:text-ink',
                    isMobile ? 'h-9' : 'h-7',
                  )}
                >
                  {c}
                </button>
                {!isLast && <span className="text-muted/50">/</span>}
              </span>
            )
          })}
        </nav>
        <div className="flex items-center shrink-0">
          <ToolbarButton
            isMobile={isMobile}
            title="刷新当前目录"
            onClick={() => loadDir(currentDir, true)}
          >
            <RefreshCw size={isMobile ? 16 : 13} />
          </ToolbarButton>
          <ToolbarButton
            isMobile={isMobile}
            title={`在 ${currentDir} 新建文件`}
            onClick={() => setNameDialog({ mode: 'newfile', baseDir: currentDir })}
          >
            <FilePlus size={isMobile ? 16 : 13} />
          </ToolbarButton>
          <ToolbarButton
            isMobile={isMobile}
            title={`在 ${currentDir} 新建目录`}
            onClick={() => setNameDialog({ mode: 'newdir', baseDir: currentDir })}
          >
            <FolderPlus size={isMobile ? 16 : 13} />
          </ToolbarButton>
        </div>
      </div>

      {/* 树主体 */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1" role="tree">
        {rows.map((row, rowIndex) => {
          if (row.kind === 'loading') {
            return (
              <div
                key={`loading-${row.dirPath}`}
                className="flex items-center gap-1.5 px-2 text-muted"
                style={{ paddingLeft: row.depth * indentStep + 24, minHeight: isMobile ? 44 : 28 }}
              >
                <Loader2 size={12} className="animate-spin" />
                <span className="text-xs">加载中…</span>
              </div>
            )
          }
          if (row.kind === 'empty') {
            return (
              <div
                key={`empty-${rowIndex}`}
                className="flex items-center gap-1.5 pr-2 text-muted/70 select-none"
                style={{ paddingLeft: row.depth * indentStep + 24, minHeight: isMobile ? 44 : 28 }}
              >
                <span className="text-xs italic">（空目录）</span>
              </div>
            )
          }
          if (row.kind === 'error') {
            return (
              <div
                key={`error-${row.dirPath}`}
                className="flex items-center gap-1.5 pr-2 text-bad"
                style={{ paddingLeft: row.depth * indentStep + 24 }}
              >
                <AlertCircle size={12} className="flex-shrink-0" />
                <span className="text-xs truncate" title={row.message}>{row.message}</span>
                <button
                  onClick={() => loadDir(row.dirPath, true)}
                  className={cn(
                    'ml-auto flex-shrink-0 rounded-md text-xs hover:bg-bad/10 px-2',
                    isMobile ? 'h-11' : 'h-6',
                  )}
                >
                  重试
                </button>
              </div>
            )
          }
          return (
            <TreeRow
              key={row.entry.path}
              entry={row.entry}
              depth={row.depth}
              isMobile={isMobile}
              indentStep={indentStep}
              expanded={expanded.includes(row.entry.path)}
              selected={selected === row.entry.path}
              isCurrentDir={currentDir === row.entry.path}
              childLoading={row.entry.is_dir && dirs[row.entry.path]?.status === 'loading'}
              onToggleDir={toggleDir}
              onOpenFile={openFile}
              onLongPress={setSheetTarget}
              onRename={(e) =>
                setNameDialog({ mode: 'rename', baseDir: parentOf(e.path) ?? POD_HOME, target: e })
              }
              onDelete={setConfirmTarget}
            />
          )
        })}
      </div>

      {/* 手机长按操作菜单 */}
      <ActionSheet
        open={sheetTarget != null}
        onClose={() => setSheetTarget(null)}
        title={sheetTarget ? sheetTarget.name : undefined}
        items={sheetItems}
      />

      {/* 新建/重命名弹窗 */}
      <NameDialog
        open={nameDialog != null}
        title={
          nameDialog?.mode === 'newfile'
            ? `新建文件 · ${nameDialog.baseDir}`
            : nameDialog?.mode === 'newdir'
              ? `新建目录 · ${nameDialog.baseDir}`
              : `重命名 · ${nameDialog?.target?.name ?? ''}`
        }
        initial={nameDialog?.mode === 'rename' ? nameDialog.target?.name ?? '' : ''}
        confirmLabel={nameDialog?.mode === 'rename' ? '重命名' : '创建'}
        onClose={() => setNameDialog(null)}
        onSubmit={async (name) => {
          if (!nameDialog) return
          if (nameDialog.mode === 'rename' && nameDialog.target) {
            await renameEntry(nameDialog.target, name)
          } else {
            await createEntry(nameDialog.baseDir, name, nameDialog.mode === 'newdir' ? 'folder' : 'file')
          }
        }}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={confirmTarget != null}
        title={confirmTarget?.is_dir ? '删除目录' : '删除文件'}
        message={
          confirmTarget
            ? `确定删除 ${confirmTarget.name}？${confirmTarget.is_dir ? '目录内全部内容将一并删除,不可恢复。' : ''}`
            : ''
        }
        onClose={() => setConfirmTarget(null)}
        onConfirm={async () => {
          if (confirmTarget) await deleteEntry(confirmTarget)
        }}
      />
    </div>
  )
}

// ── 子组件 ──────────────────────────────────────────────────────────────────

function ToolbarButton({
  isMobile,
  title,
  onClick,
  children,
}: {
  isMobile: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-ink/5 transition-colors',
        isMobile ? 'h-9 w-9' : 'h-7 w-7',
      )}
    >
      {children}
    </button>
  )
}

interface TreeRowProps {
  entry: FileEntry
  depth: number
  isMobile: boolean
  indentStep: number
  expanded: boolean
  selected: boolean
  isCurrentDir: boolean
  childLoading: boolean
  onToggleDir: (e: FileEntry) => void
  onOpenFile: (e: FileEntry) => void
  onLongPress: (e: FileEntry) => void
  onRename: (e: FileEntry) => void
  onDelete: (e: FileEntry) => void
}

function TreeRow(props: TreeRowProps) {
  const { entry, depth, isMobile, indentStep, expanded, selected, isCurrentDir, childLoading } = props
  const isRoot = (TREE_ROOTS as readonly string[]).includes(entry.path)
  const Icon =
    entry.path === SHARED
      ? HardDrive
      : entry.is_dir
        ? (expanded ? FolderOpen : Folder)
        : iconFor(entry)

  const longPress = useLongPress({
    onLongPress: () => props.onLongPress(entry),
    enabled: isMobile,
  })

  const onClick = () => {
    if (isMobile && longPress.wasLongPress()) return // 长按后松手不触发点击
    if (entry.is_dir) props.onToggleDir(entry)
    else props.onOpenFile(entry)
  }

  return (
    <div
      className={cn('group relative', isMobile ? 'flex items-center pr-1 min-h-[44px]' : 'ide-ft-row')}
      style={{ paddingLeft: depth * indentStep }}
    >
      {/* 缩进参考线:每层一条 1px 竖线(纯装饰) */}
      {!isMobile &&
        Array.from({ length: depth }, (_, d) => (
          <span
            key={d}
            className="ide-ft-guide"
            style={{ left: d * indentStep + indentStep / 2 }}
          />
        ))}
      <button
        onClick={onClick}
        onPointerDown={longPress.onPointerDown}
        onLostPointerCapture={longPress.onLostPointerCapture}
        title={entry.path}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-left',
          isMobile
            ? cn(
                'h-11 py-0 rounded-md px-1.5 transition-colors',
                selected || isCurrentDir
                  ? 'bg-accent-light text-accent'
                  : 'hover:bg-ink/5 text-ink-2',
              )
            : cn('ide-ft-row-btn px-1.5', selected || isCurrentDir ? 'ide-ft-row-selected' : ''),
        )}
      >
        {entry.is_dir ? (
          childLoading ? (
            <Loader2 size={12} className="flex-shrink-0 animate-spin text-muted" />
          ) : expanded ? (
            <ChevronDown size={12} className="flex-shrink-0 text-muted" />
          ) : (
            <ChevronRight size={12} className="flex-shrink-0 text-muted" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <Icon
          size={isMobile ? 16 : 14}
          className={cn('flex-shrink-0', entry.is_exec ? 'text-warn' : 'text-muted')}
          style={entry.is_dir ? { color: '#e3b341' } : undefined}
        />
        <span className="truncate font-mono text-[13px]">{entry.name}</span>
        {typeof entry.size === 'number' && (
          <span className="ml-auto flex-shrink-0 pl-2 text-[10px] text-muted">
            {formatBytes(entry.size)}
          </span>
        )}
      </button>

      {/* 桌面悬停操作(手机走长按 ActionSheet) */}
      {!isMobile && !isRoot && (
        <>
          <RowActionButton title={`重命名 ${entry.name}`} onClick={() => props.onRename(entry)}>
            <Pencil size={12} />
          </RowActionButton>
          <RowActionButton title={`删除 ${entry.name}`} danger onClick={() => props.onDelete(entry)}>
            <Trash2 size={12} />
          </RowActionButton>
        </>
      )}
    </div>
  )
}

function RowActionButton({
  title,
  danger,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md opacity-0 transition-all group-hover:opacity-100',
        danger ? 'text-muted hover:text-bad hover:bg-bad/10' : 'text-muted hover:text-ink hover:bg-ink/[0.07]',
      )}
    >
      {children}
    </button>
  )
}

// ── 弹窗 ────────────────────────────────────────────────────────────────────

function NameDialog(props: {
  open: boolean
  title: string
  initial: string
  confirmLabel: string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [value, setValue] = useState(props.initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (props.open) {
      setValue(props.initial)
      setError('')
      setBusy(false)
    }
  }, [props.open, props.initial])

  const submit = async () => {
    const name = value.trim()
    if (!name) return setError('名称不能为空')
    if (name.includes('/') || name === '.' || name === '..') {
      return setError('名称不能包含 /,也不能是 . 或 ..')
    }
    setBusy(true)
    setError('')
    try {
      await props.onSubmit(name)
      props.onClose()
    } catch (e) {
      setError((e as Error)?.message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onClose={busy ? () => {} : props.onClose} title={props.title} width="max-w-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="名称"
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
        {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={props.onClose}>
            取消
          </Button>
          <Button size="sm" type="submit" loading={busy}>
            {props.confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ConfirmDialog(props: {
  open: boolean
  title: string
  message: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (props.open) {
      setBusy(false)
      setError('')
    }
  }, [props.open])

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await props.onConfirm()
      props.onClose()
    } catch (e) {
      setError((e as Error)?.message || '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onClose={busy ? () => {} : props.onClose} title={props.title} width="max-w-sm">
      <p className="text-sm text-ink-2">{props.message}</p>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={props.onClose}>
          取消
        </Button>
        <Button variant="danger" size="sm" loading={busy} onClick={confirm}>
          删除
        </Button>
      </div>
    </Dialog>
  )
}
