// Categorical palette for pie / donut charts.
//
// Validated with the dataviz validator against this dashboard's own surfaces
// (light card #ffffff, dark card #18222f): every check passes, with a
// light-mode contrast WARN on three slots that the always-present legend
// table satisfies (the "relief" rule — identity is never carried by color
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
