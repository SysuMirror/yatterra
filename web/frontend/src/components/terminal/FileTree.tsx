import { FileBrowser, type FileEntry } from '@/components/domain/FileBrowser'

interface FileTreeProps {
  podName: string
  entries: FileEntry[]
  onOpen: (path: string) => void
  className?: string
}

export function FileTree({ podName, entries, onOpen, className }: FileTreeProps) {
  return (
    <div className={className}>
      <div className="px-3 py-2 text-xs font-semibold text-muted border-b border-black/[0.06]">
        文件浏览器
      </div>
      <div className="py-1">
        <FileBrowser entries={entries} onOpen={onOpen} />
      </div>
    </div>
  )
}
