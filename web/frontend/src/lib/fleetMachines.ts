export interface FleetCard {
  cardKey: string
  hostId: string
  hostName: string
  arch: string | null
  cpuModel: string | null
  product: string | null
  unified: boolean
  empty: boolean
  status?: string
  index: number | null
  name: string
  util: number | null
  memUsedMiB: number | null
  memTotalMiB: number | null
  temp: number | null
  power: number | null
  powerLimit: number | null
  driver: string | null
}

export function archLabel(arch?: string | null): string {
  if (!arch) return '架构未知'
  const key = arch.toLowerCase()
  if (key === 'x86_64' || key === 'amd64') return 'amd64'
  if (key === 'aarch64' || key === 'arm64') return 'arm64'
  return arch
}

/** One row per accelerator. Hosts with no GPU stay as a single empty row. */
export function fleetCards(hosts: any[]): FleetCard[] {
  const cards: FleetCard[] = []
  for (const host of hosts ?? []) {
    const hardware = host?.hardware ?? {}
    const gpus = Array.isArray(host?.data?.gpus) ? host.data.gpus : []
    const base = {
      hostId: String(host?.id ?? ''),
      hostName: String(host?.name || host?.id || ''),
      arch: hardware.arch ?? null,
      cpuModel: hardware.cpu_model ?? null,
      product: hardware.product ?? null,
      unified: !!hardware.unified_memory,
      status: host?.status,
    }
    if (!gpus.length) {
      cards.push({
        ...base,
        cardKey: `${base.hostId}:none`,
        empty: true,
        index: null,
        name: '',
        util: null,
        memUsedMiB: null,
        memTotalMiB: null,
        temp: null,
        power: null,
        powerLimit: null,
        driver: null,
      })
      continue
    }
    const hostDriver = typeof host?.data?.nvidia?.driver_version === 'string' ? host.data.nvidia.driver_version : ''
    gpus.forEach((gpu: any, i: number) => {
      const index = gpu?.index == null ? i : Number(gpu.index)
      const used = gpu?.memory_used_bytes
      const total = gpu?.memory_total_bytes
      const driver = typeof gpu?.driver_version === 'string' && gpu.driver_version ? gpu.driver_version : hostDriver
      cards.push({
        ...base,
        cardKey: `${base.hostId}:${gpu?.id ?? index}`,
        empty: false,
        index: Number.isFinite(index) ? index : i,
        name: gpu?.name || '未知加速器',
        util: gpu?.utilization_pct ?? null,
        memUsedMiB: used == null ? null : used / 1024 / 1024,
        memTotalMiB: total == null ? null : total / 1024 / 1024,
        temp: gpu?.temperature_c ?? null,
        power: gpu?.power_watts ?? null,
        powerLimit: gpu?.power_limit_watts ?? null,
        driver: driver || null,
      })
    })
  }
  return cards
}
