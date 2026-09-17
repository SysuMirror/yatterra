import type { useDrag } from '@use-gesture/react'

/**
 * Spread helper for `@use-gesture/react`'s `bind()` on a framer-motion element.
 *
 * The two libraries declare conflicting `onAnimationStart` signatures — React's
 * `AnimationEventHandler<EventTarget>` vs framer-motion's
 * `(definition: AnimationDefinition) => void` — so spreading `bind()` directly
 * onto a `motion.*` element fails to typecheck even though it works at runtime
 * (the gesture handlers never touch animation events).
 *
 * Usage:  <motion.div {...motionBind(bind())} />
 */
export function motionBind(bind: ReturnType<typeof useDrag>): Record<string, unknown> {
  return bind as unknown as Record<string, unknown>
}
