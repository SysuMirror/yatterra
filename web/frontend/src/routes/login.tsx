import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { motion } from 'framer-motion'
import { Lock } from 'lucide-react'
import { api } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  ssemarket: 'SSE Market 授权失败',
  unisso: 'UniSSO 授权失败',
  missing_params: 'OAuth 回调参数缺失',
  invalid_state: 'OAuth state 验证失败，请重试',
  no_token: '未获取到授权令牌',
}

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuthStore()
  const [searchParams] = useSearchParams()

  // Show OAuth error from redirect query params
  useEffect(() => {
    const oauthError = searchParams.get('oauth_error')
    if (oauthError) {
      const detail = searchParams.get('detail')
      const base = OAUTH_ERROR_MESSAGES[oauthError] || `授权失败 (${oauthError})`
      setError(detail ? `${base}: ${detail}` : base)
    }
  }, [searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await api.post<any>('/auth/login', { username, password })
      login(data.user, data.role, data.perms || [])
      navigate('/')
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-5"
      style={{
        background: 'radial-gradient(ellipse 80% 60% at 10% 20%, rgba(10,132,255,0.18) 0%, transparent 60%), radial-gradient(ellipse 60% 80% at 80% 10%, rgba(191,90,242,0.14) 0%, transparent 55%), linear-gradient(160deg, #f0f4ff 0%, #f5f0ff 30%, #f0fdf4 55%, #fef9f0 80%, #f0f4ff 100%)',
      }}
    >
      <motion.div
        className="w-full max-w-[420px] p-9 rounded-[20px]"
        style={{
          background: 'rgba(255,255,255,0.72)',
          backdropFilter: 'blur(40px) saturate(200%)',
          WebkitBackdropFilter: 'blur(40px) saturate(200%)',
          border: '0.5px solid rgba(255,255,255,0.5)',
          boxShadow: '0 0 0 0.5px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.08), 0 16px 48px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.4)',
        }}
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        {/* Lock icon */}
        <div className="w-12 h-12 mx-auto mb-4 rounded-[14px] flex items-center justify-center"
          style={{ background: 'rgba(10,132,255,0.1)', border: '0.5px solid rgba(10,132,255,0.15)' }}
        >
          <Lock size={24} className="text-accent" />
        </div>

        <h2 className="text-center text-[22px] font-bold tracking-tight mb-1">sseinfra</h2>
        <p className="text-center text-sm text-muted mb-6">请输入用户名和密码以进入控制台</p>

        {error && (
          <motion.div
            className="mb-4 p-3 rounded-lg text-sm font-medium text-bad bg-bad-bg border border-bad/25"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {error}
          </motion.div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-2 mb-1.5">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              placeholder="用户名"
              className="w-full px-3.5 py-2.5 rounded-[10px] text-sm border-[0.5px] border-black/8 bg-white/82 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3.5px_rgba(10,132,255,0.18)] focus:bg-white/85 transition-all duration-100"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-2 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3.5 py-2.5 rounded-[10px] text-sm border-[0.5px] border-black/8 bg-white/82 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3.5px_rgba(10,132,255,0.18)] focus:bg-white/85 transition-all duration-100"
            />
          </div>

          <motion.button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-[10px] text-sm font-semibold text-white bg-accent shadow-[0_0_0_0.5px_rgba(10,132,255,0.3),0_2px_8px_rgba(10,132,255,0.2)] hover:bg-accent-dark disabled:opacity-50 transition-all duration-100"
            whileTap={{ scale: 0.97 }}
          >
            {loading ? '登录中...' : '登录'}
          </motion.button>
        </form>

        <div className="flex items-center gap-3 my-4 text-muted text-xs">
          <div className="flex-1 h-px bg-black/[0.06]" />
          <span>或</span>
          <div className="flex-1 h-px bg-black/[0.06]" />
        </div>

        <div className="space-y-2">
          <motion.a
            href="/api/auth/oauth/ssemarket"
            className="flex items-center justify-center gap-2.5 w-full py-3 rounded-xl text-[15px] font-semibold text-white bg-accent shadow-[0_0_0_0.5px_rgba(10,132,255,0.3),0_2px_8px_rgba(10,132,255,0.2)]"
            whileTap={{ scale: 0.97 }}
          >
            SSE Market 登录
          </motion.a>
          <motion.a
            href="/api/auth/oauth/unisso"
            className="flex items-center justify-center gap-2.5 w-full py-3 rounded-xl text-[15px] font-semibold text-white bg-[#bf5af2] shadow-[0_0_0_0.5px_rgba(191,90,242,0.3),0_2px_8px_rgba(191,90,242,0.2)]"
            whileTap={{ scale: 0.97 }}
          >
            UniSSO 登录
          </motion.a>
        </div>

        <div className="flex items-center gap-3 my-4 text-muted text-xs">
          <div className="flex-1 h-px bg-black/[0.06]" />
          <span>或</span>
          <div className="flex-1 h-px bg-black/[0.06]" />
        </div>

        <motion.button
          onClick={async () => {
            setLoading(true)
            try {
              const data = await api.post<any>('/auth/guest')
              login(data.user, data.role, data.perms || [])
              navigate('/')
            } catch (err: any) { setError(err.message) }
            finally { setLoading(false) }
          }}
          className="w-full py-2.5 rounded-[10px] text-sm font-semibold text-ink-2 bg-white/72 border-[0.5px] border-black/8 shadow-1 hover:bg-white/85 transition-all duration-100"
          whileTap={{ scale: 0.97 }}
        >
          👤 游客访问
        </motion.button>
      </motion.div>
    </div>
  )
}
