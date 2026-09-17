import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#1d1d1f', 2: '#424245' },
        muted: '#86868b',
        accent: {
          DEFAULT: '#0a84ff',
          dark: '#0071e3',
          light: 'rgba(10,132,255,.10)',
        },
        ok: { DEFAULT: '#30d158', bg: 'rgba(48,209,88,.10)' },
        warn: { DEFAULT: '#ff9f0a', bg: 'rgba(255,159,10,.10)' },
        bad: { DEFAULT: '#ff453a', bg: 'rgba(255,69,58,.10)' },
        surface: {
          0: '#ffffff',
          1: 'rgba(255,255,255,.78)',
          2: 'rgba(255,255,255,.55)',
          3: 'rgba(255,255,255,.35)',
          4: 'rgba(24,24,26,.78)',
        },
      },
      borderRadius: {
        xs: '6px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
      },
      boxShadow: {
        1: '0 1px 2px rgba(0,0,0,.04)',
        2: '0 4px 12px rgba(0,0,0,.08)',
        3: '0 12px 40px rgba(0,0,0,.12)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.32, 0.72, 0, 1)',
        bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        decel: 'cubic-bezier(0, 0, 0.2, 1)',
        accel: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      fontSize: {
        '3xl': ['28px', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
        '2xl': ['24px', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        xl: ['20px', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        lg: ['17px', { lineHeight: '1.3' }],
        base: ['15px', { lineHeight: '1.5' }],
        sm: ['13px', { lineHeight: '1.5' }],
        xs: ['11px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
      },
      fontFamily: {
        sans: ['"SF Pro Display"', '"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"SF Mono"', '"Menlo"', '"Consolas"', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
