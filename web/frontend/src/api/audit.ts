import { api } from './client'

export const auditApi = {
  list: (params?: { action?: string; actor?: string; since?: string; page?: number; per_page?: number }) => {
    const sp = new URLSearchParams()
    if (params?.action) sp.set('action', params.action)
    if (params?.actor) sp.set('actor', params.actor)
    if (params?.since) sp.set('since', params.since)
    if (params?.page) sp.set('page', String(params.page))
    if (params?.per_page) sp.set('per_page', String(params.per_page))
    const qs = sp.toString()
    return api.get(`/audit${qs ? `?${qs}` : ''}`)
  },
}

export const sharedApi = {
  list: (path = '/') => api.get(`/shared?path=${encodeURIComponent(path)}`),
  mkdir: (path: string, name: string) => api.post('/shared/mkdir', { path, name }),
  upload: (formData: FormData) =>
    fetch('/api/shared/upload', { method: 'POST', body: formData, credentials: 'same-origin' }).then((r) => r.json()),
  delete: (path: string) => api.del(`/shared?path=${encodeURIComponent(path)}`),
}

export const llmApi = {
  providers: () => api.get('/llm/providers'),
  updateProvider: (id: string, data: any) => api.put(`/llm/providers/${id}`, data),
  usage: () => api.get('/llm/usage'),
}

export const threatMapApi = {
  get: () => api.get('/threat-map'),
}
