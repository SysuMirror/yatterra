import { api } from './client'

export interface PushEvent {
  event_key: string
  kind: string
  group: string
  title: string
  body: string
  url: string
  ts: number
  read: boolean
}

export interface PushEventsResponse {
  events: PushEvent[]
  total: number
  unread: number
  limit: number
  offset: number
}

export const pushApi = {
  events: (params: { limit?: number; offset?: number; unread_only?: boolean; kind?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.unread_only) q.set('unread_only', '1')
    if (params.kind) q.set('kind', params.kind)
    return api.get<PushEventsResponse>(`/push/events${q.toString() ? `?${q}` : ''}`)
  },
  markRead: (keys: string[]) => api.post<{ ok: boolean; updated: number }>('/push/events/read', { keys }),
  markAllRead: () => api.post<{ ok: boolean; updated: number }>('/push/events/read', { all: true }),
}
