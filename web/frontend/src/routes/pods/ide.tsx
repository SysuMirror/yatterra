/**
 * /pods/:name/ide — Web IDE 页面。
 * 权限:与 Pod 详情页一致(App.tsx RequirePerm group.view + 后端
 * route_perm 的 pod view/member 校验;页面 AI 用 pagePerms 的 'pod_ide')。
 */
import { Link, useParams } from 'react-router'
import { IdeShell } from '@/ide/IdeShell'

export default function PodIdePage() {
  const { name } = useParams()

  if (!name) {
    return (
      <div className="p-6 text-sm">
        缺少 Pod 名称。
        <Link className="ml-2 text-accent underline" to="/ide">返回 IDE 入口</Link>
      </div>
    )
  }

  // key:换 Pod(深链)时强制重挂载。否则 /pods/:name/ide 是同一个路由元素,
  // IdeShell / MobileIdeLayout 里 loadLayout(podName) 的 useState 初值不会重算,
  // 会把上一个 Pod 的布局树与活动面板带过来(还会写错 storage key)。
  return (
    <div className="h-full min-h-0">
      <IdeShell key={name} podName={name} />
    </div>
  )
}
