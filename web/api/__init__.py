#!/usr/bin/env python3
"""REST API for YatTerra — token-authed, JSON in/out.

Mounted at /api/v1 via Flask Blueprint.  Auth via Authorization: Bearer <token>.
Permissions reuse the same has_perm / can_pod system as the web UI.
"""
import functools
from flask import Blueprint, request, jsonify, g
import users, groups, lifecycle, audit, host_health, deploys
import minio_svc as minio_mod
import db_svc as db_mod

api_bp = Blueprint("api", __name__, url_prefix="/api/v1")


def _parse_health_timeout(value=60):
    """Validate deployment health-check timeout in seconds."""
    from middleware.error_handler import bad_request
    text = str(value).strip()
    if not text.isdigit():
        raise bad_request("health_timeout must be an integer between 1 and 3600 seconds")
    timeout = int(text)
    if not 1 <= timeout <= 3600:
        raise bad_request("health_timeout must be an integer between 1 and 3600 seconds")
    return timeout


# ── auth helpers ──────────────────────────────────────────────
def _resolve_token():
    """Resolve bearer token → {username, role} or None. Cached on g.
    DB errors are caught to prevent 500s from stale connections."""
    if hasattr(g, "_api_user_cache"):
        return g._api_user_cache
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else None
    try:
        info = users.verify_token(token) if token else None
    except Exception:
        info = None
    g._api_user_cache = info
    return info


def api_auth(perm=None):
    """Decorator: token auth + optional permission check.
    Injects g.api_user = {username, role}.
    DB errors are caught to prevent 500s from stale connections."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            u = _resolve_token()
            if not u:
                return jsonify({"error": "未认证或 token 无效"}), 401
            if perm:
                try:
                    has = users.has_perm(u, perm)
                except Exception:
                    has = False
                if not has:
                    return jsonify({"error": f"无权限: {perm}"}), 403
            g.api_user = u
            return fn(*args, **kwargs)
        return wrapper
    return deco


def api_pod(level="member"):
    """Decorator: pod access check.  Pod name is the first URL arg.
    Requires @api_auth to run first (or chains internally).
    Injects g.api_pod = pod_dict."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(name, *args, **kwargs):
            u = _resolve_token()
            if not u:
                return jsonify({"error": "未认证或 token 无效"}), 401
            g.api_user = u
            pod = groups.load_state()["groups"].get(name)
            if not pod:
                return jsonify({"error": f"Pod {name} 不存在"}), 404
            try:
                can = users.can_pod(u, pod, level)
            except Exception:
                can = False
            if not can:
                return jsonify({"error": f"无权访问 Pod {name}"}), 403
            g.api_pod = pod
            return fn(name, *args, **kwargs)
        return wrapper
    return deco


def _actor():
    return g.api_user["username"]


def _body():
    return request.get_json(silent=True) or {}


# ── self-documenting root ─────────────────────────────────────
@api_bp.route("/", methods=["GET"])
def api_index():
    return jsonify({"service": "YatTerra API", "version": "1",
                    "auth": "Authorization: Bearer <token>",
                    "endpoints": {
        "users":       "GET /users, POST /users, DELETE /users/<name>, PUT /users/<name>/role, PUT /users/<name>/password [admin.users]",
        "groups":      "GET /groups, POST /groups, GET/DELETE /groups/<name>, POST /groups/<name>/start|stop|restart, GET /groups/<name>/logs [group.view/create + pod access]",
        "deploys":     "GET/POST /groups/<name>/deploys, POST /groups/<name>/deploys/<id>/run|stop, GET /groups/<name>/deploys/<id>/status|logs, DELETE /groups/<name>/deploys/<id> [pod access]",
        "storage":     "GET /storage, POST /storage/buckets, DELETE /storage/buckets/<name>, POST /storage/keys, DELETE /storage/keys/<id> [infra.storage]",
        "databases":   "GET /databases, POST /databases/creds, DELETE /databases/creds/<id> [infra.db]",
        "host":        "GET /host/health [infra.host]",
        "audit":       "GET /audit [ops.audit]",
        "tokens":      "GET /tokens, POST /tokens, DELETE /tokens/<id> [any authenticated user]",
    }})


# ── users ─────────────────────────────────────────────────────
@api_bp.route("/users", methods=["GET"])
@api_auth("admin.users")
def api_users_list():
    return jsonify({"users": users.list_users()})


@api_bp.route("/users", methods=["POST"])
@api_auth("admin.users")
def api_users_create():
    b = _body()
    if g.api_user.get("role") != "super" and b.get("role") == "super":
        return jsonify({"error": "只有超级管理员能创建超级管理员"}), 403
    ok, msg = users.create_user(b.get("username", ""), b.get("password", ""), b.get("role", "user"))
    if not ok:
        return jsonify({"error": msg}), 400
    audit.record("api_user_add", detail=f"{b.get('username','')} role={b.get('role','')}", actor=_actor())
    return jsonify({"ok": True}), 201


@api_bp.route("/users/<username>", methods=["DELETE"])
@api_auth("admin.users")
def api_users_delete(username):
    if username == g.api_user["username"]:
        return jsonify({"error": "不能删除自己"}), 400
    tu = users.get_user(username)
    if tu and tu.get("role") == "super" and g.api_user.get("role") != "super":
        return jsonify({"error": "只有超级管理员能删除超级管理员"}), 403
    users.delete_user(username)
    audit.record("api_user_delete", detail=username, actor=_actor())
    return jsonify({"ok": True})


@api_bp.route("/users/<username>/role", methods=["PUT"])
@api_auth("admin.users")
def api_users_role(username):
    b = _body()
    role = b.get("role", "user")
    if role == "super" and g.api_user.get("role") != "super":
        return jsonify({"error": "只有超级管理员能设置超级管理员"}), 403
    users.set_role(username, role)
    audit.record("api_user_role", detail=f"{username} → {role}", actor=_actor())
    return jsonify({"ok": True})


@api_bp.route("/users/<username>/password", methods=["PUT"])
@api_auth("admin.users")
def api_users_password(username):
    b = _body()
    ok, msg = users.set_password(username, b.get("password", ""))
    if not ok:
        return jsonify({"error": msg}), 400
    audit.record("api_user_password", detail=username, actor=_actor())
    return jsonify({"ok": True})


# ── groups / pods ─────────────────────────────────────────────
@api_bp.route("/groups", methods=["GET"])
@api_auth("group.view")
def api_groups_list():
    u = g.api_user
    out = []
    for name, pod in groups.load_state()["groups"].items():
        role = users.pod_role(u, pod)
        if role is None and u.get("role") not in ("super", "admin"):
            continue
        out.append({"name": name, "type": pod.get("type"), "gpus": pod.get("gpus", []),
                     "cpu": pod.get("cpu"), "mem": pod.get("mem"),
                     "status": groups.pod_status(name),
                     "owners": pod.get("owners", []), "members": pod.get("members", []),
                     "my_role": role})
    return jsonify({"groups": out})


@api_bp.route("/groups", methods=["POST"])
@api_auth("group.create")
def api_groups_create():
    b = _body()
    gpus = None
    if b.get("gpus"):
        gpus = [int(x) for x in str(b["gpus"]).split(",") if x.strip()]
    try:
        pod = groups.create_group(b.get("name", ""), gpus=gpus or None,
                                  cpu=b.get("cpu"), mem=b.get("mem"),
                                  storage=b.get("storage"), creator=_actor())
        audit.record("api_create_group", detail=pod["name"], actor=_actor())
        return jsonify({"ok": True, "name": pod["name"]}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/groups/<name>", methods=["GET"])
@api_pod("member")
def api_group_detail(name):
    pod = g.api_pod
    return jsonify({"name": name, "type": pod.get("type"), "gpus": pod.get("gpus", []),
                     "cpu": pod.get("cpu"), "mem": pod.get("mem"), "storage": pod.get("storage"),
                     "status": groups.pod_status(name),
                     "owners": pod.get("owners", []), "members": pod.get("members", []),
                     "lifecycle": lifecycle.group_lifecycle(name)})


@api_bp.route("/groups/<name>", methods=["DELETE"])
@api_pod("owner")
def api_groups_delete(name):
    try:
        groups.remove_group(name)
        audit.record("api_delete_group", detail=name, actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/groups/<name>/start", methods=["POST"])
@api_pod("owner")
def api_groups_start(name):
    lifecycle.start_group(name)
    audit.record("api_group_start", detail=name, actor=_actor())
    return jsonify({"ok": True})


@api_bp.route("/groups/<name>/stop", methods=["POST"])
@api_pod("owner")
def api_groups_stop(name):
    lifecycle.stop_group(name)
    audit.record("api_group_stop", detail=name, actor=_actor())
    return jsonify({"ok": True})


@api_bp.route("/groups/<name>/restart", methods=["POST"])
@api_pod("owner")
def api_groups_restart(name):
    lifecycle.restart_group(name)
    audit.record("api_group_restart", detail=name, actor=_actor())
    return jsonify({"ok": True})


@api_bp.route("/groups/<name>/logs", methods=["GET"])
@api_pod("member")
def api_groups_logs(name):
    return jsonify({"logs": lifecycle.group_logs(name, lines=int(request.args.get("lines", 100)))})


# ── deploys ───────────────────────────────────────────────────
@api_bp.route("/groups/<name>/deploys", methods=["GET"])
@api_pod("member")
def api_deploys_list(name):
    out = []
    for d in deploys.list_for(name):
        st = deploys.status(name, d["id"])
        out.append({"id": d["id"], "name": d.get("name"), "repo": d.get("repo"),
                     "branch": d.get("branch", ""), "kind": d.get("kind", "serve"),
                     "state": st.get("state"), "auto_deploy": d.get("auto_deploy", False),
                     "last_ref": (d.get("last_ref") or "")[:12]})
    return jsonify({"deploys": out})


@api_bp.route("/groups/<name>/deploys", methods=["POST"])
@api_pod("owner")
def api_deploys_add(name):
    b = _body()
    repo = (b.get("repo") or "").strip()
    ok, msg = deploys.validate_repo(repo)
    if not ok:
        return jsonify({"error": msg}), 400
    nm = (b.get("name") or "").strip()
    if not nm:
        from urllib.parse import urlparse
        nm = urlparse(repo).path.rstrip("/").rsplit("/", 1)[-1].replace(".git", "") or "deploy"
    spec = {"name": nm, "repo": repo, "branch": (b.get("branch") or "").strip(),
            "subdir": (b.get("subdir") or "").strip(), "token": (b.get("token") or "").strip(),
            "mode": (b.get("mode") or "service").strip(), "kind": (b.get("kind") or "serve").strip(),
            "gpu": (b.get("gpu") or "").strip(), "vram": (b.get("vram") or "").strip(),
            "auto_deploy": bool(b.get("auto_deploy", False)), "health": (b.get("health") or "").strip(),
            "health_timeout": _parse_health_timeout(b.get("health_timeout", 60))}
    d = deploys.add(name, spec)
    audit.record("api_deploy_add", detail=f"{name}/{d['name']} id={d['id']}", actor=_actor())
    return jsonify({"ok": True, "id": d["id"], "name": d["name"]}), 201


@api_bp.route("/groups/<name>/deploys/<did>/run", methods=["POST"])
@api_pod("owner")
def api_deploys_run(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    ok, msg = deploys.run(name, d)
    audit.record("api_deploy_run", detail=f"{name}/{did} ok={ok}", actor=_actor())
    return jsonify({"ok": ok, "msg": msg})


@api_bp.route("/groups/<name>/deploys/<did>/stop", methods=["POST"])
@api_pod("owner")
def api_deploys_stop(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    deploys.stop(name, d)
    audit.record("api_deploy_stop", detail=f"{name}/{did}", actor=_actor())
    return jsonify({"ok": True})


@api_bp.route("/groups/<name>/deploys/<did>/status", methods=["GET"])
@api_pod("member")
def api_deploys_status(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    st = deploys.status(name, did)
    st.update(name=d.get("name"), auto_deploy=d.get("auto_deploy", False),
              last_ref=(d.get("last_ref") or "")[:12])
    return jsonify(st)


@api_bp.route("/groups/<name>/deploys/<did>/logs", methods=["GET"])
@api_pod("member")
def api_deploys_logs(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    return jsonify({"logs": deploys.logs(name, d, lines=int(request.args.get("lines", 200)))})


@api_bp.route("/groups/<name>/deploys/<did>", methods=["DELETE"])
@api_pod("owner")
def api_deploys_delete(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    deploys.delete(name, d)
    audit.record("api_deploy_delete", detail=f"{name}/{did}", actor=_actor())
    return jsonify({"ok": True})


# ── storage (MinIO) ───────────────────────────────────────────
@api_bp.route("/storage", methods=["GET"])
@api_auth("infra.storage")
def api_storage_status():
    st = minio_mod.status()
    out = {"status": st, "buckets": [], "keys": minio_mod.list_keys()}
    if st.get("ready"):
        try:
            out["buckets"] = minio_mod.buckets()
        except Exception as e:
            out["error"] = str(e)
    return jsonify(out)


@api_bp.route("/storage/buckets", methods=["POST"])
@api_auth("infra.storage")
def api_storage_bucket_add():
    name = (_body().get("name") or "").strip()
    if not name:
        return jsonify({"error": "桶名不能为空"}), 400
    try:
        minio_mod.make_bucket(name)
        audit.record("api_bucket_add", detail=name, actor=_actor())
        return jsonify({"ok": True}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/storage/buckets/<name>", methods=["DELETE"])
@api_auth("infra.storage")
def api_storage_bucket_delete(name):
    force = request.args.get("force", "0") in ("1", "true", "yes")
    try:
        minio_mod.remove_bucket(name, force=force)
        audit.record("api_bucket_delete", detail=name, actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/storage/keys", methods=["POST"])
@api_auth("infra.storage")
def api_storage_key_add():
    b = _body()
    try:
        rec = minio_mod.add_key(b.get("label", ""), b.get("bucket", ""), b.get("perm", "readwrite"))
        audit.record("api_key_add", detail=f"{rec['label']} bucket={b.get('bucket','')}", actor=_actor())
        return jsonify({"ok": True, "key": rec}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/storage/keys/<kid>", methods=["DELETE"])
@api_auth("infra.storage")
def api_storage_key_delete(kid):
    try:
        minio_mod.remove_key(kid)
        audit.record("api_key_delete", detail=kid, actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── databases ─────────────────────────────────────────────────
@api_bp.route("/databases", methods=["GET"])
@api_auth("infra.db")
def api_databases_status():
    return jsonify({"status": db_mod.status(), "creds": db_mod.list_creds()})


@api_bp.route("/databases/creds", methods=["POST"])
@api_auth("infra.db")
def api_databases_cred_add():
    b = _body()
    service = (b.get("service") or "").strip()
    if service not in ("mysql", "redis", "qdrant"):
        return jsonify({"error": "service 必须是 mysql/redis/qdrant"}), 400
    try:
        rec = db_mod.add_cred(service, (b.get("label") or "").strip())
        audit.record("api_db_cred_add", detail=f"{service} {rec.get('label','')}", actor=_actor())
        return jsonify({"ok": True, "cred": rec}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/databases/creds/<kid>", methods=["DELETE"])
@api_auth("infra.db")
def api_databases_cred_delete(kid):
    try:
        db_mod.remove_cred(kid)
        audit.record("api_db_cred_delete", detail=kid, actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── host / audit / tokens ─────────────────────────────────────
@api_bp.route("/host/health", methods=["GET"])
@api_auth("infra.host")
def api_host_health():
    return jsonify(host_health.host_health())


@api_bp.route("/tokens", methods=["GET"])
@api_auth()
def api_tokens_list():
    return jsonify({"tokens": users.list_tokens(g.api_user["username"])})


@api_bp.route("/tokens", methods=["POST"])
@api_auth()
def api_tokens_create():
    return jsonify({"token": users.create_token(g.api_user["username"], _body().get("name", ""))}), 201


@api_bp.route("/tokens/<tid>", methods=["DELETE"])
@api_auth()
def api_tokens_delete(tid):
    if not users.delete_token(g.api_user["username"], tid):
        return jsonify({"error": "token 不存在或不属于你"}), 404
    return jsonify({"ok": True})


# ── Import the pods blueprint ─────────────────────────────────
from .pods import pods_bp  # noqa: E402
from .auth import auth_bp  # noqa: E402
from .infra import infra_bp  # noqa: E402
from .agents import agents_bp  # noqa: E402
from .mcp import mcp_bp  # noqa: E402
from .audit import audit_bp  # noqa: E402
from .shared import shared_bp  # noqa: E402
from .users import users_bp, tokens_bp  # noqa: E402
from .profile import profile_bp  # noqa: E402
from .llm import llm_bp  # noqa: E402
from .threat_map import threat_map_bp  # noqa: E402
from .push import push_bp  # noqa: E402
from .ai import ai_bp  # noqa: E402


# ── Blueprint registration helper ─────────────────────────────
def register_all_blueprints(app):
    """Register all API blueprints on the Flask app."""
    app.register_blueprint(api_bp)
    app.register_blueprint(pods_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(infra_bp)
    app.register_blueprint(agents_bp)
    app.register_blueprint(mcp_bp)
    app.register_blueprint(audit_bp)
    app.register_blueprint(shared_bp)
    app.register_blueprint(users_bp)
    app.register_blueprint(tokens_bp)
    app.register_blueprint(profile_bp)
    app.register_blueprint(llm_bp)
    app.register_blueprint(threat_map_bp)
    app.register_blueprint(push_bp)
    app.register_blueprint(ai_bp)
