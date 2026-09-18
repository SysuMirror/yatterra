import { Link } from 'react-router'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

interface DocHintProps {
  /** Doc section id, e.g. "infra" / "pods" / "ops-knowledge" */
  section: string
  /** Item index within that section (0-based), matching docs.tsx order */
  item?: number
  /** Short label shown next to the icon */
  label?: string
  /** Optional tooltip-ish longer text */
  title?: string
  className?: string
  onboardingTarget?: string
}

/**
 * Small inline "查看文档" affordance that deep-links into /docs.
 *
 * The docs page reads `?s=<section>&i=<item>`, opens that section + item and
 * scrolls it into view — so a hint placed next to a feature lands the user on
 * the exact paragraph that explains it.
 */
export function DocHint({ section, item = 0, label = '文档', title, className, onboardingTarget }: DocHintProps) {
  return (
    <Link
      data-onboarding-target={onboardingTarget}
      data-assistant-control={onboardingTarget === 'page-docs' ? 'page-docs' : undefined}
      data-assistant-label={onboardingTarget === 'page-docs' ? '当前页面文档' : undefined}
      data-assistant-actions={onboardingTarget === 'page-docs' ? 'inspect navigate' : undefined}
      to={`/docs?s=${encodeURIComponent(section)}&i=${item}`}
      title={title ?? '查看相关文档'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted',
        'hover:text-accent hover:bg-accent/[0.08] transition-colors',
        className,
      )}
    >
      <HelpCircle size={12} />
      {label && <span>{label}</span>}
    </Link>
  )
}
