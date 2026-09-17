import { api } from './client'

export const agentsApi = {
  list: () => api.get('/agents'),
  get: (id: string) => api.get(`/agents/${id}`),
  update: (id: string, data: any) => api.put(`/agents/${id}`, data),
  run: (data: { mode: string; message: string; session_id?: string }) => api.post<{ run_id: string }>('/agents/run', data),
  stop: (runId: string) => api.post('/agents/stop', { run_id: runId }),

  // Sessions
  sessions: (mode?: string) => api.get(`/agents/sessions${mode ? `?mode=${mode}` : ''}`),
  newSession: (mode: string) => api.post<{ session_id: string }>('/agents/session/new', { mode }),
  loadSession: (id: string) => api.get(`/agents/session/load?id=${id}`),
  deleteSession: (id: string) => api.post('/agents/session/delete', { id }),

  pods: () => api.get('/agents/pods'),
}

export const harnessesApi = {
  list: () => api.get('/harnesses'),
  get: (name: string) => api.get(`/harnesses/${name}`),
  create: (data: any) => api.post('/harnesses', data),
  update: (name: string, data: any) => api.put(`/harnesses/${name}`, data),
  delete: (name: string) => api.del(`/harnesses/${name}`),
  run: (name: string) => api.post(`/harnesses/${name}/run`),
}
