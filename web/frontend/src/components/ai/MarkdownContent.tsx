import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = className?.replace('language-', '') || ''
  const code = String(children).replace(/\n$/, '')
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="relative group my-1.5">
      <div className="flex items-center justify-between bg-[#1d1d1f] text-white/50 text-[10px] px-3 py-1 rounded-t-lg">
        <span>{lang || 'code'}</span>
        <button onClick={handleCopy} className="hover:text-white transition-colors">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="bg-[#1d1d1f] text-[#f5f5f7] p-3 rounded-b-lg overflow-x-auto text-xs leading-relaxed !m-0">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose-sm prose-neutral max-w-none text-sm leading-relaxed overflow-x-auto [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_ul]:mb-1.5 [&_ol]:mb-1.5 [&_li]:mb-0.5 [&_h1]:text-base [&_h1]:font-bold [&_h1]:mb-1.5 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-0.5 [&_strong]:font-semibold [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-accent/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_table]:w-full [&_pre]:overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const isBlock = className?.startsWith('language-') || String(children).includes('\n')
            if (isBlock) {
              return <MarkdownCode className={className}>{children}</MarkdownCode>
            }
            return <code className="bg-black/10 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>
          },
          pre({ children }) {
            return <>{children}</>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
