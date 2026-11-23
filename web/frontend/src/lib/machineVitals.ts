import { formatBytes, formatDuration } from './format.ts'

export interface MachineDisk {
  mount: string
  usedPct: number | null
  usedLabel: string | null
  totalLabel: string | null
  error: string | null
}

export interface MachineVitals {
  cores: number | null
  cpuPct: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  memPct: number | null
  memUsed: string | null
  memTotal: string | null
  swapUsed: string | null
  swapTotal: string | null
  uptime: string | null
  driver: string | null
  netRx: number | null
  netTx: number | null
  diskRead: number | null
  diskWrite: number | null
  disks: MachineDisk[]
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bytesLabel(value: unknown): string | null {
  const amount = num(value)
  return amount == null ? null : formatBytes(amount)
}

/** Fleet probe or local health payload → the same machine-page numbers. */
export function machineVitals(data: any): MachineVitals {
  const cpu = data?.cpu ?? {}
  const memory = data?.memory ?? data?.mem ?? {}
  const swap = data?.swap ?? {}
  const load = data?.load ?? {}
  const disks = (Array.isArray(data?.disks) ? data.disks : Array.isArray(data?.disk) ? data.disk : []).map((disk: any) => ({
    mount: String(disk?.mount ?? ''),
    usedPct: num(disk?.usage_pct ?? disk?.used_pct),
    usedLabel: disk?.error ? null : (disk?.used_h ?? bytesLabel(disk?.used_bytes)),
    totalLabel: disk?.error ? null : (disk?.total_h ?? bytesLabel(disk?.total_bytes)),
    error: disk?.error ? String(disk.error) : null,
  }))
  const uptimeSeconds = num(data?.uptime_seconds ?? data?.uptime?.seconds)
  const uptime = typeof data?.uptime === 'string'
    ? data.uptime
    : (data?.uptime?.human ?? (uptimeSeconds == null ? null : formatDuration(uptimeSeconds)))
  return {
    cores: num(cpu.count ?? cpu.cores),
    cpuPct: num(cpu.usage_pct),
    load1: num(cpu.load1 ?? load.load1),
    load5: num(cpu.load5 ?? load.load5),
    load15: num(cpu.load15 ?? load.load15),
    memPct: num(memory.usage_pct ?? memory.used_pct),
    memUsed: memory.used_h ?? bytesLabel(memory.used_bytes),
    memTotal: memory.total_h ?? bytesLabel(memory.total_bytes),
    swapUsed: bytesLabel(swap.used_bytes) ?? swap.used_h ?? null,
    swapTotal: bytesLabel(swap.total_bytes) ?? swap.total_h ?? null,
    uptime,
    driver: typeof data?.nvidia?.driver_version === 'string' && data.nvidia.driver_version ? data.nvidia.driver_version : null,
    netRx: num(data?.network?.rx_bytes_per_sec),
    netTx: num(data?.network?.tx_bytes_per_sec),
    diskRead: num(data?.disk_io?.read_bytes_per_sec),
    diskWrite: num(data?.disk_io?.write_bytes_per_sec),
    disks,
  }
}
