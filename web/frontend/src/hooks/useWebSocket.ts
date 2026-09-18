import { useEffect, useRef, useCallback, useState } from 'react'

interface UseWebSocketOptions {
  onMessage?: (data: any) => void; onOpen?: () => void; onClose?: () => void; onError?: (e: Event) => void
  reconnect?: boolean; maxRetries?: number; pauseWhenHidden?: boolean
}

export function useWebSocket(url: string | null, options: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryRef = useRef(0)
  const optionsRef = useRef(options); optionsRef.current = options
  const stoppedRef = useRef(false)
  const [readyState, setReadyState] = useState<WebSocket['readyState']>(WebSocket.CLOSED)

  const connect = useCallback(() => {
    const opts = optionsRef.current
    if (!url || stoppedRef.current || !navigator.onLine || (opts.pauseWhenHidden !== false && document.visibilityState !== 'visible') || wsRef.current) return
    const ws = new WebSocket(url); wsRef.current = ws; setReadyState(ws.readyState)
    ws.onopen = () => { retryRef.current = 0; setReadyState(WebSocket.OPEN); optionsRef.current.onOpen?.() }
    ws.onmessage = (e) => { try { optionsRef.current.onMessage?.(JSON.parse(e.data)) } catch { optionsRef.current.onMessage?.(e.data) } }
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null
      setReadyState(WebSocket.CLOSED); optionsRef.current.onClose?.()
      const current = optionsRef.current
      if (!stoppedRef.current && current.reconnect && navigator.onLine && (current.pauseWhenHidden === false || document.visibilityState === 'visible') && retryRef.current < (current.maxRetries ?? 10)) {
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000) + Math.round(Math.random() * 250); retryRef.current++
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { timerRef.current = null; connect() }, delay)
      }
    }
    ws.onerror = (e) => { setReadyState(ws.readyState); optionsRef.current.onError?.(e) }
  }, [url])

  useEffect(() => {
    stoppedRef.current = false
    const pause = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }; wsRef.current?.close(); wsRef.current = null; setReadyState(WebSocket.CLOSED) }
    const resume = () => { const o = optionsRef.current; if (navigator.onLine && (o.pauseWhenHidden === false || document.visibilityState === 'visible')) connect() }
    const onVisibility = () => document.visibilityState === 'visible' ? resume() : (optionsRef.current.pauseWhenHidden !== false ? pause() : undefined)
    window.addEventListener('offline', pause); window.addEventListener('online', resume); document.addEventListener('visibilitychange', onVisibility); connect()
    return () => { stoppedRef.current = true; window.removeEventListener('offline', pause); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', onVisibility); pause() }
  }, [connect])

  const send = useCallback((data: unknown) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data)) }, [])
  const close = useCallback(() => { stoppedRef.current = true; retryRef.current = Infinity; if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }; wsRef.current?.close(); wsRef.current = null }, [])
  return { send, close, readyState, isConnected: readyState === WebSocket.OPEN }
}
