import { api } from './client'

export type BillingRange = '24h' | '7d' | '30d'
export type BillingBucket = 'hour' | 'day'

/** One bucketed row — stored second-integrals plus derived core/card-hours. */
export interface UsageBucket {
  bucket_start: number
  n_samples: number
  cpu_core_seconds: number
  cpu_req_core_seconds: number
  mem_gib_seconds: number
  gpu_mem_gib_seconds: number
  gpu_compute_card_seconds: number
  core_hours: number
  request_core_hours: number
  gpu_mem_gib_hours: number
  compute_card_hours: number
  cpu_utilization: number | null
}

export interface UsageTotals {
  core_hours: number
  request_core_hours: number
  gap_core_hours: number
  gpu_mem_gib_hours: number
  compute_card_hours: number
  cpu_utilization: number | null
}

export interface PodUsage {
  group: string
  range: BillingRange
  bucket: BillingBucket
  since: number
  until: number
  partial: boolean
  series: UsageBucket[]
  totals: UsageTotals
}

export interface GroupUsage extends UsageBucket {
  group_name: string
  gap_core_hours: number
}

export interface PlatformSummary {
  range: BillingRange
  bucket: BillingBucket
  since: number
  until: number
  series: UsageBucket[]
  per_group: GroupUsage[]
  totals: UsageTotals
}

function qs(range: BillingRange, bucket: BillingBucket) {
  return `?range=${range}&bucket=${bucket}`
}

export const billingApi = {
  pod: (name: string, range: BillingRange = '7d', bucket: BillingBucket = 'hour'): Promise<PodUsage> =>
    api.get(`/billing/pods/${encodeURIComponent(name)}${qs(range, bucket)}`),
  summary: (range: BillingRange = '7d', bucket: BillingBucket = 'day'): Promise<PlatformSummary> =>
    api.get(`/billing/summary${qs(range, bucket)}`),
}
