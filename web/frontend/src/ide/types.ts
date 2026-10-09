/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Web IDE 面板契约(后续面板实现 agent 必读)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一个「面板」= 注册进 registry.tsx 的一个 PanelContract 对象。布局内核
 * (DesktopIdeLayout / MobileIdeLayout)只认 registry,不 import 任何具体
 * 面板,因此各面板可以由不同 agent 并行实现、独立替换 component。
 *
 * ── 面板组件的 props 签名 ────────────────────────────────────────────────
 *
 *   function MyPanel(props: PanelProps) { ... }
 *
 *   PanelProps(见下方接口):
 *     podName       当前 Pod 名(路由参数,API 路径 /api/pods/<podName>/...)
 *     panelId       本面板在 registry 里的 id(即布局 JSON 里引用的 id)
 *     surface       'desktop' | 'mobile' — 当前由哪套渲染器承载
 *     maximized     本面板当前是否处于最大化(桌面=group 最大化,手机=单面板最大化)
 *     activate()    请求布局层把本面板设为可见/激活
 *                   (桌面=切换到所在 tab 并 focus;手机=取消最大化并滚动定位)
 *     toggleMaximize()  请求布局层切换本面板的最大化状态
 *
 * 面板组件**不需要**接收布局树或持久化回调 —— 布局(顺序/尺寸/预设)完全
 * 由布局内核管理,面板只管自己的内容。
 *
 * ── 如何注册新面板 ──────────────────────────────────────────────────────
 *
 *   1. 写组件: `src/ide/panels/<id>.tsx`,导出 `export function XxxPanel(props: PanelProps)`。
 *   2. 在 `src/ide/registry.tsx` 末尾调用:
 *        registerPanel({
 *          id: 'mypanel',              // 全局唯一,布局 JSON 按它引用,定了别改
 *          title: '我的面板',            // 标签/面板头标题
 *          icon: SomeLucideIcon,        // lucide-react 图标组件
 *          component: MyPanel,
 *          minSize: 160,               // 可选,px,手机堆叠最小高度/桌面最小尺寸
 *          mobileDrawer: false,        // 可选,手机上吸附为底部抽屉(目前仅 ai 面板)
 *        })
 *   3. 若要进内置布局预设,在 layout.ts 的 BUILTIN_PRESETS 里引用该 id。
 *   注册后桌面/手机渲染器自动可用,无需改布局内核。
 *
 * ── 手机渲染器对面板组件的额外要求 ───────────────────────────────────────
 *
 *   * 组件必须自适应填满父容器(父容器有确定高度;用 h-full/w-full 或
 *     absolute inset-0),不能假设视口高度,也不能给外层加页面级 padding。
 *   * 手机渲染器会**卸载**不可见面板(切换 tab、最大化其它面板、抽屉收起)。
 *     重资源(xterm 实例、SSE/WS 连接、定时器)必须在 useEffect 清理函数里
 *     释放,内部状态要么自行持久化(localStorage / 后端),要么能接受重建。
 *   * 字号请用 var(--ide-fs)(编辑器)/ var(--ide-tfs)(终端),缩放用
 *     var(--ide-scale),由 editorPrefs store 全局写入,勿各存一份。
 *   * 手机上 44px 是最小命中区,面板内自定义按钮请保证 ≥44px 命中。
 *   * mobileDrawer 面板在手机上不进垂直堆叠,而是底部抽屉(25/50/90 三档),
 *     组件同样会被卸载/重建,要求同上。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type React from 'react'
import type { LucideIcon } from 'lucide-react'

/** 面板组件收到的 props(由布局内核注入,见文件头注释)。 */
export interface PanelProps {
  podName: string
  panelId: string
  surface: 'desktop' | 'mobile'
  maximized: boolean
  /** 让布局层激活/定位到本面板。 */
  activate: () => void
  /** 切换本面板最大化。 */
  toggleMaximize: () => void
}

/** 注册表里的单个面板契约。 */
export interface PanelContract {
  /** 全局唯一 id,布局 JSON / 预设按它引用。 */
  id: string
  /** 标签/面板头标题。 */
  title: string
  /** lucide-react 图标组件。 */
  icon: LucideIcon
  /** 面板内容组件。 */
  component: React.ComponentType<PanelProps>
  /** 最小尺寸 px(手机=堆叠最小高度,桌面传给 dockview minimum)。 */
  minSize?: number
  /** 手机上吸附为底部抽屉而非垂直堆叠(仅 AI 类面板用)。 */
  mobileDrawer?: boolean
}

// ── 布局 JSON 树 ───────────────────────────────────────────────────────────
// 序列化到 localStorage key `yatterra.ide.layout.<podName>`(见 layout.ts)。

/** 叶子:一组以标签页共存的面板。 */
export interface TabsLayoutNode {
  type: 'tabs'
  /** 面板 id 列表(引用 registry 的 id)。 */
  panels: string[]
  /** 当前激活面板 id。 */
  active: string
}

/** 分支:按 dir 方向排列的子节点,sizes 为占比权重(和不必为 1)。 */
export interface SplitLayoutNode {
  type: 'split'
  /** 'row' = 左右排列,'col' = 上下排列。 */
  dir: 'row' | 'col'
  /** 与 children 一一对应的占比权重。 */
  sizes: number[]
  children: LayoutNode[]
}

export type LayoutNode = TabsLayoutNode | SplitLayoutNode

/** localStorage 里存的整体记录。 */
export interface StoredIdeLayout {
  version: 1
  /** 规范布局树(手机渲染器的数据源;桌面优先用 dockview 精确快照)。 */
  tree: LayoutNode
  /** 桌面 dockview 的 toJSON 快照(精确恢复拖拽边界/分组)。 */
  dockview?: unknown
  /** 手机渲染器覆盖:面板顺序与占比(与 tree 的面板集合保持一致)。 */
  mobile?: MobileLayoutOverride
}

/** 手机堆叠布局的持久化覆盖。 */
export interface MobileLayoutOverride {
  /**
   * 堆叠槽位顺序。槽位 key = 该 tabs 节点 panels 的 join('/')
   * (不含 mobileDrawer 面板所在的 tabs 组)。
   */
  /** 旧堆叠时代的槽位顺序(手机渲染器已不写,仅旧记录/桌面兼容保留)。 */
  order?: string[]
  /** 与 order 一一对应的占比权重(0–1,和为 1)。 */
  weights?: number[]
  /** 底部抽屉(mobileDrawer 面板)高度档位。 */
  drawerSnap?: 0.25 | 0.5 | 0.9
  /** 底部抽屉是否展开(收起时只剩 44px 把手条)。 */
  drawerOpen?: boolean
  /** 当前激活的面板 id(MobileIdeLayout 持久化)。 */
  activePanel?: string
}
