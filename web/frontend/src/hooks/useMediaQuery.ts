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
