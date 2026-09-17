# web/api/ — REST API 蓝图

Flask Blueprint 集合，按资源分文件。全部由 `api/__init__.py` 的
`register_all_blueprints(app)` 注册。

## 文件与挂载前缀

| 文件 | 前缀 | 内容 |
|---|---|---|
| `__init__.py` | `/api/v1` | 注册入口 + v1 兼容端点 + 旧版 `/api/*` 路由 |
| `_auth.py` | — | `require_auth(perm)` / `require_pod(level)` 装饰器（**所有鉴权的唯一来源**） |
| `auth.py` | `/api/auth` | 登录/登出/游客/OAuth/`me`/`csrf` |
| `pods.py` | `/api/pods` | Pod CRUD、生命周期、指标、日志、文件、凭证、成员、部署 |
| `infra.py` | `/api/infra` | 主机/GPU/指标/存储/数据库/反代；含 **Pod 级子域名自助** 路由 |
| `agents.py` | `/api/agents` | Agent 列表/更新/运行/SSE 流/会话 |
| `ai.py` | `/api/ai` | 对话、分析、视觉、洞察、知识库 |
| `llm.py` | `/api/llm` | LLM 提供方与用量 |
| `mcp.py` | `/api/mcp` | MCP 服务器管理 |
| `audit.py` | `/api/audit` | 审计查询 |
| `shared.py` | `/api/shared` | 共享目录浏览/上传 |
| `users.py` | `/api/users` + `/api/tokens` | 用户管理 + 个人 API Token |
| `profile.py` | `/api/profile` | 个人资料与身份绑定 |
| `push.py` | `/api/push` | Web Push 订阅 |
| `threat_map.py` | `/api/threat-map` | 蜜罐威胁数据 |
| `v1.py` | `/api/v1` | 早期 v1 实现（与 `__init__.py` 有重叠，改动前先确认哪个在生效） |

## 鉴权模型

```python
from api._auth import require_auth, require_pod, current_username, current_user_obj

@bp.route("/x")
@require_auth("infra.host")     # 需要该权限
def x(): ...

@bp.route("/pods/<name>/y")
@require_pod("member")          # Pod 名必须是第一个 URL 参数
def y(name): ...
```

- `require_auth` 同时接受 **Bearer Token** 和 **Session Cookie**。
- 成功后注入 `g.api_user`；`require_pod` 额外注入 `g.api_pod`。
- 权限字符串定义在 `web/users.py` 的 `ROLE_PERMS` / `PERM_GROUPS`。

## 错误响应

统一用 `middleware/error_handler.py` 的 `bad_request` / `not_found` / `ApiError`，
格式 `{"error": {"code": "...", "message": "..."}}`。

## 加一个新端点

1. 在对应资源文件里加路由 + 装饰器。
2. 写操作记得 `audit.record(...)`。
3. 前端在 `frontend/src/api/<resource>.ts` 加封装。

细节与坑见 [SKILL.md](SKILL.md)。
