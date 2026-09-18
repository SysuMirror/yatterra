---
name: yatterra
description: YatTerra 分组开发平台（K3s + frp + Flask）的运维与开发。当需要改平台代码、排查 Pod/集群问题、调整 Agent/LLM/反代配置，或定位"这个功能在哪个文件"时使用。本文件是入口，具体细节在下层目录的 SKILL.md。
---

# YatTerra 平台 — Agent 操作指南（顶层）

## 先建立心智模型

平台 = **一个 Flask 应用**（`web/`，跑在宿主机 root）+ **25 个组容器 Pod**（K3s `clouds` 命名空间）
+ **一组基础设施**（`platform-infra`：MySQL/Redis/Qdrant/MinIO）+ **公网中继**（example.com 上的 frps + nginx_proxy 容器）。

所有跨机器动作都走 `web/remote_hosts.py`（SSH 到 example.com），**不要**直接打 Tailscale 100.x。

## 下钻顺序（不要一上来读全部）

1. 先读本文件 + `README.md` 的目录地图，定位到**一个**子目录。
2. 读那个子目录的 `README.md`（是什么）→ `SKILL.md`（怎么改、坑在哪）。
3. 只有需要具体实现细节时才读源码。

| 你的任务 | 去哪 |
|---|---|
| 改 API / 加端点 | `web/api/SKILL.md` |
| 改前端页面 / 组件 | `web/frontend/SKILL.md` |
| 改 Agent 行为 / 提示词 / 工具 | `web/SKILL.md` → 搜 `agent.py` |
| 改 Pod 生命周期 / 端口 / frpc | `web/SKILL.md` → `groups.py` |
| 改子域名反代 | `web/SKILL.md` → `proxy_map.py` |
| 改 LLM 提供方 / 用量 | `web/SKILL.md` → `llm_conf.py` / `llm.py` |
| 改监控 / 洞察 | `web/SKILL.md` → `host_health.py` / `insight.py` / `fleet_*` |
| 改组容器镜像 | `image/SKILL.md` |
| 改后台守护 | `systemd/SKILL.md` |
| 喂 AI 知识 | `kb/SKILL.md` |

## 硬约束（违反会搞坏平台）

- **不要** `systemctl stop/restart yatterra-web` 之外的破坏性操作；重启 web 会杀掉当前 AI 会话。
- 改 `web/*.py` 后必须 `sudo systemctl restart yatterra-web` 才生效（`preload_app=False`，无热重载）。
- 改前端后必须 build + publish 两步，**不能**直接改 `web/static/spa/`（会被下次发布覆盖）。
- `groups.json` / `proxy_mappings.json` 是**权威状态**，nginx/frpc 配置由它们生成。手改 nginx 会被下次 `apply()` 覆盖。
- 顶层 `*.json` 多数是 root 600。以 `sse` 身份读不到是正常的，用 `sudo` 或走平台 API。
- 危险命令（`rm -rf /`、`mkfs`、`dd` 写块设备、`kubectl delete`）在 Agent 工具层被 denylist 拦。

## 常用命令

```bash
systemctl status yatterra-web yatterra-fleet-sampler yatterra-req-estimator
sudo journalctl -u yatterra-web -n 50 --no-pager
kubectl -n clouds get pods
kubectl -n platform-infra get pods
curl --noproxy '*' -s http://127.0.0.1:8090/health    # 注意本机 curl 需 --noproxy
```

## 已知坑（详见各层 SKILL）

- 本机 `curl` 走代理会挂住 → 一律加 `--noproxy '*'`。
- Agent 自定义提示词会**替换**内置提示词，平台会自动补回工具清单 + `ACTION:` 协议（见 `web/SKILL.md`）。
- 模型上下文 65536，`agent.conf` 的 compact 阈值必须低于它，否则长会话 400。
- 前端 SPA 的 Service Worker 会缓存，改完前端要确认 `index.html` 指向新 hash。
