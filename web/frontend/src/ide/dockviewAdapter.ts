/**
 * LayoutNode 树 ↔ dockview 的双向转换。
 *
 * - buildDockviewFromTree: 用 DockviewApi.addPanel 按树搭出分组/分栏
 *   (尺寸为均分 —— dockview 没有公开的按权重设尺寸 API;用户拖过边界后
 *   由 toJSON 快照精确恢复,见 DesktopIdeLayout)。
 * - dockviewToTree: 把 dockview toJSON 的 grid 结构还原成 LayoutNode 树,
 *   保证桌面改动同步回规范树(手机渲染器据此压平)。
 */
import type { DockviewApi } from 'dockview-react'
import type { LayoutNode, SplitLayoutNode, TabsLayoutNode } from './types'
import { getPanel } from './registry'
import { sanitizeTree } from './layout'

// ── 树 → dockview ──────────────────────────────────────────────────────────

/**
 * 按树构建 dockview 布局。调用前应先 api.clear()。
 * 返回树中第一个成功添加的面板 id(空树返回 undefined)。
 */
export function buildDockviewFromTree(
  api: DockviewApi,
  tree: LayoutNode,
  podName: string,
): string | undefined {
  const addPanel = (panelId: string, position?: { referencePanel: string; direction: 'left' | 'right' | 'above' | 'below' | 'within' }) => {
    const contract = getPanel(panelId)
    if (!contract) return
    api.addPanel({
      id: panelId,
      component: panelId,
      title: contract.title,
      params: { podName, panelId },
      ...(position ? { position } : {}),
    })
  }

  /** 递归:返回该子树第一个面板 id,作为后续定位的参照。 */
  const build = (
    node: LayoutNode,
    position?: { referencePanel: string; direction: 'left' | 'right' | 'above' | 'below' },
  ): string | undefined => {
    if (node.type === 'tabs') {
      let first: string | undefined
      node.panels.forEach((pid) => {
        if (!first) {
          addPanel(pid, position)
          first = pid
        } else {
          // 同组追加标签
          addPanel(pid, { referencePanel: first, direction: 'within' })
        }
      })
      // tabs 节点的 active 面板设为激活标签
      if (first && node.active !== first) {
        api.panels.find((p) => p.id === node.active)?.api.setActive()
      }
      return first
    }
    // split:逐个子树摆放,后一个相对前一个的 first 面板定位
    const dir = node.dir === 'row' ? 'right' : 'below'
    let prevFirst: string | undefined
    for (const child of node.children) {
      const first = build(child, prevFirst ? { referencePanel: prevFirst, direction: dir } : position)
      if (first) prevFirst = first
    }
    return prevFirst
  }

  return build(tree)
}

// ── dockview → 树 ──────────────────────────────────────────────────────────

interface SerializedGridObjectLike {
  type: 'leaf' | 'branch'
  data: unknown
  size?: number
}

interface GroupViewStateLike {
  views?: unknown
  activeView?: unknown
}

const flip = (o: 'HORIZONTAL' | 'VERTICAL'): 'HORIZONTAL' | 'VERTICAL' =>
  o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'

/**
 * 把 dockview 的 SerializedDockview(grid 部分)还原成 LayoutNode 树。
 * 输入是 unknown(toJSON 的结果),内部做防御性解析,失败返回 undefined。
 */
export function dockviewToTree(json: unknown): LayoutNode | undefined {
  if (!json || typeof json !== 'object') return undefined
  const grid = (json as { grid?: { root?: unknown; orientation?: unknown } }).grid
  if (!grid || typeof grid !== 'object') return undefined
  const orientation = grid.orientation === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL'
  const converted = convertNode(grid.root, orientation)
  if (!converted) return undefined
  return sanitizeTree(converted)
}

function convertNode(node: unknown, orientation: 'HORIZONTAL' | 'VERTICAL'): LayoutNode | undefined {
  if (!node || typeof node !== 'object') return undefined
  const n = node as SerializedGridObjectLike
  if (n.type === 'leaf') {
    const data = n.data as GroupViewStateLike | undefined
    const views = Array.isArray(data?.views) ? (data!.views as unknown[]).filter((v): v is string => typeof v === 'string') : []
    if (views.length === 0) return undefined
    const active = typeof data?.activeView === 'string' && views.includes(data.activeView) ? data.activeView : views[0]!
    const tabs: TabsLayoutNode = { type: 'tabs', panels: views, active }
    return tabs
  }
  if (n.type === 'branch' && Array.isArray(n.data)) {
    const children: LayoutNode[] = []
    const sizes: number[] = []
    for (const child of n.data as unknown[]) {
      const converted = convertNode(child, flip(orientation))
      if (!converted) continue
      children.push(converted)
      const size = (child as SerializedGridObjectLike | null)?.size
      sizes.push(typeof size === 'number' && size > 0 ? size : 1)
    }
    if (children.length === 0) return undefined
    if (children.length === 1) return children[0]
    const splitNode: SplitLayoutNode = {
      type: 'split',
      // dockview: HORIZONTAL 分支 = 子节点左右排列
      dir: orientation === 'HORIZONTAL' ? 'row' : 'col',
      sizes,
      children,
    }
    return splitNode
  }
  return undefined
}

/** toJSON 快照是否看起来可 fromJSON(防御版本漂移/损坏)。 */
export function isValidDockviewSnapshot(json: unknown): json is Record<string, unknown> {
  return (
    !!json &&
    typeof json === 'object' &&
    typeof (json as any).grid === 'object' &&
    (json as any).grid !== null &&
    typeof (json as any).grid.root === 'object' &&
    (json as any).grid.root !== null
  )
}
