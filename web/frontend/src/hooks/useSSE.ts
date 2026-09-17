import { useEffect, useRef, useCallback } from 'react'

/**
 * Hook for Server-Sent Events (EventSource).
 * Automatically reconnects on error with exponential backoff.
 */
export function useSSE(
  url: string | null,
  handlers: {
    onMessage?: (data: string) => void
    onError?: (e: Event) => void
    onOpen?: () => void
  },
  options?: { withCredentials?: boolean },
) {
  const esRef = useRef<EventSource | null>(null)
  const retryRef = useRef(0)

  const connect = useCallback(() => {
    if (!url) return
    const es = new EventSource(url, { withCredentials: options?.withCredentials ?? true })
    esRef.current = es

    es.onopen = () => {
      retryRef.current = 0
      handlers.onOpen?.()
    }

    es.onmessage = (e) => {
      handlers.onMessage?.(e.data)
    }

    es.onerror = (e) => {
      handlers.onError?.(e)
      es.close()
      // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
      const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000)
      retryRef.current++
      setTimeout(connect, delay)
    }
  }, [url, handlers, options])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [connect])

  const disconnect = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  return { disconnect }
}
