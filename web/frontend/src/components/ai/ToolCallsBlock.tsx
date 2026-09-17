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

export function ToolCallsBlock({ calls }: { calls: ToolCallEntry[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  if (!calls?.length) return null
  return (
    <div className="space-y-1 mb-1.5">
      {calls.map((tc) => {
        const isOpen = expanded[tc.id] ?? false
        const label = TOOL_LABELS[tc.name] || tc.name
        const argStr = Object.entries(tc.args)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
        return (
          <div key={tc.id} className="rounded-lg bg-slate-50 border border-slate-200/60 overflow-hidden">
            <button
              onClick={() => setExpanded((p) => ({ ...p, [tc.id]: !p[tc.id] }))}
              className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs hover:bg-slate-100 transition-colors"
            >
              {tc.status === 'running' ? (
                <Loader2 size={13} className="animate-spin text-blue-500" />
              ) : tc.status === 'done' ? (
                <CheckCircle2 size={13} className="text-emerald-500" />
              ) : (
                <AlertCircle size={13} className="text-red-500" />
              )}
              <Wrench size={12} className="text-slate-400" />
              <span className="font-medium text-slate-700">{label}</span>
              {argStr && <span className="text-slate-400 truncate ml-1 max-w-[180px]">{argStr}</span>}
              {isOpen ? <ChevronDown size={11} className="ml-auto text-slate-400" /> : <ChevronRight size={11} className="ml-auto text-slate-400" />}
            </button>
            <AnimatePresence>
              {isOpen && tc.result && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <pre className="px-2.5 pb-2 text-[11px] text-slate-600 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto font-mono">
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
