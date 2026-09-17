import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Outlet, useNavigate, useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import AuthLayout from './routes/_auth.layout'
import MainLayout from './routes/_layout'
import { api, getCsrfToken } from './api/client'
import { useAuthStore } from './stores/auth'
import { useAuth } from './hooks/useAuth'
import { Link } from 'react-router'
import { Skeleton } from './components/ui/Skeleton'
import { setAppBadge, clearAppBadge } from './lib/badge'

// ── Lazy-loaded pages (code splitting) ──
const Login = lazy(() => import('./routes/login'))
const Dashboard = lazy(() => import('./routes/index'))
const PodList = lazy(() => import('./routes/pods/index'))
const PodDetail = lazy(() => import('./routes/pods/$name'))
const HostPage = lazy(() => import('./routes/infra/host'))
const StoragePage = lazy(() => import('./routes/infra/storage'))
const DatabasesPage = lazy(() => import('./routes/infra/databases'))
const ProxyPage = lazy(() => import('./routes/infra/proxy'))
const HarnessPage = lazy(() => import('./routes/dev/harness'))
const McpPage = lazy(() => import('./routes/dev/mcp'))
const DevLlm = lazy(() => import('./routes/dev/llm'))
const InfraOverview = lazy(() => import('./routes/infra/index'))
const DevOverview = lazy(() => import('./routes/dev/index'))
const OpsOverview = lazy(() => import('./routes/ops/index'))
const GpuPage = lazy(() => import('./routes/infra/gpu'))
const FleetPage = lazy(() => import('./routes/infra/fleet'))
const AuditPage = lazy(() => import('./routes/ops/audit'))
const SharedPage = lazy(() => import('./routes/ops/shared'))
const UsersPage = lazy(() => import('./routes/users'))
const ProfilePage = lazy(() => import('./routes/profile'))
const DocsPage = lazy(() => import('./routes/docs'))
const ThreatMapPage = lazy(() => import('./routes/threat-map'))
const NotFound = lazy(() => import('./routes/not-found'))

// ── Global AI components (eager-loaded for instant availability) ──
import { AiContextMenu } from './components/domain/AiContextMenu'

/** Page loading fallback. */
function PageLoader() {
  return <Skeleton height={300} />
}

/**
 * Single auth guard at layout level.
 * - Hydrates from sessionStorage for instant render
 * - Validates with /auth/me in background (non-blocking)
 * - Only redirects to /login if server says not logged in
 */
function AuthGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { isLoggedIn, login, logout } = useAuthStore()

  const { data, isError } = useQuery({
    queryKey: ['auth-check'],
    queryFn: () => api.get<{ is_logged_in: boolean; user: string; role: string; perms: string[] }>('/auth/me'),
    staleTime: 300_000,       // 5 min — don't re-check on every navigation
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,  // only re-check on network reconnect
  })

  // Badge: poll for failed pods + today's attacks
  const { data: badgeData } = useQuery({
    queryKey: ['badge-status'],
    queryFn: async () => {
      try {
        const [pods, threat] = await Promise.all([
          api.get<{ pods: any[] }>('/pods?per_page=200').catch(() => ({ pods: [] })),
          api.get<any>('/threat-map?window=1d').catch(() => ({ stats: {} })),
        ])
        const failed = (pods.pods ?? []).filter((p: any) => p.status === 'Failed').length
        const attacks = threat?.stats?.total_attacks ?? 0
        return failed + attacks
      } catch { return 0 }
    },
    staleTime: 60_000,          // 1 min
    refetchInterval: 120_000,   // poll every 2 min
    enabled: isLoggedIn,        // only when logged in
  })

  useEffect(() => {
    if (!isLoggedIn) { clearAppBadge(); return }
    const count = badgeData ?? 0
    setAppBadge(count)
  }, [badgeData, isLoggedIn])

  useEffect(() => {
    if (!data) return
    if (data.is_logged_in) {
      // Always sync — cached localStorage perms may be stale (e.g. role
      // changed server-side); otherwise revoked perms keep rendering pages
      // that then 403 on every API call.
      login(data.user, data.role, data.perms || [])
    } else {
      logout()
      clearAppBadge()
      if (location.pathname !== '/login') navigate('/login', { replace: true })
    }
  }, [data, isLoggedIn, login, logout, navigate, location.pathname])

  useEffect(() => {
    if (isError && !isLoggedIn && location.pathname !== '/login') {
      navigate('/login', { replace: true })
    }
  }, [isError, isLoggedIn, navigate, location.pathname])

  // If we have cached auth, render immediately (no "Checking auth…" screen)
  // If no cached auth and query hasn't returned yet, show minimal loader
  if (!isLoggedIn && !data && !isError) {
    return <div className="flex items-center justify-center h-[60vh]"><Skeleton height={32} width={120} /></div>
  }

  return <>{children}</>
}

/** Simple 403 page shown when a route's required permission is missing. */
function Forbidden() {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-center px-4">
      <div className="text-5xl font-bold text-muted">403</div>
      <div className="text-lg font-semibold">无权访问</div>
      <p className="text-sm text-muted">你没有访问此页面的权限，请联系管理员开通。</p>
      <Link
        to="/"
        className="mt-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
      >
        返回首页
      </Link>
    </div>
  )
}

/**
 * Route guard: renders children only if the user has one of the required
 * permissions (super's "*" passes everything); otherwise shows a 403 page.
 * Pass no perms to allow all logged-in users.
 */
function RequirePerm({ perms, children }: { perms?: string[]; children: React.ReactNode }) {
  const { hasAnyPerm } = useAuth()
  if (perms && perms.length > 0 && !hasAnyPerm(perms)) return <Forbidden />
  return <>{children}</>
}

export default function App() {
  // Hydrate auth from sessionStorage on first render
  const hydrate = useAuthStore((s) => s.hydrate)
  useEffect(() => { hydrate() }, [hydrate])

  // Prefetch CSRF token in parallel (don't wait for first mutation)
  useEffect(() => { getCsrfToken().catch(() => {}) }, [])

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Auth routes (no sidebar) */}
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<Login />} />
        </Route>

        {/* Main app routes — single AuthGuard at layout level */}
        <Route element={<MainLayout />}>
          <Route element={<AuthGuard><Suspense fallback={<PageLoader />}><Outlet /></Suspense></AuthGuard>}>
            <Route index element={<RequirePerm perms={['group.view']}><Dashboard /></RequirePerm>} />
            <Route path="/pods" element={<RequirePerm perms={['group.view']}><PodList /></RequirePerm>} />
            <Route path="/pods/:name" element={<RequirePerm perms={['group.view']}><PodDetail /></RequirePerm>} />
            <Route path="/infra" element={<RequirePerm perms={['infra.host', 'infra.storage', 'infra.db', 'infra.scheduler', 'infra.proxy']}><InfraOverview /></RequirePerm>} />
            <Route path="/infra/host" element={<RequirePerm perms={['infra.host']}><HostPage /></RequirePerm>} />
            <Route path="/infra/gpu" element={<RequirePerm perms={['infra.host']}><GpuPage /></RequirePerm>} />
            <Route path="/infra/fleet" element={<RequirePerm perms={['infra.host']}><FleetPage /></RequirePerm>} />
            <Route path="/infra/storage" element={<RequirePerm perms={['infra.storage']}><StoragePage /></RequirePerm>} />
            <Route path="/infra/databases" element={<RequirePerm perms={['infra.db']}><DatabasesPage /></RequirePerm>} />
            <Route path="/infra/proxy" element={<RequirePerm perms={['infra.proxy']}><ProxyPage /></RequirePerm>} />
            <Route path="/dev" element={<RequirePerm perms={['dev.harness', 'dev.mcp', 'dev.agent', 'dev.llm']}><DevOverview /></RequirePerm>} />
            <Route path="/dev/harness" element={<RequirePerm perms={['dev.harness']}><HarnessPage /></RequirePerm>} />
            <Route path="/dev/mcp" element={<RequirePerm perms={['dev.mcp']}><McpPage /></RequirePerm>} />
            <Route path="/dev/llm" element={<RequirePerm perms={['dev.llm']}><DevLlm /></RequirePerm>} />
            <Route path="/ops" element={<RequirePerm perms={['ops.audit', 'ops.shared.read', 'ops.shared.write']}><OpsOverview /></RequirePerm>} />
            <Route path="/ops/audit" element={<RequirePerm perms={['ops.audit']}><AuditPage /></RequirePerm>} />
            <Route path="/ops/shared" element={<RequirePerm perms={['ops.shared.read', 'ops.shared.write']}><SharedPage /></RequirePerm>} />
            <Route path="/users" element={<RequirePerm perms={['admin.users']}><UsersPage /></RequirePerm>} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/threat-map" element={<RequirePerm perms={['ops.threat']}><ThreatMapPage /></RequirePerm>} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>

      {/* Global AI context menu — right-click on selected text */}
      <AiContextMenu />
    </Suspense>
  )
}


