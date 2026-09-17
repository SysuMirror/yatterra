import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

export interface Metrics {
  cpu_percent: number
  mem_percent: number
  mem_used: number
  mem_total: number
  phase: string
  gpus: { index: number; util: number; mem_used: number; mem_total: number; temp: number }[]
}

export function useMetrics(podName: string, interval = 5000) {
  return useQuery<Metrics>({
    queryKey: ['metrics', podName],
    queryFn: () => api.get(`/pods/${podName}/metrics`),
    enabled: !!podName,
    refetchInterval: interval,
    staleTime: interval,
  })
}

export interface HostMetrics {
  cpu_percent: number
  mem_percent: number
  mem_used: number
  mem_total: number
  gpu_count: number
  gpu_util: number
}

export function useHostMetrics(interval = 10000) {
  return useQuery<HostMetrics>({
    queryKey: ['host-metrics'],
    queryFn: () => api.get('/infra/host'),
    refetchInterval: interval,
    staleTime: interval,
  })
}
