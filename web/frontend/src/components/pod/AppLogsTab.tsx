import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, RefreshCw, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { podsApi, type AppLogFile } from '@/api/pods'

const TAIL = 200

export function AppLogsTab({ podName }: { podName: string }) {
  const files = useQuery({ queryKey: ['app-log-files', podName], queryFn: () => podsApi.appLogFiles(podName), refetchInterval: 10_000, retry: false })
  const [selected, setSelected] = useState('')
  const names = files.data?.files ?? []
  useEffect(() => {
    if (!names.length) { setSelected(''); return }
    if (!names.some((file) => file.name === selected)) setSelected(names.some((file) => file.name === 'app.log') ? 'app.log' : names[0]?.name ?? '')
  }, [names, selected])
  const content = useQuery({ queryKey: ['app-log-content', podName, selected], queryFn: () => podsApi.appLogContent(podName, selected, TAIL), enabled: !!selected, refetchInterval: 10_000, retry: false })
  const retry = () => { void files.refetch(); if (selected) void content.refetch() }
  const listError = files.error as Error | null
  const contentError = content.error as Error | null
  const openTutorial = () => { window.location.assign('/docs?lesson=logs') }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[16rem] flex-1"><Select label="日志文件" value={selected} onChange={setSelected} options={names.map((file) => ({ value: file.name, label: file.name }))} placeholder={files.isLoading ? '加载文件列表…' : '没有日志文件'} /></div>
      <Button variant="outline" size="sm" onClick={retry} disabled={files.isFetching || content.isFetching}><RefreshCw size={13} className={files.isFetching ? 'animate-spin' : ''} />刷新</Button>
      <Button variant="ghost" size="sm" onClick={openTutorial}><ExternalLink size={13} />日志教程</Button>
    </div>
    {listError ? <ErrorBox message={listError.message || '日志文件列表加载失败'} onRetry={retry} /> : files.isLoading ? <div className="rounded-xl p-4 text-sm text-muted">加载日志文件列表…</div> : !names.length ? <EmptyBox /> : contentError ? <ErrorBox message={contentError.message || '日志内容加载失败'} onRetry={() => void content.refetch()} /> : <LogContent file={names.find((file) => file.name === selected)} text={content.data ?? ''} loading={content.isLoading} />}
  </div>
}

function LogContent({ file, text, loading }: { file?: AppLogFile; text: string; loading: boolean }) {
  return <div className="space-y-2"><div className="flex items-center gap-2 text-xs text-muted"><ScrollText size={14} />{file?.source || file?.name}{file?.size != null && <span>· {file.size} bytes</span>}</div><div className="rounded-xl p-4 font-mono text-xs leading-5 bg-[#1d1d1f] text-[#f5f5f7] max-h-[min(480px,70vh)] min-h-[200px] overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all">{loading ? <span className="text-white/40">加载中…</span> : text ? text : <span className="text-white/40">文件为空（不是加载失败）</span>}</div></div>
}
function EmptyBox() { return <div className="rounded-xl border border-black/8 p-6 text-sm text-muted"><ScrollText size={16} className="inline mr-2" />暂无应用日志文件。请先让应用写入平台日志目录。</div> }
function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(message) } catch {
      const ta = document.createElement('textarea')
      ta.value = message; document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      ta.remove()
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }
  return <div className="rounded-xl border border-bad/20 bg-bad/5 p-4 text-sm"><AlertTriangle size={16} className="inline mr-2 text-bad flex-shrink-0" /><span className="break-all">{message}</span><Button variant="outline" size="sm" className="ml-3 flex-shrink-0" onClick={copy}>{copied ? '已复制' : '复制'}</Button><Button variant="outline" size="sm" className="flex-shrink-0" onClick={onRetry}>重试</Button></div>
}
