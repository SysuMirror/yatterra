/**
 * 页面 AI 助手入口(薄触发器)。
 *
 * 三套助手统一后, 面板本体是挂在 routes/_layout.tsx 的 GlobalAiAssistant
 * (全局单例, 后台执行 + 断线续传 + 完成推送)。本组件只保留各页面
 * PageHeader 里的「AI 助手」按钮和旧 forwardRef send() 入口:
 * - 挂载时把 page/context 登记进全局 store(FAB 打开时即用当前页上下文);
 * - 点击打开全局面板; ref.send(text) 打开面板并自动发送预设问题。
 * props 签名与旧版完全一致, 各页面用法无需改动。
 */
import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AiPageType } from '@/api/ai'
import { useAiAssistantStore } from '@/stores/aiAssistant'
import { usePageAiAllowed } from '@/lib/pagePerms'

interface PageAiAssistantProps {
  page: AiPageType
  context?: string
  className?: string
}

export interface PageAiAssistantHandle {
  send: (text: string) => void
}

export const PageAiAssistant = forwardRef<PageAiAssistantHandle, PageAiAssistantProps>(
  function PageAiAssistant({ page, context, className }, ref) {
    // hide the entry entirely on pages the user has no permission for
    const aiAllowed = usePageAiAllowed(page)
    const registerPage = useAiAssistantStore(s => s.registerPage)
    const openWith = useAiAssistantStore(s => s.openWith)
    const sendFromPage = useAiAssistantStore(s => s.sendFromPage)

    // 登记当前页 + 页面上下文, 供全局面板/FAB 使用
    useEffect(() => {
      registerPage(page, context || '')
    }, [page, context, registerPage])

    useImperativeHandle(ref, () => ({
      send(text: string) {
        sendFromPage(page, context, text)
      },
    }))

    if (!aiAllowed) return null

    return (
      <button
        data-onboarding-target="page-assistant"
        onClick={() => openWith(page, context)}
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all',
          'border-black/[0.08] bg-surface-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-accent',
          className,
        )}
      >
        <Sparkles size={14} />
        <span className="hidden sm:inline">AI 助手</span>
      </button>
    )
  }
)
