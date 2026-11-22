#!/usr/bin/env python3
"""Platform management GUI."""
import os, secrets, time, pty, struct, fcntl, termios, threading, subprocess, json, shlex, re
import urllib.parse
shlex_quote = shlex.quote
from datetime import timedelta
from flask import (Flask, request, redirect,
                   session, flash, Response, jsonify)
from flask.sessions import SecureCookieSessionInterface
from flask_socketio import SocketIO, emit
from flask_compress import Compress
import groups
import agent
import agent_runs
import cert_alerts  # noqa: F401 模块级 start() 拉起证书到期/攻击激增巡检线程
import scan_svc  # noqa: F401 模块级 start() 拉起安全巡检(明文密钥/危险代码)线程
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
import podwatch
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
app.config["SESSION_COOKIE_DOMAIN"] = (siteconf.SESSION_COOKIE_DOMAINS or [None])[0]
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 86400  # 1 day cache for /static/
app.config["JSON_SORT_KEYS"] = False              # skip key sorting overhead
app.permanent_session_lifetime = timedelta(days=7)


class _HostAwareSessionInterface(SecureCookieSessionInterface):
    """Send the session cookie on the widest domain that is safe for the host.

    The console is reachable through several public entries. Entries that share
    a registrable domain (``cloud.ssemarket.cn`` and ``ssemarket.cn:24000``)
    should share one session, so they get ``Domain=.ssemarket.cn``. An entry on
    an unrelated domain (a Cloudflare Tunnel backup host) must stay host-only —
    a browser silently REJECTS a cookie whose Domain does not cover the origin
    it came from, which would make that entry impossible to log into at all.
    """

    def get_cookie_domain(self, app, session=None):
        try:
            from flask import has_request_context, request
        except Exception:  # pragma: no cover - import guard
            return app.config.get("SESSION_COOKIE_DOMAIN")
        if has_request_context():
            host = (request.headers.get("X-Forwarded-Host") or request.host or "")
            host = host.split(",")[0].strip().split(":")[0].lower()
            for dom in siteconf.SESSION_COOKIE_DOMAINS:
                d = dom.lower()
                if host == d.lstrip(".") or host.endswith(d):
                    return d
            # Host is not under any shared domain (e.g. a Cloudflare Tunnel
            # backup domain): keep the cookie host-only, never emit a Domain
            # the browser would reject.
            return None
        return app.config.get("SESSION_COOKIE_DOMAIN")


app.session_interface = _HostAwareSessionInterface()

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
    if session.get("logged_in") is not True:
        return False
    # 会话绝对生命周期闸(与 API 侧 api._auth 一致): 超期即登出。
    try:
        from api._auth import session_age_exceeded
        if session_age_exceeded():
            session.clear()
            return False
    except Exception:
        pass
    return True

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
    # SPA Web IDE 深链 /pods/<name>/ide — 与 Pod 详情同级:member/view
    if path.startswith("/pods/") and path.endswith("/ide"):
        return None, (path.split("/")[2], "view")
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
        return "infra.host.view", None
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
        # Pod Web 兜底页 — 公开页面, 不能被 SPA index.html 吞掉
        elif path == '/pod-offline':
            pass  # fall through to Flask route handler
        # Harness(编排)管理:SPA dev/harness 页面直接 fetch 无 /api 前缀的
        # 裸路径(/harness/list|def|store|delete)。若不放行会被下面的 SPA
        # 兜底吞成 index.html → 前端解析 JSON 失败。放行后仍走 login+route_perm。
        elif path.startswith('/harness/'):
            pass  # fall through to Flask route handlers / legacy auth+perm gate
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
                            "deploy_webhook", "deploy_internal_report", "health",
                            "pod_offline_page", "static"):
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
    # harness 删除由 SPA dev 页用裸 fetch POST(不带 CSRF token);与 webhook
    # 同理豁免,权限仍由 route_perm 的 dev.harness 把关。
    if request.path == "/harness/delete":
        return
    form_token = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
    session_token = session.get("csrf_token")
    if not form_token or not session_token or form_token != session_token:
        flash("表单已过期,请重试", "error")
        dest = request.referrer or "/"
        return redirect(dest)

@app.before_request
def block_unauth_api_options():
    """Reject unauthenticated OPTIONS on /api/*.

    Flask answers OPTIONS automatically and echoes an ``Allow:`` header, which
    lets anonymous callers enumerate the exact HTTP methods (incl. write verbs
    like POST/PUT/DELETE) every endpoint accepts — part of the unauth
    self-description finding.  The SPA is served same-origin so it never issues
    a CORS preflight; authenticated callers (session cookie or bearer token)
    still receive the normal automatic answer.
    """
    if request.method != "OPTIONS" or not request.path.startswith("/api/"):
        return
    if login_required():
        return
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else None
    if token:
        try:
            if users.verify_token(token):
                return
        except Exception:
            pass
    return jsonify({"error": {"code": "UNAUTHORIZED",
                              "message": "Authentication required"}}), 401


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp

# --- Socket.IO (web 终端) ---
def _socketio_origins():
    """Socket.IO CORS 白名单 = 平台自身对外 origin。

    这里曾经是 '*' —— 任意站点(含 `Origin: null`)都能被原样反射并带着
    受害者凭据建立跨域实时通道。改为按站点枚举;非浏览器请求(不带 Origin)
    不触发 CORS 检查,不受影响。新增对外入口时把主机名加进
    YATTERRA_EXTRA_PUBLIC_HOSTS 即可。
    """
    hosts = {
        siteconf.PLATFORM_HOST,          # cloud.ssemarket.cn
        siteconf.PUBLIC_HOST,            # ssemarket.cn
        siteconf.DOMAIN,
        f"www.{siteconf.DOMAIN}",
        f"admin.{siteconf.DOMAIN}",
        *siteconf.EXTRA_PUBLIC_HOSTS,    # 备用入口(如 CF Tunnel 域名)
    }
    ports = {None, siteconf.PLATFORM_GUI_PORT}   # 443 与 24000 两个入口
    origins = set()
    for h in hosts:
        if not h:
            continue
        for scheme in ("https", "http"):
            for port in ports:
                origins.add(f"{scheme}://{h}" + (f":{port}" if port else ""))
    # 本地 vite dev server(仅本机可达)
    origins.update({"http://localhost:5173", "http://127.0.0.1:5173"})
    return sorted(origins)


socketio = SocketIO(app, async_mode='threading',
                    cors_allowed_origins=_socketio_origins(),
                    ping_interval=5, ping_timeout=10)

# --- REST API (all API blueprints) ---
register_all_blueprints(app)

# --- 审批蓝图(approvals.py,agent.py 已在顶部 import approvals) ---
import approvals as _approvals
if _approvals.approvals_bp is not None:
    app.register_blueprint(_approvals.approvals_bp)
else:
    __import__("logging").getLogger("approvals").error(
        "approvals_bp 为 None,审批端点(/api/agents/approvals 等)未注册")

# --- Unified JSON error handler for API endpoints ---
from middleware.error_handler import register_error_handlers
register_error_handlers(app)

# --- SPA fallback: serve React SPA for all non-API, non-WS routes ---
import os as _os
_SPA_DIR = _os.path.join(_os.path.dirname(__file__), 'static', 'spa')
_SPA_INDEX = _os.path.join(_SPA_DIR, 'index.html')
_SPA_AVAILABLE = _os.path.isfile(_SPA_INDEX)

# 终端会话表: sid -> 会话记录; _TERM_TOKENS: resume token -> 同一条记录。
# 记录: {'master','proc','thread','token','sid','buf','cleanup_timer'}
# 断开后不立即杀 PTY, 保留 TERM_GRACE 秒供 socket.io 自动重连续传
# (重连带 resume token → 重绑 sid + 回放 buf, shell 状态不丢)。
SESSIONS = {}
_TERM_TOKENS = {}
_SESSIONS_LOCK = threading.Lock()
TERM_GRACE = int(os.environ.get("YATTERRA_TERM_GRACE", "300"))
TERM_BUF_MAX = 200_000   # 重连回放缓冲上限(字符)

# PTY winsize ioctl 常量。Linux 上叫 TIOCSWINSZ(0x5414); 旧代码写的
# termios.TIOCSWINSIZE 在 Linux 上根本不存在, AttributeError 又被三处
# except Exception: pass 静默吞掉 —— 导致 winsize 从未真正设置过,
# claude code 等全屏 TUI 一直按默认窄宽度换行, 拖分隔条也无效。
_TIOCSWINSZ = getattr(termios, "TIOCSWINSZ", None)

def _set_winsize(fd, cols, rows):
    """设置 PTY winsize; 失败记日志不静默(本 bug 就是静默吞出来的)。"""
    if _TIOCSWINSZ is None or not cols or not rows:
        return
    try:
        fcntl.ioctl(fd, _TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except Exception:
        import logging
        logging.getLogger("term").exception("set pty winsize failed")

def _term_child_setup(slave_fd):
    """kubectl 子进程的 preexec: 独立会话 + 把 slave 设为控制终端。

    没有 TIOCSCTTY, TIOCSWINSZ 只改 winsize 值而不产生 SIGWINCH,
    kubectl 的 resize 监听(靠 SIGWINCH)永远不触发, 远端 PTY 尺寸
    就不会跟着变 —— 实测: 无 ctty 时 ioctl 后子进程 0 次 SIGWINCH,
    setsid+TIOCSCTTY 后正常收到。函数体只有两个系统调用, 不分配
    内存, preexec_fn 里调用是安全的。
    """
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

def _term_drop(rec):
    """真正销毁一个终端会话: 关 master fd、杀进程、从两张表摘除。"""
    with _SESSIONS_LOCK:
        if SESSIONS.get(rec.get('sid')) is rec:
            SESSIONS.pop(rec.get('sid'), None)
        if _TERM_TOKENS.get(rec.get('token')) is rec:
            _TERM_TOKENS.pop(rec.get('token'), None)
        timer = rec.get('cleanup_timer')
        rec['cleanup_timer'] = None
    if timer:
        try:
            timer.cancel()
        except Exception:
            pass
    try:
        os.close(rec['master'])
    except OSError:
        pass
    p = rec['proc']
    try:
        p.kill()
    except Exception:
        pass
    try:
        p.wait(timeout=2)
    except Exception:
        pass
    t = rec['thread']
    if t is not None and t.is_alive() and t is not threading.current_thread():
        t.join(timeout=2)

def _term_cleanup(sid):
    """按 sid 清理(输入失败/进程退出路径)。"""
    with _SESSIONS_LOCK:
        rec = SESSIONS.get(sid)
    if rec:
        _term_drop(rec)

def _term_cleanup_token(token):
    """延迟清理定时器到点: token 对应会话仍未被重连认领 → 销毁。"""
    with _SESSIONS_LOCK:
        rec = _TERM_TOKENS.get(token)
    if rec:
        _term_drop(rec)

def _term_reader(rec, master):
    """daemon 线程: 循环读 PTY 输出, 写入回放缓冲并 emit 给当前绑定的 sid。"""
    with app.app_context():
        try:
            while True:
                try:
                    data = os.read(master, 4096)
                except OSError:
                    break
                if not data:
                    break
                text = data.decode(errors='replace')
                rec['buf'] = (rec['buf'] + text)[-TERM_BUF_MAX:]
                try:
                    emit('term_output', {'data': text},
                         to=rec['sid'], namespace='/')
                except Exception as e:
                    print(f"[term-reader] emit failed: {e!r}", flush=True)
                    break
        except Exception as e:
            print(f"[term-reader] loop died: {e!r}", flush=True)
        try:
            emit('term_exit', {'data': '会话已结束'},
                 to=rec['sid'], namespace='/')
        except Exception as e:
            print(f"[term-reader] term_exit emit failed: {e!r}", flush=True)
    # 进程退出: 立即销毁(保留也没有意义), 不走宽限期
    _term_drop(rec)

# --- OAuth2 external login (ssemarket & unisso) ---
# 注意:这两个 /oauth/callback/* 是**线上真正接收 IdP 回调**的路由——
# oauth2_login 生成的 redirect_uri 即 /oauth/callback/<provider>(已注册到
# ssemarket IdP 与 UniSSO client 配置),浏览器 302 落在这里。
# api/auth.py 里的 /api/auth/callback/* 是同逻辑的重复实现,但其路径从未被
# 用作 redirect_uri,属死代码;该文件归其他模块管,勿在此删,也不要把
# redirect_uri 改成 /api/auth/callback/*(会与已注册的 URI 不符导致 code 交换失败)。

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
        redirect_uri = f"{oauth2_login.request_base_url(request)}/oauth/callback/ssemarket"
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
        users.sync_oauth_profile(username, "ssemarket", user_id, name, email, avatar)
        existing = users.get_user(username)

        # log in
        ip = request.remote_addr or "unknown"
        session.clear()
        session["logged_in"] = True
        session["user"] = username
        session["role"] = existing.get("role", "user") if existing else "user"
        session["_user_obj"] = existing
        session["_user_ts"] = time.time()
        session["_login_at"] = time.time()   # 会话绝对起点(滑动续期不清零)
        session["oauth_provider"] = "ssemarket"
        session["oauth_name"] = name
        session["oauth_email"] = email
        session["oauth_avatar"] = avatar
        session.permanent = True
        audit.record("login_oauth", detail=f"ssemarket:{username}({name}) ip={ip}")
        return redirect("/console")
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
        redirect_uri = f"{oauth2_login.request_base_url(request)}/oauth/callback/unisso"
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
        users.sync_oauth_profile(username, "unisso", user_id, name, email, avatar)
        existing = users.get_user(username)

        # log in
        ip = request.remote_addr or "unknown"
        session.clear()
        session["logged_in"] = True
        session["user"] = username
        session["role"] = existing.get("role", "user") if existing else "user"
        session["_user_obj"] = existing
        session["_user_ts"] = time.time()
        session["_login_at"] = time.time()   # 会话绝对起点(滑动续期不清零)
        session["oauth_provider"] = "unisso"
        session["oauth_name"] = name
        session["oauth_email"] = email
        session["oauth_avatar"] = avatar
        session.permanent = True
        audit.record("login_oauth", detail=f"unisso:{username}({name}) ip={ip}")
        return redirect("/console")
    except Exception as e:
        log = __import__("logging").getLogger("oauth2")
        log.exception("unisso OAuth2 callback error")
        return redirect(f"/login?oauth_error=unisso&detail={urllib.parse.quote(str(e))}")

# --- webhook: push-to-deploy (branch-filtered) ---
@app.route("/deploy/webhook", methods=["POST"])
def deploy_webhook():
    """gitee/github push webhook. Triggers run() for matching auto_deploy deploys.
    No CSRF (external callback); auth via HMAC/token secret."""
    source = (request.args.get("source") or "").lower()
    body = request.get_data()
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
    # Signature check is scoped to the parsed repo+branch: candidate deploys are
    # matched first, then authorized by their own per-deploy secret (preferred)
    # or the platform-wide global secret (legacy fallback, admin-managed).
    matches, mode = deploys.match_webhook(source, request.headers, body, repo_url, branch)
    if not matches:
        audit.record("deploy_webhook", detail=f"auth fail source={source} repo={repo_url} branch={branch}", actor="webhook")
        return jsonify({"error": "bad signature"}), 403
    audit.record("deploy_webhook", detail=f"source={source} repo={repo_url} branch={branch} matches={len(matches)} mode={mode}", actor="webhook")
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
        # wait=True: 同一记录已有部署在跑就排队(在**这个后台线程**里等, 不占 gunicorn
        #   请求线程); skip_if_same_ref=True: ref 未变且程序 RUNNING 就跳过重启,
        #   让 GitHub 重投/连推同一 commit 变成幂等 no-op。
        threading.Thread(target=deploys.run, args=(group, dep),
                         kwargs={"wait": True, "skip_if_same_ref": True},
                         daemon=True).start()
        try:
            import pwa_alerts
            pwa_alerts.enqueue_webhook(group, dep, repo_url, branch, payload)
        except Exception:
            app.logger.exception("webhook notification enqueue failed for %s", group)
    return jsonify({"triggered": len(matches), "branch": branch, "mode": mode})


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


# --- Harness(编排)管理:SPA dev/harness 页使用的裸路径 ---
# frontend/src/routes/dev/harness.tsx 与 dev/index.tsx 直接用 fetch 拉取这些
# 无 /api 前缀的路径。guard() 已放行 /harness/ 到 Flask 处理器,权限由
# route_perm() 收口(/harness/store 任意登录用户可读,其余需 dev.harness)。
# 运行/商店导入走 api 蓝图(/api/harnesses/*,见 api/agents.py)。
@app.route("/harness/list")
def harness_list():
    """当前用户的 harness 名称列表。返回 {"names": [...]}。"""
    try:
        names = agent_conf.list_harnesses(current_user())
    except Exception:
        names = []
    return jsonify({"names": names})


@app.route("/harness/def")
def harness_def():
    """读取一个 harness 定义(JSON)。"""
    name = request.args.get("name", "")
    doc = agent_conf.load_harness(name, current_user()) if name else None
    if not doc:
        return jsonify({"error": f"harness 不存在: {name}"}), 404
    return jsonify(doc)


@app.route("/harness/store")
def harness_store():
    """公开商店中可导入的 harness 列表。返回 {"published": [...]}。"""
    try:
        items = agent_conf.list_public_harnesses()
    except Exception:
        items = []
    published = [{"name": it.get("name", ""),
                  "description": it.get("title") or "",
                  "author": it.get("author", ""),
                  "published_at": it.get("published_at", 0)} for it in items]
    return jsonify({"published": published})


@app.route("/harness/delete", methods=["POST", "GET"])
def harness_delete():
    """删除当前用户的一个 harness。"""
    if request.method == "GET":
        # 状态变更应走 POST;GET 仅为兼容旧前端保留,前端迁移后删除
        __import__("logging").getLogger("deprecation").warning(
            "GET /harness/delete 已废弃,请改用 POST(前端 dev/harness 页迁移后移除兼容)")
    body = request.get_json(silent=True) or {}
    name = request.args.get("name", "") or body.get("name", "")
    if not name:
        return jsonify({"error": "缺少 name"}), 400
    try:
        agent_conf.delete_harness(name, current_user())
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


# --- Socket.IO 事件: web 终端 ---
@socketio.on('connect')
def _sio_connect():
    """握手时建 PTY + kubectl exec。客户端 query 带 name。"""
    if not login_required():
        return False
    name = request.args.get('name', '')
    resume = request.args.get('resume', '')
    # 断线重连: token 命中且会话还活着 → 重绑 sid + 回放缓冲,不重建 shell
    if resume:
        with _SESSIONS_LOCK:
            rec = _TERM_TOKENS.get(resume)
            if rec is not None:
                old_sid = rec.get('sid')
                if old_sid and old_sid != request.sid:
                    SESSIONS.pop(old_sid, None)
                rec['sid'] = request.sid
                SESSIONS[request.sid] = rec
                timer = rec.get('cleanup_timer')
                rec['cleanup_timer'] = None
            else:
                rec = None
        if rec is not None:
            if timer:
                try:
                    timer.cancel()
                except Exception:
                    pass
            # 重连后按当前容器尺寸重设 winsize
            try:
                _cols = max(2, min(500, int(request.args.get('cols', 0) or 0)))
                _rows = max(2, min(300, int(request.args.get('rows', 0) or 0)))
            except (TypeError, ValueError):
                _cols = _rows = 0
            _set_winsize(rec['master'], _cols, _rows)
            emit('term_replay', {'data': rec['buf'], 'token': resume})
            audit.record('term_resume', detail=f"token={resume} sid={request.sid}")
            return
        # token 失效(超宽限期/进程退出): 走正常新建流程,前端拿到新 token
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
    # 初始 winsize 必须在 exec 之前设置:pty.openpty() 默认 0×0,而客户端的
    # 首次 fit/term_resize 发生在 socket 建立之前(发不出去),ResizeObserver
    # 又只在容器尺寸变化时触发——不在这里设,claude code 等全屏 TUI 会一直
    # 按初始窄宽度换行,直到用户手动拖一次面板。
    try:
        _cols = max(2, min(500, int(request.args.get('cols', 0) or 0)))
        _rows = max(2, min(300, int(request.args.get('rows', 0) or 0)))
    except (TypeError, ValueError):
        _cols = _rows = 0
    _set_winsize(master, _cols, _rows)
    try:
        # TERM must be set on the *remote* side: `kubectl exec -t` does not
        # forward the local TERM, it hardcodes TERM=xterm (verified against
        # k8s 1.3x), and this process has no controlling terminal anyway — so
        # the shell would come up with a crippled TERM and drop all color
        # (ls --color, PS1, git, …). `env TERM=… su -l cloud` survives the
        # login shell, so the PTY gets a real 256-color terminal.
        proc = subprocess.Popen(
            ['kubectl', '-n', groups.NS, 'exec', '-i', '-t', pod, '--',
             'env', 'TERM=xterm-256color', 'COLORTERM=truecolor',
             'su', '-l', 'cloud'],
            stdin=slave, stdout=slave, stderr=slave, close_fds=True,
            preexec_fn=lambda: _term_child_setup(slave),
        )
    finally:
        os.close(slave)  # fork 后父进程关闭 slave
    token = secrets.token_hex(16)
    rec = {'master': master, 'proc': proc, 'thread': None, 'token': token,
           'sid': sid, 'buf': '', 'cleanup_timer': None}
    t = threading.Thread(target=_term_reader, args=(rec, master), daemon=True)
    rec['thread'] = t
    with _SESSIONS_LOCK:
        SESSIONS[sid] = rec
        _TERM_TOKENS[token] = rec
    t.start()
    emit('term_ready', {'token': token})
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
    _set_winsize(s['master'], cols, rows)

@socketio.on('disconnect')
def _sio_disconnect():
    """客户端断开 -> 不立即杀 shell, 留 TERM_GRACE 秒等自动重连认领。"""
    sid = request.sid
    with _SESSIONS_LOCK:
        rec = SESSIONS.get(sid)
        if rec is None:
            return
        SESSIONS.pop(sid, None)
        if rec.get('cleanup_timer'):
            return  # 已有定时器在等
        timer = threading.Timer(TERM_GRACE, _term_cleanup_token,
                                args=(rec['token'],))
        rec['cleanup_timer'] = timer
    timer.daemon = True
    timer.start()

# --- LLM Config + Usage ---
import llm_conf
import llm_usage

# --- Health check ---
@app.route('/health')
def health():
    return jsonify({'health': 'ok'})

# --- Pod Web 入口兜底页 ---
# 当某个 Pod 的 Web 服务没起来时, relay nginx 把它的公网 23xxx server block
# 路由到这里(而不是直接甩 502)。欠费停机时页面会写明「资源已冻结」。
# 公开只读: 不需要登录, 只读该 Pod 的计费状态来决定文案。
@app.route('/pod-offline')
def pod_offline_page():
    import pod_offline
    group = (request.args.get('g') or '').strip()
    resp = Response(pod_offline.render(group), mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp, 404

# --- /goal 目标: 平台启动后延迟拉起未完成的 IDE 目标(自动复核完成度) ---
try:
    import ide_agent as _ide_agent
    _ide_agent.resume_goals()
except Exception:
    pass

if __name__ == "__main__":
    socketio.run(app, host="127.0.0.1", port=8090, allow_unsafe_werkzeug=True)
