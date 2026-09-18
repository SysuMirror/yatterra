export type ActionType = 'navigate' | 'click' | 'fill' | 'inspect'
export interface AssistantAction { id: string; type: ActionType; target_id: string; value?: string; route?: string }
export interface Control { id: string; label: string; kind: string; actions: ActionType[]; route?: string; element: HTMLElement }
const sensitive = /password|secret|token|credential|api[-_]?key|authorization/i
const blocked = /delete|remove|destroy|submit|upload|deploy|permission|role|credential|password|secret|token|api[-_]?key|authorize|grant|revoke|reset|format|shutdown/i

export function rendered(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"],[data-assistant-ui]')) return false
  if (el.matches(':disabled,[aria-disabled="true"],[data-sensitive],[data-assistant-danger="true"]')) return false
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return false
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
  }
  return true
}

// Only controls explicitly opted in by application source can enter the snapshot.
// Never send DOM text, field values, arbitrary selectors or model-supplied routes.
export function controls(): Control[] {
  const entries: Control[] = []
  for (const element of document.querySelectorAll<HTMLElement>('[data-assistant-control]')) {
    if (!rendered(element)) continue
    const id = element.dataset.assistantControl || '', label = element.dataset.assistantLabel || ''
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id) || !label || sensitive.test(id)) continue
    const declared = element.dataset.assistantActions
    if (!declared) continue
    const actions = declared.split(' ').filter(a => ['inspect','navigate','click','fill'].includes(a)) as ActionType[]
    if (!actions.length) continue
    const safeTab = id.startsWith('pod-tab-') && element.getAttribute('role') === 'tab' && actions.every(a => a === 'click' || a === 'inspect')
    const descriptor = `${id} ${element.getAttribute('id') || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('type') || ''} ${element.getAttribute('aria-label') || ''} ${label} ${element.dataset.assistantDanger || ''}`
    if ((sensitive.test(descriptor) || blocked.test(descriptor)) && !safeTab) continue
    let route: string | undefined
    if (element instanceof HTMLAnchorElement) {
      const url = new URL(element.href)
      if (url.origin !== location.origin || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) continue
      route = url.pathname + url.search + url.hash
    }
    entries.push({ id, label: label.slice(0,100), kind: element.tagName.toLowerCase(), actions, route, element })
  }
  return entries.filter(e => entries.filter(other => other.id === e.id).length === 1).slice(0,100)
}
export function snapshot() { return controls().map(({ element: _, ...control }) => control) }
export function resolveAction(action: AssistantAction): Control | undefined {
  const c = controls().find(c => c.id === action.target_id)
  if (!c || !c.actions.includes(action.type)) return
  if (action.type === 'navigate' && (!c.route || (action.route !== undefined && c.route !== action.route))) return
  if (action.type === 'fill' && (!(c.element instanceof HTMLInputElement) || !['text','search'].includes(c.element.type) || c.element.readOnly || typeof action.value !== 'string' || action.value.length > 2000)) return
  if (action.type === 'click' && (!(c.element instanceof HTMLButtonElement) || c.element.type !== 'button')) return
  return c
}
export function perform(action: AssistantAction, navigate: (route: string) => void): Control | undefined {
  const c = resolveAction(action)
  if (!c) return
  if (action.type === 'navigate') navigate(c.route!)
  if (action.type === 'click') c.element.click()
  if (action.type === 'fill') {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) return
    setter.call(c.element, action.value)
    c.element.dispatchEvent(new Event('input', { bubbles: true }))
    c.element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return c
}
