import { useEffect, useRef, useCallback } from 'react'

export function useSSE(
  url: string | null,
  handlers: {
    onMessage?: (data: string) => void
    onError?: (e: Event) => void
    onOpen?: () => void
  },
  options?: { withCredentials?: boolean; pauseWhenHidden?: boolean },
) {
  const esRef = useRef<EventSource | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryRef = useRef(0)
  const handlersRef = useRef(handlers)
  const optionsRef = useRef(options)
  const stoppedRef = useRef(false)
  handlersRef.current = handlers
  optionsRef.current = options

  const connect = useCallback(() => {
    if (!url || stoppedRef.current || !navigator.onLine) return
    if (optionsRef.current?.pauseWhenHidden !== false && document.visibilityState !== 'visible') return
    if (esRef.current) return
    const es = new EventSource(url, { withCredentials: optionsRef.current?.withCredentials ?? true })
    esRef.current = es
    es.onopen = () => { retryRef.current = 0; handlersRef.current.onOpen?.() }
    es.onmessage = (e) => { handlersRef.current.onMessage?.(e.data) }
    es.onerror = (e) => {
      handlersRef.current.onError?.(e)
      es.close()
      if (esRef.current === es) esRef.current = null
      if (stoppedRef.current || !navigator.onLine) return
      const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000) + Math.round(Math.random() * 250)
      retryRef.current++
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = setTimeout(() => { retryTimerRef.current = null; connect() }, delay)
    }
  }, [url])

  useEffect(() => {
    stoppedRef.current = false
    const pause = () => {
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
      esRef.current?.close(); esRef.current = null
    }
    const resume = () => { if (navigator.onLine && (optionsRef.current?.pauseWhenHidden === false || document.visibilityState === 'visible')) connect() }
    const onVisibility = () => document.visibilityState === 'visible' ? resume() : (optionsRef.current?.pauseWhenHidden !== false ? pause() : undefined)
    window.addEventListener('offline', pause)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', onVisibility)
    connect()
    return () => {
      stoppedRef.current = true
      window.removeEventListener('offline', pause); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', onVisibility)
      pause()
    }
  }, [connect])

  const disconnect = useCallback(() => {
    stoppedRef.current = true
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
    esRef.current?.close(); esRef.current = null
  }, [])
  return { disconnect }
}
