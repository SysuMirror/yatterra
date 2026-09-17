# web/frontend/ — React + Vite SPA

平台管理界面。构建产物发布到 `../static/spa/`，由 Flask 兜底路由提供。

## 技术栈

React 18 · Vite 8 · TypeScript · Tailwind 4 · TanStack Query · framer-motion ·
react-router 7 · recharts · xterm · CodeMirror · vite-plugin-pwa（Workbox injectManifest）

## 目录

| 目录 | 内容 |
|---|---|
| `src/routes/` | 页面（按 URL 分文件；`_layout.tsx` 是外壳，`_auth.layout.tsx` 是登录守卫） |
| `src/routes/infra/` | 基础设施页：`index` `host` `fleet` `gpu` `storage` `databases` `proxy` |
| `src/routes/dev/` | 开发页：`index` `harness` `mcp` `llm` |
| `src/routes/ops/` | 运维页：`index` `audit` `shared` |
| `src/routes/pods/` | `index`（列表）、`$name.tsx`（详情，含子域名/部署/成员标签页） |
| `src/components/ui/` | 无业务的基础组件（Button/Card/Dialog/DataTable/…） |
| `src/components/domain/` | 业务组件（AiInsightPanel/AgentWidget/DocHint/…） |
| `src/components/pod/` | Pod 详情各标签页 |
| `src/components/layout/` | 外壳：Sidebar/TopBar/PageHeader/AppShell |
| `src/components/ai/` | Markdown 渲染、推理展示、工具调用块 |
| `src/api/` | 后端接口封装（每个资源一个文件） |
| `src/hooks/` `src/lib/` `src/stores/` | 通用 hooks / 工具函数 / zustand store |
| `scripts/publish_spa.py` | 构建 + 发布（**唯一正确的发布方式**） |
| `tests/test_publish_spa.py` | 发布脚本的单元测试 |

## 构建与发布

```bash
cd /opt/yatterra/web/frontend
npm run build:stage                      # 输出 staging 目录路径
npm run publish:spa -- --staging <路径>   # 原子发布到 ../static/spa/
npx tsc --noEmit -p tsconfig.json        # 类型检查（提交前建议跑）
```

`publish_spa.py` 保证：不清理 live 目录、逐文件原子替换、不可变 asset 不允许
内容冲突、`index.html`/`sw.js` 最后写。

细节见 [SKILL.md](SKILL.md)。
