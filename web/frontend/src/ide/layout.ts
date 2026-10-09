/**
 * IDE 布局模型:LayoutNode 树的构造/校验/压平/持久化,以及内置预设。
 *
 * 持久化 key:
 *   yatterra.ide.layout.<podName>   — StoredIdeLayout(树 + dockview 快照 + 手机覆盖)
 *   yatterra.ide.presets            — 用户命名保存的预设 Record<name, LayoutNode>
 */
import type {
  LayoutNode,
  MobileLayoutOverride,
  SplitLayoutNode,
  StoredIdeLayout,
  TabsLayoutNode,
} from './types'
import { getPanel } from './registry'

export const LAYOUT_KEY = (podName: string) => `yatterra.ide.layout.${podName}`
export const PRESETS_KEY = 'yatterra.ide.presets'

// ── 构造 helper ────────────────────────────────────────────────────────────

export function tabs(panels: string[], active?: string): TabsLayoutNode {
  const list = panels.filter((p) => getPanel(p))
  if (list.length === 0) throw new Error('tabs(): no registered panels')
  return { type: 'tabs', panels: list, active: active && list.includes(active) ? active : list[0]! }
}

export function split(dir: SplitLayoutNode['dir'], children: LayoutNode[], sizes?: number[]): SplitLayoutNode {
  if (children.length === 0) throw new Error('split(): no children')
  const weights =
    sizes && sizes.length === children.length ? sizes : children.map(() => 1)
  return { type: 'split', dir, sizes: weights, children }
}

// ── 内置预设 ───────────────────────────────────────────────────────────────

/**
 * 内置布局预设(名字 → 树工厂;每次取新实例,避免共享可变引用)。
 * 只保留一个熟悉的三栏默认(files / editor / ai);terminal/logs 不在
 * 默认布局里,由顶栏面板开关按需打开。localStorage 里已存的旧布局
 * (含 code/debug 时代的树)按值照常加载,无需迁移。
 */
export const BUILTIN_PRESETS: Record<string, () => LayoutNode> = {
  default: () =>
    split('row', [
      tabs(['files']),
      tabs(['editor'], 'editor'),
      tabs(['ai']),
    ], [0.18, 0.52, 0.3]),
}

export const DEFAULT_PRESET = 'default'

// ── 校验与修复 ─────────────────────────────────────────────────────────────

/** 过滤掉未注册面板并保证结构合法;全部失效时回退默认预设。 */
export function sanitizeTree(node: unknown): LayoutNode {
  const fallback = () => BUILTIN_PRESETS[DEFAULT_PRESET]!()
  if (!node || typeof node !== 'object') return fallback()
  const n = node as Partial<SplitLayoutNode> & Partial<TabsLayoutNode>
  if (n.type === 'tabs') {
    const panels = (n.panels ?? []).filter((p): p is string => typeof p === 'string' && !!getPanel(p))
    if (panels.length === 0) return fallback()
    const active = typeof n.active === 'string' && panels.includes(n.active) ? n.active : panels[0]!
    return { type: 'tabs', panels, active }
  }
  if (n.type === 'split' && (n.dir === 'row' || n.dir === 'col') && Array.isArray(n.children)) {
    const children = n.children.map(sanitizeTree)
    if (children.length === 0) return fallback()
    const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length
      ? n.sizes.map((s) => (typeof s === 'number' && s > 0 ? s : 1))
      : children.map(() => 1)
    return { type: 'split', dir: n.dir, sizes, children }
  }
  return fallback()
}

// ── 持久化 ─────────────────────────────────────────────────────────────────

export function loadLayout(podName: string): StoredIdeLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY(podName))
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredIdeLayout>
      if (parsed && parsed.version === 1 && parsed.tree) {
        return { version: 1, tree: sanitizeTree(parsed.tree), dockview: parsed.dockview, mobile: parsed.mobile }
      }
    }
  } catch { /* private mode / corrupt JSON */ }
  return { version: 1, tree: BUILTIN_PRESETS[DEFAULT_PRESET]!() }
}

export function saveLayout(podName: string, layout: StoredIdeLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY(podName), JSON.stringify(layout))
  } catch { /* private mode */ }
}

/** 用户命名预设(localStorage 全局共享,跨 Pod)。 */
export function loadUserPresets(): Record<string, LayoutNode> {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, LayoutNode> = {}
    for (const [name, tree] of Object.entries(parsed as Record<string, unknown>)) {
      out[name] = sanitizeTree(tree)
    }
    return out
  } catch {
    return {}
  }
}

export function saveUserPreset(name: string, tree: LayoutNode): void {
  try {
    const all = loadUserPresets()
    all[name] = tree
    localStorage.setItem(PRESETS_KEY, JSON.stringify(all))
  } catch { /* private mode */ }
}

export function deleteUserPreset(name: string): void {
  try {
    const all = loadUserPresets()
    delete all[name]
    localStorage.setItem(PRESETS_KEY, JSON.stringify(all))
  } catch { /* private mode */ }
}

// ── 树查询/修改 ────────────────────────────────────────────────────────────

/** 深度遍历,返回所有 tabs 节点(含嵌套)。 */
export function tabsNodes(node: LayoutNode, out: TabsLayoutNode[] = []): TabsLayoutNode[] {
  if (node.type === 'tabs') out.push(node)
  else node.children.forEach((c) => tabsNodes(c, out))
  return out
}

/** 树里出现过的全部面板 id。 */
export function panelsInTree(node: LayoutNode): string[] {
  return tabsNodes(node).flatMap((t) => t.panels)
}

/** 把某个 tabs 节点的 active 换成 panelId(按 panels 列表匹配到具体节点)。 */
export function setActiveTab(node: LayoutNode, panelsKey: string, panelId: string): LayoutNode {
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === 'tabs') {
      if (n.panels.join('/') !== panelsKey || !n.panels.includes(panelId)) return n
      return { ...n, active: panelId }
    }
    return { ...n, children: n.children.map(walk) }
  }
  return walk(node)
}

// ── 手机压平 ───────────────────────────────────────────────────────────────

/** 压平后的一个堆叠槽位。 */
export interface FlatPanelSlot {
  /** 当前显示的面板 id。 */
  panelId: string
  /** 同 tabs 组的全部面板(可切换标签;长度 1 时无标签条)。 */
  siblings: string[]
  /** tabs 节点 panels 的 join('/') key,用于 setActiveTab。 */
  tabsKey: string
}

/**
 * 把布局树压平成手机垂直堆叠的槽位序列:
 * split 按顺序展开,tabs 取 active 面板(其余面板通过面板头标签切换)。
 * mobileDrawer 面板(如 ai)不进堆叠,由渲染器单独处理。
 */
export function flattenForMobile(node: LayoutNode): FlatPanelSlot[] {
  const out: FlatPanelSlot[] = []
  const walk = (n: LayoutNode) => {
    if (n.type === 'tabs') {
      const drawerOnly = n.panels.every((p) => getPanel(p)?.mobileDrawer)
      if (drawerOnly) return
      const stacked = n.panels.filter((p) => !getPanel(p)?.mobileDrawer)
      if (stacked.length === 0) return
      const active = n.active && stacked.includes(n.active) ? n.active : stacked[0]!
      out.push({ panelId: active, siblings: stacked, tabsKey: n.panels.join('/') })
      return
    }
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** 从手机覆盖(order/weights)恢复,槽位集合与当前树一致才可用。 */
export function mobileOverrideFor(tree: LayoutNode, saved?: MobileLayoutOverride): MobileLayoutOverride | undefined {
  if (!saved || !Array.isArray(saved.order) || !Array.isArray(saved.weights)) return undefined
  const current = flattenForMobile(tree).map((s) => s.tabsKey)
  const savedSet = new Set(saved.order)
  // 覆盖必须与当前槽位集合完全一致,否则视为过期(面板增删/换预设后)
  if (current.length !== savedSet.size || current.some((k) => !savedSet.has(k))) return undefined
  if (saved.order.length !== saved.weights.length) return undefined
  const total = saved.weights.reduce((a, b) => a + (b > 0 ? b : 0), 0)
  if (!(total > 0)) return undefined
  const weights = saved.weights.map((w) => (w > 0 ? w : 0) / total)
  return {
    order: [...saved.order],
    weights,
    drawerSnap: saved.drawerSnap === 0.25 || saved.drawerSnap === 0.5 || saved.drawerSnap === 0.9 ? saved.drawerSnap : 0.5,
    drawerOpen: saved.drawerOpen !== false,
  }
}

/** 默认手机覆盖:按压平顺序均分,抽屉半开。 */
export function defaultMobileOverride(tree: LayoutNode): MobileLayoutOverride {
  const order = flattenForMobile(tree).map((s) => s.tabsKey)
  const weights = order.map(() => 1 / Math.max(1, order.length))
  return { order, weights, drawerSnap: 0.5, drawerOpen: true }
}
