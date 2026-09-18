import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { User, Plus, Trash2, Key, Copy, RefreshCw } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { useAuth } from '@/hooks/useAuth'

const roleOptions = [
  { value: 'super', label: '超级管理员' },
  { value: 'admin', label: '管理员' },
  { value: 'owner', label: 'Owner' },
  { value: 'user', label: '普通用户' },
  { value: 'guest', label: '访客' },
]

export default function Users() {
  const toast = useToastStore((s) => s.add)
  const { hasPerm } = useAuth()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [resetOpen, setResetOpen] = useState(false)
  const [resetUser, setResetUser] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)
  const [tokenDesc, setTokenDesc] = useState('')
  const [createdToken, setCreatedToken] = useState('')

  const canManage = hasPerm('admin.users')

  const { data, isLoading } = useQuery<{ current: string; users: any[] }>({
    enabled: canManage,
    queryKey: ['users'],
    queryFn: () => api.get<any>('/users').then(d => ({ current: d.current ?? '', users: d.users ?? d })),
  })

  const current = data?.current ?? ''
  const users = data?.users ?? []

  const createMut = useMutation({
    mutationFn: (d: any) => api.post('/users', d),
    onSuccess: () => { toast({ type: 'success', message: '用户已创建' }); setCreateOpen(false); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  const deleteMut = useMutation({
    mutationFn: (u: string) => api.del(`/users/${u}`),
    onSuccess: () => { toast({ type: 'success', message: '用户已删除' }); qc.invalidateQueries({ queryKey: ['users'] }) },
  })

  const roleMut = useMutation({
    mutationFn: ({ username, role }: { username: string; role: string }) => api.put(`/users/${username}`, { role }),
    onSuccess: () => { toast({ type: 'success', message: '角色已更新' }); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  const resetMut = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) => api.put(`/users/${username}`, { password }),
    onSuccess: () => { toast({ type: 'success', message: '密码已重置' }); setResetOpen(false); setNewPassword('') },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  // API Tokens
  const { data: tokens } = useQuery<any[]>({
    queryKey: ['tokens'],
    queryFn: () => api.get<any>('/tokens').then(d => d.tokens ?? d),
  })

  const tokenCreateMut = useMutation({
    mutationFn: (d: any) => api.post('/tokens', d),
    onSuccess: (res: any) => {
      setCreatedToken(res.token ?? res.key ?? '')
      setTokenDesc('')
      qc.invalidateQueries({ queryKey: ['tokens'] })
    },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  const tokenDeleteMut = useMutation({
    mutationFn: (id: string) => api.del(`/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => { toast({ type: 'success', message: 'Token 已删除' }); qc.invalidateQueries({ queryKey: ['tokens'] }) },
    onError: (e: any) => toast({ type: 'error', message: e?.message || 'Token 删除失败' }),
  })

  return (
    <>
      <PageHeader title="用户管理" description="系统用户与权限管理" count={users.length ? `${users.length} 人` : undefined} doc={{ section: 'ops', item: 1, label: '用户管理文档' }}>
        {canManage && <>
          <PageAiAssistant page="users" context={users.length > 0 ? `用户总数: ${users.length}, 当前用户: ${data?.current ?? ''}\n${users.map((u: any) => `  ${u.name ?? u.username ?? u} [${u.role ?? '?'}]`).join('\n')}` : '暂无用户数据'} />
          <Button data-onboarding-target="users-create" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> 创建用户</Button>
        </>}
      </PageHeader>

      {!canManage && (
        <Card className="mb-5">
          <p className="text-sm text-muted">无权限查看系统用户(需要 admin.users 权限)。你只能管理自己的 API Token。</p>
        </Card>
      )}

      {/* AI Insight */}
      {canManage && !isLoading && users.length > 0 && (
        <AiInsightPanel
          page="users"
          title="用户管理洞察"
          className="mb-5"
          context={`用户总数: ${users.length}, 当前用户: ${data?.current ?? ''}\n角色分布: ${['super','admin','owner','user','guest'].map(r => `${r}=${users.filter((u: any) => (u.role ?? 'user') === r).length}`).join(', ')}\n用户列表:\n${users.map((u: any) => `  ${u.name ?? u.username ?? u} [${u.role ?? '?'}]`).join('\n')}\nAPI Tokens: ${tokens?.length ?? 0} 个`}
        />
      )}

      {canManage && <Card padding="none">
        <DataTable
          columns={[
            { key: 'username', title: '用户名', sortable: true, render: (r: any) => {
              const name = r.username || r.user
              const isCurrent = name === current
              return (
                <div className="flex items-center gap-2">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center ${isCurrent ? 'bg-ok-bg' : 'bg-accent-light'}`}>
                    <User size={14} className={isCurrent ? 'text-ok' : 'text-accent'} />
                  </div>
                  <span className="font-medium">{name}</span>
                  {isCurrent && <Badge variant="ok" className="text-[10px] px-1.5 py-0">你</Badge>}
                </div>
              )
            }},
            { key: 'role', title: '角色', sortable: true, width: '200px', render: (r: any) => (
              <Select
                value={r.role}
                onChange={(v) => roleMut.mutate({ username: r.username || r.user, role: v })}
                options={roleOptions}
                className="w-[150px]"
              />
            )},
            { key: 'actions', title: '', width: '90px', render: (r: any) => {
              const name = r.username || r.user
              if (name === current) return null
              return (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setResetUser(name); setNewPassword(''); setResetOpen(true) }} title="重置密码" aria-label="重置密码">
                    <Key size={14} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm(`删除用户 ${name}?`)) deleteMut.mutate(name) }} aria-label="删除用户">
                    <Trash2 size={14} />
                  </Button>
                </div>
              )
            }},
          ]}
          data={users}
          keyFn={(r: any) => r.username || r.user}
          empty={<p className="text-sm text-muted text-center py-8">暂无用户</p>}
        />
      </Card>}

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="创建用户">
        <div className="space-y-4">
          <div>
            <Input label="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
            <div className="mt-1"><AiFormHelper type="general" partial={username} context="创建新用户用户名" onApply={setUsername} /></div>
          </div>
          <Input label="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Select value={role} onChange={setRole} options={roleOptions.filter(o => o.value !== 'super')} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => createMut.mutate({ username, password, role })} disabled={!username || !password}>创建</Button>
          </div>
        </div>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetOpen} onClose={() => setResetOpen(false)} title={`重置密码 - ${resetUser}`}>
        <div className="space-y-4">
          <Input label="新密码" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <p className="text-xs text-muted">重置后需通知用户使用新密码登录</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResetOpen(false)}>取消</Button>
            <Button onClick={() => resetMut.mutate({ username: resetUser, password: newPassword })} disabled={!newPassword}>确认</Button>
          </div>
        </div>
      </Dialog>

      {/* API Tokens */}
      <Card className="mt-6" padding="none">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Key size={16} /> API Token
          </h2>
          <Button data-onboarding-target="users-token" size="sm" onClick={() => { setTokenOpen(true); setCreatedToken(''); setTokenDesc('') }}>
            <Plus size={14} /> 创建
          </Button>
        </div>
        <DataTable
          columns={[
            { key: 'description', title: '描述', sortable: true, render: (r: any) => (
              <span className="font-medium">{r.description || r.name || '-'}</span>
            )},
            { key: 'prefix', title: '前缀', width: '100px', render: (r: any) => (
              <code className="text-xs font-mono text-muted">{r.prefix || (r.token ? r.token.slice(0, 8) + '…' : '-')}</code>
            )},
            { key: 'created', title: '创建时间', sortable: true, render: (r: any) => (
              <span className="text-sm text-muted">{r.created_at || r.created || '-'}</span>
            )},
            { key: 'last_used', title: '最后使用', render: (r: any) => (
              <span className="text-sm text-muted">{r.last_used_at || r.last_used || '-'}</span>
            )},
            { key: 'actions', title: '', width: '60px', render: (r: any) => (
              <Button variant="ghost" size="sm" onClick={() => { if (confirm('删除此 Token?')) tokenDeleteMut.mutate(r.id ?? r.name) }}>
                <Trash2 size={14} />
              </Button>
            )},
          ]}
          data={tokens ?? []}
          keyFn={(r: any) => r.id ?? r.name}
          empty={<p className="text-sm text-muted text-center py-8">暂无 API Token</p>}
        />
      </Card>

      {/* Create Token Dialog */}
      <Dialog open={tokenOpen} onClose={() => setTokenOpen(false)} title="创建 API Token">
        <div className="space-y-4">
          {!createdToken ? (
            <>
              <div>
                <Input label="描述" value={tokenDesc} onChange={(e) => setTokenDesc(e.target.value)} placeholder="例如: CI/CD 部署" />
                <div className="mt-1"><AiFormHelper type="general" partial={tokenDesc} context="API Token 描述" onApply={setTokenDesc} /></div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setTokenOpen(false)}>取消</Button>
                <Button onClick={() => tokenCreateMut.mutate({ description: tokenDesc })} disabled={!tokenDesc}>创建</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">Token 已创建，请妥善保存，此值仅显示一次：</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono bg-warn/5 border border-warn/20 rounded px-3 py-2 break-all select-all">{createdToken}</code>
                <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard.writeText(createdToken); toast({ type: 'success', message: '已复制' }) }}>
                  <Copy size={14} />
                </Button>
              </div>
              <p className="text-xs text-warn">⚠ 请立即复制，此 Token 仅显示一次</p>
              <div className="flex justify-end">
                <Button onClick={() => setTokenOpen(false)}>关闭</Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </>
  )
}
