/**
 * 设置面板:字号/缩放(editorPrefs store,实时生效)、主题(ThemePicker)、
 * 布局预设管理(保存当前布局为命名预设 / 应用 / 删除 / 恢复默认)。
 *
 * 「应用预设」的跨面板通信:布局树归内核管(契约),面板不能直接改,
 * 这里通过 window CustomEvent 通知布局外壳:
 *
 *   export const IDE_APPLY_PRESET_EVENT = 'ide:apply-preset'
 *   window.dispatchEvent(new CustomEvent(IDE_APPLY_PRESET_EVENT, {
 *     detail: { name: string },   // 内置('default')或用户预设名
 *   }))
 *
 * 集成接线:在 IdeShell(IdeShell.tsx)挂载时加一个监听,把事件转发给
 * 已有的 applyPreset(name) 即可,一行:
 *
 *   useEffect(() => {
 *     const h = (e: Event) => applyPreset((e as CustomEvent).detail?.name)
 *     window.addEventListener(IDE_APPLY_PRESET_EVENT, h)
 *     return () => window.removeEventListener(IDE_APPLY_PRESET_EVENT, h)
 *   }, [applyPreset])
 *
 * 「保存当前布局为预设」直接读 localStorage 的持久化树
 * (loadLayout(podName).tree,IdeShell 落盘有 200ms 防抖,足够新)。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Check, LayoutTemplate, RotateCcw, Save, Trash2 } from 'lucide-react'
import { ThemePicker } from '@/components/ui/ThemePicker'
import { useEditorPrefsStore } from '@/stores/editorPrefs'
import {
  BUILTIN_PRESETS,
  DEFAULT_PRESET,
  deleteUserPreset,
  loadLayout,
  loadUserPresets,
  saveUserPreset,
} from '../layout'
import type { LayoutNode } from '../types'
import type { PanelProps } from '../types'

/** 应用预设事件(见文件头注释;IdeShell 需监听并转发给 applyPreset)。 */
export const IDE_APPLY_PRESET_EVENT = 'ide:apply-preset'

/** 请求布局外壳应用某个预设(内置或用户预设)。 */
export function requestApplyPreset(name: string): void {
  window.dispatchEvent(new CustomEvent(IDE_APPLY_PRESET_EVENT, { detail: { name } }))
}

// ── 小组件 ─────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ide-set-card">
      <h3 className="text-xs font-semibold text-muted mb-3 tracking-wide">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function SliderRow({
  label, value, min, max, step, onChange, format,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[13px]">{label}</label>
        <span className="text-xs text-muted tabular-nums select-none">{format(value)}</span>
      </div>
      {/* h-11 保证手机上好拖;accentColor 跟主题色 */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-11 cursor-pointer bg-transparent"
        style={{ accentColor: 'var(--accent, #0a84ff)' }}
      />
    </div>
  )
}

// ── 面板本体 ───────────────────────────────────────────────────────────────

export function SettingsPanel({ podName, surface }: PanelProps) {
  const editorFontSize = useEditorPrefsStore((s) => s.editorFontSize)
  const terminalFontSize = useEditorPrefsStore((s) => s.terminalFontSize)
  const uiScale = useEditorPrefsStore((s) => s.uiScale)
  const setEditorFontSize = useEditorPrefsStore((s) => s.setEditorFontSize)
  const setTerminalFontSize = useEditorPrefsStore((s) => s.setTerminalFontSize)
  const setUiScale = useEditorPrefsStore((s) => s.setUiScale)

  const [userPresets, setUserPresets] = useState<Record<string, LayoutNode>>(() => loadUserPresets())
  const [presetName, setPresetName] = useState('')
  const [justSaved, setJustSaved] = useState<string | null>(null)

  const mobile = surface === 'mobile'
  const actBtn = cnBtn(mobile)

  /** 把当前布局(持久化树)存为命名预设。 */
  const saveCurrentAsPreset = () => {
    const name = presetName.trim()
    if (!name) return
    saveUserPreset(name, loadLayout(podName).tree)
    setUserPresets(loadUserPresets())
    setPresetName('')
    setJustSaved(name)
    window.setTimeout(() => setJustSaved((cur) => (cur === name ? null : cur)), 1500)
  }

  const removePreset = (name: string) => {
    if (!window.confirm(`删除预设「${name}」?`)) return
    deleteUserPreset(name)
    setUserPresets(loadUserPresets())
  }

  const presetRows: Array<{ name: string; builtin: boolean }> = [
    ...Object.keys(BUILTIN_PRESETS).map((name) => ({ name, builtin: true })),
    ...Object.keys(userPresets).map((name) => ({ name, builtin: false })),
  ]

  return (
    <div className="h-full w-full overflow-y-auto p-3 sm:p-4">
      <div className="max-w-xl mx-auto space-y-4">
        {/* 外观 */}
        <Section title="外观">
          <ThemePicker />
          <p className="text-xs text-muted">主题立即生效并全平台同步。</p>
        </Section>

        {/* 字号与缩放:实时生效(编辑器面板读 var(--ide-fs),终端面板订阅 store) */}
        <Section title="字号与缩放">
          <SliderRow
            label="编辑器字号"
            value={editorFontSize}
            min={12}
            max={28}
            step={1}
            onChange={setEditorFontSize}
            format={(v) => `${v} px`}
          />
          <SliderRow
            label="终端字号"
            value={terminalFontSize}
            min={12}
            max={28}
            step={1}
            onChange={setTerminalFontSize}
            format={(v) => `${v} px`}
          />
          <SliderRow
            label="界面缩放"
            value={uiScale}
            min={0.8}
            max={1.4}
            step={0.05}
            onChange={setUiScale}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <p className="text-xs text-muted">终端字号也可在终端面板用 +/- 按钮或双指捏合调整。</p>
        </Section>

        {/* 布局预设 */}
        <Section title="布局预设">
          <div className="space-y-2">
            {presetRows.map(({ name, builtin }) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-lg bg-ink/[0.03] px-2.5 py-1.5"
              >
                <LayoutTemplate size={14} className="text-muted shrink-0" />
                <span className="text-[13px] truncate flex-1 min-w-0">
                  {name}
                  {builtin && <span className="ml-1.5 text-[10px] text-muted/70">内置</span>}
                </span>
                <button
                  type="button"
                  onClick={() => requestApplyPreset(name)}
                  className={actBtn}
                >
                  应用
                </button>
                {!builtin && (
                  <button
                    type="button"
                    aria-label={`删除预设 ${name}`}
                    onClick={() => removePreset(name)}
                    className={cnBtn(mobile, true)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* 保存当前布局为预设 */}
          <div className="flex items-center gap-2">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentAsPreset() }}
              placeholder="新预设名称"
              className="flex-1 min-w-0 px-3 rounded-lg text-[13px] border border-line bg-ink/[0.03] focus:outline-none focus:ring-2 focus:ring-accent/20"
              style={{ height: mobile ? 44 : 36 }}
            />
            <button
              type="button"
              onClick={saveCurrentAsPreset}
              disabled={!presetName.trim()}
              className={`${actBtn} bg-ink/5 hover:bg-ink/10 disabled:opacity-40`}
            >
              {justSaved ? <Check size={13} /> : <Save size={13} />}
              <span className="hidden sm:inline">{justSaved ? '已保存' : '存为预设'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => requestApplyPreset(DEFAULT_PRESET)}
            className={`${actBtn} w-full justify-center border border-line hover:bg-ink/5`}
          >
            <RotateCcw size={13} />
            恢复默认布局（{DEFAULT_PRESET}）
          </button>
        </Section>
      </div>
    </div>
  )
}

/** 面板内操作按钮:手机 44px 命中,桌面紧凑。 */
function cnBtn(mobile: boolean, iconOnly = false): string {
  return [
    'inline-flex items-center gap-1.5 rounded-lg text-xs font-medium transition-colors',
    mobile ? 'h-11' : 'h-9',
    iconOnly ? (mobile ? 'w-11' : 'w-9') : 'px-3',
    'text-ink-2 hover:text-ink hover:bg-ink/5 active:bg-ink/[0.07]',
  ].join(' ')
}
