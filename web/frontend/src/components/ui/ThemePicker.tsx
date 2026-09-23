import { Sun, Moon, Monitor } from 'lucide-react'
import { useThemeStore, type ThemeMode } from '@/stores/theme'

const options = [
  { mode: 'light', label: '白天', icon: Sun },
  { mode: 'dark', label: '黑夜', icon: Moon },
  { mode: 'system', label: '跟随浏览器', icon: Monitor },
] satisfies { mode: ThemeMode; label: string; icon: typeof Sun }[]

export function ThemePicker() {
  const { mode, setMode } = useThemeStore()
  return (
    <div role="group" aria-label="外观主题" className="flex gap-1 rounded-lg bg-surface-2 p-1">
      {options.map(({ mode: value, label, icon: Icon }) => (
        <button key={value} type="button" aria-pressed={mode === value}
          onClick={() => setMode(value)}
          className={`flex min-h-9 flex-1 items-center justify-center gap-1 rounded-md px-2 py-2 text-xs ${mode === value ? 'bg-surface-0 text-accent shadow-1' : 'text-muted hover:text-ink'}`}>
          <Icon size={14} className="shrink-0" /><span className="whitespace-nowrap">{label}</span>
        </button>
      ))}
    </div>
  )
}
