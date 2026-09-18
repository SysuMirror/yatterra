import { useSyncExternalStore } from 'react'

let online = typeof navigator === 'undefined' ? true : navigator.onLine
const listeners = new Set<() => void>()

function emit() {
  online = navigator.onLine
  listeners.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', emit)
  window.addEventListener('offline', emit)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() { return online }

export function isOnline() { return online }

export function useNetworkStatus() {
  return useSyncExternalStore(subscribe, getSnapshot, () => true)
}
