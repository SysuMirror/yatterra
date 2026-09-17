import { create } from 'zustand'

/**
 * Navigation direction store.
 *
 * Tracks whether the last navigation was "forward" (drilling in) or
 * "back" (going up), so the page transition animation can slide in
 * the appropriate direction — like iOS's push/pop navigation.
 *
 * Set `direction` before the route change happens so AnimatePresence
 * picks up the correct exit/enter variants.
 */
interface NavState {
  direction: 'forward' | 'back'
  setDirection: (d: 'forward' | 'back') => void
}

export const useNavStore = create<NavState>()((set) => ({
  direction: 'forward',
  setDirection: (d) => set({ direction: d }),
}))
