/**
 * Site configuration — deployment-specific values, overridable at build time.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, so these are baked into
 * the bundle. Set them in `web/frontend/.env` (or the shell) before
 * `npm run build:stage`. Defaults match the reference deployment.
 */

const env = import.meta.env

/** Public relay parent domain, e.g. "ssemarket.cn". */
export const DOMAIN: string = env.VITE_DOMAIN || 'ssemarket.cn'

/** Public host for SSH / web entry (usually the same as DOMAIN). */
export const PUBLIC_HOST: string = env.VITE_PUBLIC_HOST || DOMAIN

/** Scheme for public URLs. */
export const PUBLIC_SCHEME: string = env.VITE_PUBLIC_SCHEME || 'https'

/** Build a public URL for a relay port. */
export function publicUrl(port?: number | string | null): string {
  const base = `${PUBLIC_SCHEME}://${PUBLIC_HOST}`
  return port ? `${base}:${port}` : base
}

/** Build a subdomain URL, e.g. sub("app") → "https://app.ssemarket.cn". */
export function subdomainUrl(sub: string): string {
  return `${PUBLIC_SCHEME}://${sub}.${DOMAIN}`
}
