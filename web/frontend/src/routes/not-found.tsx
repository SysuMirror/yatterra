import { useNavigate } from 'react-router'
import { Home, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20">
      <span className="text-6xl font-bold text-muted/30">404</span>
      <h2 className="text-xl font-semibold">页面未找到</h2>
      <p className="text-sm text-muted">你访问的页面不存在</p>
      <div className="flex gap-3 mt-2">
        <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> 返回
        </Button>
        <Button size="sm" onClick={() => navigate('/console')}>
          <Home size={14} /> 首页
        </Button>
      </div>
    </div>
  )
}
