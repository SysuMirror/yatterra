/**
 * App Badging API — 在已安装 PWA 的图标/Dock 上显示未读数。
 *
 * 仅在「已安装」或部分支持的浏览器上生效；未安装时全部静默 no-op，
 * 所以可以直接调用，不需要在调用点做能力判断。
 */
type NavigatorWithBadge = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

function nav(): NavigatorWithBadge | null {
  return typeof navigator === 'undefined' ? null : (navigator as NavigatorWithBadge)
}

export function isBadgeSupported(): boolean {
  return nav()?.setAppBadge !== undefined
}

// 记住上一次的值，避免每次轮询都重复写 OS 层的角标。
let last: number | null = null

/** 设置角标数字；count <= 0 时清除角标。 */
export async function setAppBadge(count: number): Promise<void> {
  const n = nav()
  if (typeof n?.setAppBadge !== 'function') return
  const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (next === last) return
  last = next
  try {
    if (next === 0) await n.clearAppBadge?.()
    else await n.setAppBadge(next)
    // 同步给 SW：页面关闭后角标依然保留，后台同步也能接着更新。
    navigator.serviceWorker?.controller?.postMessage({ type: 'SET_APP_BADGE', count: next })
  } catch {
    // 未安装 / 平台不支持时静默失败，别打断页面逻辑
    last = null
  }
}

export async function clearAppBadge(): Promise<void> {
  await setAppBadge(0)
}
