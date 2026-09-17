# YatTerra — 分组开发平台

K3s 单节点上的分组开发平台：每个组一个 Ubuntu 24.04 容器 Pod，经 frp 隧道 +
公网 nginx 暴露 SSH / Web / GUI 端口，平台本体是一个 Flask 应用（管理 GUI + REST API）。

- 平台 Web：`http://127.0.0.1:8090`（gunicorn，systemd `yatterra-web`）
- 公网入口：`https://ssemarket.cn:24000`（经 frp + nginx_proxy 容器）
- 组容器命名空间：`students`（历史名，可用 `YATTERRA_GROUP_NS` 覆盖）；基础设施命名空间：`platform-infra`

## 部署配置（环境变量）

所有部署相关的值（域名、端口方案、命名空间、宿主机路径、中继服务器路径）
集中在 **`web/siteconf.py`**，从环境变量读取，默认值即参考部署。前端对应
`web/frontend/src/lib/site.ts`（构建期 `VITE_*`）。

改配置不用改源码：

```bash
cp .env.example .env && chmod 600 .env   # 填凭证 + 按需覆盖站点值
sudo systemctl restart yatterra-web
```

凭证（DB / MinIO / OAuth / frpc / webhook）**没有硬编码默认值**，必须来自
`.env`。完整变量清单见 [`.env.example`](.env.example)。

## 许可

本项目采用 **CC BY-NC-SA 4.0**（署名-非商业性使用-相同方式共享）许可，
**禁止商业使用**。详见 [LICENSE](LICENSE)。

## 目录地图

| 目录 | 是什么 | 深入 |
|---|---|---|
| `web/` | 平台本体：Flask 应用 + 后台守护 + 前端 SPA | [web/README.md](web/README.md) |
| `web/api/` | REST API 蓝图（按资源分文件） | [web/api/README.md](web/api/README.md) |
| `web/frontend/` | React + Vite SPA 源码与发布脚本 | [web/frontend/README.md](web/frontend/README.md) |
| `web/services/` | 可脱离 Flask 独立运行的服务模块（含一份未使用的旧副本） | [web/services/README.md](web/services/README.md) |
| `web/middleware/` | API 中间件（鉴权/CSRF/分页/错误） | [web/middleware/README.md](web/middleware/README.md) |
| `web/tests/` | 后端单元测试 | [web/tests/README.md](web/tests/README.md) |
| `harnesses/` | 每用户的 Agent 编排 DAG（运行时数据） | [harnesses/README.md](harnesses/README.md) |
| `harnesses_public/` | 公开编排商店 | [harnesses_public/README.md](harnesses_public/README.md) |
| `kb/` | RAG 知识库源文件（喂给 AI 助手） | [kb/README.md](kb/README.md) |
| `image/` | 组容器镜像构建 | [image/README.md](image/README.md) |
| `manifests/` | 每个组的 K8s Deployment YAML（由代码生成） | [manifests/README.md](manifests/README.md) |
| `systemd/` | 后台守护的 systemd unit 副本 | [systemd/README.md](systemd/README.md) |

## 运行时状态文件（顶层，多为 root 600，含凭证）

`groups.json` 组定义（权威）· `agents.json` Agent 注册表 · `agent.conf` Agent 全局参数 ·
`proxy_mappings.json` 子域名映射（权威）· `remote_hosts.json` 远程主机 ·
`llm_providers.json` 模型提供方 · `db_creds.json` / `minio_keys.json` 凭证 ·
`audit.log` 审计流水 · `.env` 密钥（systemd EnvironmentFile 加载）。

> 这些文件**不是**文档，改动即改行为。改前先看对应模块的 README/SKILL。

## 三个后台服务

| unit | 入口 | 作用 |
|---|---|---|
| `yatterra-web` | `web/app.py`（gunicorn） | 管理 GUI + REST API + 后台线程 |
| `yatterra-fleet-sampler` | `web/fleet_sampler.py` | 每 15s 采集本机+远程主机指标 → SQLite |
| `yatterra-req-estimator` | `web/req_loop.py` | 按 EWMA 实际用量调整 Pod 的 k8s requests |

## 快速上手

```bash
systemctl status yatterra-web
sudo systemctl restart yatterra-web          # 改后端后
cd /opt/yatterra/web/frontend && npm run build:stage && npm run publish:spa -- --staging <上一步输出路径>   # 改前端后
kubectl -n students get pods
```

AI Agent 请先读 [SKILL.md](SKILL.md)。
