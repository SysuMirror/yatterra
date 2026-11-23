import { api } from './client'

export interface Pod {
  name: string
  status: string
  phase: string
  cpu: number
  mem: number
  gpus: number
  storage: number
  owner: string
  reason?: string
  created_at: string
  /** placement target: "auto" or a node name from /api/infra/nodes */
  node?: string
  /** 活动/分组标签（元数据）— 管理员可按 tag 批量发额度 */
  tag?: string | null
}

/** 活动资源上限（仅 UniSSO 用户受约束；admin/super 豁免）。 */
export interface PodLimits {
  scoped: boolean
  caps: {
    cpu: number
    mem_gib: number
    storage_gib: number
    gpu_allowed: boolean
    mem: string
    storage: string
  }
}

export interface AppLogFile {
  name: string
  size: number
  mtime: string
  symlink: boolean
  source?: string
}

export interface AppLogContent {
  file: AppLogFile
  content: string
}

export interface PodDetail extends Pod {
  role: string
  password: string
  ssh_public: number
  web_public: number
  env: Record<string, string>
  internal_ports: number[]
  internal_host: string
  credentials: { db: any[]; minio: any[] }
  deploys: any[]
}

export const podsApi = {
  list: (params?: { status?: string; search?: string; page?: number; per_page?: number }) => {
    const sp = new URLSearchParams()
    if (params?.status) sp.set('status', params.status)
    if (params?.search) sp.set('search', params.search)
    if (params?.page) sp.set('page', String(params.page))
    if (params?.per_page) sp.set('per_page', String(params.per_page))
    const qs = sp.toString()
    return api.get<{ pods: Pod[]; total: number; page: number; per_page: number }>(`/pods${qs ? `?${qs}` : ''}`)
  },

  get: (name: string) => api.get<PodDetail>(`/pods/${name}`),

  /** 当前用户的活动资源上限（scoped=false 表示不受限）。 */
  limits: () => api.get<PodLimits>('/pods/limits'),

  create: (data: Partial<Pod>) => api.post<Pod>('/pods', data),

  /** 设置/清空 Pod 标签（owner 可改；空字符串 = 清空）。 */
  setTag: (name: string, tag: string) =>
    api.post<{ ok: boolean; tag: string | null }>(`/pods/${name}/tag`, { tag }),

  delete: (name: string) => api.del(`/pods/${name}`),

  start: (name: string) => api.post<Pod>(`/pods/${name}/start`),
  stop: (name: string) => api.post<Pod>(`/pods/${name}/stop`),
  restart: (name: string) => api.post<Pod>(`/pods/${name}/restart`),

  resize: (name: string, data: { cpu?: number; mem?: number; storage?: number }) =>
    api.post<Pod>(`/pods/${name}/resize`, data),

  resetPassword: (name: string) => api.post<{ password: string }>(`/pods/${name}/reset-pw`),

  join: (name: string, reason: string) => api.post(`/pods/${name}/join`, { reason }),

  metrics: (name: string) => api.get(`/pods/${name}/metrics`),
  metricsHistory: (name: string) => api.get(`/pods/${name}/metrics/history`),
  events: (name: string) => api.get(`/pods/${name}/events`),

  logs: (name: string, tail = 200) => api.get<string>(`/pods/${name}/logs?tail=${tail}`),
  appLogFiles: (name: string) => api.get<{ files: AppLogFile[] }>(`/pods/${encodeURIComponent(name)}/app-logs`),
  appLogContent: (name: string, file: string, tail = 200) => {
    const sp = new URLSearchParams({ file, tail: String(tail) })
    return api.get<string>(`/pods/${encodeURIComponent(name)}/app-logs?${sp}`)
  },

  files: (name: string, path = '/') => api.get(`/pods/${name}/files?path=${encodeURIComponent(path)}`),
  fileContent: (name: string, path: string) => api.get<string>(`/pods/${name}/files/content?path=${encodeURIComponent(path)}`),
  createFile: (name: string, data: { path: string; type: 'file' | 'dir' }) => api.post(`/pods/${name}/files/create`, data),
  deleteFile: (name: string, path: string) => api.del(`/pods/${name}/files?path=${encodeURIComponent(path)}`),
  saveFile: (name: string, data: { path: string; content: string }) => api.put(`/pods/${name}/files/save`, data),

  applyTemplate: (name: string, template: string) => api.post(`/pods/${name}/apply-template`, { template }),
}
