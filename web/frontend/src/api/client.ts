/** Base API client with CSRF, error handling, and JSON defaults. */

const API_BASE = '/api'

let csrfToken: string | null = null
let csrfPromise: Promise<string> | null = null

/** Fetch CSRF token from meta tag or API. Deduped — concurrent calls share one fetch. */
export async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken
  if (csrfPromise) return csrfPromise

  const pending: Promise<string> = (async () => {
    // Try meta tag first (server-rendered)
    const meta = document.querySelector('meta[name="csrf-token"]')
    if (meta) {
      const val = meta.getAttribute('content')
      if (val) { csrfToken = val; return val }
    }
    // Fetch from API — 404 is expected if backend has no CSRF endpoint
    try {
      const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'same-origin' })
      if (!res.ok) { csrfToken = ''; return '' }
      const data = await res.json()
      const token: string = data.token || ''
      csrfToken = token
      return token
    } catch {
      csrfToken = ''
      return ''
    } finally {
      csrfPromise = null
    }
  })()
  csrfPromise = pending

  return pending
}

export function setCsrfToken(token: string) {
  csrfToken = token
}

/** Custom API error. */
export class ApiError extends Error {
  code: string
  status: number
  details?: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Base fetch wrapper. */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${path}`
  const headers = new Headers(options.headers)

  // JSON content type by default
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  // CSRF for mutating requests
  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
    const token = await getCsrfToken()
    if (token) headers.set('X-CSRF-Token', token)
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
  })

  // No content
  if (res.status === 204) return undefined as T

  // JSON response
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = await res.json()
    if (!res.ok) {
      const err = data.error || data
      if (typeof err === 'string') throw new ApiError('UNKNOWN', err, res.status)
      throw new ApiError(err.code || 'UNKNOWN', err.message || 'Request failed', res.status, err.details)
    }
    return data as T
  }

  // Text response
  if (contentType.includes('text/')) {
    const text = await res.text()
    if (!res.ok) throw new ApiError('UNKNOWN', text, res.status)
    return text as T
  }

  // Other
  if (!res.ok) throw new ApiError('UNKNOWN', `HTTP ${res.status}`, res.status)
  return undefined as T
}

/** Convenience methods. */
export const api = {
  get: <T = unknown>(path: string) => apiFetch<T>(path),

  post: <T = unknown>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    }),

  put: <T = unknown>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    }),

  del: <T = unknown>(path: string) =>
    apiFetch<T>(path, { method: 'DELETE' }),
}
