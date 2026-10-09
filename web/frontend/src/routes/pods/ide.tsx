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
  return <IdeShell podName={name} />
}
