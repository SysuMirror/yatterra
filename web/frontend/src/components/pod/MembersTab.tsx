import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UserPlus, Check, X, Trash2, Plus, Crown, Users } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog } from '@/components/ui/Dialog'
import { api } from '@/api/client'
import { Input } from '@/components/ui/Input'
import { AiFormHelper } from '@/components/domain/AiFormHelper'
import { UserCombobox } from '@/components/pod/UserCombobox'
import { useToastStore } from '@/stores/toast'

export function MembersTab({ podName, canManage }: { podName: string; canManage: boolean }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [inviteName, setInviteName] = useState('')
  const [inviteReason, setInviteReason] = useState('')
  const [addOwnerOpen, setAddOwnerOpen] = useState(false)
  const [ownerName, setOwnerName] = useState('')

  const { data } = useQuery<any>({
    queryKey: ['members', podName],
    queryFn: () => api.get(`/pods/${podName}/members`),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['members', podName] })

  const invalidate = () => { refresh(); qc.invalidateQueries({ queryKey: ['pod', podName] }) }

  const invite = useMutation({
    mutationFn: () => api.post(`/pods/${podName}/members/invite`, { username: inviteName.trim(), reason: inviteReason.trim() }),
    onSuccess: () => { toast({ type: 'success', message: `已向 ${inviteName} 发出邀请` }); setInviteName(''); setInviteReason(''); invalidate() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '邀请失败' }),
  })

  const approve = useMutation({
    mutationFn: ({ username, approved }: { username: string; approved: boolean }) => api.post(`/pods/${podName}/members/approve`, { username, approved }),
    onSuccess: (_d, { username, approved }) => { toast({ type: 'success', message: approved ? `已通过 ${username} 的加入申请` : `已拒绝 ${username} 的加入申请` }); invalidate() },
    onError: (e: any) => toast({ type: 'error', message: e?.message }),
  })

  const remove = useMutation({
    mutationFn: ({ kind, u }: { kind: 'member' | 'owner'; u: string }) =>
      api.del(`/pods/${podName}/${kind === 'owner' ? 'owners' : 'members'}/${encodeURIComponent(u)}`),
    onSuccess: (_d, { u }) => { toast({ type: 'success', message: `已移除 ${u}` }); invalidate() },
    onError: (e: any) => toast({ type: 'error', message: e?.message }),
  })
  const addOwner = useMutation({
    mutationFn: () => api.post(`/pods/${podName}/owners/add`, { username: ownerName.trim() }),
    onSuccess: () => { toast({ type: 'success', message: `已添加负责人 ${ownerName}` }); setAddOwnerOpen(false); setOwnerName(''); invalidate() },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '添加失败' }),
  })

  const owners: string[] = data?.owners ?? []
  const members: string[] = (data?.members ?? []).filter((m: string) => !owners.includes(m))
  const pending: any[] = data?.pending ?? []

  return (
    <div className="space-y-4">
      {/* Join requests */}
      {pending.length > 0 && (
        <Card padding="lg">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold">加入申请</h3>
            <Badge variant="warn">{pending.length} 待审批</Badge>
          </div>
          <ul className="space-y-2">
            {pending.map((p: any) => {
              const u = p.username ?? p.user ?? String(p)
              const reason = p.reason ?? ''
              return (
                <li key={u} className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-medium">{u}</span>
                  {reason && <span className="text-xs text-muted flex-1 min-w-0 truncate" title={reason}>“{reason}”</span>}
                  {canManage && <div className="flex items-center gap-1 ml-auto">
                    <Button variant="secondary" size="sm" disabled={approve.isPending} onClick={() => approve.mutate({ username: u, approved: true })} loading={approve.isPending && approve.variables?.username === u}>
                      <Check size={13} className="text-ok" /> 通过
                    </Button>
                    <Button variant="ghost" size="sm" disabled={approve.isPending} onClick={() => { if (confirm(`拒绝 ${u} 的申请？`)) approve.mutate({ username: u, approved: false }) }}>
                      <X size={13} />
                    </Button>
                  </div>}
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {/* Owners */}
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Crown size={14} /> 所有者</h3>
          {canManage && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAddOwnerOpen(true)}>
              <Plus size={13} /> 添加负责人
            </Button>
          )}
        </div>
        <ul className="space-y-1">
          {owners.map((u) => (
            <li key={u} className="flex items-center gap-2 py-1 text-sm group">
              <Badge variant="accent">Owner</Badge>
              <span className="font-medium">{u}</span>
              {canManage && owners.length > 1 && (
                <button
                  aria-label={`移除所有者 ${u}`}
                  className="ml-auto opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-muted hover:text-bad hover:bg-bad/10 transition-all"
                  onClick={() => { if (confirm(`移除所有者 ${u}？`)) remove.mutate({ kind: 'owner', u }) }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Dialog open={addOwnerOpen} onClose={() => { if (!addOwner.isPending) { setAddOwnerOpen(false); setOwnerName('') } }} title="添加负责人">
        <div className="space-y-4">
          <div>
            <UserCombobox podName={podName} label="用户名" value={ownerName} onChange={setOwnerName} mode="owner" disabled={addOwner.isPending} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={addOwner.isPending} onClick={() => { setAddOwnerOpen(false); setOwnerName('') }}>取消</Button>
            <Button disabled={!ownerName.trim()} loading={addOwner.isPending} onClick={() => addOwner.mutate()}>确认</Button>
          </div>
        </div>
      </Dialog>

      {/* Members */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><Users size={14} /> 成员 <span className="text-muted/60">{members.length}</span></h3>
        {members.length ? (
          <ul className="space-y-1">
            {members.map((u) => (
              <li key={u} className="flex items-center gap-2 py-1 text-sm group">
                <Badge variant="default">Member</Badge>
                <span className="font-medium">{u}</span>
                {canManage && (
                  <button
                    aria-label={`移除成员 ${u}`}
                    className="ml-auto opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-muted hover:text-bad hover:bg-bad/10 transition-all"
                    onClick={() => { if (confirm(`移除成员 ${u}？`)) remove.mutate({ kind: 'member', u }) }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">暂无其他成员</p>
        )}
      </Card>

      {/* Invite */}
      {canManage && (
        <Card padding="lg">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><UserPlus size={14} /> 邀请成员</h3>
          <div className="space-y-3 max-w-md">
            <div>
              <UserCombobox podName={podName} label="用户名" value={inviteName} onChange={setInviteName} disabled={invite.isPending} />
            </div>
            <div>
              <Input label="备注（可选）" value={inviteReason} onChange={(e) => setInviteReason(e.target.value)} placeholder="加入理由" />
              <div className="mt-1"><AiFormHelper type="general" partial={inviteReason} context="邀请备注" onApply={setInviteReason} /></div>
            </div>
            <Button size="sm" disabled={!inviteName.trim()} loading={invite.isPending} onClick={() => invite.mutate()}>
              <UserPlus size={13} /> 发出邀请
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
