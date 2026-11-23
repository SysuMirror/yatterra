/** Where a dynamic console route should send a lost user. */
export function recoveryPath(path: string, staticPaths: readonly string[]): string {
  if (!path.includes(':')) return path
  const known = new Set(staticPaths)
  const stripped = path.replace(/\/:[^/]+/g, '') || '/'
  if (known.has(stripped)) return stripped
  const tail = stripped.split('/').filter(Boolean).pop()
  if (tail && known.has(`/${tail}`)) return `/${tail}`
  let cursor = stripped
  while (cursor.lastIndexOf('/') > 0) {
    cursor = cursor.slice(0, cursor.lastIndexOf('/'))
    if (known.has(cursor)) return cursor
  }
  return '/console'
}
