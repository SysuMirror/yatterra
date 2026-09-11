import { motion } from 'framer-motion'
import { haptic } from '@/lib/haptic'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}

export function Switch({ checked, onChange, disabled, label }: SwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => { haptic('light'); onChange(!checked) }}
      className={`inline-flex items-center gap-2 active:scale-95 transition-transform duration-100 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <div
        className="relative w-[44px] h-[26px] rounded-full transition-colors duration-200"
        style={{
          background: checked
            ? 'var(--accent, #0a84ff)'
            : 'rgba(120,120,128,0.16)',
        }}
      >
        <motion.div
          className="absolute top-[2px] w-[22px] h-[22px] rounded-full bg-white"
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.04)' }}
          animate={{ left: checked ? '20px' : '2px' }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </div>
      {label && <span className="text-sm text-ink-2">{label}</span>}
    </button>
  )
}
