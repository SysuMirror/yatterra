import { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowUpRight, Fingerprint, KeyRound, LockKeyhole, Sparkles, UserRound } from 'lucide-react'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  ssemarket: 'SSE Market 授权失败',
  unisso: 'UniSSO 授权失败',
  missing_params: 'OAuth 回调参数缺失',
  invalid_state: 'OAuth state 验证失败，请重试',
  no_token: '未获取到授权令牌',
}

function TerraMark({ small = false }: { small?: boolean }) {
  const size = small ? 40 : 58
  return (
    <svg width={size} height={size} viewBox="0 0 58 58" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="terra-login-mark" x1="8" y1="8" x2="50" y2="51" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9DEBFF" />
          <stop offset=".48" stopColor="#5C8BFF" />
          <stop offset="1" stopColor="#B56DFF" />
        </linearGradient>
      </defs>
      <circle cx="29" cy="29" r="22" stroke="url(#terra-login-mark)" strokeWidth="1.4" strokeDasharray="2 4" opacity=".7" />
      <path d="M16 25.2 29 16l13 9.2v14.1L29 47l-13-7.7V25.2Z" stroke="url(#terra-login-mark)" strokeWidth="2" />
      <path d="m16.5 25.5 12.7 7.8 12.4-7.8M29.2 33.3V47" stroke="url(#terra-login-mark)" strokeWidth="1.7" />
      <circle cx="29" cy="15.8" r="3" fill="#B9F4FF" />
      <circle cx="16" cy="25.4" r="2.2" fill="#789BFF" />
      <circle cx="42" cy="25.4" r="2.2" fill="#C183FF" />
    </svg>
  )
}

function NetworkArt() {
  const nodes = [[86, 389], [198, 283], [284, 324], [402, 170], [522, 242], [144, 116], [262, 190], [390, 130]]
  return (
    <svg viewBox="0 0 640 500" fill="none" className="pointer-events-none absolute inset-0 h-full w-full opacity-90" aria-hidden="true">
      <defs>
        <linearGradient id="terra-login-line" x1="80" y1="80" x2="560" y2="410" gradientUnits="userSpaceOnUse">
          <stop stopColor="#70E5FF" stopOpacity=".55" />
          <stop offset="1" stopColor="#9577FF" stopOpacity=".08" />
        </linearGradient>
        <radialGradient id="terra-login-orb">
          <stop stopColor="#5CD8FF" stopOpacity=".45" />
          <stop offset="1" stopColor="#5CD8FF" stopOpacity="0" />
        </radialGradient>
        <filter id="terra-login-glow">
          <feGaussianBlur stdDeviation="12" />
        </filter>
      </defs>
      <circle cx="470" cy="92" r="150" fill="url(#terra-login-orb)" filter="url(#terra-login-glow)" opacity=".28" />
      <ellipse cx="330" cy="268" rx="213" ry="94" stroke="url(#terra-login-line)" strokeWidth="1" transform="rotate(-20 330 268)" />
      <ellipse cx="330" cy="268" rx="213" ry="94" stroke="url(#terra-login-line)" strokeWidth="1" opacity=".5" transform="rotate(48 330 268)" />
      <path d="M86 389 198 283l86 41 118-154 120 72" stroke="url(#terra-login-line)" strokeWidth="1" strokeDasharray="4 8" />
      <path d="M144 116 262 190l128-60 112 88" stroke="url(#terra-login-line)" strokeWidth="1" strokeDasharray="3 9" opacity=".6" />
      {nodes.map(([cx, cy], index) => (
        <g key={`${cx}-${cy}`}>
          <circle cx={cx} cy={cy} r="4" fill={index % 3 === 0 ? '#A2F1FF' : '#9A87FF'} />
          <circle cx={cx} cy={cy} r="11" stroke={index % 3 === 0 ? '#64DFFF' : '#9077FF'} opacity=".25" />
        </g>
      ))}
    </svg>
  )
}

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [health, setHealth] = useState<'checking' | 'ok' | 'error'>('checking')
  const navigate = useNavigate()
  const { login } = useAuthStore()
  const [searchParams] = useSearchParams()

  useEffect(() => {
    const oauthError = searchParams.get('oauth_error')
    if (oauthError) {
      const detail = searchParams.get('detail')
      const base = OAUTH_ERROR_MESSAGES[oauthError] || `授权失败 (${oauthError})`
      setError(detail ? `${base}: ${detail}` : base)
    }
  }, [searchParams])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    // /health is unauthenticated and lives outside /api, so probe it directly.
    fetch('/health', { signal: controller.signal, credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return
        setHealth(data?.health === 'ok' ? 'ok' : 'error')
      })
      .catch(() => {
        if (!cancelled) setHealth('error')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await api.post<any>('/auth/login', { username, password })
      login(data.user, data.role, data.perms || [])
      navigate('/console')
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const handleGuestLogin = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.post<any>('/auth/guest')
      login(data.user, data.role, data.perms || [])
      navigate('/console')
    } catch (err: any) {
      setError(err.message || '游客登录失败')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    background: 'rgba(10, 17, 36, .72)',
    border: '1px solid rgba(158, 185, 255, .14)',
    color: '#F5F7FF',
  }
  const oauthStyle = {
    background: 'rgba(255,255,255,.055)',
    border: '1px solid rgba(255,255,255,.12)',
    color: '#EAF0FF',
  }

  return (
    <main
      className="relative min-h-screen overflow-hidden bg-[#070B18] text-[#F5F7FF]"
      style={{ backgroundImage: 'radial-gradient(circle at 15% 10%, rgba(71, 103, 210, .23), transparent 36%), radial-gradient(circle at 84% 85%, rgba(108, 68, 184, .2), transparent 34%)' }}
    >
      <div
        className="absolute inset-0 opacity-[.18]"
        style={{
          backgroundImage: 'linear-gradient(rgba(150,180,255,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(150,180,255,.12) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'linear-gradient(to bottom, black, transparent 75%)',
        }}
      />

      <div className="relative mx-auto grid min-h-screen w-full max-w-[1240px] items-center gap-10 px-5 py-8 sm:px-10 lg:grid-cols-[1fr_440px] lg:gap-20 lg:px-14">
        <section className="relative hidden min-h-[620px] flex-col justify-between py-4 lg:flex">
          <div className="flex items-center gap-3">
            <TerraMark small />
            <span className="text-[17px] font-semibold tracking-[.18em] text-white">YATERRA</span>
            <span className="rounded-full border border-cyan-200/20 px-2 py-1 text-[9px] font-medium tracking-[.2em] text-cyan-100/60">CONSOLE</span>
          </div>

          <div className="relative -mt-10 max-w-[580px]">
            <NetworkArt />
            <div className="relative z-10">
              <p className="mb-5 flex items-center gap-2 text-xs font-medium uppercase tracking-[.28em] text-cyan-200/70">
                <Sparkles size={14} />
                AI infrastructure, reimagined
              </p>
              <h1 className="max-w-xl text-5xl font-semibold leading-[1.04] text-white xl:text-[4.4rem]">
                让每一个
                <br />
                <span className="bg-gradient-to-r from-cyan-200 via-blue-300 to-violet-300 bg-clip-text text-transparent">想法落地。</span>
              </h1>
              <p className="mt-7 max-w-md text-[15px] leading-7 text-slate-400">
                连接集群、模型与工作负载。YatTerra 将复杂的基础设施，收敛成一个清晰而可靠的控制面。
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span
              className={
                health === 'ok'
                  ? 'h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_12px_#6ee7b7]'
                  : health === 'error'
                    ? 'h-1.5 w-1.5 rounded-full bg-amber-300 shadow-[0_0_12px_#fcd34d]'
                    : 'h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400'
              }
            />
            <span className={health === 'error' ? 'text-amber-200/90' : undefined}>
              {health === 'checking' ? '检查中…' : health === 'ok' ? '所有系统运行正常' : '部分服务异常'}
            </span>
            <span className="mx-1 text-slate-700">/</span>
            <span>安全连接 · 私有部署</span>
          </div>
        </section>

        <motion.section
          className="relative w-full max-w-[440px] justify-self-center rounded-[28px] border border-white/[.13] bg-[#10182d]/[.88] p-6 shadow-[0_28px_90px_rgba(0,0,0,.38)] backdrop-blur-2xl sm:p-9"
          initial={{ opacity: 0, y: 18, scale: .98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: .55, ease: [.23, 1, .32, 1] }}
        >
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <TerraMark small />
            <span className="text-base font-semibold tracking-[.16em]">YATERRA</span>
          </div>

          <div className="mb-7">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-200/20 bg-cyan-300/[.08]">
              <LockKeyhole size={20} className="text-cyan-200" />
            </div>
            <h2 className="text-[28px] font-semibold">登录 YatTerra</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">登录控制台，开始管理你的集群、模型与工作负载。</p>
          </div>

          {error && (
            <motion.div
              className="mb-5 rounded-xl border border-rose-300/20 bg-rose-400/[.09] px-3.5 py-3 text-sm leading-5 text-rose-100"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {error}
            </motion.div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs font-medium tracking-wide text-slate-300">用户名</span>
              <div className="relative">
                <UserRound size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input required type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="输入用户名" className="h-12 w-full rounded-xl pl-10 pr-3.5 text-sm outline-none transition duration-200 placeholder:text-slate-600 focus:border-cyan-200/60 focus:bg-[#121e3a] focus:shadow-[0_0_0_4px_rgba(103,232,249,.09)]" style={inputStyle} />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-medium tracking-wide text-slate-300">密码</span>
              <div className="relative">
                <KeyRound size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入密码" className="h-12 w-full rounded-xl pl-10 pr-3.5 text-sm outline-none transition duration-200 placeholder:text-slate-600 focus:border-cyan-200/60 focus:bg-[#121e3a] focus:shadow-[0_0_0_4px_rgba(103,232,249,.09)]" style={inputStyle} />
              </div>
            </label>

            <motion.button type="submit" disabled={loading} className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-blue-300 text-sm font-semibold text-[#071021] shadow-[0_10px_28px_rgba(91,195,255,.16)] transition duration-200 hover:brightness-110 disabled:cursor-wait disabled:opacity-55" whileTap={{ scale: .975 }}>
              {loading ? '正在验证...' : '登录控制台'}
              {!loading && <ArrowUpRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />}
            </motion.button>
          </form>

          <motion.button type="button" onClick={handleGuestLogin} disabled={loading} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/[.1] bg-white/[.035] text-sm font-medium text-slate-300 transition duration-200 hover:bg-white/[.08] hover:text-white disabled:cursor-wait disabled:opacity-55" whileTap={{ scale: .975 }}>
            <Fingerprint size={16} className="text-slate-400" />
            先看看，不注册
          </motion.button>
          <p className="mt-2.5 text-center text-xs leading-5 text-slate-500">以游客身份进入控制台，无需账号。</p>

          <p className="mt-4 text-center text-xs leading-5 text-slate-500">还没有账号？请联系管理员开通，或先用游客身份体验。</p>

          <div className="my-6 flex items-center gap-3 text-[11px] text-slate-600">
            <span className="h-px flex-1 bg-white/[.09]" />
            其他登录方式
            <span className="h-px flex-1 bg-white/[.09]" />
          </div>

          <div className="space-y-2.5">
            <motion.a href="/api/auth/oauth/ssemarket" className="flex h-11 items-center justify-between rounded-xl px-4 text-sm font-medium transition duration-200 hover:border-cyan-200/35 hover:bg-white/[.09]" style={oauthStyle} whileTap={{ scale: .975 }}>
              <span className="flex items-center gap-2.5"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-300/15 text-[10px] font-bold text-cyan-100">S</span>SSE Market</span>
              <ArrowUpRight size={15} className="text-slate-500" />
            </motion.a>
            <motion.a href="/api/auth/oauth/unisso" className="flex h-11 items-center justify-between rounded-xl px-4 text-sm font-medium transition duration-200 hover:border-violet-200/35 hover:bg-white/[.09]" style={oauthStyle} whileTap={{ scale: .975 }}>
              <span className="flex items-center gap-2.5"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-300/15 text-[10px] font-bold text-violet-100">U</span>UniSSO</span>
              <ArrowUpRight size={15} className="text-slate-500" />
            </motion.a>
          </div>

          <Link to="/" className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-cyan-200">
            <ArrowLeft size={14} />
            返回 YatTerra 项目首页
          </Link>
        </motion.section>
      </div>
    </main>
  )
}
