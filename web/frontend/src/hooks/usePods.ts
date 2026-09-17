import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'

export interface Pod {
  name: string
  status: string
  cpu: number
  mem: number
  gpus: number
  storage: number
  owner: string
  phase: string
  created_at: string
}

export interface PodListResult {
  items: Pod[]
  total: number
  page: number
  per_page: number
}

export function usePods(params?: { status?: string; search?: string; page?: number; per_page?: number }) {
  return useQuery<PodListResult>({
    queryKey: ['pods', params],
    queryFn: () => {
      const searchParams = new URLSearchParams()
      if (params?.status) searchParams.set('status', params.status)
      if (params?.search) searchParams.set('search', params.search)
      if (params?.page) searchParams.set('page', String(params.page))
      if (params?.per_page) searchParams.set('per_page', String(params.per_page))
      const qs = searchParams.toString()
      return api.get(`/pods${qs ? `?${qs}` : ''}`)
    },
    staleTime: 10_000,
  })
}

export function usePod(name: string) {
  return useQuery<Pod>({
    queryKey: ['pod', name],
    queryFn: () => api.get(`/pods/${name}`),
    enabled: !!name,
  })
}

export function usePodActions() {
  const qc = useQueryClient()

  const create = useMutation({
    mutationFn: (data: Partial<Pod>) => api.post('/pods', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pods'] }),
  })

  const remove = useMutation({
    mutationFn: (name: string) => api.del(`/pods/${name}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pods'] }),
  })

  const start = useMutation({
    mutationFn: (name: string) => api.post(`/pods/${name}/start`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pods'] }),
  })

  const stop = useMutation({
    mutationFn: (name: string) => api.post(`/pods/${name}/stop`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pods'] }),
  })

  const restart = useMutation({
    mutationFn: (name: string) => api.post(`/pods/${name}/restart`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pods'] }),
  })

  return { create, remove, start, stop, restart }
}
