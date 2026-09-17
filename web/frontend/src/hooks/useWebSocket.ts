import { useEffect, useRef, useCallback, useState } from 'react'

interface UseWebSocketOptions {
  onMessage?: (data: any) => void
  onOpen?: () => void
  onClose?: () => void
  onError?: (e: Event) => void
  reconnect?: boolean
  maxRetries?: number
}

/**
 * Hook for WebSocket connections with auto-reconnect.
 */
export function useWebSocket(url: string | null, options: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(0)
  const [readyState, setReadyState] = useState<WebSocket['readyState']>(WebSocket.CLOSED)

  const connect = useCallback(() => {
    if (!url) return

    const ws = new WebSocket(url)
    wsRef.current = ws
    setReadyState(ws.readyState)

    ws.onopen = () => {
      retryRef.current = 0
      setReadyState(WebSocket.OPEN)
      options.onOpen?.()
    }

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        options.onMessage?.(data)
      } catch {
        options.onMessage?.(e.data)
      }
    }

    ws.onclose = () => {
      setReadyState(WebSocket.CLOSED)
      options.onClose?.()
      if (options.reconnect && retryRef.current < (options.maxRetries ?? 10)) {
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000)
        retryRef.current++
        setTimeout(connect, delay)
      }
    }

    ws.onerror = (e) => {
      setReadyState(ws.readyState)
      options.onError?.(e)
    }
  }, [url, options])

  useEffect(() => {
    connect()
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [connect])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }, [])

  const close = useCallback(() => {
    retryRef.current = Infinity // Prevent reconnect
    wsRef.current?.close()
  }, [])

  return { send, close, readyState, isConnected: readyState === WebSocket.OPEN }
}
