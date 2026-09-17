import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Folder, File, Upload, FolderPlus, Download, X, ChevronDown, ChevronRight } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { FileBrowser, type FileEntry } from '@/components/domain/FileBrowser'
import { CodeEditor } from '@/components/terminal/CodeEditor'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { api, apiFetch } from '@/api/client'
import { useToastStore } from '@/stores/toast'

export default function OpsShared() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  // On mobile: collapse tree when file is selected to give viewer full space
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const viewerRef = useRef<HTMLDivElement>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const mkdirMut = useMutation({
    mutationFn: () => api.post('/shared/mkdir', { path: '', name: mkdirName }),
    onSuccess: () => { toast({ type: 'success', message: '目录已创建' }); setMkdirOpen(false); setMkdirName(''); qc.invalidateQueries({ queryKey: ['shared', ''] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '创建失败' }),
  })

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    formData.append('path', '')
    try {
      await apiFetch('/shared/upload', { method: 'POST', body: formData })
      toast({ type: 'success', message: '上传成功' })
      qc.invalidateQueries({ queryKey: ['shared', ''] })
    } catch (err: any) {
      toast({ type: 'error', message: err?.message || '上传失败' })
    }
    e.target.value = ''
  }

  const { data: raw, isLoading } = useQuery<any>({
    queryKey: ['shared', ''],
    queryFn: () => api.get('/shared?path='),
  })

  const handleOpen = async (path: string) => {
    setSelectedFile(path)
    setTreeCollapsed(true)  // auto-collapse tree on mobile
    try {
      const content = await api.get<string>(`/shared?path=${encodeURIComponent(path)}`)
      setFileContent(typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    } catch {
      setFileContent('无法加载文件内容')
    }
    // Scroll viewer into view on mobile
    setTimeout(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100)
  }

  const handleCloseFile = () => {
    setSelectedFile(null)
    setFileContent('')
    setTreeCollapsed(false)
  }

  // Lazy-load children when a directory is expanded
  const handleExpand = useCallback(async (path: string): Promise<FileEntry[]> => {
    const normalized = path.startsWith('/') ? path.slice(1) : path
    const data = await api.get<any>(`/shared?path=${encodeURIComponent(normalized)}`)
    const children: any[] = data?.entries ?? (Array.isArray(data) ? data : [])
    return children.map((e: any) => ({
      name: e.name,
      type: e.is_dir ? 'dir' : 'file',
      size: e.size,
      modified: e.mtime,
      path: e.path,
    }))
  }, [])

  const entries = raw?.entries ?? (Array.isArray(raw) ? raw : [])
  const fileEntries: FileEntry[] = entries.map((e: any) => ({
    name: e.name,
    type: e.is_dir ? 'dir' : 'file',
    size: e.size,
    modified: e.mtime,
    path: e.path,
  }))

  return (
    <>
      <PageHeader title="共享目录" description="跨 Pod 共享文件管理" doc={{ section: 'dev', item: 3, label: '共享目录文档' }}>
        <div className="flex gap-2">
          <PageAiAssistant page="shared" context={fileEntries.length > 0 ? `共享目录文件: ${fileEntries.length} 个\n${fileEntries.slice(0, 20).map((e: any) => `  ${e.isDir ? '📁' : '📄'} ${e.name} ${e.size ? `(${e.size})` : ''}`).join('\n')}` : '暂无共享文件'} />
          <Button variant="secondary" size="sm" onClick={() => setMkdirOpen(true)}><FolderPlus size={14} /> <span className="hidden sm:inline">新目录</span></Button>
          <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}><Upload size={14} /> <span className="hidden sm:inline">上传</span></Button>
          <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" />
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && fileEntries.length > 0 && (
        <AiInsightPanel
          page="shared"
          title="共享目录洞察"
          className="mb-5"
          context={`共享目录: ${fileEntries.length} 个条目 (${fileEntries.filter((e: any) => e.type === 'dir').length} 目录, ${fileEntries.filter((e: any) => e.type === 'file').length} 文件)\n${fileEntries.slice(0, 20).map((e: any) => `  ${e.type === 'dir' ? '📁' : '📄'} ${e.name} ${e.size ? `(${e.size})` : ''}`).join('\n')}`}
        />
      )}

      <Dialog open={mkdirOpen} onClose={() => setMkdirOpen(false)} title="新建目录">
        <div className="space-y-4">
          <div>
            <Input label="目录名" value={mkdirName} onChange={(e) => setMkdirName(e.target.value)} placeholder="子目录名称" />
            <div className="mt-1"><AiFormHelper type="general" partial={mkdirName} context="共享目录下新建子目录名称" onApply={setMkdirName} /></div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setMkdirOpen(false)}>取消</Button>
            <Button size="sm" disabled={!mkdirName.trim()} loading={mkdirMut.isPending} onClick={() => mkdirMut.mutate()}>创建</Button>
          </div>
        </div>
      </Dialog>

      <div className="grid grid-cols-1 md:grid-cols-5 lg:grid-cols-3 gap-3 md:gap-4">
        {/* File tree */}
        <Card
          padding="none"
          className={`
            md:col-span-2 lg:col-span-1
            overflow-y-auto
            max-h-[50vh] md:max-h-[65vh] lg:max-h-[70vh]
            ${treeCollapsed ? 'hidden md:block' : ''}
            transition-all
          `}
        >
          <div className="px-3 py-2 text-xs font-semibold text-muted border-b border-black/[0.06] flex items-center justify-between">
            <span>/shared</span>
            {selectedFile && (
              <button
                onClick={() => setTreeCollapsed(true)}
                className="md:hidden p-1 rounded-md text-muted hover:text-ink hover:bg-black/[0.06] transition-colors"
              >
                <ChevronDown size={14} />
              </button>
            )}
          </div>
          <div className="p-2">
            <FileBrowser
              entries={fileEntries}
              onOpen={handleOpen}
              onExpand={handleExpand}
              onDownload={(path) => { const a = document.createElement('a'); a.href = `/api/shared/download?path=${encodeURIComponent(path)}`; a.click() }}
            />
          </div>
        </Card>

        {/* File viewer */}
        <Card
          padding="none"
          className={`
            md:col-span-3 lg:col-span-2
            min-h-[180px] sm:min-h-[220px]
          `}
          ref={viewerRef}
        >
          {selectedFile ? (
            <div className="h-full flex flex-col">
              <div className="px-3 sm:px-4 py-2 text-xs font-semibold text-muted border-b border-black/[0.06] flex items-center gap-2 min-w-0">
                <File size={12} className="flex-shrink-0" />
                <span className="truncate flex-1 min-w-0">{selectedFile}</span>
                <button
                  onClick={handleCloseFile}
                  className="p-1 rounded-md text-muted hover:text-ink hover:bg-black/[0.06] transition-colors flex-shrink-0"
                  title="关闭"
                >
                  <X size={14} />
                </button>
              </div>
              <CodeEditor
                value={fileContent}
                language="text"
                readOnly
                className="flex-1 min-h-[40vh] sm:min-h-[50vh] md:min-h-0 md:flex-1"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-[180px] sm:h-[220px] md:h-full text-sm text-muted gap-2">
              <File size={24} className="text-black/[0.08]" />
              <span>选择文件查看内容</span>
              {/* On mobile, show hint to expand tree */}
              <button
                onClick={() => setTreeCollapsed(false)}
                className="md:hidden text-xs text-accent hover:underline mt-1"
              >
                <ChevronRight size={12} className="inline -mt-0.5" /> 展开文件树
              </button>
            </div>
          )}
        </Card>
      </div>

      {/* Mobile: floating button to re-show tree when it's collapsed */}
      {treeCollapsed && selectedFile && (
        <button
          onClick={() => setTreeCollapsed(false)}
          className="md:hidden fixed bottom-4 left-4 z-[var(--z-fab)] flex items-center gap-1.5 px-3 py-2 rounded-full bg-accent text-white text-sm font-medium shadow-lg active:scale-95 transition-transform"
        >
          <Folder size={14} />
          文件树
        </button>
      )}
    </>
  )
}
