import { Database, HardDrive } from 'lucide-react'
import { CodeChip } from '@/components/ui/CodeChip'
import { Badge } from '@/components/ui/Badge'

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

  return (
    <div className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-2.5 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] active:scale-[0.98] transition-all duration-200">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-muted" />
        <span className="text-sm font-semibold">{service}</span>
        <Badge variant="muted">{type === 'database' ? '数据库' : '存储'}</Badge>
      </div>

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
