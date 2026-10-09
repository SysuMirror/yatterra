/** AI API client — typed wrappers for /api/ai endpoints. */

import { api, apiFetch } from './client'

// ── Types ─────────────────────────────────────────────────────

export interface AiChatRequest {
  message: string
  system?: string
  context?: string | ChatMessage[]
  stream?: boolean
  max_tokens?: number
}

export interface AiAnalyzeRequest {
  text: string
  task: 'summarize' | 'classify' | 'extract' | 'translate' | 'explain'
  categories?: string[]
  extract_type?: string
  stream?: boolean
}

export interface AiVisionRequest {
  image: string  // base64 without data: prefix
  prompt?: string
  stream?: boolean
}

export interface AiCodeRequest {
  prompt: string
  language?: string
  task?: 'generate' | 'explain' | 'review'
  stream?: boolean
}

export interface AiWebQaRequest {
  question: string
  search_results?: { title: string; url: string; snippet: string }[]
  stream?: boolean
}

export interface AiCompleteRequest {
  partial: string
  schema?: Record<string, unknown>
  context?: string
}

export interface AiPageRequest {
  page: AiPageType
  question: string
  context?: string
  stream?: boolean
  /** Persisted conversation id; server loads history for it (per-user). */
  session_id?: string
}

/** One persisted page-assistant conversation (per user, global list). */
export interface PageSession {
  id: string
  title: string
  page?: string | null
  updated: number
  created: number
  preview: string
  n: number
}

/** One stored turn as returned by /ai/page/session/load. */
export interface PageSessionMessage {
  role: 'user' | 'assistant'
  content: string
  ts: number
}

export type AiPageType =
  | 'dashboard' | 'pod' | 'terminal' | 'audit'
  | 'llm' | 'users' | 'threat-map' | 'storage' | 'databases'
  | 'proxy' | 'shared' | 'profile' | 'mcp' | 'harness' | 'docs'
  | 'dev' | 'infra' | 'ops' | 'gpu' | 'host' | 'fleet'
  | 'pod_ide'
  | `pod:${string}`

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  tool_call_id: string
  name: string
  result: string
}

export interface AiSseEvent {
  type: 'reasoning' | 'content' | 'tool_call' | 'tool_result' | 'done'
  data: string | ToolCall | ToolResult
}

/** 进行中/历史的页面助手后台 run(见 web/page_ai_runs.py)。 */
export interface PageRunInfo {
  run_id: string
  username?: string
  page: string
  question: string
  session_id?: string
  route?: string
  status: 'running' | 'done' | 'error' | 'stopped' | 'interrupted'
  created: number
  finished?: number
}

// ── Non-streaming calls ──────────────────────────────────────

export const aiApi = {
  /** General-purpose chat */
  chat: (req: AiChatRequest) =>
    api.post<{ content: string }>('/ai/chat', { ...req, stream: false }),

  /** Text analysis */
  analyze: (req: AiAnalyzeRequest) =>
    api.post<{ content: string; task: string }>('/ai/analyze', { ...req, stream: false }),

  /** Image understanding (vision) */
  vision: (req: AiVisionRequest) =>
    api.post<{ content: string }>('/ai/vision', { ...req, stream: false }),

  /** Code generation/explanation/review */
  code: (req: AiCodeRequest) =>
    api.post<{ content: string; language: string; task: string }>('/ai/code', { ...req, stream: false }),

  /** Web QA (with search results) */
  webQa: (req: AiWebQaRequest) =>
    api.post<{ content: string }>('/ai/web-qa', { ...req, stream: false }),

  /** Smart completion */
  complete: (req: AiCompleteRequest) =>
    api.post<{ completion: string }>('/ai/complete', req),

  /** Translate */
  translate: (text: string, target: string = 'zh') =>
    api.post<{ content: string; target: string }>('/ai/translate', { text, target, stream: false }),

  /** Explain (errors, logs, code) */
  explain: (text: string) =>
    api.post<{ content: string }>('/ai/explain', { text, stream: false }),

  /** Page-level AI assistant (已废弃的同步入口, 仅 AiInsightPanel 等一次性调用) */
  page: (req: AiPageRequest) =>
    api.post<{ content: string }>('/ai/page', { ...req, stream: false }),

  /** 起一个后台页面助手 run, 立即返回 run_id(前端统一入口) */
  startPageRun: (req: AiPageRequest & { images?: string[]; route?: string }) =>
    api.post<{ run_id: string; session_id: string | null }>('/ai/page/run', req),

  /** 当前用户进行中的 run 列表(刷新后找回任务) */
  activePageRuns: () =>
    api.get<{ runs: PageRunInfo[] }>('/ai/page/runs?active=1'),

  /** 当前用户全部 run 列表(含已结束;重挂载时回放卸载期间完成的 run) */
  pageRuns: () =>
    api.get<{ runs: PageRunInfo[] }>('/ai/page/runs'),

  /** 协作式停止一个 run */
  stopPageRun: (run_id: string) =>
    api.post<{ ok: boolean }>('/ai/page/stop', { run_id }),

  /** 回传一批页面动作(browser_control)的执行结果 */
  submitPageActionResult: (run_id: string, results: unknown[], action_id?: string) =>
    api.post<{ ok: boolean }>('/ai/page/action_result', { run_id, results, action_id }),

  /** List the current user's page-assistant conversations (newest first) */
  pageSessions: () =>
    api.get<{ sessions: PageSession[] }>('/ai/page/sessions'),

  /** Create a new page-assistant conversation */
  newPageSession: (page?: string) =>
    api.post<{ session_id: string }>('/ai/page/session/new', { page }),

  /** Load one conversation's messages (ownership enforced server-side) */
  loadPageSession: (id: string) =>
    apiFetch<{ session_id: string; title: string; page?: string | null; messages: PageSessionMessage[] }>(
      '/ai/page/session/load?id=' + encodeURIComponent(id)),

  /** Rename a conversation */
  renamePageSession: (id: string, title: string) =>
    api.post<{ ok: boolean }>('/ai/page/session/rename', { id, title }),

  /** Delete a conversation */
  deletePageSession: (id: string) =>
    api.post<{ ok: boolean }>('/ai/page/session/delete', { id }),

  /** Read pre-computed insight from Redis cache */
  getInsight: (page: string) =>
    apiFetch<{ content: string | null; ts?: number; cached: boolean }>(`/ai/insight/${page}`),

  /** Force re-compute one page's insight */
  refreshInsight: (page: string) =>
    apiFetch<{ content: string | null; ts?: number; cached: boolean }>(`/ai/insight/${page}/refresh`, { method: 'POST' }),
}

// ── Streaming helpers ────────────────────────────────────────

/** Stream an AI SSE endpoint. Yields AiSseEvent chunks. */
export async function* streamAi(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AiSseEvent> {
  const res = await fetch(`/api${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    credentials: 'same-origin',
    signal,
  })

  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => `HTTP ${res.status}`)
    yield { type: 'content', data: `AI 请求失败: ${err}` }
    yield { type: 'done', data: '' }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const ev: AiSseEvent = JSON.parse(line.slice(6))
        yield ev
        if (ev.type === 'done') return
      } catch {
        // skip malformed
      }
    }
  }
}

/** Collect a full streaming response as a string. */
export async function collectStream(
  endpoint: string,
  body: Record<string, unknown>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  let result = ''
  for await (const ev of streamAi(endpoint, body)) {
    if (ev.type === 'content') {
      const chunk = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)
      result += chunk
      onChunk?.(chunk)
    }
  }
  return result
}

/** File to base64 helper (for vision) */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip data:image/xxx;base64, prefix
      const base64 = result.split(',')[1] || result
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
