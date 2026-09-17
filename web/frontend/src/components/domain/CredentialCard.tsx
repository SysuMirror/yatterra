import { useState } from 'react'
import { Database, HardDrive, Sparkles, Loader2 } from 'lucide-react'
import { CodeChip } from '@/components/ui/CodeChip'
import { Badge } from '@/components/ui/Badge'
import { aiApi } from '@/api/ai'

interface CredentialCardProps {
  service: string
  type: 'database' | 'storage'
  host: string
  port?: number
  username: string
  password: string
  database?: string
}

export function CredentialCard({ service, type, host, port, username, password, database }: CredentialCardProps) {
  const Icon = type === 'database' ? Database : HardDrive
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiAdvice = async () => {
    setAiLoading(true)
    setAiTip('')
    try {
      const info = `${type === 'database' ? '数据库' : '存储'}凭证: ${service}, 主机: ${host}:${port ?? '默认'}, 用户: ${username}, 密码长度: ${password.length}, 数据库: ${database ?? 'N/A'}`
      const res = await aiApi.analyze({ text: info, task: 'explain' })
      setAiTip(res.content)
    } catch {
      setAiTip('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-2.5 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] active:scale-[0.98] transition-all duration-200">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-muted" />
        <span className="text-sm font-semibold">{service}</span>
        <Badge variant="muted">{type === 'database' ? '数据库' : '存储'}</Badge>
        <button
          onClick={handleAiAdvice}
          disabled={aiLoading}
          className="ml-auto inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
          title="AI 安全建议"
        >
          {aiLoading ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />} 安全建议
        </button>
      </div>
      {aiTip && (
        <div className="p-2 rounded-lg bg-accent/5 border border-accent/10 text-xs whitespace-pre-wrap">
          <div className="flex items-center gap-1 mb-0.5 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 建议</div>
          {aiTip}
        </div>
      )}

      <div className="space-y-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted w-12">主机</span>
          <CodeChip code={port ? `${host}:${port}` : host} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted w-12">用户</span>
          <CodeChip code={username} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted w-12">密码</span>
          <CodeChip code={password} mask />
        </div>
        {database && (
          <div className="flex items-center gap-2">
            <span className="text-muted w-12">库</span>
            <CodeChip code={database} />
          </div>
        )}
      </div>
    </div>
  )
}
