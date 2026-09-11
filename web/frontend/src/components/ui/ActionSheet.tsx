import { Dialog } from '@/components/ui/Dialog'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

export interface ActionSheetItem {
  key: string
  label: string
  icon?: React.ReactNode
  /** Style as destructive (red). Destructive items go to the bottom section. */
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

interface ActionSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  items: ActionSheetItem[]
}

/**
 * Mobile-friendly action sheet.
 *
 * Uses Dialog (which auto-switches to BottomSheet on mobile),
 * so this works great on both desktop and phone.
 *
 * Items are split into two groups: normal actions and destructive actions.
 * Destructive actions are visually separated at the bottom.
 */
export function ActionSheet({ open, onClose, title, items }: ActionSheetProps) {
  const normal = items.filter((i) => !i.danger)
  const danger = items.filter((i) => i.danger)

  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-sm">
      <div className="space-y-1 -mx-1">
        {normal.map((item) => (
          <SheetRow key={item.key} item={item} onClose={onClose} />
        ))}
      </div>

      {danger.length > 0 && (
        <>
          <div className="my-2 h-px bg-black/[0.06]" />
          <div className="space-y-1 -mx-1">
            {danger.map((item) => (
              <SheetRow key={item.key} item={item} onClose={onClose} />
            ))}
          </div>
        </>
      )}
    </Dialog>
  )
}

function SheetRow({ item, onClose }: { item: ActionSheetItem; onClose: () => void }) {
  return (
    <button
      disabled={item.disabled}
      onClick={() => {
        haptic(item.danger ? 'heavy' : 'light')
        item.onClick()
        onClose()
      }}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all active:scale-[0.98]',
        item.danger
          ? 'text-bad hover:bg-bad/8 active:bg-bad/12'
          : 'text-ink hover:bg-black/[0.04] active:bg-black/[0.06]',
        item.disabled && 'opacity-40 pointer-events-none',
      )}
    >
      {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
      {item.label}
    </button>
  )
}
