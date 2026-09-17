/// <reference types="vite/client" />

// SPA diagnostic global
interface Window {
  __SPA_DIAG?: string[]
}

// CSS module declarations
declare module '*.css' {
  const content: string
  export default content
}

// xterm module declarations
declare module 'xterm/css/xterm.css' {
  const content: string
  export default content
}

declare module 'xterm-addon-fit' {
  import { ITerminalAddon } from 'xterm'
  export class FitAddon implements ITerminalAddon {
    fit(): void
    dispose(): void
    activate(terminal: any): void
  }
}
