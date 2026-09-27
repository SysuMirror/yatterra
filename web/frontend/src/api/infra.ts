import { api } from './client'

export const infraApi = {
  host: () => api.get('/infra/host'),
  remoteHosts: () => api.get('/infra/remote-hosts'),
  metrics: () => api.get('/infra/metrics'),

  // Storage
  storage: () => api.get('/infra/storage'),
  storageEnsure: () => api.post('/infra/storage/ensure'),
  storageBuckets: {
    create: (name: string) => api.post('/infra/storage/buckets', { name }),
    delete: (name: string) => api.del(`/infra/storage/buckets/${name}`),
    objects: (name: string, prefix = '', recursive = false) =>
      api.get(`/infra/storage/buckets/${encodeURIComponent(name)}/objects?prefix=${encodeURIComponent(prefix)}${recursive ? '&recursive=1' : ''}`),
    deleteObject: (name: string, key: string) =>
      api.del(`/infra/storage/buckets/${encodeURIComponent(name)}/object?key=${encodeURIComponent(key)}`),
    objectUrl: (name: string, key: string, download = false) =>
      `/api/infra/storage/buckets/${encodeURIComponent(name)}/object?key=${encodeURIComponent(key)}${download ? '&download=1' : ''}`,
  },
  storageKeys: {
    create: (data: { bucket: string; perm: string }) => api.post('/infra/storage/keys', data),
    delete: (id: string) => api.del(`/infra/storage/keys/${id}`),
  },

  // Databases
  databases: () => api.get('/infra/databases'),
  databasesEnsure: () => api.post('/infra/databases/ensure'),
  dbCreds: {
    create: (data: { group: string; service: string }) => api.post('/infra/databases/creds', data),
    delete: (id: string) => api.del(`/infra/databases/creds/${id}`),
  },

  // Proxy
  proxy: () => api.get('/infra/proxy'),
  proxyCreate: (data: { subdomain: string; port: number; note?: string }) => api.post('/infra/proxy', data),
  proxyUpdate: (id: string, data: { enabled?: boolean }) => api.put(`/infra/proxy/${id}`, data),
  proxyDelete: (id: string) => api.del(`/infra/proxy/${id}`),
}
