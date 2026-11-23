import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { billingMoneyApi } from '@/api/billing'
import { useToastStore } from '@/stores/toast'

/** 平台开关：欠费是否限制资源。默认关，关时不扣费、不提醒、不停机。 */
export function ArrearsPolicyCard() {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data } = useQuery({
    queryKey: ['billing-policy'],
    queryFn: () => billingMoneyApi.policy(),
    staleTime: 15_000,
  })
  const on = !!data?.arrears_limit

  const toggle = async (next: boolean) => {
    setBusy(true)
    try {
      await billingMoneyApi.setPolicy(next)
      toast({
        type: 'success',
        message: next
          ? '已打开欠费限制：之后的小时才扣费，欠费会提醒，持续欠费会停机'
          : '已关闭欠费限制：不扣费、不提醒、不限制任何资源',
      })
      void qc.invalidateQueries({ queryKey: ['billing-policy'] })
      void qc.invalidateQueries({ queryKey: ['billing-health'] })
    } catch (e) {
      toast({ type: 'error', message: e instanceof Error ? e.message : '修改失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card padding="lg" className="mb-6" data-onboarding-target="billing-arrears">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert size={16} className={on ? 'text-warn' : 'text-muted'} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">欠费限制资源</div>
          <p className="text-xs text-muted mt-0.5 leading-relaxed">
            {on
              ? (data?.auto_suspend
                ? '已打开。之后的小时会扣费；欠费会提醒；连续欠费后停机并缩到 0 副本。打开之前的用量不补扣。'
                : '已打开扣费和提醒。自动停机目前被环境关掉，欠费不会缩容。打开之前的用量不补扣。')
              : '默认关闭。不扣费、不提醒、不因欠费限制任何资源。'}
          </p>
        </div>
        <Switch
          checked={on}
          disabled={busy || data == null}
          onChange={toggle}
          label={on ? '限制' : '不限制'}
          aria-label="欠费是否限制资源"
        />
      </div>
    </Card>
  )
}
