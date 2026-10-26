/**
 * Pod 文件下载:GET /api/pods/<pod>/files/download 拉成 blob 再存盘。
 *
 * 不直接 window.open:错误响应是 JSON(带 error 字段),直接打开会把
 * JSON 当页面显示;fetch 才能拦截 4xx 并 toast 出后端的中文原因
 * (超限/路径不存在等)。Cookie 同源鉴权,无需额外头。
 */
export async function downloadPodFile(
  podName: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  const res = await fetch(
    `/api/pods/${encodeURIComponent(podName)}/files/download?path=${encodeURIComponent(path)}`,
    { credentials: 'same-origin' },
  )
  if (!res.ok) {
    const j = await res.json().catch(() => null)
    throw new Error(j?.error || `下载失败 (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // 目录后端打的是 tar.gz,文件名补后缀;单文件用原名
  const base = path.split('/').pop() || 'download'
  a.download = isDir ? `${base}.tar.gz` : base
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
