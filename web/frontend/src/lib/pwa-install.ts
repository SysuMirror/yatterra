import { useCallback, useEffect, useState } from 'react'

type InstallOutcome = 'accepted' | 'dismissed'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: InstallOutcome }>
}

type PwaState = {
  deferredPrompt: BeforeInstallPromptEvent | null
  installed: boolean
}

const listeners = new Set<() => void>()
const state: PwaState = {
  deferredPrompt: null,
  installed: false,
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

function emit(): void {
  listeners.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  state.installed = isStandalone()
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    state.deferredPrompt = event as BeforeInstallPromptEvent
    emit()
  })
  window.addEventListener('appinstalled', () => {
    state.deferredPrompt = null
    state.installed = true
    emit()
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePwaInstall() {
  const [, setVersion] = useState(0)

  useEffect(() => subscribe(() => setVersion((version) => version + 1)), [])

  const promptInstall = useCallback(async (): Promise<InstallOutcome | null> => {
    const prompt = state.deferredPrompt
    if (!prompt) return null
    state.deferredPrompt = null
    emit()
    await prompt.prompt()
    const choice = await prompt.userChoice
    emit()
    return choice.outcome
  }, [])

  return {
    canInstall: state.deferredPrompt !== null,
    isInstalled: state.installed || (typeof window !== 'undefined' && isStandalone()),
    isIos: typeof navigator !== 'undefined' && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)),
    promptInstall,
  }
}
