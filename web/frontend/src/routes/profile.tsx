import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { User, Key, Link, Unlink, RefreshCw, Bell, BellOff, Check, Download, Smartphone, ShieldCheck, Loader2 } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { CodeChip } from '@/components/ui/CodeChip'
import { Dialog } from '@/components/ui/Dialog'
import { Switch } from '@/components/ui/Switch'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { MarkdownContent } from '@/components/ai'
import { api } from '@/api/client'
import { aiApi } from '@/api/ai'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { checkForUpdate } from '@/lib/sw-update'
import { isPushSupported, getSubscriptionState, subscribePush, unsubscribePush, type PushState } from '@/lib/push'
import { usePwaInstall } from '@/lib/pwa-install'
import { haptic } from '@/lib/haptic'
import { ThemePicker } from '@/components/ui/ThemePicker'

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
  const { canInstall, isInstalled, isIos, promptInstall } = usePwaInstall()
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

  // ── 推送偏好 (prefs.push_kinds) ─────────────────────────────
  const PUSH_KINDS: { kind: string; label: string }[] = [
    { kind: 'pod-down', label: '故障告警' },
    { kind: 'pod-recovery', label: '恢复通知' },
    { kind: 'deploy-result', label: '部署结果' },
    { kind: 'approval-pending', label: '审批待审' },
    { kind: 'agent-done', label: 'AI 任务完成' },
    { kind: 'quota-warn', label: '配额预警' },
    { kind: 'broadcast', label: '平台广播' },
  ]

  const { data: pushPrefs } = useQuery<any>({
    queryKey: ['push-prefs'],
    queryFn: () => api.get('/profile/push-prefs'),
  })

  // null = 全部开启; 本地用 Set 表示已勾选的 kind
  const [enabledKinds, setEnabledKinds] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (pushPrefs) {
      setEnabledKinds(pushPrefs.push_kinds == null ? null : new Set(pushPrefs.push_kinds))
    }
  }, [pushPrefs])

  const prefsDirty = (() => {
    if (!pushPrefs || enabledKinds === null) return false
    const saved = pushPrefs.push_kinds == null ? null : new Set<string>(pushPrefs.push_kinds)
    if ((saved === null) !== (enabledKinds === null)) return true
    if (saved === null || enabledKinds === null) return false
    return saved.size !== enabledKinds.size || [...saved].some((k) => !enabledKinds.has(k))
  })()

  const toggleKind = (kind: string) => {
    haptic('light')
    setEnabledKinds((prev) => {
      if (prev === null) {
        // 从"全部"切到手动选择: 先全选, 再去掉当前项
        const all = new Set(PUSH_KINDS.map((k) => k.kind))
        all.delete(kind)
        return all
      }
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const savePrefsMut = useMutation({
    mutationFn: () => {
      const allOn = enabledKinds === null || enabledKinds.size === PUSH_KINDS.length
      return api.put('/profile/push-prefs', { push_kinds: allOn ? null : [...(enabledKinds ?? new Set())] })
    },
    onSuccess: () => {
      toast({ type: 'success', message: '推送偏好已保存' })
      qc.invalidateQueries({ queryKey: ['push-prefs'] })
    },
    onError: (e: any) => toast({ type: 'error', message: e.message || '保存失败' }),
  })

  const identities = profile?.identities ?? []
  const boundProviders: string[] = profile?.bound_providers ?? []
  const oauthProvider = profile?.oauth_provider
  const oauthName = profile?.oauth_name
  const oauthEmail = profile?.oauth_email

  // ── Account security check (on-demand, per-user, never cached) ──
  // Deliberately NOT an AiInsightPanel: page insights are cached globally by
  // page name, so a per-user postures would leak between accounts. This is a
  // one-shot call built from *this* user's own profile.
  const [secBusy, setSecBusy] = useState(false)
  const [secResult, setSecResult] = useState('')

  const handleSecurityCheck = async () => {
    if (secBusy) return
    setSecBusy(true)
    setSecResult('')
    try {
      const facts = [
        `用户名: ${auth.user || profile?.user || '?'}`,
        `角色: ${auth.role || profile?.role || '?'}`,
        `权限数量: ${auth.perms.size}`,
        `已绑定身份: ${boundProviders.join(', ') || '无'}（共 ${identities.length} 个）`,
        `登录方式: ${oauthProvider ? `OAuth — ${PROVIDER_LABELS[oauthProvider] || oauthProvider}` : '本地密码'}`,
        `推送通知: ${pushEnabled ? '已开启' : '未开启'}`,
      ].join('\n')
      const res = await aiApi.chat({
        message: `以下是我当前的账户状态，请做一次简要的安全体检：\n\n${facts}`,
        system: '你是一个账户安全顾问。根据用户提供的账户状态，用简体中文给出简短的安全评估：先一句话总体结论，再列 2-4 条具体、可执行的改进建议（如开启推送告警、绑定备用登录方式、避免共享账号等）。只依据已提供的信息，不要编造。',
      })
      setSecResult(res.content || '未返回结果')
    } catch (e: any) {
      toast({ type: 'error', message: e.message || '安全体检失败，请重试' })
    } finally {
      setSecBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="个人管理" description="账户设置与身份绑定" doc={{ section: 'profile', item: 0, label: '账户文档' }}>
        <PageAiAssistant page="profile" context={profile ? `用户: ${profile.user ?? '?'}, 角色: ${profile.role ?? '?'}, 身份绑定: ${identities.length} 个 (${boundProviders.join(', ') || '无'}), OAuth: ${oauthProvider ?? '无'}${oauthName ? ` (${oauthName})` : ''}` : '暂无用户数据'} />
      </PageHeader>

      {/* Account Info */}
      <Card data-onboarding-target="profile-account" padding="lg" className="mb-6">
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
      <Card data-onboarding-target="profile-oauth" padding="lg" className="mb-6">
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
                  data-onboarding-target="profile-oauth-bind"
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

      <Card data-onboarding-target="profile-theme" padding="lg" className="mb-6">
        <h2 className="text-sm font-semibold">外观主题</h2>
        <p className="mb-3 mt-1 text-xs text-muted">选择白天、黑夜，或自动跟随浏览器。偏好保存在当前浏览器。</p>
        <div className="max-w-sm"><ThemePicker /></div>
      </Card>

      {/* Password */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">修改密码</h2>
            <p className="text-xs text-muted mt-0.5">更新你的登录密码</p>
          </div>
          <Button data-onboarding-target="profile-password" variant="secondary" size="sm" onClick={() => setPwOpen(true)}><Key size={14} /> 修改</Button>
        </div>
      </Card>

      {/* Account Security Check */}
      <Card data-onboarding-target="profile-security" padding="lg" className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-light text-accent">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2 className="text-sm font-semibold">账户安全体检</h2>
              <p className="mt-0.5 text-xs text-muted">基于你当前的账户状态，让 AI 现场给出安全评估与改进建议。</p>
            </div>
          </div>
          <Button data-onboarding-target="profile-security-run" variant="secondary" size="sm" onClick={handleSecurityCheck} disabled={secBusy}>
            {secBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {secBusy ? '体检中…' : '开始体检'}
          </Button>
        </div>
        {secResult && (
          <div className="mt-4 rounded-xl bg-black/[0.02] p-4 text-sm">
            <MarkdownContent content={secResult} />
          </div>
        )}
      </Card>

      {/* PWA Install */}
      <Card data-onboarding-target="profile-install" padding="lg" className="mb-6">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-light text-accent">
            <Smartphone size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">YatTerra 应用</h2>
            <p className="mt-0.5 text-xs leading-5 text-muted">
              {isInstalled
                ? '应用已安装，可从桌面或主屏幕直接打开；资源管理和终端操作仍需联网。'
                : isIos
                  ? '在 Safari 中点击分享 → 添加到主屏幕，即可像应用一样使用。'
                  : '安装到桌面或主屏幕，通过独立窗口快速打开。资源管理和终端操作仍需联网。'}
            </p>
            {isInstalled ? (
              <p className="mt-2 text-xs font-semibold text-green-600">已安装</p>
            ) : canInstall ? (
              <Button data-onboarding-target="profile-install-btn" className="mt-3" size="sm" onClick={() => { void promptInstall().catch(() => toast({ type: 'error', message: '未能打开安装提示，请通过浏览器菜单安装。' })) }}>
                <Download size={14} /> 安装应用
              </Button>
            ) : (
              <p className="mt-2 text-xs text-muted">也可以使用浏览器菜单中的“安装应用”或“添加到主屏幕”。</p>
            )}
          </div>
        </div>
      </Card>

      {/* Version Update */}
      <Card padding="lg" className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">版本更新</h2>
            <p className="mt-0.5 text-xs text-muted">检查并获取最新版本，刷新后即可使用。</p>
          </div>
          <Button data-onboarding-target="profile-update" variant="secondary" size="sm" onClick={handleCheckUpdate} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            {checking ? '检查中…' : '检查更新'}
          </Button>
        </div>
      </Card>

      {/* Push Notifications */}
      <Card data-onboarding-target="profile-push" padding="lg">
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
            data-onboarding-target="profile-push-toggle"
            checked={pushEnabled}
            onChange={handlePushToggle}
            disabled={!pushSupported || pushState === 'denied' || pushBusy}
          />
        </div>
        {pushSupported && pushPrefs !== undefined && (
          <div data-onboarding-target="profile-push-kinds" className="mt-4 pt-4 border-t border-black/[0.06]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2">通知类型偏好</p>
              <Button
                data-onboarding-target="profile-push-save"
                variant="secondary"
                size="sm"
                onClick={() => savePrefsMut.mutate()}
                disabled={!prefsDirty || savePrefsMut.isPending}
              >
                {savePrefsMut.isPending ? '保存中…' : '保存偏好'}
              </Button>
            </div>
            <p className="text-xs text-muted mb-3">选择要接收的推送类型，默认全部开启。</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {PUSH_KINDS.map(({ kind, label }) => {
                const on = enabledKinds === null || enabledKinds.has(kind)
                return (
                  <button
                    key={kind}
                    onClick={() => { haptic('light'); toggleKind(kind) }}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-black/[0.03] active:bg-black/[0.06] transition-colors text-left"
                  >
                    <span
                      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                        on ? 'bg-accent border-accent text-white' : 'border-black/20 bg-white'
                      }`}
                    >
                      {on && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span className={`text-sm ${on ? 'text-ink' : 'text-muted'}`}>{label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
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
