import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Wrench, CheckCircle2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'

export interface ToolCallEntry {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  ok?: boolean
  status: 'running' | 'done' | 'error'
}

const TOOL_LABELS: Record<string, string> = {
  run: '执行命令',
  run_remote: '远程执行',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  grep: '搜索',
  list_dir: '目录列表',
  web_search: '搜索网页',
  fetch_url: '抓取网页',
  inspect: 'K8s 查询',
  spawn: '并行子任务',
  screenshot: '截图',
  browser_navigate: '导航',
  browser_click: '点击',
  browser_fill: '填写',
  browser_screenshot: '截图',
  vision: '视觉分析',
  ai_chat: 'AI 子调用',
  memory_save: '保存记忆',
  memory_load: '读取记忆',
  memory_list: '列出记忆',
  list_pods: '列出 Pod',
  get_pod: '查看 Pod 详情',
  pod_logs: '查看 Pod 日志',
  cluster_status: '集群状态',
  shell_exec: '执行命令',
}

function StatusIcon({ status }: { status: ToolCallEntry['status'] }) {
  if (status === 'running') return <Loader2 size={13} className="animate-spin text-accent" />
  if (status === 'done') return <CheckCircle2 size={13} className="text-ok" />
  return <AlertCircle size={13} className="text-bad" />
}

export function ToolCallsBlock({ calls }: { calls: ToolCallEntry[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  if (!calls?.length) return null
  return (
    <div className="my-1.5 space-y-1">
      {calls.map((tc) => {
        const isOpen = expanded[tc.id] ?? false
        const label = TOOL_LABELS[tc.name] || tc.name
        const argStr = Object.entries(tc.args)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
        const expandable = Boolean(tc.result) || Boolean(argStr)
        return (
          <div
            key={tc.id}
            className="rounded-lg bg-surface-2 border border-black/[0.06] border-l-2 border-l-accent/50 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => expandable && setExpanded((p) => ({ ...p, [tc.id]: !p[tc.id] }))}
              disabled={!expandable}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs transition-colors enabled:hover:bg-black/[0.04] disabled:cursor-default"
            >
              <StatusIcon status={tc.status} />
              <Wrench size={12} className="shrink-0 text-muted" />
              <span className="font-medium text-ink shrink-0">{label}</span>
              {argStr && (
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                  {argStr}
                </span>
              )}
              {expandable &&
                (isOpen ? (
                  <ChevronDown size={11} className="ml-auto shrink-0 text-muted" />
                ) : (
                  <ChevronRight size={11} className="ml-auto shrink-0 text-muted" />
                ))}
            </button>
            <AnimatePresence initial={false}>
              {isOpen && tc.result && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-black/[0.06] bg-black/[0.03] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
                    {tc.result}
                  </pre>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
