import type { ToolCallEntry } from './ToolCallsBlock'

/**
 * The assistant stream arrives as an ordered sequence of `reasoning`,
 * `content`, `tool_call` and `tool_result` events. Collapsing it into three
 * parallel fields (reasoning / content / toolCalls) destroys that order and
 * makes every tool call render in one block, detached from the sentence that
 * asked for it.
 *
 * `Segment` keeps the arrival order: a text run, a reasoning run and a run of
 * tool calls are appended as they arrive, so the UI reads top-to-bottom in the
 * same order the model produced them.
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; calls: ToolCallEntry[] }

const clone = (segments: Segment[]): Segment[] => segments.slice()

export function appendText(
  segments: Segment[],
  kind: 'text' | 'reasoning',
  text: string,
): Segment[] {
  const last = segments[segments.length - 1]
  if (last && last.kind === kind) {
    const next = clone(segments)
    next[segments.length - 1] = { kind, text: last.text + text }
    return next
  }
  return [...segments, { kind, text }]
}

/** Consecutive tool calls (parallel invocations) stay grouped in one block. */
export function appendTool(segments: Segment[], call: ToolCallEntry): Segment[] {
  const last = segments[segments.length - 1]
  if (last && last.kind === 'tools') {
    const next = clone(segments)
    next[segments.length - 1] = { kind: 'tools', calls: [...last.calls, call] }
    return next
  }
  return [...segments, { kind: 'tools', calls: [call] }]
}

/** Patches the call in place so its position in the timeline never moves. */
export function settleTool(
  segments: Segment[],
  id: string,
  patch: Partial<ToolCallEntry>,
): Segment[] {
  let changed = false
  const next = segments.map((seg) => {
    if (seg.kind !== 'tools') return seg
    const idx = seg.calls.findIndex((c) => c.id === id)
    if (idx < 0) return seg
    changed = true
    const calls = seg.calls.slice()
    calls[idx] = { ...calls[idx], ...patch } as ToolCallEntry
    return { kind: 'tools' as const, calls }
  })
  return changed ? next : segments
}

export function segmentsText(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : '')).join('')
}

export function segmentsReasoning(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'reasoning' ? s.text : '')).join('')
}

export function segmentsTools(segments: Segment[]): ToolCallEntry[] {
  return segments.flatMap((s) => (s.kind === 'tools' ? s.calls : []))
}

/** Legacy messages (or plain error notices) rendered without a timeline. */
export function fallbackSegments(msg: {
  content: string
  reasoning?: string
  toolCalls?: ToolCallEntry[]
}): Segment[] {
  const out: Segment[] = []
  if (msg.reasoning) out.push({ kind: 'reasoning', text: msg.reasoning })
  if (msg.toolCalls?.length) out.push({ kind: 'tools', calls: msg.toolCalls })
  if (msg.content) out.push({ kind: 'text', text: msg.content })
  return out
}
