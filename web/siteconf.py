"""Central site configuration — every deployment-specific value in one place.

All values are read from environment variables. The defaults are **generic
placeholders** (``example.com``, ``/srv/yatterra``, …) so that no real
deployment's topology is baked into the source. A real deployment must set the
values it cares about in the systemd ``EnvironmentFile``
(``<platform root>/.env``) — see ``.env.example`` for the full list.

Nothing secret is hardcoded here: credentials (OAuth secrets, frpc admin
password, DB/MinIO keys) have **empty** defaults and must come from the
environment.
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
ROOT = _env("YATTERRA_ROOT", "/srv/yatterra")
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
# GROUP_NS holds the per-group work containers ("groups" in the UI).
GROUP_NS = _env("YATTERRA_GROUP_NS", "clouds")
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
CLICKHOUSE_SERVICE = _env("YATTERRA_CLICKHOUSE_SERVICE",
                          f"langfuse-clickhouse.{INFRA_NS}.svc.cluster.local")
KAFKA_SERVICE = _env("YATTERRA_KAFKA_SERVICE",
                     f"kafka.{INFRA_NS}.svc.cluster.local")

# ARTEX 自主渗透平台（group-artex pod 的 Go 单体后端）。安全巡检板通过它的
# HTTP API 驱动端到端渗透测试：yatterra 侧不需要它的管理员口令——直接读它的
# HS256 签名密钥(jwt.key)自签一枚 JWT 调用 /api/*（见 artex_svc.py）。
ARTEX_URL = _env("YATTERRA_ARTEX_URL", "http://127.0.0.1:32038")
ARTEX_KEY_FILE = _env("YATTERRA_ARTEX_KEY_FILE",
                      "/mnt/sdb/groups/artex/home/artex/jwt.key")

# --------------------------------------------------------------------------- #
# Public entry (relay domain + port scheme)
# --------------------------------------------------------------------------- #
DOMAIN = _env("YATTERRA_DOMAIN", "example.com")
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

# Host the platform console is served under. The console has exactly ONE public
# origin: cookies are scoped per host, so serving it on both `cloud.<domain>`
# (443, via the nginx_proxy container) and `<domain>:24000` (via https-web.conf)
# would split sessions — a login on one entry looks logged-out on the other.
# Everything (OAuth redirect_uri, deploy REPORT_URL, PWA start_url) must agree.
PLATFORM_HOST = _env("YATTERRA_PLATFORM_HOST", f"cloud.{DOMAIN}")

# Canonical console URL — single origin, no explicit port.
PLATFORM_CONSOLE_URL = _env("YATTERRA_PLATFORM_CONSOLE_URL",
                            f"{PUBLIC_SCHEME}://{PLATFORM_HOST}")

# --------------------------------------------------------------------------- #
# Host data roots (hostPath volumes)
# --------------------------------------------------------------------------- #
GROUP_DATA_ROOT = _env("YATTERRA_GROUP_DATA_ROOT", "/srv/data/groups")
# Cross-node read-write sync disk. Same path on every node: local dir on the
# platform node, NFS mount (from the platform node) on remote nodes. Mounted
# into every group pod at /interop.
INTEROP_ROOT = _env("YATTERRA_INTEROP_ROOT", "/mnt/sdb/interop")
SHARED_ROOT = _env("YATTERRA_SHARED_ROOT", "/srv/data/shared")
DB_DATA_ROOT = _env("YATTERRA_DB_DATA_ROOT", "/srv/data/db")
MINIO_DATA_ROOT = _env("YATTERRA_MINIO_DATA_ROOT", "/srv/data/minio")
HONEYPOT_DIR = _env("YATTERRA_HONEYPOT_DIR", "/srv/data/honeypot")
PRESSURE_DIR = _env("YATTERRA_PRESSURE_DIR",
                    os.path.join(SHARED_ROOT, "pressure"))
DISK_MOUNTS = _list("YATTERRA_DISK_MOUNTS", ["/", "/srv/data"])

# --------------------------------------------------------------------------- #
# frp — frpc admin API (used to reload tunnels)
# --------------------------------------------------------------------------- #
FRPC_ADMIN_URL = _env("FRPC_ADMIN_URL", "http://127.0.0.1:7500")
FRPC_ADMIN_USER = _env("FRPC_ADMIN_USER", "admin")
FRPC_ADMIN_PASS = _env("FRPC_ADMIN_PASS", "")   # required; set in .env

# --------------------------------------------------------------------------- #
# Public relay server (managed over SSH via remote_hosts.json)
# --------------------------------------------------------------------------- #
RELAY_HOST_NAME = _env("YATTERRA_RELAY_HOST", "relay")
NGINX_PROXY_CONF = _env("YATTERRA_NGINX_PROXY_CONF",
                        "/etc/nginx/conf.d/relay-proxy.conf")
NGINX_PROXY_CONTAINER = _env("YATTERRA_NGINX_PROXY_CONTAINER",
                             "nginx-proxy")
# Path the proxy conf is mounted at *inside* the container. The container runs
# `nginx -c <this>`, so -t/-T checks must target it explicitly (the default
# /etc/nginx/nginx.conf is the unused image default).
NGINX_PROXY_CONTAINER_CONF = _env("YATTERRA_NGINX_PROXY_CONTAINER_CONF",
                                  "/etc/nginx/custom.conf")
NGINX_WEB_CONF = _env("YATTERRA_NGINX_WEB_CONF",
                      "/etc/nginx/sites-available/https-web.conf")
NGINX_SSL_CERT = _env("YATTERRA_NGINX_SSL_CERT",
                      f"/etc/nginx/ssl/{DOMAIN}/fullchain.pem")
NGINX_SSL_KEY = _env("YATTERRA_NGINX_SSL_KEY",
                     f"/etc/nginx/ssl/{DOMAIN}/privkey.pem")
# Subdomains that the proxy manager must never hand out.
RESERVED_SUBDOMAINS = set(_list(
    "YATTERRA_RESERVED_SUBDOMAINS",
    ["www", "cloud", "sso", "admin"]))

# Extra public entry hostnames (e.g. a Cloudflare Tunnel backup domain) that the
# platform will accept as a valid origin when building OAuth redirect_uri values.
# Comma-separated. Empty by default — the primary relay host is always allowed.
EXTRA_PUBLIC_HOSTS = _list("YATTERRA_EXTRA_PUBLIC_HOSTS", [])

# Domain attribute(s) for the session cookie, comma-separated. Cookies ignore
# the port, so the registrable domain lets every console entry on the SAME
# domain share one session — e.g. `cloud.<domain>` (443, nginx_proxy) and
# `<domain>:24000` (https-web.conf) stop looking logged-out to each other.
# Origins on a DIFFERENT registrable domain (e.g. a Cloudflare Tunnel backup
# domain) still get their own session: a cookie can never span registrable
# domains, and that is deliberate. Empty = host-only cookie (previous behaviour).
SESSION_COOKIE_DOMAINS = _list("YATTERRA_SESSION_COOKIE_DOMAINS", [f".{DOMAIN}"])

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
GROUP_CONTAINER = _env("YATTERRA_GROUP_CONTAINER", "ubuntu")
CLOUD_USER = _env("YATTERRA_CLOUD_USER", "cloud")
CLOUD_UID = _int("YATTERRA_CLOUD_UID", 1000)
# Env var the container entrypoint reads to set the login password.
PASSWORD_ENV = _env("YATTERRA_PASSWORD_ENV", "CLOUD_PASSWORD")

# --------------------------------------------------------------------------- #
# Default outbound proxy for group pods
# --------------------------------------------------------------------------- #
# Every pod (container env + supervised programs) points at the host's mihomo
# core. Routing policy lives on the proxy (mode: rule = CN direct / foreign
# proxied), so pods need no policy of their own — they only need to point here.
# A group can override any of these via its custom env vars.
def _guess_lan_ip():
    """IP of the interface holding the default route (no packet is sent)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("223.5.5.5", 80))
        return s.getsockname()[0]
    except Exception:
        return ""
    finally:
        s.close()

PROXY_HOST = _env("YATTERRA_PROXY_HOST", _guess_lan_ip())
PROXY_PORT = _env("YATTERRA_PROXY_PORT", "7890")
PROXY_URL = _env("YATTERRA_PROXY_URL", f"http://{PROXY_HOST}:{PROXY_PORT}" if PROXY_HOST else "")
# Never proxied: loopback, RFC1918 + cluster CIDRs, cluster DNS suffixes, own domains.
NO_PROXY = _env("YATTERRA_NO_PROXY", ",".join([
    "localhost", "127.0.0.1", "::1", "0.0.0.0",
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "10.42.0.0/16", "10.43.0.0/16",
    ".svc", ".svc.cluster.local", ".cluster.local", ".local",
    DOMAIN, f".{DOMAIN}", f"cloud.{DOMAIN}", f"api.{DOMAIN}", ".mony.eu.org",
]))


def proxy_env_defaults():
    """Proxy env for one group. Empty if no proxy host is known, so a missing
    proxy degrades to the previous (direct) behaviour instead of breaking pods."""
    if not PROXY_URL:
        return {}
    return {
        "HTTP_PROXY": PROXY_URL, "HTTPS_PROXY": PROXY_URL, "ALL_PROXY": PROXY_URL,
        "NO_PROXY": NO_PROXY,
        "http_proxy": PROXY_URL, "https_proxy": PROXY_URL, "all_proxy": PROXY_URL,
        "no_proxy": NO_PROXY,
    }


def proxy_auto_enabled(group_env):
    """Whether a group wants the default outbound proxy injected into the Pod.

    A group can opt out by setting ``YATTERRA_PROXY_MODE`` in its custom env to
    off / manual / 0 / false / no (case-insensitive). The Pod then starts with
    **no** proxy env and reaches the internet only after the interactive
    ``proxy on`` command (the opt-in shell helper sourced from ~/.bashrc).
    Anything else, or unset, keeps the historical always-on default."""
    mode = str((group_env or {}).get("YATTERRA_PROXY_MODE", "auto")).strip().lower()
    return mode not in ("off", "manual", "0", "false", "no")
