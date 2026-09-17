import { api } from './client'

export const deploysApi = {
  list: (podName: string) => api.get(`/pods/${podName}/deploys`),
  create: (podName: string, data: any) => api.post(`/pods/${podName}/deploys`, data),
  delete: (podName: string, id: string) => api.del(`/pods/${podName}/deploys?id=${encodeURIComponent(id)}`),
  run: (podName: string, id: string) => api.post(`/pods/${podName}/deploys/${id}/run`),
  stop: (podName: string, id: string) => api.post(`/pods/${podName}/deploys/${id}/stop`),
  status: (podName: string, id: string) => api.get(`/pods/${podName}/deploys/${id}/status`),
  logs: (podName: string, id: string) => api.get<string>(`/pods/${podName}/deploys/${id}/logs`),
  browse: (podName: string, path = '/') => api.get(`/pods/${podName}/deploys/browse?path=${encodeURIComponent(path)}`),
}
