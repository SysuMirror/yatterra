import { Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function SearchBar({ value, onChange, placeholder = '搜索...', className }: SearchBarProps) {
  return (
    <div className={cn('relative', className)}>
      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-10 pr-9 py-2.5 rounded-xl text-sm border-[0.5px] border-black/8 bg-white/62 placeholder:text-muted/60 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3.5px_rgba(10,132,255,0.18)] transition-all duration-100"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] transition-colors"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
