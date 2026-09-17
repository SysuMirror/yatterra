import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'

interface TerminalProps {
  podName: string
  wsUrl?: string
  className?: string
}

export interface TerminalHandle {
  terminal: any | null
  fit: () => void
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  ({ podName, wsUrl, className }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)

    useImperativeHandle(ref, () => ({
      terminal: null,
      fit: () => {},
    }))

    useEffect(() => {
      if (!containerRef.current) return

      // Dynamically import xterm to avoid SSR issues
      let term: any = null
      let ws: WebSocket | null = null

      const init = async () => {
        try {
          const { Terminal: XTerminal } = await import('xterm')
          const { FitAddon } = await import('xterm-addon-fit')
          await import('xterm/css/xterm.css')

          term = new XTerminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
            theme: {
              background: '#1d1d1f',
              foreground: '#f5f5f7',
              cursor: '#0a84ff',
              selectionBackground: 'rgba(10,132,255,0.25)',
            },
          })

          const fit = new FitAddon()
          term.loadAddon(fit)
          if (containerRef.current) {
            term.open(containerRef.current)
            fit.fit()
          }

          if (wsUrl) {
            ws = new WebSocket(wsUrl)
            ws.onmessage = (e) => {
              try {
                const data = JSON.parse(e.data)
                if (data.data) term.write(data.data)
              } catch {
                term.write(e.data)
              }
            }
            term.onData((data: string) => {
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data }))
              }
            })
            ws.onclose = () => {
              term.write('\r\n\x1b[90m— 连接断开 —\x1b[0m\r\n')
            }
          }
        } catch (err) {
          console.error('Terminal init failed:', err)
        }
      }

      init()

      return () => {
        ws?.close()
        term?.dispose()
      }
    }, [wsUrl])

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%' }}
      />
    )
  },
)

Terminal.displayName = 'Terminal'
