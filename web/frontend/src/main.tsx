// PWA auto-update: reload once when a user-approved new service worker takes control.
// 首次安装 SW 时 controller 从 null 变为有值也会触发 controllerchange,
// 用启动时是否已被控制区分,避免首次访问白刷一次。
const __hadController = !!navigator.serviceWorker?.controller
let __swReloaded = false
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (__swReloaded || !__hadController) return
  __swReloaded = true
  location.reload()
})

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import App from './App'
import { ToastContainer } from '@/components/ui/Toast'
import { NetworkStatusBanner } from '@/components/ui/NetworkStatusBanner'
import { SWUpdateNotifier } from '@/components/ui/SWUpdateNotifier'
import { initTheme } from '@/stores/theme'
import { initEditorPrefs } from '@/stores/editorPrefs'
import '@/lib/pwa-install'
import './styles/globals.css'
import './styles/animations.css'

initTheme()
initEditorPrefs()

onlineManager.setEventListener((setOnline) => {
  const onOnline = () => setOnline(true)
  const onOffline = () => setOnline(false)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 300_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      networkMode: 'online',
    },
    mutations: { networkMode: 'online' },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <NetworkStatusBanner />
        <ToastContainer />
        <SWUpdateNotifier />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
