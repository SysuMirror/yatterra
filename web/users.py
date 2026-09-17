#!/usr/bin/env python3
"""Multi-user store with 4 roles + pod-level ownership access control.

Users live in the platform's built-in MySQL (namespace platform-infra,
ClusterIP service `mysql`).  Database `yatterra`, table `users`.
Root credentials read from /opt/yatterra/db.conf.

Each user row: (username, password, role)
  password = "salt$pbkdf2_hex"  (pbkdf2-hmac-sha256, 100k iterations)

role ∈ super/admin/user/guest. Role expands to a set of fine-grained permissions
(ROLE_PERMS) for non-pod modules (infra/dev/ops/admin). Pod access is
ownership-based: each pod in groups.json has owners/members/pending lists.

Pod access levels:
  pod_role(user, pod_dict) → "owner" | "member" | None
  super/admin → "owner" for all pods
  username in pod["owners"] → "owner"
  username in pod["members"] → "member"
  else → None
"""
import json, os, subprocess, hashlib, hmac, secrets, threading
from queue import Queue, Empty, Full
import pymysql

import siteconf

DB_CONF = siteconf.path("db.conf")
OLD_USERS_FILE = siteconf.path("users.json")   # pre-migration backup (read-only)

# --- MySQL connection ---
_MYSQL_HOST = None
_MYSQL_PORT = 3306
_INIT_LOCK = threading.Lock()
_INITED = False


def _discover_mysql_host():
    """Return the MySQL ClusterIP from k3s (stable for the service's lifetime)."""
    try:
        r = subprocess.run(
            ["kubectl", "-n", "platform-infra", "get", "svc", "mysql",
             "-o", "jsonpath={.spec.clusterIP}"],
            capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return None


def _db_config():
    global _MYSQL_HOST
    if _MYSQL_HOST is None:
        _MYSQL_HOST = _discover_mysql_host() or os.environ.get("YATTERRA_MYSQL_HOST", "")
    # prefer env var, fallback to db.conf
    pw = os.environ.get("MYSQL_ROOT_PASSWORD")
    if not pw:
        with open(DB_CONF) as f:
            pw = json.load(f)["mysql_root_password"]
    return {
        "host": _MYSQL_HOST,
        "port": _MYSQL_PORT,
        "user": "root",
        "password": pw,
        "database": "yatterra",
        "charset": "utf8mb4",
        "cursorclass": pymysql.cursors.DictCursor,
        "autocommit": True,   # pooled conns must not hold REPEATABLE-READ
        # snapshots from read-only queries, or newly inserted rows (e.g.
        # API tokens) stay invisible on that conn until restart -> 401s.
        "connect_timeout": 5,
        "read_timeout": 5,
        "write_timeout": 5,
    }


# --- connection pool ---
_pool = Queue(maxsize=5)

class _PooledConn:
    """Context manager: get from pool on enter, return on exit."""
    def __enter__(self):
        # try reuse
        # Borrow only connections that survive ping(reconnect=True): a
        # TLS conn killed by the server still reports open=True, and reusing
        # it raises "MySQL server has gone away" (500 on every request).
        while True:
            try:
                cn = _pool.get_nowait()
            except Empty:
                break
            if not cn.open:
                continue
            try:
                cn.ping(reconnect=True)
                self._cn = cn
                return cn
            except Exception:
                try:
                    cn.close()
                except Exception:
                    pass
        self._cn = pymysql.connect(**_db_config())
        return self._cn

    def __exit__(self, *exc):
        cn = self._cn
        try:
            if cn.open:
                _pool.put_nowait(cn)
            else:
                cn.close()
        except Full:
            cn.close()
        return False

def _conn():
    """Return a pooled connection context manager."""
    return _PooledConn()


def _ensure_init():
    """Create database/table if missing; one-time migration from JSON."""
    global _INITED
    if _INITED:
        return
    with _INIT_LOCK:
        if _INITED:
            return
        cfg = _db_config()
        # connect without database to create it
        cfg_no_db = dict(cfg)
        db_name = cfg_no_db.pop("database")
        with pymysql.connect(**cfg_no_db) as cn:
            with cn.cursor() as cur:
                cur.execute(
                    f"CREATE DATABASE IF NOT EXISTS `{db_name}` "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        with pymysql.connect(**cfg) as cn:
            with cn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        username  VARCHAR(64)  PRIMARY KEY,
                        password  VARCHAR(255) NOT NULL,
                        role      VARCHAR(16)  NOT NULL DEFAULT 'user',
                        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS api_tokens (
                        id           VARCHAR(32)  PRIMARY KEY,
                        token_hash   VARCHAR(64)  NOT NULL,
                        username     VARCHAR(64)  NOT NULL,
                        name         VARCHAR(128) NOT NULL DEFAULT '',
                        created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        last_used_at TIMESTAMP    NULL,
                        INDEX idx_username (username)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS oauth_identities (
                        id              INT AUTO_INCREMENT PRIMARY KEY,
                        username        VARCHAR(64)  NOT NULL,
                        provider        VARCHAR(32)  NOT NULL,
                        provider_uid    VARCHAR(255) NOT NULL,
                        provider_name   VARCHAR(128) NOT NULL DEFAULT '',
                        provider_email  VARCHAR(128) NOT NULL DEFAULT '',
                        provider_avatar VARCHAR(255) NOT NULL DEFAULT '',
                        bound_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE KEY uk_provider_uid (provider, provider_uid),
                        INDEX idx_username (username)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                # one-time migration from old JSON file
                cur.execute("SELECT COUNT(*) AS n FROM users")
                if cur.fetchone()["n"] == 0 and os.path.exists(OLD_USERS_FILE):
                    try:
                        with open(OLD_USERS_FILE) as f:
                            old = json.load(f)
                        for u in old:
                            uname = u.get("username", "").strip()
                            if not uname:
                                continue
                            role = u.get("role", "user")
                            if role not in ROLE_PERMS:
                                role = "user"
                            pw = u.get("password", "")
                            if not pw or "$" not in pw:
                                pw = _hash_pw(secrets.token_urlsafe(24))
                            cur.execute(
                                "INSERT IGNORE INTO users (username,password,role) "
                                "VALUES (%s,%s,%s)", (uname, pw, role))
                        cn.commit()
                    except Exception:
                        pass
        _INITED = True


# --- 4 roles → permissions (non-pod modules) ---
ROLE_PERMS = {
    "super": ["*"],
    "admin": ["group.create", "group.view", "group.terminal",
              "infra.host", "infra.storage", "infra.db", "infra.scheduler", "infra.proxy",
              "dev.harness", "dev.mcp", "dev.agent", "dev.llm",
              "ops.audit", "ops.threat", "ops.shared.read", "ops.shared.write", "ops.deploy",
              "admin.users"],
    "user":  ["group.create", "group.view", "group.terminal", "dev.agent", "dev.llm",
              "ops.shared.read", "ops.threat",
              "infra.host", "infra.storage.read", "infra.db.read"],
    "guest": ["group.view", "infra.host"],
}
ROLES = [("super", "超级管理员"), ("admin", "管理员"),
         ("user", "普通用户"), ("guest", "游客")]

# --- permission groups (for UI display) ---
PERM_GROUPS = [
    ("分组管理", [
        ("group.create", "创建 Pod"),
        ("group.view", "查看总览"),
        ("group.terminal", "Pod 终端/编程"),
    ]),
    ("基础设施", [
        ("infra.host", "主机健康/GPU"),
        ("infra.storage.read", "MinIO 存储只读"),
        ("infra.storage", "MinIO 存储管理"),
        ("infra.db.read", "数据库只读"),
        ("infra.db", "数据库管理"),
        ("infra.scheduler", "GPU 调度"),
        ("infra.proxy", "子域名反代"),
    ]),
    ("开发编排", [
        ("dev.harness", "编排 DAG"),
        ("dev.mcp", "MCP 服务"),
        ("dev.agent", "助手悬浮窗"),
        ("dev.llm", "LLM 配置/用量"),
    ]),
    ("运维", [
        ("ops.audit", "审计日志"),
        ("ops.threat", "攻防威胁地图"),
        ("ops.shared.read", "共享只读"),
        ("ops.shared.write", "共享读写"),
        ("ops.deploy", "CI/CD 部署"),
    ]),
    ("管理", [
        ("admin.users", "用户管理"),
    ]),
]
ALL_PERMS = [k for _, items in PERM_GROUPS for k, _ in items]


# --- password hashing ---
def _hash_pw(pw, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt.encode("utf-8"), 100000)
    return salt + "$" + dk.hex()


def _verify_pw(pw, stored):
    if not stored or "$" not in stored:
        return False
    salt, h = stored.split("$", 1)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt.encode("utf-8"), 100000)
    return hmac.compare_digest(dk.hex(), h)


# --- permission checks (non-pod modules) ---
def expanded_perms(user):
    """Return the set of all permissions granted to user."""
    if not user:
        return set()
    role = user.get("role", "user")
    perms = set(ROLE_PERMS.get(role, []))
    if "*" in perms:
        return set(ALL_PERMS) | {"*"}
    # write perms imply their read-only counterparts (admin keeps full access)
    for write_perm, read_perm in _WRITE_IMPLIES_READ.items():
        if write_perm in perms:
            perms.add(read_perm)
    return perms


# holding a write perm grants the matching read-only perm
_WRITE_IMPLIES_READ = {
    "infra.storage": "infra.storage.read",
    "infra.db": "infra.db.read",
}


def has_perm(user, perm):
    if not user:
        return False
    perms = expanded_perms(user)
    return perm in perms or "*" in perms


# --- pod access checks ---
def pod_role(user, pod):
    """Return "owner", "member", or None for user's access to a pod dict.

    pod is a group dict from groups.json with optional owners/members lists.
    super/admin roles get owner-level access to all pods.
    """
    if not user or not pod:
        return None
    role = user.get("role", "user")
    if role in ("super", "admin"):
        return "owner"
    username = user.get("username", "")
    if username in (pod.get("owners") or []):
        return "owner"
    if username in (pod.get("members") or []):
        return "member"
    return None


def can_pod(user, pod, level):
    """Check if user has at least `level` access to pod.

    level: "member" (member or owner) or "owner" (owner only).
    """
    pr = pod_role(user, pod)
    if level == "owner":
        return pr == "owner"
    if level == "member":
        return pr in ("owner", "member")
    return False


# --- user CRUD ---
def list_users():
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute("SELECT username, role FROM users ORDER BY username")
            return [{"username": r["username"], "role": r["role"]} for r in cur.fetchall()]


def authenticate(username, password):
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute("SELECT username, password, role FROM users WHERE username=%s",
                        (username,))
            r = cur.fetchone()
    if r and _verify_pw(password, r["password"]):
        return {"username": r["username"], "role": r["role"]}
    return None


def get_user(username):
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute("SELECT username, role FROM users WHERE username=%s",
                        (username,))
            r = cur.fetchone()
    if r:
        return {"username": r["username"], "role": r["role"]}
    return None


def create_user(username, password, role="user"):
    username = (username or "").strip()
    if not username:
        return False, "用户名不能为空"
    if not password:
        return False, "密码不能为空"
    role = role if role in ROLE_PERMS else "user"
    _ensure_init()
    try:
        with _conn() as cn:
            with cn.cursor() as cur:
                cur.execute(
                    "INSERT INTO users (username, password, role) VALUES (%s,%s,%s)",
                    (username, _hash_pw(password), role))
            cn.commit()
    except pymysql.err.IntegrityError:
        return False, "用户名已存在"
    return True, None


def delete_user(username):
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE username=%s", (username,))
        cn.commit()


def set_role(username, role):
    role = role if role in ROLE_PERMS else "user"
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute("UPDATE users SET role=%s WHERE username=%s", (role, username))
        cn.commit()


def set_password(username, password):
    if not password:
        return False, "密码不能为空"
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute("UPDATE users SET password=%s WHERE username=%s",
                        (_hash_pw(password), username))
            if cur.rowcount == 0:
                return False, "用户不存在"
        cn.commit()
    return True, None


# --- API token CRUD ---
def create_token(username, name=""):
    """Create an API token for username. Returns the plaintext token (shown once)."""
    _ensure_init()
    tid = secrets.token_hex(8)       # 16 hex chars
    secret = secrets.token_hex(16)   # 32 hex chars
    token = f"yt_{tid}_{secret}"
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "INSERT INTO api_tokens (id, token_hash, username, name) "
                "VALUES (%s,%s,%s,%s)", (tid, token_hash, username, name))
        cn.commit()
    return token


def verify_token(token):
    """Verify a token string. Returns {username, role} or None."""
    if not token or not token.startswith("yt_"):
        return None
    _ensure_init()
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT t.username, u.role FROM api_tokens t "
                "JOIN users u ON u.username = t.username "
                "WHERE t.token_hash = %s", (token_hash,))
            r = cur.fetchone()
            if r:
                cur.execute(
                    "UPDATE api_tokens SET last_used_at = NOW() "
                    "WHERE token_hash = %s", (token_hash,))
                cn.commit()
                return {"username": r["username"], "role": r["role"]}
    return None


def list_tokens(username):
    """List all tokens for username (without secrets)."""
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT id, name, created_at, last_used_at "
                "FROM api_tokens WHERE username = %s ORDER BY created_at DESC",
                (username,))
            return [dict(r) for r in cur.fetchall()]


def delete_token(username, token_id):
    """Delete a token. Only the owner can delete their own token."""
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "DELETE FROM api_tokens WHERE id = %s AND username = %s",
                (token_id, username))
            deleted = cur.rowcount
        cn.commit()
    return deleted > 0


# ---------------------------------------------------------------------------
# OAuth identity binding
# ---------------------------------------------------------------------------

def list_identities(username):
    """List all OAuth identities bound to a yatterra user."""
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT id, provider, provider_uid, provider_name, "
                "provider_email, provider_avatar, bound_at "
                "FROM oauth_identities WHERE username = %s ORDER BY bound_at",
                (username,))
            return [dict(r) for r in cur.fetchall()]


def find_user_by_identity(provider, provider_uid):
    """Find which yatterra username an external identity is bound to.
    Returns username string or None."""
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT username FROM oauth_identities "
                "WHERE provider = %s AND provider_uid = %s LIMIT 1",
                (provider, str(provider_uid)))
            row = cur.fetchone()
            return row["username"] if row else None


def bind_identity(username, provider, provider_uid,
                  provider_name="", provider_email="", provider_avatar=""):
    """Bind an external OAuth identity to a yatterra user.
    Returns (True, None) on success, (False, error_msg) on failure."""
    _ensure_init()
    provider_uid = str(provider_uid)
    # check if already bound to a different user
    existing = find_user_by_identity(provider, provider_uid)
    if existing:
        if existing == username:
            return False, "已绑定该外部账号"
        return False, f"该{provider}账号已被用户 {existing} 绑定"
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "INSERT INTO oauth_identities "
                "(username, provider, provider_uid, provider_name, "
                "provider_email, provider_avatar) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (username, provider, provider_uid, provider_name,
                 provider_email, provider_avatar))
        cn.commit()
    return True, None


def unbind_identity(username, identity_id):
    """Unbind an external OAuth identity. Only the owner can unbind."""
    _ensure_init()
    with _conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "DELETE FROM oauth_identities WHERE id = %s AND username = %s",
                (identity_id, username))
            deleted = cur.rowcount
        cn.commit()
    return deleted > 0

