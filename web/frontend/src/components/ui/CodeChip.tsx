import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

interface CodeChipProps {
  code: string
  mask?: boolean
  className?: string
}

export function CodeChip({ code, mask = false, className }: CodeChipProps) {
  const [copied, setCopied] = useState(false)
  const display = mask ? '••••••••' : code

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    haptic('light')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg max-w-full',
        'bg-black/[0.04] border-[0.5px] border-black/[0.06]',
        'font-mono text-xs text-ink-2',
        className,
      )}
    >
      <code className="select-all break-all min-w-0">{display}</code>
      <button
        onClick={handleCopy}
        className="w-5 h-5 rounded flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:scale-90 transition-all"
      >
        {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
      </button>
    </div>
  )
}
