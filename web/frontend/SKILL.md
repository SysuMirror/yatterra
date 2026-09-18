---
name: yatterra-frontend
description: 改 YatTerra 前端（页面、组件、样式、PWA、发布）时使用。包含发布流程、路由/组件定位、以及 SPA 缓存等坑。
---

# web/frontend/ — 前端操作指南

## 改完必须发布（两步，不能省）

```bash
cd /srv/yatterra/web/frontend
npx tsc --noEmit -p tsconfig.json                 # 先过类型
npm run build:stage                                # 输出一个 .spa-staging/release-xxxx 路径
npm run publish:spa -- --staging <上一步的路径>      # 原子发布到 ../static/spa/
```

**不要**直接编辑 `../static/spa/`——那是产物，下次发布会覆盖，且可能造成
`index.html` 与 `sw.js` 版本不一致。

验证：

```bash
timeout 15 curl --noproxy '*' -s http://127.0.0.1:8090/ | grep -o 'assets/index-[^"]*\.js'
# 确认新 hash 出现；再确认新页面字符串在对应 chunk 里
grep -rl "你的新增文案" /srv/yatterra/web/static/spa/assets/ | head
```

## 定位

| 想改什么 | 去哪 |
|---|---|
| 某个 URL 的页面 | `src/routes/<对应路径>.tsx` |
| 侧边栏/顶栏/移动端 tab | `src/components/layout/` |
| 页面标题栏（含"使用文档"小提示） | `src/components/layout/PageHeader.tsx` |
| 通用按钮/表格/弹窗 | `src/components/ui/` |
| AI 洞察面板 / 悬浮助手 | `src/components/domain/AiInsightPanel.tsx` / `AgentWidget.tsx` |
| 文档页内容 | `src/routes/docs.tsx`（数据在 `sections` 数组，按 `id` + item 下标索引） |
| 接口调用 | `src/api/<resource>.ts` |
| 全局样式 / 动效 | `src/styles/` |

## 文档深链（DocHint）

页面上的「使用文档」小提示用 `DocHint` 组件：

```tsx
<DocHint section="infra" item={3} label="子域名文档" />
// 或 PageHeader 的 doc 属性
<PageHeader title="…" doc={{ section: 'infra', item: 3, label: '子域名文档' }} />
```

跳到 `/docs?s=<sectionId>&i=<itemIndex>`，文档页会展开对应章节+条目并滚动过去。

⚠️ `item` 是 **`docs.tsx` 里 `sections` 数组的下标（0 起）**。在 `docs.tsx` 里
增删条目会让后面所有下标位移 —— 改完文档必须 `grep -rn "doc={{" src/` 复核一遍。

## 坑

- **Service Worker 缓存**：`vite-plugin-pwa` 用 Workbox。改完发布后浏览器可能仍跑旧
  `sw.js`；验证时用无痕窗口或 DevTools → Application → Unregister。
- Service Worker 的 `NavigationRoute` **必须 denylist `/api/` 和 `/oauth/`**，
  否则 OAuth 回调会被 SPA 吞掉变成 404（见 `src/sw.ts`）。
- 本机 `curl` 要加 `--noproxy '*'`，否则挂住。
- `App.tsx.bak*` / `*.bak-*` 是历史备份，不要 import。
- 路由是 `BrowserRouter` + Flask 兜底返回 `index.html`，新增路由不需要改后端。
- 类型检查只跑 `tsc --noEmit`；`npm test` 是占位符，真正的测试在 `tests/test_publish_spa.py`。
