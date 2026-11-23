import inventory from './inventory.json'

export interface UxEntry {
  page: string
  inconvenience: string
  kind: 'fix' | 'radical' | 'reviewed'
  source: string
  marker: string
}

/** Shipped scan of console inconveniences. The unit test reads the same JSON. */
export const UX_INVENTORY = inventory as UxEntry[]
