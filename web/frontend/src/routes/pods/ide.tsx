/**
 * /pods/:name/ide — Web IDE 页面。
 * 权限:与 Pod 详情页一致(App.tsx RequirePerm group.view + 后端
 * route_perm 的 pod view/member 校验;页面 AI 用 pagePerms 的 'pod_ide')。
 */
import { useParams } from 'react-router'
import { IdeShell } from '@/ide/IdeShell'

export default function PodIdePage() {
  const { name } = useParams()
  if (!name) return null
  // key:换 Pod(切换器/深链)时强制重挂载。否则 /pods/:name/ide 是同一个路由元素,
  // IdeShell / MobileIdeLayout 里 loadLayout(podName) 的 useState 初值不会重算,
  // 会把上一个 Pod 的布局树与活动面板带过来(还会写错 storage key)。
  return <IdeShell key={name} podName={name} />
}
