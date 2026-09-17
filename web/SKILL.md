---
name: yatterra-web
description: 改 YatTerra 平台后端（Flask 应用、Agent 引擎、Pod 生命周期、反代、LLM、监控）时使用。包含模块定位表、重启流程、以及各模块的坑。
---

# web/ — 后端操作指南

## 改代码的标准流程

```bash
# 1. 改 web/*.py
# 2. 语法自检
python3 -c "import ast;ast.parse(open('/opt/yatterra/web/XXX.py').read())"
# 3. 重启（唯一让改动生效的方式）
sudo systemctl restart yatterra-web && sleep 5
curl --noproxy '*' -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/health
# 4. 看日志确认后台线程起来了
sudo journalctl -u yatterra-web -n 30 --no-pager
```

`preload_app=False` + `workers=1`：没有热重载，也没有多进程一致性问题。
后台线程（`metrics` / `insight` / `req_loop` 等）在 worker 内启动，重启即重启它们。

## 定位表

| 想改什么 | 文件 | 关键点 |
|---|---|---|
| Pod 创建/删除/端口分配 | `groups.py` | 端口基址 `SSH_PUBLIC_BASE=22000` / `WEB_PUBLIC_BASE=23000` / NodePort `31000`/`32000`；改完会重写 frpc + 公网 nginx |
| frpc 隧道 | `groups.py` `build_managed_block()` | 只改标记段内；改完 `reload_frpc()` |
| 公网 nginx web-ssl | `groups.py` `rewrite_nginx_web()` | 读→剥→插→`nginx -t`→reload，失败自动回滚 |
| 子域名反代 | `proxy_map.py` | 状态文件 `proxy_mappings.json` 是权威；`add/remove/toggle/rename/set_note` 后都会 `apply()` |
| Agent 提示词/工具 | `agent.py` | 见下方「Agent 提示词」 |
| Agent 全局参数 | `../agent.conf` | `max_iters` / `max_wall` / `cmd_timeout` / compact 阈值 / fanout |
| Agent 注册表 | `../agents.json` | 每个 agent 的 runner / tools / system_prompt / mcp |
| LLM 提供方 | `llm_conf.py` + `../llm_providers.json` | 改完即时生效（每次调用都 `load_conf()`） |
| LLM 客户端行为 | `llm.py` | 并发信号量 `LLM_MAX_CONCURRENCY`、重试 `LLM_MAX_RETRIES` |
| 页面 AI 洞察 | `insight.py` | 加一个页面 = 写 `_g_<page>()` + 注册进 `GATHERERS` + 前端传 `page=` |
| 主机指标 | `host_health.py` | 返回字段被前端和 insight 直接读，**加字段要同步改消费方** |
| 多主机监控 | `fleet_monitor.py` | 采样由独立 systemd 服务跑，不在 web 进程内 |
| 权限 | `users.py` | `ROLE_PERMS` 决定角色→权限；`can_pod` 决定 Pod 访问 |
| 审计 | `audit.py` | 所有写操作都应 `audit.record(...)`；子系统动作传 `module=`（见下） |

## 审计归属（`audit.record`）

每个模块用自己的角色记账，便于追溯：

```python
# 用户直接触发的动作 —— actor 就是操作人（自动解析 Bearer/session）
audit.record("api_proxy_add", detail=f"{sub}:{port}", actor=current_username() or "unknown")

# 子系统/共享模块代表用户做的事 —— 用 module=
audit.record("proxy_add", detail=f"{sub}:{port}", module="proxy_map")
# → {"action":"proxy_add","actor":"proxy_map","detail":"...:23011 by=mony"}
```

`module=` 会把 `actor` 设成模块名（`proxy_map` / `minio_svc` / `db_svc` / `deploys`），
并把解析出的真实操作人追加到 `detail` 的 `by=<user>`。这样审计里既能看到
「哪个子系统做的」，也能看到「谁触发的」。

**不要**再写 `actor="teacher"` 这类假用户名 —— 它既不指向真实用户，也丢失了
子系统信息。后台任务（无请求上下文）解析到 `system`，用 `module=` 仍能标出模块。

## Agent 提示词（重要）

`_system_prompt_for(agent_def)` 的逻辑：

- `agents.json` 里 `system_prompt` **非空** → 用它，但**自动追加**内置提示词里
  「可用工具…」之后的部分（工具清单 + `ACTION:` 输出协议）。
- 为空 → 用 `_BUILTIN_SYS[id]` 完整内置提示词。

**为什么**：自定义提示词若不含 `ACTION:` 协议，模型会输出散文，ReAct 循环第一轮
就把散文当最终答案结束，表现为「助手没反应/空回复」。所以自定义提示词只需写
角色与工作原则，工具说明交给平台补。

`_sub_prompt_for` 同理（子 agent 用）。

## Agent 循环的几个保护

`run_agent()` / `_subagent_run()` / `_run_node_stream()` 三处循环都有：

- **空输出重试**：模型只输出 reasoning 或空内容时，注入一条提醒重试，连续 2 次才放弃。
- **`_parse_action` 容错**：接受 `{"tool":...}`、`{"run":{...}}` 简写、以及
  `ACTION: run(<cmd>)` 调用式简写。
- **compact**：`last_prompt_tokens > threshold_tokens` 时压缩历史。
  ⚠️ 阈值必须 **小于模型真实上下文**（当前模型 65536，`agent.conf` 设 40000）。
  设大了长会话直接被上游 400 拒绝。

## 坑

- 本机 `curl` 默认走代理会挂住 → 加 `--noproxy '*'`。
- `groups.json` / `proxy_mappings.json` 是 root 600，以 `sse` 读会 `PermissionError`。
  这是**预期**的，不要改权限；要用就 `sudo` 或走 API。
- `remote_hosts.run_remote()` 是唯一合法的跨机通道，别自己拼 ssh。
- 改 `host_health.py` 的返回结构时，同步检查：`insight.py` 的 `_g_host`/`_g_infra`/`_g_dashboard`、
  前端 `routes/infra/host.tsx`、`routes/infra/index.tsx`、`ai_service.py` 的 `get_host_health` 工具。
- `static/spa/` 是发布产物。改前端走 `frontend/`。
