"""Central site configuration — every deployment-specific value in one place.

All values are read from environment variables, with defaults that match the
reference deployment so the platform runs unmodified out of the box. Operators
override them via the systemd ``EnvironmentFile`` (``/opt/yatterra/.env``)
without editing source.

Nothing secret is hardcoded here: credentials (OAuth secrets, frpc admin
password, DB/MinIO keys) have **empty** defaults and must come from the
environment. See ``.env.example`` for the full list.
"""
import os


def _env(name, default=""):
    """Read an env var; treat empty string as unset so defaults apply."""
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _int(name, default):
    try:
        return int(_env(name, default))
    except (TypeError, ValueError):
        return default


def _list(name, default):
    raw = _env(name, "")
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# --------------------------------------------------------------------------- #
# Layout
# --------------------------------------------------------------------------- #
ROOT = _env("YATTERRA_ROOT", "/opt/yatterra")
WEB_DIR = _env("YATTERRA_WEB_DIR", os.path.join(ROOT, "web"))


def path(*parts):
    """Path under the platform root (state files, configs, logs)."""
    return os.path.join(ROOT, *parts)


def web_path(*parts):
    """Path under the platform web directory."""
    return os.path.join(WEB_DIR, *parts)


# --------------------------------------------------------------------------- #
# Kubernetes namespaces
# --------------------------------------------------------------------------- #
# GROUP_NS holds the per-group work containers ("groups" in the UI). The
# namespace name itself is still `students` for backward compatibility with
# existing clusters; override with YATTERRA_GROUP_NS.
GROUP_NS = _env("YATTERRA_GROUP_NS", _env("YATTERRA_STUDENT_NS", "students"))
INFRA_NS = _env("YATTERRA_INFRA_NS", "platform-infra")

# In-cluster service endpoints (depend on the namespaces above).
MYSQL_SERVICE = _env("YATTERRA_MYSQL_SERVICE",
                     f"mysql.{INFRA_NS}.svc.cluster.local")
REDIS_SERVICE = _env("YATTERRA_REDIS_SERVICE",
                     f"redis.{INFRA_NS}.svc.cluster.local")
QDRANT_SERVICE = _env("YATTERRA_QDRANT_SERVICE",
                      f"qdrant.{INFRA_NS}.svc.cluster.local")
MINIO_SERVICE = _env("YATTERRA_MINIO_SERVICE",
                     f"minio.{INFRA_NS}.svc.cluster.local")

# --------------------------------------------------------------------------- #
# Public entry (relay domain + port scheme)
# --------------------------------------------------------------------------- #
DOMAIN = _env("YATTERRA_DOMAIN", "ssemarket.cn")
PUBLIC_HOST = _env("YATTERRA_PUBLIC_HOST", DOMAIN)
PUBLIC_SCHEME = _env("YATTERRA_PUBLIC_SCHEME", "https")

# Public port bases: group index i → SSH 22000+i, web 23000+i.
SSH_PUBLIC_BASE = _int("YATTERRA_SSH_PUBLIC_BASE", 22000)
WEB_PUBLIC_BASE = _int("YATTERRA_WEB_PUBLIC_BASE", 23000)
PLATFORM_GUI_PORT = _int("YATTERRA_GUI_PORT", 24000)


def public_url(port=None):
    """Public URL for this relay host, optionally with an explicit port."""
    base = f"{PUBLIC_SCHEME}://{PUBLIC_HOST}"
    return f"{base}:{port}" if port else base


PLATFORM_URL = _env("YATTERRA_PLATFORM_URL", public_url(PLATFORM_GUI_PORT))

# --------------------------------------------------------------------------- #
# Host data roots (hostPath volumes)
# --------------------------------------------------------------------------- #
GROUP_DATA_ROOT = _env("YATTERRA_GROUP_DATA_ROOT", "/mnt/sdb/groups")
SHARED_ROOT = _env("YATTERRA_SHARED_ROOT", "/mnt/sdb/shared")
DB_DATA_ROOT = _env("YATTERRA_DB_DATA_ROOT", "/mnt/sdb/db")
MINIO_DATA_ROOT = _env("YATTERRA_MINIO_DATA_ROOT", "/mnt/sdb/minio")
HONEYPOT_DIR = _env("YATTERRA_HONEYPOT_DIR", "/mnt/sdb/honeypot")
PRESSURE_DIR = _env("YATTERRA_PRESSURE_DIR",
                    os.path.join(SHARED_ROOT, "pressure"))
DISK_MOUNTS = _list("YATTERRA_DISK_MOUNTS", ["/", "/mnt/sdb"])

# --------------------------------------------------------------------------- #
# frp — frpc admin API (used to reload tunnels)
# --------------------------------------------------------------------------- #
FRPC_ADMIN_URL = _env("FRPC_ADMIN_URL", "http://127.0.0.1:7500")
FRPC_ADMIN_USER = _env("FRPC_ADMIN_USER", "admin")
FRPC_ADMIN_PASS = _env("FRPC_ADMIN_PASS", "")   # required; set in .env

# --------------------------------------------------------------------------- #
# Public relay server (managed over SSH via remote_hosts.json)
# --------------------------------------------------------------------------- #
RELAY_HOST_NAME = _env("YATTERRA_RELAY_HOST", "ssemarket")
NGINX_PROXY_CONF = _env("YATTERRA_NGINX_PROXY_CONF",
                        "/root/SSE_Market/nginx_proxy/nginx.conf")
NGINX_PROXY_CONTAINER = _env("YATTERRA_NGINX_PROXY_CONTAINER",
                             "sse_market_server-nginx_proxy-1")
NGINX_WEB_CONF = _env("YATTERRA_NGINX_WEB_CONF",
                      "/etc/nginx/sites-available/https-web.conf")
NGINX_SSL_CERT = _env("YATTERRA_NGINX_SSL_CERT",
                      f"/root/SSE_Market/Nginx/live/{DOMAIN}/fullchain.pem")
NGINX_SSL_KEY = _env("YATTERRA_NGINX_SSL_KEY",
                     f"/root/SSE_Market/Nginx/live/{DOMAIN}/privkey.pem")
# Subdomains that the proxy manager must never hand out.
RESERVED_SUBDOMAINS = set(_list(
    "YATTERRA_RESERVED_SUBDOMAINS",
    ["ssemarket", "www", "cloud", "sso", "admin", "iwiki"]))

# --------------------------------------------------------------------------- #
# Agent harnesses (per-user orchestration DAGs)
# --------------------------------------------------------------------------- #
HARNESSES_DIR = _env("YATTERRA_HARNESSES_DIR", os.path.join(ROOT, "harnesses"))
HARNESSES_PUBLIC_DIR = _env("YATTERRA_HARNESSES_PUBLIC_DIR",
                            os.path.join(ROOT, "harnesses_public"))

# --------------------------------------------------------------------------- #
# Group work container
# --------------------------------------------------------------------------- #
# Container name inside the pod, and the unprivileged login user inside it.
GROUP_CONTAINER = _env("YATTERRA_GROUP_CONTAINER",
                       _env("YATTERRA_STUDENT_CONTAINER", "ubuntu"))
CLOUD_USER = _env("YATTERRA_CLOUD_USER", _env("YATTERRA_STUDENT_USER", "cloud"))
CLOUD_UID = _int("YATTERRA_CLOUD_UID", 1001)
# Env var the container entrypoint reads to set the login password.
PASSWORD_ENV = _env("YATTERRA_PASSWORD_ENV", "CLOUD_PASSWORD")
