#!/usr/bin/env python3
"""Platform management GUI."""
import os, secrets, time, pty, struct, fcntl, termios, threading, subprocess, json, shlex, re
shlex_quote = shlex.quote
from datetime import timedelta
from flask import (Flask, request, redirect,
                   session, flash, Response, jsonify)
from flask_socketio import SocketIO, emit
from flask_compress import Compress
import groups
import agent
import agent_runs
import harness_runs
import agent_conf
import users
import deploys
import shared as shared_mod
import minio_svc as minio_mod
import db_svc as db_mod
import llm as llm_mod
import cpu_stats, gpu_stats
import oauth2_login
import metrics, host_health, audit, lifecycle
import insight
import remote_hosts
import proxy_map
import mcp_client
from api import register_all_blueprints

app = Flask(__name__)
Compress(app)  # gzip/brotli for HTML, JSON, CSS, JS

# --- persistent secret key (stable across restarts) ---
import siteconf

SECRET_FILE = siteconf.web_path("secret.key")
def load_secret_key():
    try:
        with open(SECRET_FILE) as f:
            key = f.read().strip()
            if key:
                return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    try:
        with open(SECRET_FILE, "w") as f:
            f.write(key)
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass
    return key

app.secret_key = load_secret_key()

# --- session hardening ---
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = False  # served over frp http, not https
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 86400  # 1 day cache for /static/
app.config["JSON_SORT_KEYS"] = False              # skip key sorting overhead
app.permanent_session_lifetime = timedelta(days=7)

@app.after_request
def _set_cache_headers(resp):
    """Keep one cache policy for errors, versioned SPA assets and stable URLs."""
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    elif resp.status_code >= 400:
        resp.headers["Cache-Control"] = "no-store"
    elif (200 <= resp.status_code < 300 or resp.status_code == 304) and re.fullmatch(
        # Vite's default eight-character content hash, including '-' and '_'.
        r"/(?:static/spa/)?assets/[^/]+-[A-Za-z0-9_-]{8}"
        r"\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot|otf)",
        request.path,
    ):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        # HTML, service workers, manifests and all unversioned URLs revalidate.
        resp.headers["Cache-Control"] = "no-cache"
    # send_file may have supplied a future expiry using the static default.
    resp.headers.pop("Expires", None)
    return resp

def login_required():
    return session.get("logged_in") is True

# --- multi-user auth helpers ---
def current_user():
    return session.get("user")

def is_super():
    return session.get("role") == "super"

_USER_CACHE_TTL = 30  # seconds: refresh user from DB at most this often

def _session_user_obj():
    """Return user dict from session cache; refresh from DB if stale."""
    if not login_required():
        return None
    _uo = session.get("_user_obj")
    _ts = session.get("_user_ts", 0)
    if _uo and (time.time() - _ts) < _USER_CACHE_TTL:
        return _uo
    # cache miss or stale — hit DB
    _fresh = users.get_user(current_user())
    if _fresh:
        session["_user_obj"] = _fresh
        session["_user_ts"] = time.time()
    return _fresh

def user_perms_list():
    u = _session_user_obj()
    return sorted(users.expanded_perms(u))

# route path → (global_perm, pod_info).
# global_perm: permission key for non-pod modules, or None.
# pod_info: (pod_name, action) for pod routes, or None.
# action ∈ create/view/terminal/control/env/deploy/delete/join/manage
def route_perm(path):
    if path in ("/deploy/webhook", "/deploy-internal/report"):
        return None, None
    if path.startswith("/access") or path.startswith("/profile"):
        return None, None
    # pod routes
    if path == "/add":
        return "group.create", None
    if path.startswith("/group/"):
        name = path.split("/")[2]
        sub = path[len("/group/" + name):]
        if sub.startswith("/deploy"):
            return None, (name, "deploy")
        if "/delete" in sub:
            return None, (name, "delete")
        if any(a in sub for a in ("/start", "/stop", "/restart", "/reset", "/resize")):
            return None, (name, "control")
        if "/env/" in sub:
            return None, (name, "env")
        if "/cred/" in sub:
            return None, (name, "cred")
        if "/join" in sub:
            return None, (name, "join")
        if "/members/" in sub or "/owners/" in sub:
            return None, (name, "manage")
        return None, (name, "view")
    if path.startswith("/terminal/"):
        return None, (path.split("/")[2], "terminal")
    # non-pod module routes
    if path.startswith("/scheduler"):
        return "infra.scheduler", None
    if path.startswith("/shared/upload") or path.startswith("/shared/mkdir") or path.startswith("/shared/delete"):
        return "ops.shared.write", None
    if path.startswith("/shared"):
        return "ops.shared.read", None
    if path.startswith("/storage"):
        return "infra.storage", None
    if path.startswith("/databases"):
        return "infra.db", None
    if path.startswith("/proxy"):
        return "infra.proxy", None
    if path.startswith("/host"):
        return "infra.host", None
    if path.startswith("/audit"):
        return "ops.audit", None
    if path.startswith("/harness/store") or path in ("/harness/publish", "/harness/unpublish"):
        # store browse/import: any logged-in user; publish/unpublish: needs dev.harness
        if path.startswith("/harness/store"):
            return None, None
        return "dev.harness", None
    if path.startswith("/harness"):
        return "dev.harness", None
    if path.startswith("/llm"):
        return "dev.llm", None
    if path.startswith("/mcp"):
        return "dev.mcp", None
    if path.startswith("/agent"):
        return "dev.agent", None
    if path.startswith("/users/tokens"):
        return None, None  # any logged-in user can manage own tokens
    if path.startswith("/users"):
        return "admin.users", None
    return "group.view", None  # / and anything else

# pod action → required access level
_POD_ACTION_LEVEL = {
    "view": "member", "terminal": "member",
    "control": "owner", "env": "owner", "deploy": "owner",
    "delete": "owner", "manage": "owner", "cred": "owner",
}

# --- login rate limiting (in-memory, per-IP) ---
_LOGIN_FAILS = {}  # ip -> {"fails": int, "locked_until": float}
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_SECS = 300

@app.before_request
def guard():
    # SPA mode: serve React SPA for all non-API, non-WS page routes
    if _SPA_AVAILABLE:
        path = request.path
        # API and WebSocket paths — let them through to their handlers
        if path.startswith('/api/') or path.startswith('/ws/') or path.startswith('/socket.io/'):
            pass  # fall through to normal auth logic below
        # OAuth callback paths — must reach Flask route handlers, not SPA
        elif path.startswith('/oauth/callback/'):
            pass  # fall through to Flask route handlers
        # External webhook paths — must reach Flask route handlers
        elif path.startswith('/deploy/'):
            pass  # fall through to Flask route handlers
        # Health check — must reach Flask route handler
        elif path == '/health':
            pass  # fall through to Flask route handler
        # Flask /static/ files — let Flask's built-in static handler serve them
        elif path.startswith('/static/'):
            return None
        # Static SPA assets — serve from SPA build directory
        elif path.startswith('/assets/') or path.startswith('/icons/'):
            from flask import send_from_directory
            return send_from_directory(_SPA_DIR, path.lstrip('/'))
        # SPA root-level static files (registerSW.js, manifest, sw.js, etc.)
        elif path in ('/registerSW.js', '/manifest.webmanifest', '/sw.js',
                      '/offline.html', '/robots.txt') or path.endswith(('.js', '.css', '.png', '.svg', '.ico', '.woff2', '.ttf', '.webmanifest', '.map', '.jpg', '.jpeg', '.webp', '.gif', '.json', '.xml', '.txt', 'woff', '.eot', '.otf')):
            from flask import send_from_directory
            return send_from_directory(_SPA_DIR, path.lstrip('/'))
        # All other page routes → SPA index.html (client-side routing + auth)
        else:
            from flask import send_from_directory
            return send_from_directory(_SPA_DIR, 'index.html')
    if request.endpoint in ("oauth_callback_ssemarket", "oauth_callback_unisso",
                            "deploy_webhook", "deploy_internal_report", "health", "static"):
        return
    # REST API — token auth handled inside api.py
    if request.path.startswith("/api/"):
        return
    # token-authed external endpoints — no login required
    if request.path in ("/deploy/webhook", "/deploy-internal/report"):
        return
    if not login_required():
        return redirect("/login")
    # refresh user from store (cached in session, TTL-based DB refresh)
    _fresh = _session_user_obj()
    if _fresh is None:
        session.clear()
        return redirect("/login")
    session["role"] = _fresh.get("role", "user")
    # slide session cookie so active users don't get logged out
    _seen = session.get("_seen")
    if not _seen or time.time() - float(_seen) > 3600:
        session["_seen"] = time.time()
    _uo = _fresh
    perm, pod_info = route_perm(request.path)
    # non-pod module permission check
    if perm and not users.has_perm(_uo, perm):
        return jsonify({"error": f"无权限: {perm}"}), 403
    # pod access check
    if pod_info:
        pod_name, action = pod_info
        if action == "join":
            pass  # any logged-in user can apply
        else:
            state = groups.load_state()
            pod = state["groups"].get(pod_name, {})
            level = _POD_ACTION_LEVEL.get(action, "member")
            if not users.can_pod(_uo, pod, level):
                return jsonify({"error": f"无权访问 Pod {pod_name}"}), 403

@app.before_request
def csrf_protect():
    """Lenient CSRF validation on POST.

    If the form includes a csrf_token field, validate it against the session
    token and reject on mismatch. If the field is absent (templates not yet
    updated), allow the request through so the app keeps working.
    """
    if request.method != "POST":
        return
    # REST API — token auth, no CSRF needed
    if request.path.startswith("/api/"):
        return
    # token-authed external endpoints — exempt from CSRF
    if request.path in ("/deploy/webhook", "/deploy-internal/report", "/login/guest"):
        return
    form_token = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
    session_token = session.get("csrf_token")
    if not form_token or not session_token or form_token != session_token:
        flash("表单已过期,请重试", "error")
        dest = request.referrer or "/"
        return redirect(dest)

@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp

# --- Socket.IO (web 终端) ---
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*',
                    ping_interval=5, ping_timeout=10)

# --- REST API (all API blueprints) ---
register_all_blueprints(app)

# --- Unified JSON error handler for API endpoints ---
from middleware.error_handler import register_error_handlers
register_error_handlers(app)

# --- SPA fallback: serve React SPA for all non-API, non-WS routes ---
import os as _os
_SPA_DIR = _os.path.join(_os.path.dirname(__file__), 'static', 'spa')
_SPA_INDEX = _os.path.join(_SPA_DIR, 'index.html')
_SPA_AVAILABLE = _os.path.isfile(_SPA_INDEX)

# 终端会话表: sid -> {'master': fd, 'proc': Popen, 'thread': Thread}
SESSIONS = {}
_SESSIONS_LOCK = threading.Lock()

def _term_cleanup(sid):
    """清理一个终端会话: 关 master fd、杀进程、join 线程。"""
    with _SESSIONS_LOCK:
        s = SESSIONS.pop(sid, None)
    if not s:
        return
    try:
        os.close(s['master'])
    except OSError:
        pass
    p = s['proc']
    try:
        p.kill()
    except Exception:
        pass
    try:
        p.wait(timeout=2)
    except Exception:
        pass
    t = s['thread']
    if t is not None and t.is_alive() and t is not threading.current_thread():
        t.join(timeout=2)

def _term_reader(sid, master):
    """daemon 线程: 循环读 PTY 输出并 emit 给对应客户端。"""
    with app.app_context():
        try:
            while True:
                try:
                    data = os.read(master, 4096)
                except OSError:
                    break
                if not data:
                    break
                try:
                    emit('term_output', {'data': data.decode(errors='replace')},
                         to=sid, namespace='/')
                except Exception as e:
                    print(f"[term-reader] emit failed: {e!r}", flush=True)
                    break
        except Exception as e:
            print(f"[term-reader] loop died: {e!r}", flush=True)
        try:
            emit('term_exit', {'data': '会话已结束'}, to=sid, namespace='/')
        except Exception as e:
            print(f"[term-reader] term_exit emit failed: {e!r}", flush=True)
    _term_cleanup(sid)

# --- OAuth2 external login (ssemarket & unisso) ---

@app.route("/oauth/callback/ssemarket")
def oauth_callback_ssemarket():
    """Handle ssemarket OAuth2 callback (login or bind)."""
    code = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")
    if error:
        return redirect("/login?oauth_error=ssemarket&detail=" + error)
    if not code or not state:
        return redirect("/login?oauth_error=missing_params")
    # verify state
    st = oauth2_login._consume_state(state)
    if not st or st.get("provider") != "ssemarket":
        return redirect("/login?oauth_error=invalid_state")
    intent = st.get("intent", "login")
    try:
        redirect_uri = f"{oauth2_login.YATERRA_BASE_URL}/oauth/callback/ssemarket"
        token_data = oauth2_login.ssemarket_exchange_code(code, redirect_uri)
        access_token = token_data.get("access_token")
        if not access_token:
            return redirect("/login?oauth_error=no_token")
        userinfo = oauth2_login.ssemarket_fetch_userinfo(access_token)
        user_id = str(userinfo.get("user_id", ""))
        name = userinfo.get("name", "") or f"ssemarket_{user_id}"
        email = userinfo.get("email", "")
        avatar = userinfo.get("avatar_url", "")

        # --- BIND mode ---
        if intent == "bind":
            bind_user = st.get("bind_username")
            if not bind_user or session.get("user") != bind_user:
                flash("绑定失败：会话不匹配，请重试", "error")
                return redirect("/profile")
            ok, err = users.bind_identity(bind_user, "ssemarket", user_id,
                                          name, email, avatar)
            if not ok:
                flash(err, "error")
            else:
                audit.record("oauth_bind", detail=f"ssemarket:{user_id}→{bind_user}")
                flash(f"已绑定 SSE Market 账号 ({name})", "ok")
            return redirect("/profile")

        # --- LOGIN mode ---
        # check if identity is already bound to a yatterra user
        bound_user = users.find_user_by_identity("ssemarket", user_id)
        if bound_user:
            username = bound_user
            existing = users.get_user(username)
            if not existing:
                # bound user was deleted — fall back to auto-provision
                bound_user = None
        if not bound_user:
            # auto-provision with sse_ prefix
            username = f"sse_{user_id}"
            existing = users.get_user(username)
            if not existing:
                users.create_user(username, secrets.token_urlsafe(24), role="user")
                existing = users.get_user(username)
            # auto-bind so future logins recognize this identity
            users.bind_identity(username, "ssemarket", user_id, name, email, avatar)

        # log in
        ip = request.remote_addr or "unknown"
        session.clear()
        session["logged_in"] = True
        session["user"] = username
        session["role"] = existing.get("role", "user") if existing else "user"
        session["_user_obj"] = existing
        session["_user_ts"] = time.time()
        session["oauth_provider"] = "ssemarket"
        session["oauth_name"] = name
        session["oauth_email"] = email
        session["oauth_avatar"] = avatar
        session.permanent = True
        audit.record("login_oauth", detail=f"ssemarket:{username}({name}) ip={ip}")
        return redirect("/")
    except Exception as e:
        log = __import__("logging").getLogger("oauth2")
        log.exception("ssemarket OAuth2 callback error")
        return redirect(f"/login?oauth_error=ssemarket&detail={e}")

@app.route("/oauth/callback/unisso")
def oauth_callback_unisso():
    """Handle UniSSO OAuth2 callback (login or bind)."""
    code = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")
    if error:
        return redirect(f"/login?oauth_error=unisso&detail={error}")
    if not code or not state:
        return redirect("/login?oauth_error=missing_params")
    # verify state and get PKCE verifier
    st = oauth2_login._consume_state(state)
    if not st or st.get("provider") != "unisso":
        return redirect("/login?oauth_error=invalid_state")
    code_verifier = st.get("code_verifier", "")
    intent = st.get("intent", "login")
    try:
        redirect_uri = f"{oauth2_login.YATERRA_BASE_URL}/oauth/callback/unisso"
        token_data = oauth2_login.unisso_exchange_code(code, redirect_uri, code_verifier)
        access_token = token_data.get("access_token")
        if not access_token:
            return redirect("/login?oauth_error=no_token")
        userinfo = oauth2_login.unisso_fetch_userinfo(access_token)
        user_id = str(userinfo.get("sub", userinfo.get("user_id", "")))
        name = userinfo.get("name", "") or userinfo.get("username", "") or f"unisso_{user_id}"
        email = userinfo.get("email", "")
        avatar = userinfo.get("picture", "") or userinfo.get("avatar", "")

        # --- BIND mode ---
        if intent == "bind":
            bind_user = st.get("bind_username")
            if not bind_user or session.get("user") != bind_user:
                flash("绑定失败：会话不匹配，请重试", "error")
                return redirect("/profile")
            ok, err = users.bind_identity(bind_user, "unisso", user_id,
                                          name, email, avatar)
            if not ok:
                flash(err, "error")
            else:
                audit.record("oauth_bind", detail=f"unisso:{user_id}→{bind_user}")
                flash(f"已绑定 UniSSO 账号 ({name})", "ok")
            return redirect("/profile")

        # --- LOGIN mode ---
        # check if identity is already bound to a yatterra user
        bound_user = users.find_user_by_identity("unisso", user_id)
        if bound_user:
            username = bound_user
            existing = users.get_user(username)
            if not existing:
                bound_user = None
        if not bound_user:
            # auto-provision with uni_ prefix
            username = f"uni_{user_id}"
            existing = users.get_user(username)
            if not existing:
                users.create_user(username, secrets.token_urlsafe(24), role="user")
                existing = users.get_user(username)
            # auto-bind so future logins recognize this identity
            users.bind_identity(username, "unisso", user_id, name, email, avatar)

        # log in
        ip = request.remote_addr or "unknown"
        session.clear()
        session["logged_in"] = True
        session["user"] = username
        session["role"] = existing.get("role", "user") if existing else "user"
        session["_user_obj"] = existing
        session["_user_ts"] = time.time()
        session["oauth_provider"] = "unisso"
        session["oauth_name"] = name
        session["oauth_email"] = email
        session["oauth_avatar"] = avatar
        session.permanent = True
        audit.record("login_oauth", detail=f"unisso:{username}({name}) ip={ip}")
        return redirect("/")
    except Exception as e:
        log = __import__("logging").getLogger("oauth2")
        log.exception("unisso OAuth2 callback error")
        return redirect(f"/login?oauth_error=unisso&detail={e}")

# --- webhook: push-to-deploy (branch-filtered) ---
@app.route("/deploy/webhook", methods=["POST"])
def deploy_webhook():
    """gitee/github push webhook. Triggers run() for matching auto_deploy deploys.
    No CSRF (external callback); auth via HMAC/token secret."""
    source = (request.args.get("source") or "").lower()
    body = request.get_data()
    if not deploys.verify_webhook(source, request.headers, body):
        audit.record("deploy_webhook", detail=f"auth fail source={source}", actor="webhook")
        return jsonify({"error": "bad signature"}), 403
    try:
        payload = request.get_json(force=True, silent=True) or {}
    except Exception:
        payload = {}
    # extract repo url + pushed branch
    repo_url, branch = "", ""
    if source == "github":
        repo_url = (payload.get("repository") or {}).get("clone_url", "")
        ref = payload.get("ref", "")  # refs/heads/<branch>
        branch = ref.replace("refs/heads/", "") if ref.startswith("refs/heads/") else ""
    else:  # gitee
        rep = payload.get("repository") or {}
        repo_url = rep.get("html_url") or rep.get("url") or ""
        ref = payload.get("ref") or payload.get("ref_name") or ""
        branch = ref.replace("refs/heads/", "") if ref.startswith("refs/heads/") else ref
    if not repo_url or not branch:
        audit.record("deploy_webhook", detail=f"unparseable source={source}", actor="webhook")
        return jsonify({"error": "unparseable"}), 400
    matches = deploys.find_by_repo_branch(repo_url, branch)
    audit.record("deploy_webhook", detail=f"source={source} repo={repo_url} branch={branch} matches={len(matches)}", actor="webhook")
    # sseapi: sync local mirror before deploy (pod can't reach github.com)
    if 'SysuMirror/sseapi' in repo_url:
        try:
            subprocess.run(['/home/sse/sseapi-mirror-sync.sh'], timeout=30,
                         capture_output=True, text=True)
            audit.record('deploy_webhook', detail='sseapi mirror synced', actor='webhook')
        except Exception as e:
            audit.record('deploy_webhook', detail=f'sseapi sync fail: {e}', actor='webhook')
    # Deployment remains independent from notifications. The notification task
    # is deduplicated durably and runs outside the webhook request.
    delivery = (request.headers.get("X-GitHub-Delivery") or
                request.headers.get("X-Gitee-Delivery") or
                payload.get("after") or
                (payload.get("head_commit") or {}).get("id") or "")
    payload["_delivery_id"] = str(delivery)[:256]
    for group, dep in matches:
        threading.Thread(target=deploys.run, args=(group, dep), daemon=True).start()
        try:
            import pwa_alerts
            pwa_alerts.enqueue_webhook(group, dep, repo_url, branch, payload)
        except Exception:
            app.logger.exception("webhook notification enqueue failed for %s", group)
    return jsonify({"triggered": len(matches), "branch": branch})

def _send_webhook_alert(group, dep, repo_url, branch, payload):
    """Best-effort asynchronous webhook summary; never changes deploy outcome."""
    try:
        import pwa_alerts
        key = pwa_alerts.webhook_event_key(repo_url, branch, payload) + ":" + group
        if pwa_alerts.claim_webhook(key):
            pwa_alerts.notify_webhook(group, dep, repo_url, branch, payload)
    except Exception:
        app.logger.exception("webhook notification failed for %s", group)


# --- pod app → host status report (token auth) ---
@app.route("/deploy-internal/report", methods=["POST"])
def deploy_internal_report():
    """App self-report uplink. Body {deploy_id, state, metrics?, message?},
    header X-Report-Token. No CSRF (token auth)."""
    token = request.headers.get("X-Report-Token", "")
    try:
        payload = request.get_json(force=True, silent=True) or {}
    except Exception:
        payload = {}
    deploy_id = payload.get("deploy_id", "")
    state = payload.get("state", "")
    if not deploy_id or not state or not token:
        return jsonify({"error": "missing fields"}), 400
    ok, msg = deploys.record_report(deploy_id, token, state,
                                    payload.get("metrics"), payload.get("message"))
    if ok:
        audit.record("deploy_report", detail=f"id={deploy_id} state={state}", actor="app")
    return jsonify({"ok": ok, "msg": msg}), (200 if ok else 403)

# --- Socket.IO 事件: web 终端 ---
@socketio.on('connect')
def _sio_connect():
    """握手时建 PTY + kubectl exec。客户端 query 带 name。"""
    if not login_required():
        return False
    name = request.args.get('name', '')
    state = groups.load_state()
    if name not in state["groups"]:
        return False
    # pod access check: user must have member+ access
    _uo = _session_user_obj()
    if not users.can_pod(_uo, state["groups"].get(name, {}), "member"):
        emit('term_exit', {'data': '无权访问该 Pod 终端'})
        return False
    # pod 必须 Running
    if groups.pod_status(name) != 'Running':
        emit('term_exit', {'data': 'Pod 未运行,无法打开终端'})
        return False
    # 解析 pod 名
    r = groups.kubectl('get', 'pod', '-l', f'app=group-{name}',
                       '-o', 'jsonpath={.items[0].metadata.name}', check=False)
    if r.returncode != 0 or not r.stdout:
        emit('term_exit', {'data': '找不到 Pod'})
        return False
    pod = r.stdout.strip()
    sid = request.sid
    # 建 PTY
    master, slave = pty.openpty()
    try:
        proc = subprocess.Popen(
            ['kubectl', '-n', groups.NS, 'exec', '-i', '-t', pod, '--', 'su', '-l', 'cloud'],
            stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        )
    finally:
        os.close(slave)  # fork 后父进程关闭 slave
    t = threading.Thread(target=_term_reader, args=(sid, master), daemon=True)
    with _SESSIONS_LOCK:
        SESSIONS[sid] = {'master': master, 'proc': proc, 'thread': t}
    t.start()
    audit.record('term_open', detail=f"{name} pod={pod} sid={sid}")

@socketio.on('term_input')
def _sio_term_input(data):
    """客户端键盘输入 -> 写入 PTY master。"""
    sid = request.sid
    with _SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return
    if isinstance(data, dict):
        data = data.get('data', '')
    if isinstance(data, str):
        data = data.encode(errors='replace')
    elif not isinstance(data, (bytes, bytearray)):
        data = str(data).encode(errors='replace')
    try:
        os.write(s['master'], data)
    except OSError:
        _term_cleanup(sid)

@socketio.on('term_resize')
def _sio_term_resize(data):
    """终端尺寸变化 -> 设置 PTY winsize。"""
    sid = request.sid
    with _SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return
    cols = int(data.get('cols', 80))
    rows = int(data.get('rows', 24))
    try:
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(s['master'], termios.TIOCSWINSIZE, winsize)
    except Exception:
        pass

@socketio.on('disconnect')
def _sio_disconnect():
    """客户端断开 -> 清理会话。"""
    _term_cleanup(request.sid)

# --- LLM Config + Usage ---
import llm_conf
import llm_usage

# --- Health check ---
@app.route('/health')
def health():
    return jsonify({'health': 'ok'})

if __name__ == "__main__":
    socketio.run(app, host="127.0.0.1", port=8090, allow_unsafe_werkzeug=True)
