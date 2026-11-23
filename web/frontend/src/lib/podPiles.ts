export const KNOWN_PILE_STATUSES = ['Failed', 'Pending', 'Running', 'Stopped', 'Succeeded'] as const

export interface PodPile<T> {
  status: string
  pods: T[]
}

/** Group pods by status. Statuses outside the known set stay in their own piles. */
export function podPiles<T extends { status: string }>(pods: readonly T[]): PodPile<T>[] {
  const known = new Set<string>(KNOWN_PILE_STATUSES)
  const piles: PodPile<T>[] = []
  for (const status of KNOWN_PILE_STATUSES) {
    const group = pods.filter((pod) => pod.status === status)
    if (group.length) piles.push({ status, pods: group })
  }
  const extra = [...new Set(pods.filter((pod) => !known.has(pod.status)).map((pod) => pod.status || 'Other'))].sort()
  for (const status of extra) {
    piles.push({
      status,
      pods: pods.filter((pod) => (pod.status || 'Other') === status),
    })
  }
  return piles
}
