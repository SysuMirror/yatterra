/** Base API client with CSRF, bounded fetches, and JSON defaults. */

const API_BASE = '/api'
const DEFAULT_TIMEOUT_MS = 20_000

let csrfToken: string | null = null
let csrfPromise: Promise<string> | null = null

/** Fetch CSRF token from meta tag or API. Deduped — concurrent calls share one fetch. */
export async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken
  if (csrfPromise) return csrfPromise

  const pending: Promise<string> = (async () => {
    const meta = document.querySelector('meta[name="csrf-token"]')
    if (meta) {
      const val = meta.getAttribute('content')
      if (val) { csrfToken = val; return val }
    }
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

export function setCsrfToken(token: string) { csrfToken = token }

export class ApiError extends Error {
  code: string
  status: number
  details?: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

type ApiRequestInit = RequestInit & { timeoutMs?: number }

/** Base fetch wrapper. Mutations are never cached or retried here. */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${path}`
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
    const token = await getCsrfToken()
    if (token) headers.set('X-CSRF-Token', token)
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOut = false
  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = timeoutMs > 0 ? window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs) : undefined

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
      credentials: 'same-origin',
    })

    if (res.status === 204) return undefined as T
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
    if (contentType.includes('text/')) {
      const text = await res.text()
      if (!res.ok) throw new ApiError('UNKNOWN', text, res.status)
      return text as T
    }
    if (!res.ok) throw new ApiError('UNKNOWN', `HTTP ${res.status}`, res.status)
    return undefined as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (timedOut) throw new ApiError('TIMEOUT', '请求超时，请检查网络后重试', 0)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('ABORTED', '请求已取消', 0)
    }
    throw new ApiError('NETWORK', '无法连接服务器，请检查网络连接', 0, error)
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export const api = {
  get: <T = unknown>(path: string, options?: ApiRequestInit) => apiFetch<T>(path, options),
  post: <T = unknown>(path: string, body?: unknown, options?: ApiRequestInit) =>
    apiFetch<T>(path, { ...options, method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', ...options?.headers } }),
  put: <T = unknown>(path: string, body?: unknown, options?: ApiRequestInit) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', ...options?.headers } }),
  del: <T = unknown>(path: string, options?: ApiRequestInit) => apiFetch<T>(path, { ...options, method: 'DELETE' }),
}
