import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SidebarState {
  collapsed: boolean
  mobileOpen: boolean
  toggle: () => void
  setCollapsed: (v: boolean) => void
  setMobileOpen: (v: boolean) => void
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      collapsed: false,
      mobileOpen: false,
      toggle: () => set((s) => ({ collapsed: !s.collapsed })),
      setCollapsed: (v) => set({ collapsed: v }),
      setMobileOpen: (v) => set({ mobileOpen: v }),
    }),
    { name: 'sidebar-state', partialize: (s) => ({ collapsed: s.collapsed }) },
  ),
)
