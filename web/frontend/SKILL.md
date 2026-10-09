---
name: yatterra-frontend
description: 改 YatTerra 前端（页面、组件、样式、三语 i18n、PWA、发布）时使用。含源码路径与 sudo 发布两步流程、路由/组件定位、i18n 字典位置、以及 SPA/SW 缓存等坑。
---

# web/frontend/ — 前端操作指南

- 源码目录：`/opt/yatterra/web/frontend`
  ⚠️ **不是** `/srv/yatterra/web/frontend` —— 本机没有那个路径（`/srv/yatterra/web` 只剩一个残留的 `pwa_alerts.db`）。
- Flask（`web/app.py`，127.0.0.1:8090）从 `web/static/spa/` 提供前端产物。

## 改完必须发布（两步 + sudo，不能省）

```bash
cd /opt/yatterra/web/frontend

npx tsc --noEmit -p tsconfig.json                    # 类型自查（见下"已知报错"）
sudo -n npm run build:stage                          # 输出 .spa-staging/release-xxxx 路径
sudo -n npm run publish:spa -- --staging /opt/yatterra/web/.spa-staging/release-xxxx
```

- **两步都要 sudo**：`static/spa/` 里的产物是 root 所有（600），非 root 构建在校验阶段就会
  `Permission denied`（`build:stage` 会读 live 目录做校验）。node/npm 在 `/usr/bin`，root 能直接找到；
  若报找不到命令，用 `sudo -n env "PATH=$PATH" npm …`。
- 发布是**逐文件原子**替换（不是整包原子）：中途崩溃可能让 `index.html` 与 `sw.js` 版本错配。
  **不要**直接编辑 `static/spa/` —— 那是产物，下次发布会覆盖。
- `.spa-staging/release-*` 只增不减，攒多了手动清：`sudo -n rm -rf /opt/yatterra/web/.spa-staging/release-*`。

验证：

```bash
timeout 15 curl --noproxy '*' -s http://127.0.0.1:8090/ | grep -o 'assets/index-[^"]*\.js'  # 新 hash
sudo -n grep -rl "你的新增文案" /opt/yatterra/web/static/spa/assets/ | head                 # 文案进了 chunk
```

## 类型检查：有一批已知报错，别慌（也不是发布闸门）

`npx tsc --noEmit` **常驻一批 `reports.tsx` 报错**（`report` / `list[0]` possibly undefined ——
`noUncheckedIndexedAccess` 下 `find() ?? arr[0]` 的必然结果）。发布走 `vite build`（esbuild），
**不跑 tsc**，所以这些**不影响发布**。判断自己有没有引入新错：看报错是否**只在**那几行。

## 定位

| 想改什么 | 去哪 |
|---|---|
| 某个 URL 的页面 | `src/routes/<路径>.tsx`（目录即嵌套路由，如 `routes/infra/gpu.tsx`、`routes/dev/llm.tsx`） |
| 侧边栏 / 顶栏 / 移动端 tab | `src/components/layout/`（`Sidebar` / `TopBar` / `MobileTabBar`） |
| 页面标题栏（含"使用文档"小提示） | `src/components/layout/PageHeader.tsx` |
| 通用按钮 / 表格 / 弹窗 | `src/components/ui/` |
| AI 洞察面板 / 全局面板助手 | `src/components/domain/AiInsightPanel.tsx` / `GlobalAiAssistant.tsx` |
| 文档页内容 | `src/routes/docs.tsx`（数据在 `sections` 数组，按 `id` + item 下标索引） |
| 接口调用 | `src/api/<resource>.ts` |
| 全局样式 / 动效 / landing | `src/styles/`（`globals.css` / `animations.css` / `landing.css`） |

## 多语言（landing + 登录页共用；报告页另有开关）

唯一字典：`src/routes/landing.i18n.ts`，`Lang = 'en' | 'zh-CN' | 'zh-HK'`。

- 语言 store：模块级 `current` + `useSyncExternalStore`；`setLandingLang()` 写 localStorage
  `yatterra_landing_lang` 并同步 `<html lang>`；`useLandingCopy()` 取当前语言字典。
- **字典以 `zh-CN` 为基准形状**（`type LandingCopy = typeof zhCN`）——新增 key 必须把 en / zh-HK
  两份补齐，否则 tsc 报错；**数组必须等长**。
- 使用方：`landing.tsx` 与 `login.tsx` 共用这一份，选择互相同步。改语言文案**只改 `landing.i18n.ts` 一处**。
- **报告页 `/reports` 是另一套**：`reports.data.ts`（英）/ `reports.data.zh.ts`（繁中书面语），
  `reports.tsx` 顶部还有个 `UI` 常量；只有 **en / 繁中** 两个开关（全局偏好里的 `zh-CN` 归入繁中）。
  landing 里那 3 张报告卡片是**硬编码英文**，不随语言切换。
- `reports.data.ts` / `reports.data.zh.ts` / `reports.diagrams.ts` 头部写着"自动生成勿手改"
  （由 workflow / 合并脚本产出），但实际有人工编辑+脚本插入 —— 动它们要小心，改动后确认两份数据同构。

## 文档深链（DocHint）

```tsx
<DocHint section="infra" item={3} label="子域名文档" />
// 或 PageHeader 的 doc 属性
<PageHeader title="…" doc={{ section: 'infra', item: 3, label: '子域名文档' }} />
```

跳 `/docs?s=<sectionId>&i=<itemIndex>`，文档页会展开对应章节+条目并滚动过去。

⚠️ `item` 是 **`docs.tsx` 里 `sections` 数组的下标（0 起）**。在 `docs.tsx` 里增删条目会让后面
所有下标位移 —— 改完文档必须 `grep -rn "doc={{" src/` 复核一遍。

## 坑

- **Service Worker 缓存**：`vite-plugin-pwa` 用 Workbox。发布后浏览器可能仍跑旧 `sw.js`；
  验证时用无痕窗口或 DevTools → Application → Unregister。
- `src/sw.ts` 的 `NavigationRoute` **必须 denylist `/api/` 和 `/oauth/`**，否则 OAuth 回调会被
  SPA 吞掉变成 404。
- 本机 `curl` 要加 `--noproxy '*'`，否则挂住。
- 路由是 `BrowserRouter` + Flask 兜底返回 `index.html`，**新增路由不需要改后端**。
- 历史备份（`*.bak-*` / `*.backup*`）散落在 `web/` **根目录**（如 `FileBrowser.tsx.backup.*`），
  不是源码、不在 `src/` 下，别 import。
- 测试：`npm test` = `python3 -m unittest discover -s tests`，真正跑 `tests/test_publish_spa.py`
  （发布器）和 `tests/test_docs_lessons.py`（docs ↔ lessons 一致性）。
