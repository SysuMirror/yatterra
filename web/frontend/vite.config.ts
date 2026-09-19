import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

const spaOutDir = process.env.SPA_OUT_DIR || '../.spa-staging/manual'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['offline.html', 'fonts/*.ttf', 'icons/*.png'],
      manifest: {
        name: 'YatTerra',
        short_name: 'YatTerra',
        description: '普适性的技术基础设施',
        lang: 'zh-CN',
        dir: 'ltr',
        theme_color: '#0a84ff',
        background_color: '#070b17',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['education', 'productivity', 'utilities'],
        icons: [
          { src: '/icons/icon-48.png', sizes: '48x48', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-72.png', sizes: '72x72', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-96.png', sizes: '96x96', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: '集群概览',
            short_name: '概览',
            description: '查看集群状态与资源概览',
            url: '/',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: '容器管理',
            short_name: 'Pod',
            description: '查看与管理 Pod 容器',
            url: '/pods',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: '终端',
            short_name: '终端',
            description: '打开 Web 终端',
            url: '/pods',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: '攻防演练',
            short_name: '攻防',
            description: '安全攻防演练靶场',
            url: '/threat-map',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,ttf,woff2}'],
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8090', ws: true },
      '/socket.io': { target: 'ws://127.0.0.1:8090', ws: true },
    },
  },
  build: {
    outDir: spaOutDir,
    emptyOutDir: true,
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
    // Disable modulepreload entirely — heavy vendor chunks (charts 495KiB,
    // xterm 332KiB, codemirror 546KiB) should only load on demand via
    // dynamic import, not be eagerly preloaded on every page.
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Core React — loaded on every page
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router/'))
              return 'vendor-react'
            if (id.includes('@tanstack/react-query'))
              return 'vendor-tanstack'
            // Heavy UI — loaded ONLY via dynamic import (React.lazy)
            if (id.includes('recharts'))
              return 'vendor-charts'
            if (id.includes('@xterm/'))
              return 'vendor-xterm'
            if (id.includes('framer-motion'))
              return 'vendor-motion'
            // Icons — large package
            if (id.includes('lucide-react'))
              return 'vendor-lucide'
            // Code editor — only used in files/shared/docs
            if (id.includes('codemirror') || id.includes('@codemirror'))
              return 'vendor-codemirror'
            // Syntax highlight — only used in docs/code
            if (id.includes('highlight.js') || id.includes('/highlight.js/'))
              return 'vendor-highlight'
            // Other node_modules (includes zustand, redux, reselect, immer, clsx, etc.)
            return 'vendor-misc'
          }
        },
      },
    },
  },
})
