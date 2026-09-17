import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { User, Key, Link, Unlink, RefreshCw, Bell, BellOff, Check } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { CodeChip } from '@/components/ui/CodeChip'
import { Dialog } from '@/components/ui/Dialog'
import { Switch } from '@/components/ui/Switch'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { checkForUpdate } from '@/lib/sw-update'
import { isPushSupported, getSubscriptionState, subscribePush, unsubscribePush, type PushState } from '@/lib/push'

const PROVIDER_COLORS: Record<string, string> = {
  ssemarket: '#0a84ff',
  unisso: '#bf5af2',
}
const PROVIDER_LABELS: Record<string, string> = {
  ssemarket: 'SSE Market',
  unisso: 'UniSSO',
}
const PROVIDER_LETTER: Record<string, string> = {
  ssemarket: 'S',
  unisso: 'U',
}

export default function Profile() {
  const toast = useToastStore((s) => s.add)
  const auth = useAuthStore()
  const qc = useQueryClient()
  const [pwOpen, setPwOpen] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')

  const { data: profile } = useQuery<any>({
    queryKey: ['profile'],
    queryFn: () => api.get('/profile'),
  })

  const changePwMut = useMutation({
    mutationFn: () => api.post('/profile/password', { old: oldPw, new: newPw }),
    onSuccess: () => { toast({ type: 'success', message: '密码已修改' }); setPwOpen(false) },
    onError: (e: any) => toast({ type: 'error', message: e.message }),
  })

  // ── SW update check ────────────────────────────────────────
  const [checking, setChecking] = useState(false)
  const handleCheckUpdate = async () => {
    setChecking(true)
    const found = await checkForUpdate()
    setChecking(false)
    if (found) {
      toast({ type: 'info', message: '发现新版本，即将刷新…' })
    } else {
      toast({ type: 'success', message: '已是最新版本' })
    }
  }

  // ── Push notifications ─────────────────────────────────────
  const [pushState, setPushState] = useState<PushState>('not-subscribed')
  const [pushBusy, setPushBusy] = useState(false)

  useEffect(() => {
    getSubscriptionState().then(setPushState)
  }, [])

  const handlePushToggle = async (enabled: boolean) => {
    setPushBusy(true)
    try {
      if (enabled) {
        const ok = await subscribePush()
        if (ok) {
          setPushState('subscribed')
          toast({ type: 'success', message: '推送通知已开启' })
        } else {
          toast({ type: 'error', message: '无法开启推送通知，请检查权限设置' })
        }
      } else {
        await unsubscribePush()
        setPushState('not-subscribed')
        toast({ type: 'success', message: '推送通知已关闭' })
      }
    } catch (e: any) {
      toast({ type: 'error', message: e.message || '操作失败' })
    } finally {
      setPushBusy(false)
    }
  }

  const pushSupported = isPushSupported()
  const pushEnabled = pushState === 'subscribed'

  const identities = profile?.identities ?? []
  const boundProviders: string[] = profile?.bound_providers ?? []
  const oauthProvider = profile?.oauth_provider
  const oauthName = profile?.oauth_name
  const oauthEmail = profile?.oauth_email

  return (
    <>
      <PageHeader title="个人管理" description="账户设置与身份绑定" doc={{ section: 'profile', item: 0, label: '账户文档' }}>
        <PageAiAssistant page="profile" context={profile ? `用户: ${profile.user ?? '?'}, 角色: ${profile.role ?? '?'}, 身份绑定: ${identities.length} 个 (${boundProviders.join(', ') || '无'}), OAuth: ${oauthProvider ?? '无'}${oauthName ? ` (${oauthName})` : ''}` : '暂无用户数据'} />
      </PageHeader>

      {/* Account Info */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-2xl bg-accent-light flex items-center justify-center">
            <User size={28} className="text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{auth.user || profile?.user || '—'}</h2>
            <Badge variant="accent">{auth.role || profile?.role || 'user'}</Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div><span className="text-muted">用户名</span><p className="font-medium mt-0.5">{auth.user || '—'}</p></div>
          <div><span className="text-muted">角色</span><p className="font-medium mt-0.5">{auth.role || '—'}</p></div>
          <div><span className="text-muted">权限数</span><p className="font-medium mt-0.5">{auth.perms.size}</p></div>
          {oauthProvider && (
            <div>
              <span className="text-muted">登录方式</span>
              <p className="font-medium mt-0.5 flex items-center gap-1.5">
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-xs font-bold flex-shrink-0"
                  style={{ background: PROVIDER_COLORS[oauthProvider] || '#888' }}
                >
                  {PROVIDER_LETTER[oauthProvider] || '?'}
                </span>
                {PROVIDER_LABELS[oauthProvider] || oauthProvider}
              </p>
            </div>
          )}
          {oauthName && <div><span className="text-muted">显示名</span><p className="font-medium mt-0.5">{oauthName}</p></div>}
          {oauthEmail && <div><span className="text-muted">邮箱</span><p className="font-medium mt-0.5">{oauthEmail}</p></div>}
        </div>
      </Card>

      {/* Identities */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">身份绑定</h2>
        </div>
        {identities.length > 0 ? (
          <div className="space-y-2">
            {identities.map((id: any, i: number) => {
              const prov = id.provider || id.kind
              const color = PROVIDER_COLORS[prov] || '#888'
              const letter = PROVIDER_LETTER[prov] || '?'
              const label = PROVIDER_LABELS[prov] || prov
              return (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl hover:bg-black/[0.02]">
                  <span
                    className="inline-flex items-center justify-center w-9 h-9 rounded-full text-white text-sm font-bold flex-shrink-0"
                    style={{ background: color, boxShadow: `0 2px 8px ${color}40` }}
                  >
                    {letter}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{label} — {id.provider_name || id.provider_uid || id.display_name || id.uid || '—'}</div>
                    {id.provider_email && <div className="text-xs text-muted mt-0.5">{id.provider_email}</div>}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => api.post('/profile/unbind', { id: id.id }).then(() => { toast({ type: 'success', message: '已解绑' }); qc.invalidateQueries({ queryKey: ['profile'] }) })}>
                    <Unlink size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted">暂无绑定身份</p>
        )}
        <div className="space-y-3 mt-4">
          {(['ssemarket', 'unisso'] as const).map((prov) => {
            const color = PROVIDER_COLORS[prov]
            const letter = PROVIDER_LETTER[prov]
            const label = PROVIDER_LABELS[prov]
            const isBound = boundProviders.includes(prov)
            return (
              <div key={prov}>
                <button
                  className="w-full flex items-center justify-center gap-2.5 py-3 px-5 rounded-xl text-white font-semibold text-sm transition-all"
                  style={{
                    background: isBound ? `${color}60` : color,
                    boxShadow: isBound ? 'none' : `0 0 0 0.5px ${color}4D, 0 2px 8px ${color}33`,
                    opacity: isBound ? 0.4 : 1,
                    cursor: isBound ? 'default' : 'pointer',
                  }}
                  disabled={isBound}
                  onClick={() => { if (!isBound) window.location.href = `/api/auth/oauth/${prov}` }}
                >
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/20 text-xs font-bold">{letter}</span>
                  绑定 {label}
                </button>
                {isBound && (
                  <span className="flex items-center gap-1 text-xs font-semibold mt-1" style={{ color: '#34c759' }}>
                    <Check size={12} /> 已绑定
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {/* Password */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">修改密码</h2>
            <p className="text-xs text-muted mt-0.5">更新你的登录密码</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setPwOpen(true)}><Key size={14} /> 修改</Button>
        </div>
      </Card>

      {/* PWA Update */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">应用更新</h2>
            <p className="text-xs text-muted mt-0.5">检查并获取最新版本</p>
          </div>
          <Button variant="secondary" size="sm" onClick={handleCheckUpdate} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            {checking ? '检查中…' : '检查更新'}
          </Button>
        </div>
      </Card>

      {/* Push Notifications */}
      <Card padding="lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {pushEnabled ? <Bell size={18} className="text-accent" /> : <BellOff size={18} className="text-muted" />}
            <div>
              <h2 className="text-sm font-semibold">推送通知</h2>
              <p className="text-xs text-muted mt-0.5">
                {!pushSupported ? '此浏览器不支持推送' :
                  pushState === 'denied' ? '通知权限被拒绝，请在浏览器设置中开启' :
                  pushEnabled ? '有新版本时推送通知' :
                  '开启后，部署新版本将推送通知'}
              </p>
            </div>
          </div>
          <Switch
            checked={pushEnabled}
            onChange={handlePushToggle}
            disabled={!pushSupported || pushState === 'denied' || pushBusy}
          />
        </div>
      </Card>

      {/* Change Password Dialog */}
      <Dialog open={pwOpen} onClose={() => setPwOpen(false)} title="修改密码">
        <div className="space-y-4">
          <Input label="当前密码" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          <Input label="新密码" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPwOpen(false)}>取消</Button>
            <Button onClick={() => changePwMut.mutate()} disabled={!oldPw || !newPw}>确认</Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
