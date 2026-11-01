import { useEffect, useState } from 'react'

/** Reactive CSS media query. SSR-safe (defaults false, updates after mount). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** ≥768px: desktop layout (fixed sidebar beside content). Phones get the
 *  drawer nav; anything tablet-sized or wider keeps the visible rail. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)')
}

/** Web IDE 内核选择(桌面 dockview / 手机堆叠)。比 useIsDesktop 多一条高度门槛:
 *  手机横屏(如 844×390)宽度过了 768 线,但高度只有 390 —— dockview 在那里
 *  只剩一条缝,工具栏+面板全挤扁,仍是"手机"。故 IDE 只在"够宽且够高"时才用桌面内核。
 *  注意:IdeShell 选内核与 routes/_layout.tsx 的 hideTopBar 必须用同一个断言,
 *  否则横屏会同时出现平台 TopBar 和 IDE 顶栏(两条栏又叠回来)。 */
export function useIsIdeDesktop(): boolean {
  return useMediaQuery('(min-width: 768px) and (min-height: 480px)')
}
