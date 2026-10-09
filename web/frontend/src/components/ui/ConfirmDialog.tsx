import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: string
  /** 确认按钮文案, 默认「确认删除」 */
  confirmText?: string
  /** 确认按钮是否处于加载中 */
  loading?: boolean
}

/** 通用破坏性操作确认对话框(危险色确认按钮), 参考 pods 删 Pod 的写法 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = '确认删除',
  loading,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="max-w-sm"
    >
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button variant="danger" loading={loading} onClick={onConfirm}>{confirmText}</Button>
      </div>
    </Dialog>
  )
}
