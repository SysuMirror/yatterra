/**
 * 桌面 IDE 布局渲染器(dockview)。
 *
 * - 首次加载:优先 fromJSON 恢复 dockview 快照(精确到拖过的边界),
 *   没有快照时按 LayoutNode 树搭建(均分尺寸)。
 * - 任何布局变化(onDidLayoutChange,防抖)→ toJSON 存快照 + 同步还原
 *   规范树,一起写回 localStorage(由 IdeShell 的 onPersist 落盘)。
 * - 双击标签 = 最大化/恢复所在 group(dockview 内置拖边界、拖标签停靠)。
 * - rebuildNonce 变化(切换/保存预设)→ 清空重建。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import './ide-theme.css'
import type { StoredIdeLayout } from './types'
import { getPanel, listPanels } from './registry'
import { buildDockviewFromTree, dockviewToTree, isValidDockviewSnapshot } from './dockviewAdapter'
import { setPanelToggleHandler, setVisiblePanels } from './panelToggles'
import { useEditorBusStore } from './editorBus'

/** 文件类型 → 标签圆点色(python 绿 / js 黄 / json 橙 / 其他灰)。 */
function fileDotColor(path: string | null | undefined): string {
  const name = path?.split('/').pop() ?? ''
  if (/\.py$/i.test(name)) return '#3fb950'
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(name)) return '#e3b341'
  if (/\.json$/i.test(name)) return '#f0883e'
  return '#6e7b8b'
}

/** 面板图标色(非 editor 面板的标签圆点)。 */
const PANEL_DOT: Record<string, string> = {
  files: '#e3b341',
  terminal: '#3fb950',
  ai: '#a371f7',
  logs: '#9aa7b6',
  settings: '#6e7b8b',
}

/**
 * 自定义 dockview 标签(IDE 设计语言):
 * 高 34px;激活 = panel 底 + 顶部 2px accent 线 + 亮字;非激活透明底 muted;
 * 左侧 8px 圆点按面板/文件类型着色;右侧 14px 关闭 × hover 才显;
 * 双击 = 最大化/还原所在 group。
 */
function IdeTab(props: IDockviewPanelHeaderProps) {
  const { api } = props
  const params = (props.params ?? {}) as { podName?: string; panelId?: string }
  const panelId = params.panelId ?? api.id
  const [title, setTitle] = useState(api.title)
  const [active, setActive] = useState(api.isActive)
  const [pinned, setPinned] = useState(api.isPinned)

  useEffect(() => {
    const d1 = api.onDidTitleChange((e) => setTitle(e.title))
    const d2 = api.onDidActiveChange((e) => setActive(e.isActive))
    const d3 = api.onDidChangePinned((e) => setPinned(e.isPinned))
    setTitle(api.title)
    setActive(api.isActive)
    setPinned(api.isPinned)
    return () => { d1.dispose(); d2.dispose(); d3.dispose() }
  }, [api])

  // editor 面板:圆点跟随当前打开的文件类型
  const activeFile = useEditorBusStore((s) =>
    panelId === 'editor' && params.podName ? s.pods[params.podName]?.active : undefined,
  )
  const dot = panelId === 'editor' ? fileDotColor(activeFile) : (PANEL_DOT[panelId] ?? '#6e7b8b')

  const onDoubleClick = () => {
    const group = api.group
    if (!group) return
    if (group.api.isMaximized()) group.api.exitMaximized()
    else group.api.maximize()
  }

  return (
    <div
      className={`ide-tab${active ? ' ide-tab-active' : ''}`}
      onDoubleClick={onDoubleClick}
      title={title}
    >
      <span className="ide-tab-dot" style={{ ['--dot' as string]: dot }} />
      <span className="ide-tab-label">{title}</span>
      {!pinned && (
        <button
          type="button"
          aria-label={`关闭 ${title}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.close() }}
          className="ide-tab-close"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

interface DesktopIdeLayoutProps {
  podName: string
  stored: StoredIdeLayout
  /** 预设切换信号:变化时按 stored.tree 重建。 */
  rebuildNonce: number
  /** 布局变化时回传新的完整记录(由 IdeShell 落盘)。 */
  onPersist: (next: StoredIdeLayout) => void
}

export function DesktopIdeLayout({ podName, stored, rebuildNonce, onPersist }: DesktopIdeLayoutProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // registry → dockview components 映射(注入 PanelProps)
  const components = useMemo(() => {
    const map: Record<string, React.FC<IDockviewPanelProps>> = {}
    for (const contract of listPanels()) {
      map[contract.id] = (props) => {
        const params = (props.params ?? {}) as { podName?: string }
        const Comp = contract.component
        const group = props.api.group
        return (
          <Comp
            podName={params.podName ?? podName}
            panelId={contract.id}
            surface="desktop"
            maximized={!!group && group.api.isMaximized()}
            activate={() => props.api.setActive()}
            toggleMaximize={() => {
              if (!group) return
              if (group.api.isMaximized()) group.api.exitMaximized()
              else group.api.maximize()
            }}
          />
        )
      }
    }
    return map
  }, [podName])

  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const api = apiRef.current
      if (!api) return
      try {
        const json = api.toJSON()
        const tree = dockviewToTree(json) ?? stored.tree
        onPersist({ ...stored, tree, dockview: json })
      } catch { /* 序列化失败不致命 */ }
    }, 400)
    return () => { if (persistTimer.current) clearTimeout(persistTimer.current) }
  }, [onPersist, stored])

  // 监听器只在挂载时注册一次,必须经由 ref 调用最新闭包,
  // 否则会用挂载时的 stored 展开,复活已被 applyPreset 清掉的 mobile 覆盖
  const schedulePersistRef = useRef(schedulePersist)
  schedulePersistRef.current = schedulePersist

  // ── 顶栏面板开关(增删 dockview 面板;经 panelToggles 总线)──

  const handleToggle = useCallback((panelId: string, open: boolean) => {
    const api = apiRef.current
    if (!api) return
    const instances = api.panels.filter((p) => p.id === panelId)
    if (!open) {
      // 关闭该面板的所有实例
      for (const p of instances) p.api.close()
    } else {
      if (instances.length > 0) return
      const contract = getPanel(panelId)
      if (!contract) return
      const ref = api.activePanel ?? api.panels[0]
      // files 靠左 / ai 靠右 / terminal·logs 在活动 group 下方
      const direction: 'left' | 'right' | 'below' =
        panelId === 'files' ? 'left' : panelId === 'ai' ? 'right' : 'below'
      api.addPanel({
        id: panelId,
        component: panelId,
        title: contract.title,
        params: { podName, panelId },
        ...(ref ? { position: { referencePanel: ref.id, direction } } : {}),
      })
    }
    setVisiblePanels(api.panels.map((p) => p.id))
  }, [podName])
  const handleToggleRef = useRef(handleToggle)
  handleToggleRef.current = handleToggle

  // 挂载期间接管开关总线;卸载交还(手机内核会重新注册)
  useEffect(() => {
    setPanelToggleHandler((panelId, open) => handleToggleRef.current(panelId, open))
    return () => { setPanelToggleHandler(null) }
  }, [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api
    apiRef.current = api
    try {
      if (isValidDockviewSnapshot(stored.dockview)) {
        api.fromJSON(stored.dockview as never)
      } else {
        buildDockviewFromTree(api, stored.tree, podName)
      }
    } catch {
      // 快照版本漂移等 → 回退按树搭建
      try {
        api.clear()
        buildDockviewFromTree(api, stored.tree, podName)
      } catch { /* 树也坏掉时保持空布局 */ }
    }
    setVisiblePanels(api.panels.map((p) => p.id))
    // 布局组件与 API 同生命周期,无需手动 dispose
    api.onDidLayoutChange(() => {
      // 用户手动关标签/拖拽也同步顶栏开关状态
      setVisiblePanels(api.panels.map((p) => p.id))
      schedulePersistRef.current()
    })
  }, [stored, podName])

  // 预设切换 → 重建
  const firstReady = useRef(false)
  useEffect(() => {
    if (!firstReady.current) {
      firstReady.current = true
      return
    }
    const api = apiRef.current
    if (!api) return
    try {
      api.clear()
      buildDockviewFromTree(api, stored.tree, podName)
      setVisiblePanels(api.panels.map((p) => p.id))
      schedulePersist()
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildNonce])

  return (
    <div className="h-full w-full ide-dockview-host">
      <DockviewReact
        components={components}
        defaultTabComponent={IdeTab}
        onReady={onReady}
        theme={themeDark}
      />
    </div>
  )
}
