// Chart palette + theme helpers — the single source of truth for every chart
// colour on the dashboard. Nothing else should hard-code hex values.
//
// The categorical palette was validated with the dataviz validator against this
// dashboard's own surfaces (light card #ffffff, dark card #18222f): every check
// passes, with a light-mode contrast WARN on three slots that the always-present
// legend table satisfies (the "relief" rule — identity is never carried by color
// alone; each slice also has a labeled row).
//
// Assign in fixed order and never cycle: a series past the last slot folds
// into the neutral "其他 / 未归属" bucket instead of reusing a hue.
export const PIE_COLORS_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
]

export const PIE_COLORS_DARK = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
]

// Neutral gray for the "其他 / 未归属" bucket — deliberately not a series hue,
// so it never reads as one of the pods.
export const OTHER_COLOR_LIGHT = '#c3c2b7'
export const OTHER_COLOR_DARK = '#4b5563'

export function piePalette(dark: boolean): string[] {
  return dark ? PIE_COLORS_DARK : PIE_COLORS_LIGHT
}

export function otherColor(dark: boolean): string {
  return dark ? OTHER_COLOR_DARK : OTHER_COLOR_LIGHT
}

// ── Ordered palette for line / area charts ──
// Identity is by *role*, not rank: slot 0 is always the "usage" measure
// (利用率 / 占用), slot 1 the "capacity" measure (显存 / 容量). Using the same
// ordered hues as the donut palette keeps a metric one colour across every page.
// `i` is a fixed per-chart role, never a rank — keep it < palette length.
export function seriesColor(dark: boolean, i = 0): string {
  const p = piePalette(dark)
  return p[i] ?? p[0]!
}

// ── Theme-aware recharts chrome ──
// One definition, imported everywhere, so tooltips and axes stop being
// light-only on some charts and dark-aware on others.
export function chartTooltip(dark: boolean) {
  return {
    contentStyle: {
      borderRadius: 10,
      border: dark ? '0.5px solid rgba(255,255,255,0.12)' : '0.5px solid rgba(0,0,0,0.1)',
      fontSize: 12,
      background: dark ? 'rgba(28,28,30,0.95)' : 'rgba(255,255,255,0.95)',
      color: dark ? '#f5f5f7' : undefined,
    },
    labelStyle: { color: dark ? '#98989d' : '#86868b', fontSize: 11 },
  }
}

export function axisTick(dark: boolean): string {
  return dark ? '#98989d' : '#86868b'
}

export function gridStroke(dark: boolean): string {
  return dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'
}
