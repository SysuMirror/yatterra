# web/middleware/ — API 中间件

横切关注点：错误格式、CSRF、分页、鉴权辅助。

## 文件

| 文件 | 内容 | 谁在用 |
|---|---|---|
| `error_handler.py` | `ApiError` + `bad_request` / `not_found` / `forbidden` / `unauthorized` / `conflict` / `internal_error`；`register_error_handlers(app)` 统一 JSON 错误响应 | **几乎所有 api 蓝图** + `app.py` |
| `csrf.py` | `generate_csrf_token` / `get_csrf_token` / `require_csrf` 装饰器 | `api/auth.py` |
| `pagination.py` | `get_pagination_params` / `paginate_query` / `paginated_response` | 列表类端点 |
| `auth.py` | 旧版鉴权辅助（`require_login` / `require_perm` / `inject_auth_context`） | 少量旧路由 |

## 注意

**鉴权有两套**，新代码一律用 `api/_auth.py` 的 `require_auth` / `require_pod`：

| | `middleware/auth.py`（旧） | `api/_auth.py`（**新，用这个**） |
|---|---|---|
| 认证来源 | 仅 Session | Bearer Token + Session |
| Pod 级 | 无 | `require_pod(level)` |
| 注入 | `g.user` 等 | `g.api_user` / `g.api_pod` |

`middleware/auth.py` 保留是为了兼容早期路由，新端点不要用它。

细节见 [SKILL.md](SKILL.md)。
