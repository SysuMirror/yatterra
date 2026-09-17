// PWA auto-update: reload once when a new service worker takes control
let __swReloaded = false
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (__swReloaded) return
  __swReloaded = true
  location.reload()
})

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ToastContainer } from '@/components/ui/Toast'
import { SWUpdateNotifier } from '@/components/ui/SWUpdateNotifier'
import './styles/globals.css'
import './styles/animations.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,       // 10s — data is fresh for 10s before refetch
      gcTime: 300_000,         // 5min — keep unused data in cache for 5min
      retry: 1,                // only retry once (not 3x)
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ToastContainer />
        <SWUpdateNotifier />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
