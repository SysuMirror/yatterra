import { Link } from 'react-router';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Clipboard, CircleAlert, CircleCheck, ExternalLink, Flag, LockKeyhole } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
export interface Lesson {
  id: string;
  title: string;
  goal: string;
  prerequisites: string[];
  steps: string[];
  feature: string;
  acceptance: string[];
  errors: string[];
  example?: string;
}
const APP = `import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
PORT = int(os.environ.get("PORT", "8080"))
GREETING = os.environ.get("APP_GREETING", "hello from my Pod")
LOG_DIR = os.environ.get("LOG_DIR", "/home/cloud/logs")
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(level=logging.INFO, handlers=[logging.StreamHandler(), logging.FileHandler(os.path.join(LOG_DIR, "app.log"))])
class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode(); self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/health": self.send_json(200, {"ok": True})
        elif self.path == "/": self.send_json(200, {"message": GREETING})
        else: self.send_json(404, {"error": "not found"})
    def log_message(self, fmt, *args): logging.info("%s - %s", self.address_string(), fmt % args)
logging.info("starting on 0.0.0.0:%s", PORT)
ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()`;
const DEPLOY = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec python3 app.py`;
const L = (id: string, title: string, goal: string, steps: string[], feature: string, acceptance: string[], errors: string[], prerequisites = ['可以登录平台'], example?: string): Lesson => ({
  id,
  title,
  goal,
  prerequisites,
  steps,
  feature,
  acceptance,
  errors,
  example
});
export const lessons: Lesson[] = [
  L('concepts', '先建立模型', '理解 Pod、部署、服务和健康检查各自负责什么。', ['Pod 是隔离的运行环境；部署是其中一份可重复执行的应用配置。', '服务部署持续运行前台进程；一次性部署完成后可以结束。', '平台只显示实际配置的端口和连接入口，不要自行猜测公网地址。'], 'Pod 详情中的部署标签页。', ['能说清 Pod 与部署的区别', '知道应用监听 0.0.0.0 和平台提供的 PORT'], ['把容器、宿主机和公网端口当成同一个值', '把后台 daemon 当作服务进程']),
  L('pod', '创建 Pod', '创建可以承载应用的空环境。', ['打开 Pod 列表，创建并填写合法的小写名称。', '按实际需要选择 CPU、内存、GPU 和存储；先用最小规格验证。', '确认 Pod 为 Running 后再部署应用。部署列表为空时才显示快速模板；点击模板会写入示例文件并立即部署，不是预览。'], '创建向导和资源校验。', ['Pod 出现在列表', '详情页显示当前权限允许的标签'], ['名称含大写、空格或下划线', '把模板按钮当作只保存、不启动'], ['完成“先建立模型”']),
  L('connect', '连接与文件', '用平台入口安全地查看工作区。', ['连接标签页只复制实际显示的 SSH 命令或 Web 地址。', '没有连接信息时使用页面实际提供的文件或终端能力；不要拼接主机、端口或凭证。', '代码放在工作区，密码和 Token 不写入文件或提交。'], '连接标签页。', ['能打开工作区看到仓库文件', '没有把凭证贴进聊天、截图或仓库'], ['页面无端点却尝试公共主机', '把平台密码提交到 Git'], ['已有一个 Pod']),
  L('first-app', '运行第一个应用', '运行一个不需额外依赖的 Python HTTP 应用。', ['先在文件页创建 /home/cloud/tutorial-app 目录，再创建 app.py，使用下方完整示例，读取 PORT、APP_GREETING、LOG_DIR 并提供 /health。', '把下方脚本保存为同目录 deploy.sh。在终端执行 cd /home/cloud/tutorial-app && chmod +x deploy.sh；不需要 requirements.txt。用 exec 保持前台进程，不使用 nohup、& 或自行 daemonize。', '在部署页选择本地脚本，名称 tutorial-app，路径 /home/cloud/tutorial-app/deploy.sh，服务模式和健康路径 /health。普通创建只保存，再点击启动/Deploy。不要与已占用 8080 的模板同时运行。'], '部署页支持仓库来源和前台服务。', ['/health 返回 200 与 {"ok": true}', '/ 返回 APP_GREETING', '日志在标准输出和 LOG_DIR/app.log'], ['Flask 模板不会自动读取 APP_GREETING；若用模板，编辑 app.py 的根路由返回值为 jsonify(message=os.environ.get("APP_GREETING", "hello"))，再 Deploy', '只监听 127.0.0.1', '用 nohup 让 supervisor 看不到退出'], ['已能编辑 Pod 中的仓库文件'], APP),
  L('environment', '配置环境变量', '安全配置运行时变量并理解何时生效。', ['在 Pod「设置 → 环境变量」填写 APP_GREETING=hello-v2；把变量当敏感信息处理，不要截图、打印全部环境或放入仓库。', 'PORT 由平台提供，应用允许 PORT 覆盖（默认 8080）；LOG_DIR 默认 /home/cloud/logs。', '保存环境变量会触发 rollout；随后必须重新运行 Deploy，让新环境重新生成并注入。'], '环境变量保存和部署重跑。', ['重跑后 / 返回新问候语', '环境变量不出现在日志、截图或提交'], ['保存变量却不重新 Deploy', '把 PORT 写死', '在前端展示秘密值'], ['已有已保存的部署配置']),
  L('logs', '读日志与健康检查', '用日志和健康端点判断应用是否运行。', ['先看部署日志，再看应用日志确认监听。', '用平台显示的入口请求 /health；健康门在部署时运行：HTTP 探测或应用上报 ready 可使其通过，不是持续可用性监控。', '日志写 stdout，示例也写 LOG_DIR；不使用 nohup 隐藏进程。'], '部署日志、应用日志和健康检查。', ['区分构建失败、进程退出、健康失败', '看到监听地址和请求记录'], ['只看部署成功不验证 /health', '健康路径错或非 2xx', '日志目录不存在且应用未创建'], ['第一个应用已部署']),
  L('deploy', '保存、启动与重新部署', '掌握普通部署的完整生命周期。', ['本地来源填写可执行 deploy.sh 路径；仓库来源填写 repo、分支与可选子目录（脚本放在所选目录）。配置服务模式、健康路径 /health，先保存。', '保存不会替代启动；点击 Deploy/启动运行普通部署。', '代码或变量改变后重新 Deploy；不要把一次性创建当持续发布。'], '部署配置保存、启动、停止和日志轮询。', ['保存后配置仍在', 'Deploy 后状态和日志更新', '停止后前台进程退出'], ['只保存不启动', '没有 exec', '平台不保证 zero downtime'], ['应用仓库包含 app.py 和 deploy.sh']),
  L('recovery', '失败、回滚与恢复', '失败时保留证据并恢复已知良好版本。', ['保存部署日志、时间和错误；先修根因，不反复点击掩盖证据。', '健康门只在部署启动阶段执行，不是持续探活。有 last_good_ref 时平台会尝试重置仓库并重启；仅仓库来源且存在可用的上一良好 ref 时才可能恢复。本地脚本和首次部署不能依赖这种回滚。', '健康门失败以日志和 /health 为准；恢复后重新验证。'], '部署状态、日志和重新部署。', ['指出失败在保存、启动、脚本或健康门哪一步', '恢复版本通过 /health'], ['没有上一版本却声称可回滚', '把重启当修复', '把健康门当零停机'], ['至少一次成功部署或已知良好 Git ref']),
  L('webhook', '配置自动部署 Webhook', '让受控 Git 推送触发部署而不暴露秘密。', ['下方 URL 基于当前平台 origin 生成；让管理员确认仓库服务可访问这个入口。全局 secret 由管理员管理，教程不显示也不复制。', 'GitHub 配置 push 事件与 application/json，Gitee 配置 push；按仓库平台选择下方 source URL。管理员在仓库侧安全配置同一全局 secret，不粘贴到聊天或截图。', '在平台的仓库部署配置中填写 repo、明确且非空的 branch，并勾选 auto_deploy（自动部署）。推送的仓库须匹配且分支名必须精确一致；不是向 webhook 手写这三个字段。', '测试推送后查看部署日志。'], '管理员管理的全局 secret 与部署日志。', ['部署配置有非空 branch、匹配的 repo、auto_deploy=true', '日志确认匹配', '没有 secret 出现在页面或截图'], ['把 secret 写进代码或教程', 'branch/repo 为空', 'auto_deploy 缺失或为 false', 'GitHub URL 用在 Gitee'], ['管理员已准备 Webhook 全局密钥', '仓库有 GitHub 或 Gitee URL'], '<当前平台 origin>/deploy/webhook?source=github\n<当前平台 origin>/deploy/webhook?source=gitee'),
  L('access', '访问应用', '从平台显示入口验证应用，而不是猜端口。', ['回到连接或部署区域复制当前显示的应用入口。', '请求 / 和 /health；没有入口就使用实际连接方式。', '受限时检查 Pod 状态、端口映射、监听地址和健康日志。'], '按权限显示的连接信息和 Web 入口。', ['根路径和健康路径通过实际入口', '未授权用户看不到凭证'], ['使用固定域名或端口', '只在 Pod 内 curl 127.0.0.1 就认为公网可用'], ['部署通过健康检查']),
  L('services', '服务与一次性任务', '选择正确进程模式并理解 supervisor 重启行为。', ['长期 HTTP 服务选择服务模式，保持前台进程并用 exec。', '迁移或批处理选择一次性任务；退出码 0 表示成功（进程可显示 EXITED）。oneshot 不保证只执行一次：supervisor 重启时 autostart 仍可能再次运行，任务要可安全重复执行。', '需要数据库或对象存储时，到当前可见的凭证/服务页面获取 MySQL、Redis、MinIO 等实际连接信息；不要复制示例密码，不在公网暴露服务。没有入口或权限时联系负责人。'], '服务/一次性任务模式、状态徽标，以及权限允许的基础服务凭证。', ['服务退出可被平台观察', '区分任务完成与服务运行'], ['一次性脚本无限循环', '脚本 fork 到后台', '把自动启动当健康检查或零停机'], ['理解 deploy.sh 前台执行']),
  L('collaboration', '协作与发布习惯', '让多人修改可追踪、可恢复。', ['负责人在成员页按实际可用操作添加成员、审批申请并核对角色；变更前先确认用户身份，按最小权限协作。', '每次发布记录分支、commit、环境变更和验证；秘密只由平台管理。', '先在约定分支验证，再由一位负责人 Deploy，避免并发覆盖。'], '成员角色、部署日志和共享配置。', ['部署可追溯到 repo、branch、ref', '协作者只有必要权限'], ['共享管理员凭证', '多人同时发布无约定', '截图分享环境变量'], ['团队成员已加入 Pod']),
  L('troubleshooting', '排障清单', '按最短路径定位部署、运行和访问问题。', ['Pod 不运行：查 Pod 状态和资源；应用不运行：查部署日志、退出码和应用日志。', '健康失败：确认监听 0.0.0.0、使用 PORT、路径返回 2xx，并确认保存变量后已重新 Deploy。', '访问失败：只用实际入口，检查端口和权限；必要时回上一已知良好 ref。'], '状态徽标、日志和健康检查。', ['按 Pod → 部署 → 进程 → 健康 → 入口定位', '修复后重新 Deploy 并记录'], ['遇到错误就删除 Pod', '没有日志就认为没问题', '把占位符域名当真实入口'], ['完成至少一次部署']),
];
function CopyExample({
  value
}: {
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      setFailed(false);
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };
  return <div className="relative mb-4">
      <pre className="overflow-x-auto rounded-lg bg-black/[0.04] px-4 py-3 pr-14 text-[12px] leading-relaxed font-mono text-ink whitespace-pre">{value}</pre>
      <button type="button" onClick={copy} aria-label="复制示例" className="absolute right-2 top-2 rounded-md p-2 text-muted hover:bg-black/[0.06]">{copied ? <Check size={15} /> : <Clipboard size={15} />}</button>
      <span role="status" className="text-xs text-muted">{failed ? "复制失败，请手动选择并复制示例。" : copied ? "已复制" : ""}</span>
      </div>;
}
export default function LearningPath({
  lessonId,
  canViewStaffDocs = false
}: {
  lessonId?: string;
  canViewStaffDocs?: boolean;
}) {
  const i = Math.max(0, lessons.findIndex(x => x.id === lessonId));
  const l = lessons[i] ?? lessons[0]!;
  const prev = lessons[i - 1],
    next = lessons[i + 1];
  return <div className="space-y-4">{lessonId && !lessons.some(x => x.id === lessonId) && <p role="status" className="text-sm text-muted">未找到该课程，已显示第一节；请从课程目录选择。</p>}<Card className="border-accent/20 bg-accent/[0.03]">
      <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
      <div className="mb-2 flex items-center gap-2">
      <Badge variant="accent">学习路径</Badge>
      <span className="text-xs text-muted">第 {i + 1} / {lessons.length} 节</span>
      </div>
      <h2 className="text-xl font-semibold text-ink">{l.title}</h2>
      <p className="mt-1 text-sm text-ink-2">{l.goal}</p>
      </div>
      <div className="flex gap-2 text-xs">
      <Link to="/docs?view=reference" className="inline-flex items-center gap-1 rounded-md border border-black/[0.08] px-3 py-2 text-ink-2 hover:bg-black/[0.04]">
      <ExternalLink size={13} />参考文档</Link>{canViewStaffDocs && <Link to="/docs?view=admin" className="inline-flex items-center gap-1 rounded-md border border-black/[0.08] px-3 py-2 text-ink-2 hover:bg-black/[0.04]">
      <LockKeyhole size={13} />管理参考</Link>}</div>
      </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
      <Card>
      <div className="space-y-5">
      <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
      <Flag size={15} className="text-accent" />前置条件</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{l.prerequisites.map(x => <li key={x}>{x}</li>)}</ul>
      </section>
      <section>
      <h3 className="mb-2 text-sm font-semibold text-ink">操作步骤</h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-2">{l.steps.map(x => <li key={x}>{x}</li>)}</ol>
      </section>{l.example && <section>
      <h3 className="mb-2 text-sm font-semibold text-ink">可复制示例</h3>{l.id === "first-app" && <p className="mb-2 text-sm text-muted">依次保存为 app.py 与 deploy.sh；完整旧版教程见 <Link className="text-accent" to="/docs?s=pods&i=4">新手部署步骤</Link>。</p>}<CopyExample value={l.id === "webhook" ? l.example.replaceAll("<当前平台 origin>", window.location.origin) : l.example} />{l.id === 'first-app' && <CopyExample value={DEPLOY} />}</section>}<section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
      <CircleCheck size={15} className="text-ok" />完成标准</h3>
      <ul className="space-y-1 text-sm text-ink-2">{l.acceptance.map(x => <li key={x}>✓ {x}</li>)}</ul>
      </section>
      <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
      <CircleAlert size={15} className="text-warn" />常见错误</h3>
      <ul className="space-y-1 text-sm text-ink-2">{l.errors.map(x => <li key={x}>• {x}</li>)}</ul>
      </section>
      <div className="rounded-lg bg-black/[0.03] px-3 py-2 text-sm text-ink-2">
      <strong className="text-ink">平台能力：</strong> {l.feature}</div>
      </div>
      </Card>
      <Card padding="none">
      <div className="border-b border-black/[0.06] px-4 py-3 text-sm font-semibold text-ink">全部课程</div>
      <nav aria-label="课程目录" className="max-h-[620px] overflow-y-auto p-2">{lessons.map((x, n) => <Link aria-current={x.id === l.id ? "page" : undefined} key={x.id} to={`/docs?lesson=${x.id}`} className={cn('block rounded-md px-3 py-2 text-sm', x.id === l.id ? 'bg-accent/[0.1] font-medium text-accent' : 'text-ink-2 hover:bg-black/[0.04]')}>
      <span className="mr-2 text-xs text-muted">{n + 1}</span>{x.title}</Link>)}</nav>
      </Card>
      </div>
      <div className="flex items-center justify-between gap-3">
      <Link aria-disabled={!prev} tabIndex={prev ? 0 : -1} to={prev ? `/docs?lesson=${prev.id}` : '/docs'} className={cn('inline-flex items-center gap-1 rounded-md border border-black/[0.08] px-3 py-2 text-sm text-ink-2 hover:bg-black/[0.04]', !prev && 'pointer-events-none opacity-40')}>
      <ArrowLeft size={15} />上一节</Link>
      <Link aria-disabled={!next} tabIndex={next ? 0 : -1} to={next ? `/docs?lesson=${next.id}` : '/docs'} className={cn('inline-flex items-center gap-1 rounded-md border border-accent/30 px-3 py-2 text-sm text-accent hover:bg-accent/[0.06]', !next && 'pointer-events-none opacity-40')}>下一节<ArrowRight size={15} />
      </Link>
      </div>
      </div>;
}
