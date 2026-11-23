import { NavLink } from 'react-router'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/cn'

const ITEMS: { to: string; label: string; perm?: string; end?: boolean }[] = [
  { to: '/infra', label: '总览', end: true, perm: 'infra.host.view' },
  { to: '/infra/host', label: '机器', perm: 'infra.host.view' },
  { to: '/infra/gpu', label: '加速器', perm: 'infra.host.view' },
  { to: '/infra/fleet', label: '对比', perm: 'infra.host.view' },
  { to: '/infra/storage', label: '存储', perm: 'infra.storage.read' },
  { to: '/infra/databases', label: '数据库', perm: 'infra.db.read' },
  { to: '/infra/proxy', label: '子域名', perm: 'infra.proxy' },
]

/** Shared child nav so infra pages stay nested under one section. */
export default function InfraNav() {
  const { hasPerm } = useAuth()
  const items = ITEMS.filter((item) => !item.perm || hasPerm(item.perm) || hasPerm('*'))
  return (
    <nav data-ux="ux-infra-nav" aria-label="基础设施" className="mb-4 flex flex-wrap gap-1" data-sticky="ux-infra-sticky">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cn(
            'inline-flex items-center rounded-md px-2.5 py-1 text-xs',
            isActive ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:bg-black/[0.04]',
          )}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
