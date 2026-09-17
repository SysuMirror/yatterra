import { createPortal } from 'react-dom'

/**
 * Renders children into document.body.
 *
 * Overlays (Dialog / Drawer / AI panel) MUST use this. The page content is
 * wrapped in a framer-motion element with `will-change: transform`, which
 * makes it a containing block for `position: fixed` descendants — any fixed
 * overlay rendered inside it is pinned to the content box instead of the
 * viewport (bottom sheets end up below the fold, backdrops don't cover the
 * screen). Portaling to <body> escapes that containing block entirely.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
