---
name: yatterra-middleware
description: 改 YatTerra API 的错误格式、CSRF、分页，或选择鉴权装饰器时使用。
---

# web/middleware/ — 中间件操作指南

## 错误响应（统一格式）

```python
from middleware.error_handler import bad_request, not_found, forbidden, ApiError

raise bad_request("端口必须是该 Pod 的公网端口")
raise not_found(f"Proxy mapping {pid} not found")
raise ApiError("CONFLICT", "子域已存在", 409)
```

输出：`{"error": {"code": "...", "message": "...", "details": ...}}`

`register_error_handlers(app)` 在 `app.py` 里注册，兜住 `ApiError`、`HTTPException`
和未捕获异常 —— **不要**在端点里自己 `jsonify({"error": ...})`，格式会不一致。

## 鉴权：用哪套

**新代码一律 `api/_auth.py`**：

```python
from api._auth import require_auth, require_pod, current_username, current_user_obj

@require_auth("infra.host")
@require_pod("member")
```

`middleware/auth.py` 是旧版（仅 Session、无 Pod 级），只为兼容存量路由保留。
看到 `@require_perm` / `@require_login` 说明那是老代码，改的时候可以顺手迁到新装饰器。

## CSRF

`require_csrf` 只对 **Session 认证的写请求** 生效；Bearer Token 请求豁免
（脚本调用不该被 CSRF 挡）。改这块前先看 `middleware/csrf.py` 的豁免逻辑。

## 分页

```python
page, per_page = get_pagination_params()
items, total = paginate_query(query, page, per_page)
return jsonify(paginated_response(items, total, page, per_page))
```

前端 `DataTable` 期望 `{items, total, page, per_page}` 这套字段名。

## 坑

- `error_handler` 的 500 处理会记 traceback 到 logger `api.errors`，但**不**把堆栈返回给客户端。
- 改错误格式会同时影响所有 API 消费方（前端 `api/client.ts`、`cli.py`、外部脚本）。
- 中间件没有独立重启入口，改完随 `yatterra-web` 一起重启。
