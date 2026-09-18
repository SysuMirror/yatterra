# web/ — 平台本体

Flask 应用（`app.py`）+ 一组扁平的功能模块 + 前端 SPA。gunicorn 单 worker
（`gunicorn.conf.py`，`workers=1` 因为 SocketIO 需要粘性会话；`preload_app=False`
所以后台线程在 worker 内启动）。

## 子目录

| 目录 | 内容 |
|---|---|
| [`api/`](api/README.md) | REST API 蓝图，按资源分文件 |
| [`frontend/`](frontend/README.md) | React + Vite SPA 源码、构建与发布脚本 |
| [`services/`](services/README.md) | 可独立运行的服务模块 |
| [`middleware/`](middleware/README.md) | 鉴权 / CSRF / 分页 / 错误处理 |
| [`tests/`](tests/README.md) | 后端单元测试 |
| `static/spa/` | **发布产物**，由 `frontend/scripts/publish_spa.py` 写入，不要手改 |
| `.kube/` | 集群访问配置 |

## 扁平模块（按职责分组）

**核心状态与生命周期**
- `groups.py` — 组定义、K8s manifest 生成、frpc 重写、nginx web-ssl 同步。**改 Pod 相关先看这里。**
- `lifecycle.py` — 组的启动/停止/重启（kubectl 封装）
- `deploys.py` — Git 仓库部署进 Pod，由 Pod 内 supervisord 托管
- `scheduler.py` — GPU 调度

**用户与权限**
- `users.py` — 4 角色 + Pod 级 owner/member 权限；MySQL 存储；API Token
- `audit.py` — 审计流水（写 `/srv/yatterra/audit.log`）
- `oauth2_login.py` — SSE Market / UniSSO OAuth

**AI 能力**
- `agent.py` — ReAct Agent 引擎（提示词、工具、循环、fan-out、harness 执行）
- `agent_conf.py` / `agent_memory.py` / `agent_runs.py` / `harness_runs.py`
- `ai_service.py` — 统一 AI 服务层（对话/分析/视觉/RAG 检索）
- `llm.py` / `llm_conf.py` / `llm_usage.py` — 模型客户端、提供方配置、用量统计
- `mcp_client.py` — MCP 服务器注册与调用
- `kb_service.py` — RAG 知识库入库与检索（源文件在 `../kb/`）
- `insight.py` — 后台预计算各页面的 AI 洞察摘要

**基础设施服务**
- `minio_svc.py` / `db_svc.py` — MinIO、MySQL/Redis/Qdrant 的封装
- `proxy_map.py` — 子域名 → 公网端口反代（改公网 nginx_proxy 容器）
- `remote_hosts.py` — 远程主机 SSH 采集
- `shared.py` — 跨 Pod 共享目录

**监控与资源**
- `host_health.py` / `gpu_stats.py` / `cpu_stats.py` / `metrics.py`
- `fleet_monitor.py` / `fleet_probe.py` / `fleet_sampler.py` — 多主机时序监控
- `req_estimate.py` / `req_loop.py` — EWMA 估算 k8s requests
- `pressure_writer.py` / `priority_kill.py` — 压力降级与优先级驱逐
- `kvcache.py` — Redis TTL 缓存

**其它**
- `app.py` — Flask 入口、路由、SocketIO、SPA 兜底
- `cli.py` — `yatterra` 命令行客户端
- `logutil.py` — 后台守护的轮转日志

## 常用操作

```bash
sudo systemctl restart yatterra-web              # 改后端后必做
sudo journalctl -u yatterra-web -n 50 --no-pager
curl --noproxy '*' -s http://127.0.0.1:8090/health
PYTHONPATH=/srv/yatterra/web python3 -m unittest discover -s /srv/yatterra/web/tests -v
```

详细操作指南见 [SKILL.md](SKILL.md)。
