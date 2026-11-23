/** Labels and series for the machine-page host charts and the console stat strip. */

export type MarkIcon = 'cpu' | 'memory' | 'disk'

export interface HostChartMark {
  label: string
  icon: MarkIcon
  series: number[]
}

export function hostChartMarks(cpu: readonly number[] = [], mem: readonly number[] = []): { cpu: HostChartMark; memory: HostChartMark } {
  return {
    cpu: { label: '主机 CPU', icon: 'cpu', series: [...cpu] },
    memory: { label: '主机内存', icon: 'memory', series: [...mem] },
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pushPair(left: number[], right: number[], a: number | null, b: number | null) {
  if (a == null || b == null) return
  left.push(a)
  right.push(b)
}

/** Fleet history → the same CPU, memory, network and disk series every machine page plots. */
export function hostHistorySeries(samples: readonly any[] | null | undefined) {
  const host_cpu: number[] = []
  const host_mem: number[] = []
  const rx: number[] = []
  const tx: number[] = []
  const read: number[] = []
  const write: number[] = []
  for (const sample of samples ?? []) {
    const data = sample?.data && typeof sample.data === 'object' ? sample.data : sample
    const cpu = finite(data?.cpu?.usage_pct)
    const mem = finite(data?.memory?.usage_pct)
    if (cpu != null) host_cpu.push(cpu)
    if (mem != null) host_mem.push(mem)
    const net = data?.network ?? {}
    pushPair(rx, tx, finite(net.rx_bytes_per_sec), finite(net.tx_bytes_per_sec))
    const disk = data?.disk_io ?? {}
    let readRate = finite(disk.read_bytes_per_sec)
    let writeRate = finite(disk.write_bytes_per_sec)
    if ((readRate == null || writeRate == null) && Array.isArray(data?.disks)) {
      const reads = data.disks.map((item: any) => finite(item?.read_rate_bytes_sec)).filter((item: number | null): item is number => item != null)
      const writes = data.disks.map((item: any) => finite(item?.write_rate_bytes_sec)).filter((item: number | null): item is number => item != null)
      if (readRate == null && reads.length) readRate = reads.reduce((sum: number, item: number) => sum + item, 0)
      if (writeRate == null && writes.length) writeRate = writes.reduce((sum: number, item: number) => sum + item, 0)
    }
    pushPair(read, write, readRate, writeRate)
  }
  return {
    host_cpu,
    host_mem,
    network: { rx_bytes_per_sec: rx, tx_bytes_per_sec: tx },
    disk: { read_bytes_per_sec: read, write_bytes_per_sec: write },
  }
}

export function consoleStatIcons(): { cpu: { label: string; icon: MarkIcon }; memory: { label: string; icon: MarkIcon }; disk: { label: string; icon: MarkIcon } } {
  return {
    cpu: { label: 'CPU 负载 (1m)', icon: 'cpu' },
    memory: { label: '内存使用', icon: 'memory' },
    disk: { label: '磁盘', icon: 'disk' },
  }
}
