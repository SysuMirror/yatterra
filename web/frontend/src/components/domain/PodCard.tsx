import { useRef, useState } from 'react'
import { motion, useMotionValue, animate, useTransform } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { Power, RotateCw, Trash2, Sparkles, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet'
import { useLongPress } from '@/hooks/useLongPress'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { aiApi } from '@/api/ai'
import { cn } from '@/lib/cn'
import { formatSpec, podStatusLabel } from '@/lib/format'
import { motionBind } from '@/lib/gesture'

interface PodCardProps {
  name: string
  status: string
  cpu: number
  mem: number
  gpus: number
  storage: number
  owner: string
  members?: number
  role?: string
  reason?: string
  onClick?: () => void
  onStart?: () => void
  onStop?: () => void
  onRestart?: () => void
  onDelete?: () => void
}

const statusVariant: Record<string, 'ok' | 'muted' | 'warn' | 'bad'> = {
  Running: 'ok',
  Stopped: 'muted',
  Pending: 'warn',
  Failed: 'bad',
  Succeeded: 'ok',
}

const ROLE_BADGE: Record<string, { label: string; cls: string }> = {
  owner: { label: '负责人', cls: 'bg-ok/10 text-[#1a7f37]' },
  admin: { label: '管理员', cls: 'bg-accent/10 text-accent-dark' },
  super: { label: '管理员', cls: 'bg-accent/10 text-accent-dark' },
  member: { label: '成员', cls: 'bg-black/[0.03] text-muted' },
}

/** Width of the swipe action area (px) */
const ACTION_W = 140
/** Threshold to snap open (px) */
const SNAP_THRESHOLD = 60
/** Velocity threshold for snap (px/ms) */
const VELOCITY_THRESHOLD = 0.3

/** Apple-style rubber-band function */
function rubberband(overshoot: number, dim: number, constant = 0.55): number {
  return (overshoot * dim * constant) / (dim + constant * Math.abs(overshoot))
}

export function PodCard({ name, status, cpu, mem, gpus, storage, owner, members, role, reason, onClick, onStart, onStop, onRestart, onDelete }: PodCardProps) {
  const isDesktop = useIsDesktop()
  const running = status === 'Running'
  const [sheetOpen, setSheetOpen] = useState(false)

  // ── Swipe-to-action (mobile only) ──
  const x = useMotionValue(0)
  const cardRef = useRef<HTMLDivElement>(null)

  // Action button opacity scales with swipe progress
  const actionOpacity = useTransform(x, [-ACTION_W, 0], [1, 0])
  const actionWidth = useTransform(x, [-ACTION_W, 0], [ACTION_W, 0])

  const dragBind = useDrag(
    ({ movement: [mx], velocity: [vx], active, cancel, event }) => {
      if (isDesktop) { cancel(); return }

      if (active) {
        // Only allow left swipe (negative movement)
        if (mx > 8) { cancel(); return }
        const clamped = Math.max(-ACTION_W * 1.3, mx)
        // Rubber-band past the action width
        if (clamped < -ACTION_W) {
          const overshoot = clamped + ACTION_W
          x.set(-ACTION_W + rubberband(overshoot, ACTION_W))
        } else {
          x.set(clamped)
        }
        return
      }

      // On release: snap open or spring back
      if (mx < -SNAP_THRESHOLD || (mx < -30 && vx < -VELOCITY_THRESHOLD)) {
        animate(x, -ACTION_W, { type: 'spring', stiffness: 300, damping: 30, velocity: vx })
      } else {
        animate(x, 0, { type: 'spring', stiffness: 400, damping: 30, velocity: vx })
      }
    },
    {
      axis: 'x',
      enabled: !isDesktop,
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  // ── Long-press context menu (mobile only) ──
  const longPress = useLongPress({
    onLongPress: () => setSheetOpen(true),
    enabled: !isDesktop,
    delay: 400,
  })

  const snapBack = () => animate(x, 0, { type: 'spring', stiffness: 400, damping: 30 })

  const actionItems: ActionSheetItem[] = [
    { key: running ? 'stop' : 'start', label: running ? '停止' : '启动', icon: <Power size={16} className={running ? 'text-muted' : 'text-ok'} />, onClick: running ? onStop! : onStart!, disabled: !onStop && !onStart },
    { key: 'restart', label: '重启', icon: <RotateCw size={16} className="text-muted" />, onClick: onRestart!, disabled: !onRestart },
    { key: 'delete', label: '删除', icon: <Trash2 size={16} />, onClick: onDelete!, danger: true, disabled: !onDelete },
  ].filter((i) => !i.disabled)

  const roleInfo = role ? ROLE_BADGE[role] : null
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiExplain = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (aiTip) { setAiTip(''); return }
    setAiLoading(true)
    try {
      const info = `Pod: ${name}, 状态: ${status}, 规格: CPU ${cpu}核 内存 ${mem}GB GPU ${gpus} 存储 ${storage}GB, 负责人: ${owner}${reason ? `, 失败原因: ${reason}` : ''}`
      const res = await aiApi.explain(info)
      setAiTip(res.content)
    } catch {
      setAiTip('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <>
      <div className="relative overflow-hidden rounded-2xl">
        {/* Swipe action backdrop (revealed behind the card) */}
        {!isDesktop && (
          <motion.div
            className="absolute top-0 right-0 bottom-0 flex items-center justify-end gap-1 pr-3 bg-bad/8"
            style={{ width: actionWidth, opacity: actionOpacity }}
          >
            <SwipeActionBtn label={running ? '停' : '启'} onClick={() => { running ? onStop?.() : onStart?.(); snapBack() }}>
              <Power size={14} className={running ? 'text-muted' : 'text-ok'} />
            </SwipeActionBtn>
            <SwipeActionBtn label="重启" onClick={() => { onRestart?.(); snapBack() }}>
              <RotateCw size={14} className="text-muted" />
            </SwipeActionBtn>
            <SwipeActionBtn label="删除" danger onClick={() => { onDelete?.(); snapBack() }}>
              <Trash2 size={14} />
            </SwipeActionBtn>
          </motion.div>
        )}

        {/* Card content */}
        <motion.div
          ref={cardRef}
          className="glass-card group/card flex flex-col p-4 rounded-2xl cursor-pointer transition-shadow duration-150 hover:shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
          style={isDesktop ? undefined : { x }}
          onClick={(e) => {
            // Don't navigate if we just swiped open
            if (!isDesktop && x.get() < -10) { snapBack(); return }
            // Don't navigate after a long press
            if (longPress.wasLongPress()) return
            onClick?.()
          }}
          {...(isDesktop ? {} : motionBind(dragBind()))}
          {...(isDesktop ? {} : longPress)}
        >
          {/* Header: name + role badge + action buttons */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink font-mono truncate" title={name}>{name}</h3>
                {roleInfo && (
                  <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0', roleInfo.cls)}>
                    {roleInfo.label}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted truncate mt-0.5">
                {owner}{members != null && members > 1 ? ` · ${members} 人` : ''}
              </p>
            </div>
            {/* Action buttons — always visible, touch-friendly, no hover trap */}
            <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
              <IconBtn icon={aiLoading ? <Loader2 size={14} className="animate-spin text-accent" /> : <Sparkles size={14} className="text-accent" />} title="AI 分析" onClick={handleAiExplain} />
              <IconBtn icon={<Power size={14} className={running ? 'text-muted' : 'text-ok'} />} title={running ? '停止' : '启动'} onClick={running ? onStop : onStart} />
              <IconBtn icon={<RotateCw size={14} className="text-muted" />} title="重启" onClick={onRestart} />
              <IconBtn icon={<Trash2 size={14} />} title="删除" danger onClick={onDelete} />
            </div>
          </div>

          {/* Spec + status — single compact line, never wraps badly at any width */}
          <div className="flex items-center justify-between gap-2 flex-wrap mt-auto pt-1">
            <span className="text-xs text-ink-2 tnum font-medium">{formatSpec(cpu, mem, gpus, storage)}</span>
            <Badge variant={statusVariant[status] ?? 'muted'} dot>{podStatusLabel(status)}</Badge>
          </div>

          {reason && (
            <p className="text-xs text-bad mt-2 line-clamp-2" title={reason}>{reason}</p>
          )}

          {aiTip && (
            <div className="mt-2 p-2 rounded-lg bg-accent/5 border border-accent/10 text-xs whitespace-pre-wrap" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1 mb-0.5 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 分析</div>
              {aiTip}
            </div>
          )}
        </motion.div>
      </div>

      {/* Long-press action sheet (mobile) */}
      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={name}
        items={actionItems}
      />
    </>
  )
}

function IconBtn({ icon, title, danger, onClick }: { icon: React.ReactNode; title: string; danger?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cn(
        'flex items-center justify-center w-8 h-8 rounded-lg transition-colors duration-100',
        danger
          ? 'text-muted hover:text-bad hover:bg-bad/10'
          : 'text-muted hover:text-ink hover:bg-black/[0.05]',
      )}
      onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
    >
      {icon}
    </button>
  )
}

function SwipeActionBtn({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center w-10 h-10 rounded-lg text-[10px] font-medium transition-colors',
        danger ? 'text-bad' : 'text-ink-2',
      )}
    >
      {children}
      <span className="mt-0.5">{label}</span>
    </button>
  )
}
