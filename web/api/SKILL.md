---
name: yatterra-api
description: 改 YatTerra REST API（加端点、改鉴权、改 Pod/基础设施/Agent 接口）时使用。
---

# web/api/ — API 操作指南

## 加端点

```python
# web/api/infra.py
@infra_bp.route("/thing", methods=["POST"])
@require_auth("infra.host")          # 或 require_pod("member")，Pod 名须为第一个 URL 参数
def infra_thing():
    body = request.get_json(silent=True) or {}
    ...
    audit.record("api_thing", detail="...", actor=current_username() or "unknown")
    return jsonify({"ok": True}), 201
```

- 蓝图已在 `api/__init__.py` 注册，**不需要**改注册代码（除非新增文件）。
- 参数校验失败用 `bad_request(msg)`，找不到用 `not_found(msg)`。
- 写操作**必须** `audit.record`，否则审计页看不到。

## 鉴权要点

- `require_auth(perm)` 先解析用户（Bearer → Session），再 `users.has_perm`。
  `has_perm` 抛异常时**默认拒绝**（不是 500）。
- `require_pod(level)` 的 `level`：`"member"`（成员或负责人）/ `"owner"`（仅负责人）。
- 超级/管理员角色在 `pod_role()` 里对所有 Pod 返回 `"owner"`。

## 权限字符串

定义在 `web/users.py` 的 `ROLE_PERMS` / `PERM_GROUPS`（**以文件为准，别背**）：

```
分组管理   group.create / group.view / group.terminal
基础设施   infra.host / infra.storage(.read) / infra.db(.read) / infra.scheduler / infra.proxy
开发编排   dev.harness / dev.mcp / dev.agent / dev.llm
运维       ops.audit / ops.threat / ops.shared.read / ops.shared.write / ops.deploy
管理       admin.users
```

角色 → 权限：`super` = `["*"]`（`has_perm` 特判放行）；`admin` 基本全给；
`user` 只有 `group.*` / `dev.agent` / `dev.llm` / `ops.shared.read` / `ops.threat`
和只读的基础设施权限；`guest` 仅 `group.view` + `infra.host`。

⚠️ 注意 `.read` 后缀的只读权限与无后缀的管理权限是**不同字符串**，
`infra.storage.read` 不等于 `infra.storage`。加端点时选对粒度。

## 坑

- **`v1.py` 与 `__init__.py` 都定义 `/api/v1`**，且 `__init__.py` 里还有一批旧版
  `/api/*` 路由。加端点前先 `grep -rn "你的路径" web/api/` 确认没有重复。
- Pod 级路由的 URL 参数名必须是 `name`（`require_pod` 硬编码取第一个位置参数）。
- 子域名自助（`/api/infra/pods/<name>/proxy*`）的端口是**服务端推导**的，
  只接受该 Pod 自己的公网端口；不要放开成任意端口。
- 返回给前端的字段名要和 `frontend/src/api/*.ts` 的类型对齐，改字段要两边一起改。
- 改完重启：`sudo systemctl restart yatterra-web`。
