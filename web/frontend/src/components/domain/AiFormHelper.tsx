import { useState, useCallback } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { aiApi } from '@/api/ai'

interface AiFormHelperProps {
  /** What kind of form this is */
  type: 'pod' | 'deploy' | 'mcp' | 'general'
  /** Current partial input to complete from */
  partial: string
  /** Additional context */
  context?: string
  /** Called with AI completion result */
  onApply: (value: string) => void
  /** Button size */
  size?: 'sm' | 'md'
  className?: string
}

const FORM_SCHEMAS: Record<string, Record<string, unknown>> = {
  pod: {
    type: 'object',
    properties: {
      cpu: { type: 'string', description: 'CPU cores, e.g. "2", "4"' },
      memory: { type: 'string', description: 'Memory, e.g. "4Gi", "8Gi"' },
      gpus: { type: 'string', description: 'GPU indices, e.g. "0", "0,1"' },
      storage: { type: 'string', description: 'Storage size, e.g. "10Gi", "50Gi"' },
    },
  },
  deploy: {
    type: 'object',
    properties: {
      framework: { type: 'string', description: 'Detected framework: flask, fastapi, nextjs, etc.' },
      build_command: { type: 'string', description: 'Build command' },
      start_command: { type: 'string', description: 'Start command' },
      port: { type: 'number', description: 'Application port' },
    },
  },
  mcp: {
    type: 'object',
    properties: {
      command: { type: 'array', description: 'MCP server command, e.g. ["npx", "-y", "@playwright/mcp"]' },
      transport: { type: 'string', description: 'Transport type: stdio or http' },
    },
  },
}

const FORM_CONTEXTS: Record<string, string> = {
  pod: '创建 Kubernetes Pod/容器开发环境',
  deploy: '配置 Git 仓库自动部署',
  mcp: '添加 MCP (Model Context Protocol) 工具服务',
  general: '表单填写',
}

/** AI-powered form completion helper button. */
export function AiFormHelper({ type, partial, context, onApply, size = 'sm', className }: AiFormHelperProps) {
  const [loading, setLoading] = useState(false)

  const handleComplete = useCallback(async () => {
    if (loading || !partial) return
    setLoading(true)
    try {
      const result = await aiApi.complete({
        partial,
        schema: FORM_SCHEMAS[type],
        context: context || FORM_CONTEXTS[type] || '',
      })
      if (result.completion) {
        onApply(result.completion)
      }
    } catch {
      // Silently fail — form completion is nice-to-have
    } finally {
      setLoading(false)
    }
}, [partial, context, type, loading, onApply])

  return (
    <button
      type="button"
      onClick={handleComplete}
      disabled={loading || !partial}
      className={`inline-flex items-center gap-1 text-accent hover:text-accent/80 disabled:opacity-30 transition-colors ${className || ''} ${
        size === 'sm' ? 'text-xs' : 'text-sm'
      }`}
      title="AI 智能补全"
    >
      {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
      <span>AI 补全</span>
    </button>
  )
}
