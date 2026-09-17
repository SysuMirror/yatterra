import { api } from './client'

export const mcpApi = {
  list: () => api.get('/mcp'),
  create: (data: any) => api.post('/mcp', data),
  update: (id: string, data: any) => api.put(`/mcp/${id}`, data),
  delete: (id: string) => api.del(`/mcp/${id}`),
  toggle: (id: string) => api.post(`/mcp/${id}/toggle`),
}
