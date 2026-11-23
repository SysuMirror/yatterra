/** Fleet history → one card's charts. Host-agnostic: pass that host's samples. */

export interface AcceleratorPoint {
  index?: number | null
  id?: string | null
  utilization_pct?: number | null
  memory_used_bytes?: number | null
  memory_total_bytes?: number | null
}

export interface AcceleratorSeriesInput {
  index: number | null
  id?: string | null
  /** Null means no known ceiling: do not plot a memory series. */
  memTotalBytes: number | null
  /**
   * `device` reads nvidia-smi bytes, then process MiB when those bytes are absent.
   * `host` reads /proc/meminfo used bytes. Unified cards use this because the
   * device query reports N/A for the shared pool.
   */
  memSource?: 'device' | 'host'
}

export interface AcceleratorSeries {
  util: number[]
  /** Null when this card has no discrete memory total. Never a run of invented zeros. */
  mem: number[] | null
}

export interface PodUse {
  name: string
  mem: number
  util: number
}

export interface PodReport {
  hostId: string
  index: number | null
  pods?: PodUse[] | null
  groups?: string[] | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sampleGpus(sample: any): AcceleratorPoint[] {
  if (Array.isArray(sample?.data?.gpus)) return sample.data.gpus
  if (Array.isArray(sample?.gpus)) return sample.gpus
  return []
}

function sameCard(gpu: AcceleratorPoint, card: AcceleratorSeriesInput): boolean {
  if (card.id != null && card.id !== '' && gpu?.id != null && String(gpu.id) === String(card.id)) return true
  if (card.index != null && gpu?.index != null && Number(gpu.index) === Number(card.index)) return true
  return false
}

function podMemBytes(gpu: AcceleratorPoint): number | null {
  const pods = (gpu as { pods?: { mem?: unknown }[] | null }).pods
  if (!Array.isArray(pods)) return null
  let sum = 0
  let seen = false
  for (const pod of pods) {
    const mem = finite(pod?.mem)
    if (mem == null) continue
    seen = true
    sum += mem
  }
  return seen ? sum * 1024 * 1024 : null
}

export function acceleratorSeries(samples: readonly any[] | null | undefined, card: AcceleratorSeriesInput): AcceleratorSeries {
  const util: number[] = []
  const mem: number[] = []
  for (const sample of samples ?? []) {
    const gpu = sampleGpus(sample).find((item) => sameCard(item, card))
    if (!gpu) continue
    const usedUtil = finite(gpu.utilization_pct)
    if (usedUtil != null) util.push(usedUtil)
    // No ceiling: do not invent a series of zeros.
    if (card.memTotalBytes == null) continue
    if (card.memSource === 'host') {
      const hostUsed = finite(sample?.data?.memory?.used_bytes)
      if (hostUsed == null) continue
      mem.push(hostUsed / 1024 / 1024)
      continue
    }
    const total = finite(gpu.memory_total_bytes) ?? finite(card.memTotalBytes)
    // Discrete cards report bytes. If the device leaves used blank, process MiB is the fallback.
    const used = finite(gpu.memory_used_bytes) ?? podMemBytes(gpu)
    if (total == null || used == null) continue
    mem.push(used / 1024 / 1024)
  }
  return { util, mem: card.memTotalBytes == null ? null : mem }
}

function positiveMem(report: PodReport): number {
  if (!Array.isArray(report.pods)) return 0
  return report.pods.reduce((sum, pod) => sum + (typeof pod?.mem === 'number' && pod.mem > 0 ? pod.mem : 0), 0)
}

function groupNames(report: PodReport | undefined): string[] | undefined {
  return Array.isArray(report?.groups) ? report.groups : undefined
}

/** Shorten a Kubernetes pod name with this card's assigned groups, then the replica suffix. */
export function podLabel(name: string, groups?: readonly string[] | null): string {
  const raw = String(name || '')
  const body = raw.startsWith('group-') ? raw.slice('group-'.length) : raw
  const known = [...(groups ?? [])].filter((group) => group).sort((a, b) => b.length - a.length)
  for (const group of known) {
    if (body === group || body.startsWith(`${group}-`)) return group
  }
  return body.replace(/-[a-z0-9]{6,12}-[a-z0-9]{5}$/i, '') || raw
}

function labeledPods(pods: PodUse[], groups?: readonly string[] | null): PodUse[] {
  const merged = new Map<string, PodUse>()
  for (const pod of pods) {
    const name = podLabel(pod.name, groups)
    const prev = merged.get(name)
    if (!prev) {
      merged.set(name, { ...pod, name })
      continue
    }
    prev.mem += typeof pod.mem === 'number' ? pod.mem : 0
    if (typeof pod.util === 'number') prev.util = (typeof prev.util === 'number' ? prev.util : 0) + pod.util
  }
  return [...merged.values()]
}

/**
 * Pod breakdown for this host and index only.
 * Assignment badges and live VRAM come from different reports: a groups list
 * with empty pods must not hide a report that already has process memory.
 */
export function attributionForCard(card: { hostId: string; index: number | null }, reports: readonly PodReport[] | null | undefined): { pods?: PodUse[]; groups?: string[] } {
  const hits = (reports ?? []).filter((report) => report.hostId === card.hostId && report.index != null && card.index != null && Number(report.index) === Number(card.index))
  if (!hits.length) return {}
  const withMem = hits.filter((report) => positiveMem(report) > 0)
  withMem.sort((a, b) => {
    const grouped = (groupNames(b) ? 1 : 0) - (groupNames(a) ? 1 : 0)
    return grouped || positiveMem(b) - positiveMem(a)
  })
  const memHit = withMem[0]
  const groups = groupNames(hits.find((report) => groupNames(report)?.length)) ?? groupNames(memHit)
  const pods = Array.isArray(memHit?.pods) ? labeledPods(memHit.pods, groups) : undefined
  return { pods, groups }
}
