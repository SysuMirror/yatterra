#!/usr/bin/env python3
"""Core logic for the platform groups: state, manifests, frpc, kubectl."""
import users
import json, os, re, secrets, string, subprocess, textwrap, shutil, time, threading
import audit
import req_estimate
import siteconf
import nodes

# --- constants ---
STATE_FILE = siteconf.path("groups.json")
FRPC_FILE = os.environ.get("YATTERRA_FRPC_FILE", "/opt/frp/frpc.toml")
MANIFEST_DIR = siteconf.path("manifests")
NS = siteconf.GROUP_NS
IMAGE = os.environ.get("YATTERRA_GROUP_IMAGE",
                       "docker.io/sse/cloud-ubuntu:24.04")

SSH_NODEPORT_BASE = int(os.environ.get("YATTERRA_SSH_NODEPORT_BASE", "31000"))
WEB_NODEPORT_BASE = int(os.environ.get("YATTERRA_WEB_NODEPORT_BASE", "32000"))
SSH_PUBLIC_BASE = siteconf.SSH_PUBLIC_BASE
WEB_PUBLIC_BASE = siteconf.WEB_PUBLIC_BASE
GPU_COUNT = 3
# Public-port pool.  index i -> ssh 22000+i / web 23000+i / nodePort 31000+i / 32000+i.
# Freed indexes are reused (alloc_index picks the lowest gap), so a fully deleted
# group releases its ports for the next create.
MAX_GROUPS = int(os.environ.get("YATTERRA_MAX_GROUPS", "100"))

FRPC_MARK_BEGIN = "# >>> yatterra managed >>>"
FRPC_MARK_END = "# <<< yatterra managed <<<"
FRPC_ADMIN = (siteconf.FRPC_ADMIN_USER, siteconf.FRPC_ADMIN_PASS)
PLATFORM_GUI_PORT = siteconf.PLATFORM_GUI_PORT

# --- cloud nginx web-ssl (23xxx → 13xxx frpc) auto-sync ---
NGINX_WEB_CONF = siteconf.NGINX_WEB_CONF
NGINX_MARK_BEGIN = "# >>> yatterra web-ssl managed >>>"
NGINX_MARK_END = "# <<< yatterra web-ssl managed <<<"
NGINX_SSL_CERT = siteconf.NGINX_SSL_CERT
NGINX_SSL_KEY = siteconf.NGINX_SSL_KEY
NGINX_REMOTE_HOST = siteconf.RELAY_HOST_NAME  # remote_hosts.json entry
# 平台上开在 relay 上的内部端口(frps 侧), 供 pod 兜底页等回源到 GUI(8090)
NGINX_OFFLINE_INNER = PLATFORM_GUI_PORT - 10000
# htpasswd for basic-auth on "sensitive" web blocks (windows VM groups: the
# noVNC console = full desktop of the guest). Written on the relay by us.
NGINX_HTPASSWD = os.environ.get("YATTERRA_NGINX_HTPASSWD",
                                "/etc/nginx/yatterra-htpasswd")
# group types whose public web entry gets auth_basic
AUTH_WEB_TYPES = {"windows", "android"}

DEFAULT_CPU_CPU = "2"
DEFAULT_CPU_MEM = "4Gi"
DEFAULT_GPU_CPU = "4"
DEFAULT_GPU_MEM = "16Gi"
# per-group persistent home (survives rollout restart). hostPath on the big disk;
# size is a recorded soft cap (local-path/ext4 don't hard-enforce -> advisory).
GROUP_DATA_ROOT = siteconf.GROUP_DATA_ROOT
DEFAULT_STORAGE = "10Gi"

# Windows VM group (dockurr/windows = QEMU/KVM Windows in a container, noVNC web
# UI). Its own image + disk hostPath; needs /dev/kvm (so the container must be
# privileged) -> kept as a distinct group type.
WINDOWS_IMAGE = os.environ.get("YATTERRA_WINDOWS_IMAGE",
                               "docker.io/dockurr/windows:latest")
WINVM_ROOT = os.environ.get("YATTERRA_WINVM_ROOT", "/mnt/sdb/yatterra-win")
WINDOWS_DEFAULT_CPU = "4"
WINDOWS_DEFAULT_MEM = "10Gi"
# Windows account dockurr creates (must NOT be a built-in name: Administrator,
# Guest, DefaultAccount, WDAGUtilityAccount -> dockurr errors out with exit 84).
WINDOWS_DEFAULT_USER = os.environ.get("YATTERRA_WINDOWS_USER", "winadmin")

# Android VM group (budtmo/docker-android = QEMU Android emulator in a container,
# noVNC web UI + ADB + Appium). Needs /dev/kvm (privileged) -> distinct type.
ANDROID_IMAGE = os.environ.get("YATTERRA_ANDROID_IMAGE",
                               "docker.io/budtmo/docker-android:emulator_14.0")
ANDROID_ROOT = os.environ.get("YATTERRA_ANDROID_ROOT", "/mnt/sdb/yatterra-android")
ANDROID_DEFAULT_CPU = "4"
ANDROID_DEFAULT_MEM = "8Gi"
# Internal ports exposed via ClusterIP Service for automation tooling.
ANDROID_ADB_PORT = 5555
ANDROID_APPIUM_PORT = 4723
# noVNC (websockify) port. NOT 8080: the image's `docker-android start vnc_web`
# shells out to /opt/noVNC/utils/novnc_proxy as
#     novnc_proxy --vnc localhost:5900 localhost:8080
# but that novnc_proxy only honours the listen port via `--listen`; a bare
# positional breaks out of its arg loop and is dropped, so it always binds its
# compiled-in default 6080 and WEB_VNC_PORT is silently ignored. We therefore
# serve the web UI on 6080 and let the Service redirect 8080 -> 6080 (see
# _web_target_port); WEB_VNC_PORT is still pinned to 6080 so both code paths
# land on the same port if the image ever starts honouring it.
ANDROID_WEB_PORT = 6080
# The image runs the emulator as the unprivileged `androidusr` account and its
# code lives *inside* /home/androidusr (docker-android/mixins/scripts/run.sh is
# the ENTRYPOINT). Persisting that dir means mounting an (initially empty)
# hostPath over the image's home — which would hide the entrypoint. So the
# initContainer below re-seeds the mount from the image on first boot (same
# trick as the /home/cloud re-seed in INIT_SCRIPT) and hands it to this uid.
ANDROID_UID = 1300
ANDROID_GID = 1301

# Container init: the hostPath at /home/cloud shadows the image's skel-populated
# home, so on first boot (empty mount) we re-seed from /etc/skel + chown to cloud,
# then start sshd. Also bootstrap supervisord (pip --user, lives in persistent
# /home/cloud) to supervise managed deploys — survives pod restart. Wrapped by
# tini (PID 1) for signal/reap handling.
INIT_SCRIPT = """set -e
mkdir -p /run/sshd
if [ -n "$CLOUD_PASSWORD" ]; then echo "cloud:${CLOUD_PASSWORD}" | chpasswd; fi
if [ ! -e /home/cloud/.bashrc ]; then
  cp -a /etc/skel/. /home/cloud/ 2>/dev/null || true
  chown -R cloud:cloud /home/cloud 2>/dev/null || true
fi
# Expose the read-only programming guide (/shared/README.md, on the read-only
# shared disk every pod mounts) into the home dir so humans and AI coding agents
# that scan the working directory (README.md / AGENTS.md / CLAUDE.md) find it.
# Never overwrite a real file the user put there — only add the symlink when the
# path is free.
if [ -e /shared/README.md ]; then
  for f in README.md AGENTS.md CLAUDE.md; do
    if [ ! -e "/home/cloud/$f" ] && [ ! -L "/home/cloud/$f" ]; then
      ln -s /shared/README.md "/home/cloud/$f" 2>/dev/null || true
    fi
  done
fi
su -l cloud -c "mkdir -p ~/deploy/programs ~/deploy/logs ~/logs"
if [ ! -x /home/cloud/.local/bin/supervisord ]; then
  su -l cloud -c "pip install --user --break-system-packages -q supervisor" >/tmp/sup_install.log 2>&1 || true
fi
# Is supervisord already running? The pidfile lives on the persistent hostPath,
# so it survives pod recreation and its PID may collide with an unrelated
# process in the new PID namespace — `kill -0 $pid` alone is NOT proof, and a
# stale hit silently skips the start (that is how rag came back with no
# supervisord after a pod rebuild). Verify the PID's actual cmdline via
# /proc/<pid>/cmdline (NOT pgrep -f: the init script's own command line
# contains the pattern text, so pgrep would always match PID 1).
SUP_RUNNING=0
SUP_PID=$(cat /home/cloud/deploy/supervisord.pid 2>/dev/null || true)
if [ -n "$SUP_PID" ] && [ -r "/proc/$SUP_PID/cmdline" ] && tr '\\0' ' ' < "/proc/$SUP_PID/cmdline" | grep -q "bin/supervisord"; then
  SUP_RUNNING=1
else
  rm -f /home/cloud/deploy/supervisord.pid /home/cloud/deploy/supervisor.sock 2>/dev/null || true
fi
if [ "$SUP_RUNNING" = "0" ] && [ -e /home/cloud/deploy/supervisord.conf ] && [ -x /home/cloud/.local/bin/supervisord ]; then
  su -l cloud -c "~/.local/bin/supervisord -c ~/deploy/supervisord.conf" >>/home/cloud/deploy/supervisord.boot.log 2>&1 &
  sleep 1
fi
exec /usr/sbin/sshd -D -e"""

# Appended to the init script for privileged groups only. Privileged groups
# install host-coupled software (e.g. a VPN client) that lives in the ephemeral
# container rootfs (/usr/local, /lib, /etc/init.d) and disappears when the Pod is
# recreated. The durable payload is kept under /home/cloud; this hook re-wires it
# on every boot. Guarded so a missing/renamed hook is a no-op, and emitted only
# for privileged groups so ordinary groups' manifests stay byte-for-byte unchanged.
PRIV_BOOT_HOOK = """# privileged-group boot hook (idempotent): re-wire software that lives outside
# the persistent /home/cloud after a Pod rebuild. Run in the background so a slow
# first-boot apt install never delays sshd.
if [ -x /home/cloud/bin/boot-hook.sh ]; then nohup /home/cloud/bin/boot-hook.sh >/dev/null 2>&1 & fi
"""


def _cmd_block(g=None):
    """YAML for the pod command (tini -> bash -c INIT_SCRIPT).

    Container fields live at 8 spaces; the block-scalar content must be indented
    past the sibling fields (env:/ports: at 8) so the scalar terminates correctly.
    Privileged groups additionally get the boot hook that restores host-coupled
    software persisted under /home/cloud.
    """
    script = INIT_SCRIPT
    if g is not None and g.get("privileged"):
        script = script.replace("exec /usr/sbin/sshd -D -e",
                                PRIV_BOOT_HOOK + "exec /usr/sbin/sshd -D -e")
    return (
        "        command:\n"
        "        - /usr/bin/tini\n"
        "        - --\n"
        "        - /bin/bash\n"
        "        - -c\n"
        "        - |\n"
        + textwrap.indent(script, "            ")
    )


def _check_image(image):
    """Validate a per-group custom container image reference."""
    image = str(image or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image):
        raise ValueError("镜像名不合法")
    return image


def _check_mounts(mounts):
    """Validate a group's extra hostPath mounts.

    Each entry: {"path": <host abs path>, "mountPath": <container abs path>,
    "readOnly": bool (default True)}. Used to give a service pod access to
    resources kept on the node outside the standard /shared + /home/cloud pair
    (e.g. model weights). Platform dirs must not be shadowed.
    """
    out = []
    for m in (mounts or []):
        if not isinstance(m, dict):
            raise ValueError("mounts 每一项都必须是对象 {path, mountPath, readOnly}")
        p = str(m.get("path") or "").strip()
        mp = str(m.get("mountPath") or m.get("mount") or "").strip()
        if not p.startswith("/") or not mp.startswith("/"):
            raise ValueError("mounts 的 path / mountPath 必须是绝对路径")
        if mp.rstrip("/") in ("", "/shared", "/home/cloud", "/home", "/data"):
            raise ValueError(f"挂载点 {mp} 不允许覆盖平台目录")
        out.append({"path": p, "mountPath": mp.rstrip("/"),
                    "readOnly": bool(m.get("readOnly", True))})
    return out


def _extra_mounts_yaml(g):
    """Render extra volumeMounts/volumes YAML from g["mounts"].

    Returns (mounts_yaml, volumes_yaml), both "" when the group declares none, so
    ordinary groups' manifests are byte-for-byte unchanged.
    """
    mounts = g.get("mounts") or []
    if not mounts:
        return "", ""
    reserved = {"shared", "group-home", "group-data", "mps-pipe", "mps-log", "host-cuda"}
    mnt, vol, seen = [], [], set()
    for m in mounts:
        mp = str(m.get("mountPath") or "").strip()
        hp = str(m.get("path") or "").strip()
        if not mp.startswith("/") or not hp.startswith("/"):
            continue
        base = ("extra-" + re.sub(r"[^a-z0-9-]+", "-", mp.strip("/").lower()).strip("-"))[:40] or "extra"
        name, n = base, 1
        while name in seen or name in reserved:
            n += 1
            name = f"{base}-{n}"
        seen.add(name)
        ro = m.get("readOnly", True)
        mnt.append(f"        - name: {name}\n          mountPath: {mp}"
                   + ("\n          readOnly: true" if ro else ""))
        vol.append(f"      - name: {name}\n        hostPath:\n          path: {hp}\n          type: Directory")
    return "\n".join(mnt), "\n".join(vol)


# --- state ---
def load_state():
    if not os.path.exists(STATE_FILE):
        return {"groups": {}}
    with open(STATE_FILE) as f:
        return json.load(f)


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)
    os.chmod(STATE_FILE, 0o600)


def gen_password(n=16):
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def alloc_index(state):
    used = {g["index"] for g in state["groups"].values()}
    i = 1
    while i in used:
        i += 1
    if i > MAX_GROUPS:
        raise ValueError(f"已达最大组数 {MAX_GROUPS}(公网端口 {SSH_PUBLIC_BASE+1}-{SSH_PUBLIC_BASE+MAX_GROUPS} / {WEB_PUBLIC_BASE+1}-{WEB_PUBLIC_BASE+MAX_GROUPS})")
    return i


# --- kubectl ---
def kubectl(*args, check=True, timeout=30):
    cmd = ["kubectl", "-n", NS] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        if check:
            raise RuntimeError(f"kubectl {' '.join(args)} timed out after {timeout}s")
        return subprocess.CompletedProcess(cmd, 1, "", f"timed out after {timeout}s")
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def service_cluster_ip(name):
    """Service ``group-<name>`` 的 ClusterIP（Service 生命周期内稳定）；不可用→''。

    这是组 Pod 的「内网地址」——集群内其它 Pod（以及本机 kube-proxy）都能经它
    访问该组 Service 的端口，且不受 Pod 重建影响。只读，绝不抛。
    """
    r = kubectl("get", "svc", f"group-{name}",
                "-o", "jsonpath={.spec.clusterIP}", check=False)
    return (r.stdout or "").strip() if r.returncode == 0 else ""


# --- pod status cache (Redis L1 + in-process L2) ---
import kvcache

_pod_cache = {"statuses": {}, "pod_names": {}, "ts": 0}
_pod_cache_lock = threading.Lock()
POD_CACHE_TTL = 5  # seconds


def _fetch_pod_statuses():
    """Raw kubectl call to fetch all pod info. Returns (statuses, pod_names) dicts."""
    r = kubectl("get", "pods", "-o", "json", check=False)
    if r.returncode != 0:
        return None, None
    try:
        data = json.loads(r.stdout)
    except Exception:
        return None, None
    statuses = {}
    pod_names = {}
    for item in data.get("items", []):
        labels = item.get("metadata", {}).get("labels", {})
        app = labels.get("app", "")
        if app.startswith("group-"):
            name = app[len("group-"):]
            phase = item.get("status", {}).get("phase", "Unknown")
            pod_name = item.get("metadata", {}).get("name", "")
            statuses[name] = phase
            pod_names[name] = pod_name
    return statuses, pod_names


def all_pod_statuses():
    """One kubectl call to fetch ALL pod info; returns {group_name: phase} dict.
    Also populates pod name cache for resolve_pod_name().
    Cached via Redis (L1, 5s TTL) + in-process dict (L2, 5s TTL)."""
    # L2: in-process cache
    now = time.time()
    with _pod_cache_lock:
        if now - _pod_cache["ts"] < POD_CACHE_TTL:
            return _pod_cache["statuses"]
    # L1: Redis cache
    cached = kvcache.get("pod:statuses")
    if cached is not None:
        cached_names = kvcache.get("pod:names") or {}
        with _pod_cache_lock:
            _pod_cache["statuses"] = cached
            _pod_cache["pod_names"] = cached_names
            _pod_cache["ts"] = now
        return cached
    # Cache miss — call kubectl
    statuses, pod_names = _fetch_pod_statuses()
    if statuses is None:
        return _pod_cache["statuses"]  # return stale cache on failure
    # Write to both caches
    kvcache.set("pod:statuses", statuses, ttl=POD_CACHE_TTL)
    kvcache.set("pod:names", pod_names, ttl=POD_CACHE_TTL)
    with _pod_cache_lock:
        _pod_cache["statuses"] = statuses
        _pod_cache["pod_names"] = pod_names
        _pod_cache["ts"] = now
    return statuses


def resolve_pod_name(group):
    """Get pod name for a group (uses batch cache). Returns '' if not found."""
    all_pod_statuses()  # ensure cache is warm
    return _pod_cache["pod_names"].get(group, "")


def pod_status(name):
    """Single group pod status (uses batch cache)."""
    return all_pod_statuses().get(name, "NotFound")


# --- manifests ---
def _all_gpu_ids(node=None):
    """GPU indices visible on a node. Delegates to the node registry
    (nodes.gpu_ids); nvidia-smi is kept only as a local fallback for the
    default node so callers that don't know about nodes keep working."""
    if node is not None:
        return nodes.gpu_ids(node)
    if _all_gpu_ids._cache is not None:
        return _all_gpu_ids._cache
    ids = []
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=index", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=6)
        if r.returncode == 0:
            ids = [int(x.strip()) for x in (r.stdout or "").splitlines() if x.strip().isdigit()]
    except Exception:
        pass
    if not ids:
        ids = [0]
    _all_gpu_ids._cache = ids
    return ids
_all_gpu_ids._cache = None


def _gib(value, default):
    """Parse a k8s-ish memory string ("10Gi"/"8G"/"512Mi") to whole GiB."""
    import re as _re
    m = _re.match(r"^\s*(\d+)\s*(Gi|G|Mi|M)?\s*$", str(value or ""))
    if not m:
        return default
    n = int(m.group(1))
    if (m.group(2) or "Gi") in ("Mi", "M"):
        n = max(1, n // 1024)
    return n


def _windows_deployment_yaml(g):
    """Deployment for a Windows-VM group: a single privileged dockurr/windows
    container (QEMU/KVM) exposing its noVNC web UI on the group web port (8080),
    plus a persistent disk on the big hostPath. Distinct from the ubuntu groups:
    no sshd, no /home/cloud, /dev/kvm required (=> privileged)."""
    name = g["name"]
    req_cpu, req_mem, req_storage = req_estimate.request_for(g)
    cpu_cores = _gib(f'{g["cpu"]}Gi', 4)
    ram_g = max(2, _gib(g["mem"], 10) - 2)      # leave host/overhead room
    disk_g = _gib(g["storage"], 64)
    env_lines = [
        '        - name: WEB_PORT\n          value: "8080"',
        '        - name: VERSION\n          value: "10"',
        '        - name: EDITION\n          value: "Professional"',
        f'        - name: RAM_SIZE\n          value: "{ram_g}G"',
        f'        - name: CPU_CORES\n          value: "{cpu_cores}"',
        f'        - name: DISK_SIZE\n          value: "{disk_g}G"',
        # NB: built-in names (Administrator/Guest/...) are rejected by dockurr
        # ("reserved for a built-in Windows account") -> use our own name.
        f'        - name: USERNAME\n          value: {json.dumps(WINDOWS_DEFAULT_USER)}',
        f'        - name: PASSWORD\n          value: {json.dumps(g["password"])}',
    ]
    # dockurr 的 dnsmasq 启动时拿不到上游解析器：它会把容器的 /etc/resolv.conf
    # 改写成 nameserver 127.0.0.1，而 dnsmasq 视 127.0.0.0/8 为本地接口直接忽略
    # （日志 "ignoring nameserver 127.0.0.1 - local interface"），且它只在
    # /etc/resolv.dnsmasq 已存在时才加 --resolv-file（重启时该文件又会被删）。
    # 结果客户机所有外部域名都 REFUSED → Windows 显示「以太网无 Internet」。
    # 这里显式喂上游：集群 DNS(CoreDNS) + 公共 DNS。
    _win_custom_keys = {str(k).upper() for k in (g.get("env") or {})}
    if "DNSMASQ_OPTS" not in _win_custom_keys:
        env_lines.append(
            '        - name: DNSMASQ_OPTS\n'
            '          value: "--server=10.43.0.10 --server=223.5.5.5"'
        )
    # outbound proxy defaults (host mihomo) so the image can fetch the ISO;
    # overridable by the group's custom env below, or disabled outright with
    # YATTERRA_PROXY_MODE=off (then the Pod is opt-in via `proxy on`).
    _custom_keys = {str(k).upper() for k in (g.get("env") or {})}
    _proxy_env = siteconf.proxy_env_defaults() if siteconf.proxy_auto_enabled(g.get("env")) else {}
    for k, v in _proxy_env.items():
        if k.upper() in _custom_keys:
            continue
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(v)}')
    for k, v in sorted((g.get("env") or {}).items()):
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(str(v))}')
    env_block = "\n".join(env_lines)
    return f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: group-{name}
  namespace: {NS}
  labels:
    app: group-{name}
    managed-by: yatterra
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: group-{name}
  template:
    metadata:
      labels:
        app: group-{name}
    spec:
      # VM 组:停止时给 guest 一次 ACPI 关机机会。120s 太长,会把
      # 删除 / 换节点 / 改名里的"释放旧 Pod"拖满整个删除超时;60s 够用,
      # 超时就 SIGKILL(等于拔电,NTFS 自己会打脏位)。
      terminationGracePeriodSeconds: 60
      containers:
      - name: windows
        image: {WINDOWS_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
{env_block}
        ports:
        - containerPort: 8080
        resources:
          limits:
            cpu: "{g['cpu']}"
            memory: "{g['mem']}"
            ephemeral-storage: "{g['storage']}"
          requests:
            cpu: "{req_cpu}"
            memory: "{req_mem}"
            ephemeral-storage: "{req_storage}"
        securityContext:
          privileged: true
          capabilities:
            add: ["NET_ADMIN"]
        volumeMounts:
        - name: dev-kvm
          mountPath: /dev/kvm
        - name: dev-tun
          mountPath: /dev/net/tun
        - name: storage
          mountPath: /storage
      volumes:
      - name: dev-kvm
        hostPath:
          path: /dev/kvm
          type: CharDevice
      - name: dev-tun
        hostPath:
          path: /dev/net/tun
          type: CharDevice
      - name: storage
        hostPath:
          path: {WINVM_ROOT}/{name}
          type: DirectoryOrCreate
"""


def _android_deployment_yaml(g):
    """Deployment for an Android-VM group: a single privileged budtmo/docker-android
    container (QEMU/KVM Android emulator) exposing noVNC web UI on the group web
    port (ANDROID_WEB_PORT=6080, published as 8080 by the Service), ADB on
    5555, and Appium on 4723. Needs /dev/kvm (=> privileged). Persistent data
    stored on the hostPath under ANDROID_ROOT."""
    name = g["name"]
    req_cpu, req_mem, req_storage = req_estimate.request_for(g)
    env_lines = [
        # noVNC web: WEB_VNC=true enables it, and WEB_VNC_PORT is pinned to
        # ANDROID_WEB_PORT. Do NOT change this to 8080: this image's novnc_proxy
        # ignores WEB_VNC_PORT and binds 6080 regardless (see ANDROID_WEB_PORT),
        # so the Service redirects 8080 -> 6080 via _web_target_port.
        '        - name: WEB_VNC\n          value: "true"',
        f'        - name: WEB_VNC_PORT\n          value: "{ANDROID_WEB_PORT}"',
        '        - name: VNC_PORT\n          value: "5900"',
        # Enable Appium server on its default port (4723).
        '        - name: APPIUM\n          value: "true"',
        # Pick a sensible device profile; overridable via group env below.
        '        - name: EMULATOR_DEVICE\n          value: "Samsung Galaxy S10"',
        # GPU acceleration: host mode leverages KVM for hardware GL.
        '        - name: EMULATOR_GPU\n          value: "host"',
        # Set ADB port explicitly (default 5555).
        f'        - name: ADB_PORT\n          value: "{ANDROID_ADB_PORT}"',
    ]
    # outbound proxy defaults so the image can pull system images;
    # overridable by the group's custom env below.
    _custom_keys = {str(k).upper() for k in (g.get("env") or {})}
    _proxy_env = siteconf.proxy_env_defaults() if siteconf.proxy_auto_enabled(g.get("env")) else {}
    for k, v in _proxy_env.items():
        if k.upper() in _custom_keys:
            continue
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(v)}')
    for k, v in sorted((g.get("env") or {}).items()):
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(str(v))}')
    env_block = "\n".join(env_lines)
    return f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: group-{name}
  namespace: {NS}
  labels:
    app: group-{name}
    managed-by: yatterra
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: group-{name}
  template:
    metadata:
      labels:
        app: group-{name}
    spec:
      # 同 windows:给模拟器一次 ACPI 关机机会,但别拖满删除超时。
      terminationGracePeriodSeconds: 60
      initContainers:
      # /home/androidusr is bind-mounted onto an empty hostPath; the image's
      # entrypoint (docker-android/mixins/scripts/run.sh) lives there, so seed
      # it from the image on first boot (no-op afterwards). Runs as root only to
      # write the mount + chown it to the emulator uid.
      - name: seed-home
        image: {ANDROID_IMAGE}
        imagePullPolicy: IfNotPresent
        command: ["bash", "-lc"]
        args:
        - |
          set -e
          if [ ! -e /persist/docker-android/mixins/scripts/run.sh ]; then
            cp -a /home/androidusr/. /persist/
            chown {ANDROID_UID}:{ANDROID_GID} /persist
          fi
        securityContext:
          runAsUser: 0
          runAsGroup: 0
        volumeMounts:
        - name: storage
          mountPath: /persist
      containers:
      - name: android
        image: {ANDROID_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
{env_block}
        ports:
        - containerPort: {ANDROID_WEB_PORT}
        - containerPort: {ANDROID_ADB_PORT}
        - containerPort: {ANDROID_APPIUM_PORT}
        resources:
          limits:
            cpu: "{g['cpu']}"
            memory: "{g['mem']}"
            ephemeral-storage: "{g['storage']}"
          requests:
            cpu: "{req_cpu}"
            memory: "{req_mem}"
            ephemeral-storage: "{req_storage}"
        securityContext:
          privileged: true
          capabilities:
            add: ["NET_ADMIN"]
        volumeMounts:
        - name: dev-kvm
          mountPath: /dev/kvm
        - name: dev-tun
          mountPath: /dev/net/tun
        - name: storage
          mountPath: /home/androidusr
      volumes:
      - name: dev-kvm
        hostPath:
          path: /dev/kvm
          type: CharDevice
      - name: dev-tun
        hostPath:
          path: /dev/net/tun
          type: CharDevice
      - name: storage
        hostPath:
          path: {ANDROID_ROOT}/{name}
          type: DirectoryOrCreate
"""


def deployment_yaml(g):
    name = g["name"]
    if g.get("type") == "windows":
        return _windows_deployment_yaml(g)
    if g.get("type") == "android":
        return _android_deployment_yaml(g)
    is_gpu = g["type"] == "gpu"
    cpu = g["cpu"]; mem = g["mem"]
    # limits = user-set cap; requests = EWMA estimate from actual usage
    req_cpu, req_mem, req_storage = req_estimate.request_for(g)
    env_lines = [
        f'        - name: CLOUD_PASSWORD\n          value: "{g["password"]}"',
        '        - name: LOG_DIR\n          value: "/home/cloud/logs"',
    ]
    # cluster-only service ports, exposed to the app as a sorted CSV so it can
    # advertise itself (e.g. to sse-agent) without hardcoding. Changes take
    # effect on the next Pod restart; the Service itself updates immediately.
    _iports = normalize_internal_ports(g)
    env_lines.append(
        '        - name: INTERNAL_PORTS\n          value: '
        + json.dumps(",".join(map(str, _iports)))
    )
    runtime_class = ""
    if is_gpu:
        # Pod sees only its assigned GPUs (g["gpus"]); falls back to all of the
        # TARGET NODE's inventory if unset. This isolates the group's interactive
        # environment at the CUDA driver level. The per-deploy scheduler further
        # places supervised jobs within this visible set (scheduler.place_train
        # respects g["gpus"]).
        node = nodes.node_for(g)
        env_lines.append(
            f'        - name: NVIDIA_VISIBLE_DEVICES\n          value: "{nodes.visible_devices(node, g.get("gpus"))}"'
        )
        # MPS (Multi-Process Service): cooperative GPU sharing for co-resident
        # processes. Pipe+log dirs are host-mounted so all GPU pods share the
        # single host MPS daemon. Non-MPS fallback if daemon is down.
        # Node-gated: only nodes whose profile runs an MPS daemon get this.
        if nodes.has_mps(node):
            env_lines.append('        - name: CUDA_MPS_PIPE_DIRECTORY\n          value: "/tmp/nvidia-mps"')
            env_lines.append('        - name: CUDA_MPS_LOG_DIRECTORY\n          value: "/var/log/nvidia-mps"')
        # Host CUDA toolkit (nvcc + headers) mounted read-only so JIT-compiled
        # kernels (e.g. deep_gemm used by MoE/FP4 models like Ling-3.0) can
        # build inside the pod. The driver alone (via nvidia runtime) is not enough.
        # Node-gated: only nodes that expose a host CUDA tree get this.
        if nodes.cuda_host(node):
            env_lines.append('        - name: CUDA_HOME\n          value: "/usr/local/cuda"')
        runtime_class = "      runtimeClassName: nvidia\n"
    # outbound proxy defaults (host mihomo core, rule mode routing). Skipped when
    # the group overrides that key in its custom env below, or when the group
    # opts out entirely with YATTERRA_PROXY_MODE=off — the Pod then comes up with
    # no proxy env and the user turns it on per-shell with `proxy on`.
    _custom_keys = {str(k).upper() for k in (g.get("env") or {})}
    _proxy_env = siteconf.proxy_env_defaults() if siteconf.proxy_auto_enabled(g.get("env")) else {}
    for k, v in _proxy_env.items():
        if k.upper() in _custom_keys:
            continue
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(v)}')
    # admin-managed custom env vars (g["env"] = {KEY: VALUE})
    for k, v in sorted((g.get("env") or {}).items()):
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(str(v))}')
    env_block = "\n".join(env_lines)
    cmd = _cmd_block(g)
    # explicit node placement ("" for auto groups → manifest unchanged)
    placement = nodes.placement_yaml(nodes.node_for(g))
    # MPS pipe/log dir mounts (GPU pods only, shared with host daemon).
    # Node-gated: a node without an MPS daemon / host CUDA tree (e.g. spark)
    # must not reference hostPaths that only exist on the MPS node.
    node = nodes.node_for(g)
    mps_mounts = ""
    mps_volumes = ""
    if is_gpu and nodes.has_mps(node):
        mps_mounts = """        - name: mps-pipe
          mountPath: /tmp/nvidia-mps
        - name: mps-log
          mountPath: /var/log/nvidia-mps"""
        mps_volumes = """      - name: mps-pipe
        hostPath:
          path: /tmp/nvidia-mps
          type: DirectoryOrCreate
      - name: mps-log
        hostPath:
          path: /var/log/nvidia-mps
          type: DirectoryOrCreate"""
    if is_gpu and nodes.cuda_host(node):
        mps_mounts += """
        - name: host-cuda
          mountPath: /usr/local/cuda
          readOnly: true"""
        mps_volumes += """
      - name: host-cuda
        hostPath:
          path: /usr/local/cuda
          type: Directory"""
    # per-group custom image + extra hostPath mounts (service pods that need
    # resources outside the standard /shared + /home/cloud pair). Absent for
    # ordinary groups → manifest unchanged.
    g_image = g.get("image") or IMAGE
    extra_mounts, extra_volumes = _extra_mounts_yaml(g)
    if extra_mounts:
        mps_mounts = (mps_mounts + "\n" + extra_mounts) if mps_mounts else extra_mounts
    if extra_volumes:
        mps_volumes = (mps_volumes + "\n" + extra_volumes) if mps_volumes else extra_volumes
    # Opt-in privileged mode (g["privileged"]): a group whose workload creates a
    # network tunnel (e.g. a VPN client) needs the host /dev/net/tun device plus
    # NET_ADMIN to configure the interface. Ordinary groups keep the default
    # unprivileged container → manifest byte-for-byte unchanged.
    if g.get("privileged"):
        security_block = ('          privileged: true\n'
                          '          capabilities:\n'
                          '            add: ["NET_ADMIN"]')
        tun_mounts = "\n        - name: dev-tun\n          mountPath: /dev/net/tun"
        tun_volumes = ("\n      - name: dev-tun\n        hostPath:\n"
                       "          path: /dev/net/tun\n          type: CharDevice")
    else:
        security_block = "          privileged: false"
        tun_mounts = ""
        tun_volumes = ""
    return f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: group-{name}
  namespace: {NS}
  labels:
    app: group-{name}
    managed-by: yatterra
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: group-{name}
  template:
    metadata:
      labels:
        app: group-{name}
    spec:
      # 普通平台容器(supervisord/sshd)收到 SIGTERM 就会退出;显式钉住 30s
      # (= k8s 默认值,防止集群默认被改动)。改名路径删除旧 Pod 时另用
      # `--grace-period=20` 兜底,旧 Pod 不会按住 hostPath 数据目录不放。
      terminationGracePeriodSeconds: 30
{runtime_class}{placement}      containers:
      - name: ubuntu
        image: {g_image}
        imagePullPolicy: IfNotPresent
{cmd}
        env:
{env_block}
        ports:
        # The entrypoint is sshd on 22. 8080 is the Service targetPort for a
        # process the user starts later; it is not a containerPort because
        # nothing in this command binds it.
        - containerPort: 22
        resources:
          limits:
            cpu: "{cpu}"
            memory: "{mem}"
            ephemeral-storage: "{g['storage']}"
          requests:
            cpu: "{req_cpu}"
            memory: "{req_mem}"
            ephemeral-storage: "{req_storage}"
        securityContext:
{security_block}
        volumeMounts:
        - name: shared
          mountPath: /shared
          readOnly: true
        - name: group-home
          mountPath: /home/cloud
        - name: group-data
          mountPath: /data
        - name: interop
          mountPath: /interop
{mps_mounts}{tun_mounts}
      volumes:
      - name: shared
        hostPath:
          path: {siteconf.SHARED_ROOT}
          type: DirectoryOrCreate
      - name: group-home
        hostPath:
          path: {GROUP_DATA_ROOT}/{name}/home
          type: DirectoryOrCreate
      # Fixed-size ext4 image, loop-mounted on the host before the pod starts.
      # type Directory (not Create): a missing mount must fail the pod instead
      # of silently giving it an uncapped directory on the HDD.
      - name: group-data
        hostPath:
          path: {GROUP_DATA_ROOT}/{name}/data
          type: Directory
      # cross-node sync disk: same path on every node (local on the platform
      # node, NFS-mounted on remote ones). type: Directory (NOT Create) so a
      # missing mount fails the pod loudly instead of silently forking a local
      # dir per node.
      - name: interop
        hostPath:
          path: {siteconf.INTEROP_ROOT}
          type: Directory
{mps_volumes}{tun_volumes}
"""


# --- internal (cluster-only) service ports -----------------------------------
# Ports a group wants reachable from other Pods inside the cluster. Declared on
# the group's Service with no nodePort, so they are NOT exposed publicly. The
# list is stored unordered on the group (g["internal_ports"]) and normalised to
# a sorted, de-duplicated list whenever it is read or written.
INTERNAL_PORT_MIN = 1
INTERNAL_PORT_MAX = 65535
# 22/8080 are already published by the base Service; 31000-32767 is the k3s
# NodePort range and must stay free for the ssh/web nodePorts.
INTERNAL_PORT_RESERVED = {22, 8080}


def normalize_internal_ports(g):
    """Return the group's internal ports as a sorted, de-duplicated int list.
    Tolerates strings/None and silently drops values that are not usable."""
    out = set()
    for v in (g.get("internal_ports") or []):
        try:
            p = int(str(v).strip())
        except (TypeError, ValueError):
            continue
        if not (INTERNAL_PORT_MIN <= p <= INTERNAL_PORT_MAX):
            continue
        if p in INTERNAL_PORT_RESERVED or 31000 <= p <= 32767:
            continue
        out.add(p)
    return sorted(out)


def _check_internal_port(p):
    try:
        p = int(str(p).strip())
    except (TypeError, ValueError):
        raise ValueError("端口必须是整数")
    if not (INTERNAL_PORT_MIN <= p <= INTERNAL_PORT_MAX):
        raise ValueError(f"端口需在 {INTERNAL_PORT_MIN}-{INTERNAL_PORT_MAX} 之间")
    if p in INTERNAL_PORT_RESERVED:
        raise ValueError(f"端口 {p} 已被 ssh/web 占用,不能作为内网端口")
    if 31000 <= p <= 32767:
        raise ValueError(f"端口 {p} 属于 NodePort 区间(31000-32767),请换一个")
    return p


def set_internal_ports(name, ports):
    """Replace a group's internal-port list. Rewrites the Service only — no Pod
    restart, so a running service keeps its state. Returns the sorted list."""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = state["groups"][name]
    clean = sorted({_check_internal_port(p) for p in (ports or [])})
    g["internal_ports"] = clean
    apply_group(g)
    save_state(state)
    audit.record("internal_ports_set",
                 detail=f"{name} ports={','.join(map(str, clean))}")
    return clean


def _web_target_port(g):
    """Container port backing a group's web UI.

    Everything serves on 8080 except android, whose image's noVNC binds 6080 and
    cannot be moved (see ANDROID_WEB_PORT). The Service still advertises port
    8080 — only the targetPort differs — so the relay/frpc chain (which reaches
    the Service's nodePort -> port 8080) is unchanged.
    """
    return ANDROID_WEB_PORT if g.get("type") == "android" else 8080


def service_yaml(g):
    name = g["name"]
    return f"""apiVersion: v1
kind: Service
metadata:
  name: group-{name}
  namespace: {NS}
  labels:
    app: group-{name}
    managed-by: yatterra
spec:
  type: NodePort
  selector:
    app: group-{name}
  ports:
  - name: ssh
    port: 22
    targetPort: 22
    nodePort: {g["ssh_nodeport"]}
  - name: web
    port: 8080
    targetPort: {_web_target_port(g)}
    nodePort: {g["web_nodeport"]}
"""


def internal_service_name(name):
    return f"group-{name}-internal"


def internal_service_yaml(g):
    """A second, ClusterIP-only Service carrying the group's internal ports.

    It must be a SEPARATE Service: a NodePort Service auto-allocates a nodePort
    for every port that does not name one, so adding ports to the main Service
    would silently publish them on the host/LAN. ClusterIP has no such
    allocation — these ports are reachable only from inside the cluster, at
    group-<name>-internal.<ns>.svc.cluster.local.
    """
    name = g["name"]
    ports = normalize_internal_ports(g)
    if not ports:
        return ""  # nothing declared -> no Service (keeps the cluster tidy)
    body = ""
    for p in ports:
        body += (f"  - name: in-{p}\n"
                 f"    port: {p}\n"
                 f"    targetPort: {p}\n"
                 f"    protocol: TCP\n")
    return f"""apiVersion: v1
kind: Service
metadata:
  name: {internal_service_name(name)}
  namespace: {NS}
  labels:
    app: group-{name}
    managed-by: yatterra
    role: internal
spec:
  type: ClusterIP
  selector:
    app: group-{name}
  ports:
{body}"""


def write_manifest(g):
    os.makedirs(MANIFEST_DIR, exist_ok=True)
    path = os.path.join(MANIFEST_DIR, f"group-{g['name']}.yaml")
    with open(path, "w") as f:
        f.write(deployment_yaml(g))
        f.write("---\n")
        f.write(service_yaml(g))
        internal = internal_service_yaml(g)
        if internal:
            f.write("---\n")
            f.write(internal)
    return path


def apply_group(g):
    path = write_manifest(g)
    kubectl("apply", "-f", path)
    # If the internal-port list is now empty the manifest no longer contains the
    # internal Service, and `apply` never deletes objects — remove it explicitly.
    if not normalize_internal_ports(g):
        kubectl("delete", "service", internal_service_name(g["name"]),
                "--ignore-not-found=true", check=False)


def _group_pods(name):
    """(count, phase, ready, detail) for one group's pods. count=-1 on error."""
    r = kubectl("get", "pod", "-l", f"app=group-{name}", "-o", "json",
                check=False, timeout=15)
    if r.returncode != 0:
        return -1, "", False, (r.stderr or "").strip()[:200]
    try:
        items = json.loads(r.stdout or "{}").get("items", [])
    except Exception as e:
        return -1, "", False, str(e)[:200]
    if not items:
        return 0, "", False, ""
    st = items[0].get("status") or {}
    phase = st.get("phase") or "Unknown"
    ready = any(c.get("type") == "Ready" and c.get("status") == "True"
                for c in (st.get("conditions") or []))
    detail = phase
    for cs in (st.get("containerStatuses") or []):
        state = cs.get("state") or {}
        for kind in ("waiting", "terminated"):
            if state.get(kind, {}).get("reason"):
                detail = state[kind]["reason"]
    return len(items), phase, ready, detail


def _wait_pods_gone(name, tick=None, timeout=60, interval=2.0):
    """Poll until the group has no pod left (a deleted pod lingers in
    Terminating until its grace period ends). ``tick(elapsed, detail)`` is
    called every poll so a UI can show sub-progress. False on timeout."""
    t0 = time.time()
    while True:
        n, _phase, _ready, detail = _group_pods(name)
        if n == 0:
            return True
        if n < 0:
            return False          # can't tell → don't block the caller
        elapsed = time.time() - t0
        if elapsed >= timeout:
            return False
        if tick:
            try:
                tick(elapsed, f"{n} 个 Pod 正在退出（{detail}）")
            except Exception:
                pass
        time.sleep(interval)


def _wait_pod_ready(name, tick=None, timeout=120, interval=2.0):
    """Poll until the group's pod is Running and its Ready condition is True.
    ``tick(elapsed, detail)`` is called every poll. False on timeout."""
    t0 = time.time()
    while True:
        n, phase, ready, detail = _group_pods(name)
        if n == 1 and ready:
            return True
        if n < 0:
            return False          # can't tell → never block the caller
        elapsed = time.time() - t0
        if elapsed >= timeout:
            return False
        if tick:
            try:
                tick(elapsed, "无 Pod" if n == 0 else f"{phase}（{detail}）")
            except Exception:
                pass
        time.sleep(interval)


def delete_group_k8s(name, tick=None, grace=None, timeout=90):
    """Delete a group's Deployment/Services and wait for its pods to be gone.

    ``grace`` (seconds) shortens the pods' termination grace period, so a
    container that ignores SIGTERM cannot hold the group's hostPath mount for
    the full template value — the rename needs the old pod gone before the new
    one mounts the same directory. ``tick(elapsed, detail)`` is invoked while
    waiting. Returns True when no pod is left.
    """
    # Order matters. 1) the Deployment *and* its ReplicaSet go first: deletion
    # cascades in the background, and a still-alive ReplicaSet would happily
    # re-create the very pod we are about to kill. 2) then the pods, with a
    # short grace period so a container that ignores SIGTERM cannot hold the
    # group's hostPath for the whole template value. 3) the Services last — the
    # nodePort they hold is what the new Service needs.
    sel = f"app=group-{name}"
    kubectl("delete", "deployment,replicaset", "-l", sel,
            "--ignore-not-found=true", "--wait=false", check=False, timeout=20)
    pod_args = ["delete", "pod", "-l", sel,
                "--ignore-not-found=true", "--wait=false"]
    if grace is not None:
        pod_args.append(f"--grace-period={int(grace)}")
    kubectl(*pod_args, check=False, timeout=20)
    kubectl("delete", "service", "-l", sel,
            "--ignore-not-found=true", "--wait=true", "--timeout=30s",
            check=False, timeout=40)
    kubectl("delete", "service", internal_service_name(name),
            "--ignore-not-found=true", "--wait=true", "--timeout=30s",
            check=False, timeout=40)
    return _wait_pods_gone(name, tick=tick, timeout=timeout)


# --- frpc ---
def frpc_segment(name, local_port, remote_port):
    return f"""[[proxies]]
name = "{name}"
type = "tcp"
localIP = "127.0.0.1"
localPort = {local_port}
remotePort = {remote_port}
"""


def build_managed_block(state):
    lines = [FRPC_MARK_BEGIN]
    # platform gui
    lines.append(frpc_segment("platform-gui", 8090, PLATFORM_GUI_PORT - 10000))  # HTTPS: frps internal; nginx TLS on PLATFORM_GUI_PORT
    for g in state["groups"].values():
        lines.append(frpc_segment(f"grp-{g['name']}-ssh", g["ssh_nodeport"], g["ssh_public"]))
        lines.append(frpc_segment(f"grp-{g['name']}-web", g["web_nodeport"], g["web_public"] - 10000))  # HTTPS: frps internal port; nginx TLS on web_public
    lines.append(FRPC_MARK_END)
    return "\n".join(lines)


def rewrite_frpc(state):
    with open(FRPC_FILE) as f:
        content = f.read()
    # strip existing managed block
    if FRPC_MARK_BEGIN in content:
        pre = content.split(FRPC_MARK_BEGIN)[0]
        content = pre.rstrip() + "\n\n"
    else:
        content = content.rstrip() + "\n\n"
    content += build_managed_block(state) + "\n"
    with open(FRPC_FILE, "w") as f:
        f.write(content)


def reload_frpc():
    import urllib.request, base64
    url = "http://127.0.0.1:7500/api/reload"
    req = urllib.request.Request(url)  # GET
    token = base64.b64encode(f"{FRPC_ADMIN[0]}:{FRPC_ADMIN[1]}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except Exception as e:
        raise RuntimeError(f"frpc reload failed: {e}")


# --- cloud nginx web-ssl sync ---
_APR1_ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _apr1_salt(name, password):
    """Deterministic 8-char apr1 salt for one group.

    openssl picks a *random* salt on every call, so re-hashing the same group
    produced a different line each time → htpasswd never matched what was on the
    relay → nginx got rewritten+reloaded on every sync even when nothing had
    changed (the "无变化" fast path could never trigger). Deriving the salt from
    name+password keeps the line stable while still salting per group."""
    import hashlib
    d = hashlib.sha256(f"{name}\x00{password}".encode()).digest()
    return "".join(_APR1_ALPHABET[b & 0x3F] for b in d[:8])


def _apr1(password, salt=None):
    """Apache-style apr1 hash (openssl) for nginx auth_basic. None on failure.

    Pass ``salt`` for a reproducible hash (see ``_apr1_salt``)."""
    try:
        cmd = ["openssl", "passwd", "-apr1"]
        if salt:
            cmd += ["-salt", salt]
        cmd.append("-stdin")
        r = subprocess.run(cmd, input=str(password or "").encode(),
                           capture_output=True, timeout=10)
        if r.returncode == 0:
            h = r.stdout.decode().strip()
            return h if h.startswith("$apr1$") else None
    except Exception:
        pass
    return None


def _htpasswd_content(state):
    """htpasswd file body: one entry per web-auth-protected group
    (username = group name, password = group password). Stable across calls."""
    lines = []
    for g in state["groups"].values():
        if g.get("type") in AUTH_WEB_TYPES:
            pw = g.get("password")
            h = _apr1(pw, _apr1_salt(g["name"], pw))
            if h:
                lines.append(f"{g['name']}:{h}")
    return ("\n".join(lines) + "\n") if lines else ""


def _web_ssl_block(public_port, auth_user=None, group=None):
    """Generate one nginx server block: listen <port> ssl → proxy_pass 127.0.0.1:<port-10000>.
    auth_user (group name) → protect the block with HTTP basic auth.

    group (pod name) → when the pod's web entry is down (frp tunnel gone, pod
    scaled to 0, app not listening), serve YatTerra's fallback page instead of a
    bare 502.  The page is served by the platform GUI over the same relay
    (127.0.0.1:<NGINX_OFFLINE_INNER> → frp → 8090) and picks its wording from the
    pod's billing status — 资源已冻结 when it was stopped for non-payment."""
    inner = public_port - 10000
    auth = ""
    if auth_user:
        auth = (f'        auth_basic "yatterra ({auth_user})";\n'
                f'        auth_basic_user_file {NGINX_HTPASSWD};\n')
    off_err = ""
    off_loc = ""
    if group:
        import urllib.parse
        off_err = ("        proxy_intercept_errors on;\n"
                   "        error_page 502 503 504 = /__yatterra_off;\n")
        gq = urllib.parse.quote(str(group), safe="")
        # NB: a *prefix* location (= /…) may carry a URI+query in proxy_pass; a
        # named location may not. proxy_method GET keeps POSTs on the page too.
        off_loc = f"""
    location = /__yatterra_off {{
        proxy_method GET;
        proxy_pass http://127.0.0.1:{NGINX_OFFLINE_INNER}/pod-offline?g={gq};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}"""
    return f"""server {{
    listen {public_port} ssl;
    listen [::]:{public_port} ssl;
    server_name {siteconf.DOMAIN};
    ssl_certificate     {NGINX_SSL_CERT};
    ssl_certificate_key {NGINX_SSL_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    location / {{
{auth}{off_err}        proxy_pass http://127.0.0.1:{inner};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }}{off_loc}
}}"""


def build_nginx_web_block(state):
    """Build the managed marker section with all web-ssl server blocks."""
    lines = [NGINX_MARK_BEGIN]
    lines.append(_web_ssl_block(PLATFORM_GUI_PORT))
    for g in state["groups"].values():
        auth_user = g["name"] if g.get("type") in AUTH_WEB_TYPES else None
        lines.append(_web_ssl_block(g["web_public"], auth_user=auth_user,
                                    group=g["name"]))
    lines.append(NGINX_MARK_END)
    return "\n\n".join(lines)


def _strip_web_ssl_blocks(conf):
    """Remove ALL server blocks with `listen 23xxx ssl` or `listen 24000 ssl`,
    plus any existing managed marker section. Idempotent — clears everything
    so the fresh managed section can be inserted without duplicates."""
    import re as _re
    # remove old managed marker section first (if present)
    if NGINX_MARK_BEGIN in conf and NGINX_MARK_END in conf:
        conf = _re.sub(
            _re.escape(NGINX_MARK_BEGIN) + r".*?" + _re.escape(NGINX_MARK_END) + r"\n*",
            "", conf, flags=_re.DOTALL)
    # remove every server {} block that contains `listen (23\d{3}|24000) ssl`
    # match balanced server { ... } (non-greedy, no nested server blocks in these)
    conf = _re.sub(
        r"server\s*\{[^}]*?listen\s+(?:23\d{3}|24000)\s+ssl;.*?\n\}\n*",
        "", conf, flags=_re.DOTALL)
    return conf


_NGINX_SPLIT_MARK = "#__yatterra_conf_split__#"


def _nginx_apply_script(base, conf_path, hp_path):
    """One root shell that installs conf+htpasswd, tests and reloads nginx.

    Everything happens in a single SSH round trip: the per-call latency to the
    relay is ~0.9s and the old flow needed 4-5 of them. Two details matter:

    * the config is written with ``cat tmp > path`` so the file keeps its inode
      — it is bind-mounted into the nginx container and a replaced inode would
      not take effect until a restart;
    * on a failing ``nginx -t`` the previous config is restored *and the full
      nginx output is echoed back* — the caller used to keep only the last line,
      which made every failure a useless "[exit=1]".
    """
    import shlex
    script = r"""set -u
TB=__BASE__
D=__BASE__.d
rm -rf "$D"; mkdir -p "$D" || { echo MKDIRFAIL; exit 2; }
tar xzf "$TB.tgz" -C "$D" || { echo TARFAIL; rm -rf "$D" "$TB.tgz"; exit 2; }
CONF=__CONF__
HP=__HP__
cp -a "$CONF" "$D/old.conf" || { echo BACKUPFAIL; rm -rf "$D" "$TB.tgz"; exit 2; }
pre_ok=0
nginx -t > "$D/pre.log" 2>&1 || pre_ok=1
if [ -f "$D/htpasswd" ]; then
  if [ -f "$HP" ]; then cp -a "$HP" "$D/old.htpasswd"; fi
  cat "$D/htpasswd" > "$HP"
fi
cat "$D/https-web.conf" > "$CONF"
restore() {
  cat "$D/old.conf" > "$CONF"
  if [ -f "$D/old.htpasswd" ]; then cat "$D/old.htpasswd" > "$HP"; fi
}
if nginx -t > "$D/t.log" 2>&1; then
  if nginx -s reload > "$D/r.log" 2>&1; then
    rm -rf "$D" "$TB.tgz"
    echo "APPLIED conf=$(wc -c < "$CONF") hp=$(wc -c < "$HP" 2>/dev/null || echo 0)"
    exit 0
  fi
  restore
  nginx -t >/dev/null 2>&1
  echo RELOADFAIL
  tail -n 8 "$D/r.log"
  rm -rf "$D" "$TB.tgz"
  exit 3
fi
restore
nginx -t >/dev/null 2>&1
echo "TESTFAIL pre_test_failed=$pre_ok"
tail -n 20 "$D/t.log"
rm -rf "$D" "$TB.tgz"
exit 1
"""
    return (script.replace("__BASE__", shlex.quote(base))
                  .replace("__CONF__", shlex.quote(conf_path))
                  .replace("__HP__", shlex.quote(hp_path)))


def rewrite_nginx_web(state):
    """Sync cloud nginx https-web.conf: rewrite all 23xxx/24000 SSL server blocks
    from state, plus the htpasswd that protects the auth_basic ones.

    Two sudo SSH round trips: read conf+htpasswd, then one remote script that
    installs, ``nginx -t``, reloads and rolls back on failure. Returns
    ``(ok, msg)``; never raises. The message always keeps a meaningful tail of
    the remote output, so a failure can be reported instead of swallowed."""
    import base64
    import io
    import secrets
    import tarfile
    import remote_hosts

    section = build_nginx_web_block(state)
    mark = _NGINX_SPLIT_MARK
    try:
        ok, out = remote_hosts.run_remote(
            NGINX_REMOTE_HOST,
            # NB: quote the marker — it starts with '#', so an unquoted `echo`
            # is a shell comment and the split never happens (that silently made
            # the htpasswd read-back empty and every sync re-apply).
            f"cat {NGINX_WEB_CONF}; echo '{mark}'; cat {NGINX_HTPASSWD} 2>/dev/null; :",
            sudo=True, timeout=20)
        if not ok:
            return False, f"读远程 nginx 配置失败: {out.strip()[-400:]}"
    except Exception as e:
        return False, f"读远程 nginx 配置异常: {e}"

    pre, _sep, post = out.partition(mark)
    old = pre
    old_hp = post[1:] if post.startswith("\n") else post
    new = _strip_web_ssl_blocks(old)
    # insert managed section before the first remaining server { block, else append
    import re as _re
    m = _re.search(r"^\s*server\s*\{", new, _re.MULTILINE)
    if m:
        new = new[:m.start()] + section + "\n\n" + new[m.start():]
    else:
        new = new.rstrip() + "\n\n" + section + "\n"
    hp = _htpasswd_content(state)
    if new == old and hp == old_hp:
        return True, "无变化"

    # One tar.gz payload, base64 over stdin: putting it on the command line would
    # die on MAX_ARG_STRLEN once the site has a few hundred groups, and sudo owns
    # stdin (the password), so the payload can't be the command's stdin either.
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for fname, text in (("https-web.conf", new), ("htpasswd", hp)):
            if not text:
                continue
            data = text.encode()
            ti = tarfile.TarInfo(fname)
            ti.size = len(data)
            ti.mode = 0o644
            ti.mtime = int(time.time())
            tf.addfile(ti, io.BytesIO(data))
    payload = base64.b64encode(buf.getvalue()).decode()
    base = "/tmp/.yt-ngx-" + secrets.token_hex(8)

    try:
        ok, out = remote_hosts.run_remote(
            NGINX_REMOTE_HOST, f"umask 077; base64 -d > {base}.tgz",
            sudo=False, timeout=30, stdin_data=payload)
        if not ok:
            return False, f"推送 nginx 配置失败: {out.strip()[-400:]}"
        ok, out = remote_hosts.run_remote(
            NGINX_REMOTE_HOST,
            _nginx_apply_script(base, NGINX_WEB_CONF, NGINX_HTPASSWD),
            sudo=True, timeout=60)
    except Exception as e:
        return False, f"同步远程 nginx 配置异常: {e}"

    body = (out or "").strip()
    if ok and "APPLIED" in body:
        detail = next((l for l in body.splitlines() if l.startswith("APPLIED")), "APPLIED")
        return True, f"已应用并 reload（{detail}）"
    remote_hosts.run_remote(NGINX_REMOTE_HOST, f"rm -f {base}.tgz",
                            sudo=False, timeout=10)
    if "TESTFAIL" in body:
        return False, f"nginx -t 失败，已回滚: {body[-500:]}"
    if "RELOADFAIL" in body:
        return False, f"nginx reload 失败，已回滚: {body[-500:]}"
    return False, f"nginx 同步失败: {body[-500:] or '无输出'}"


def nginx_sync(state):
    """``rewrite_nginx_web()`` with a guaranteed ``(ok, msg)`` shape.

    Callers must be able to *report* a failed sync instead of swallowing it, and
    a test double may return None or raise — this normalizes all of that."""
    try:
        res = rewrite_nginx_web(state)
    except Exception as e:
        return False, f"{e!r}"
    if isinstance(res, tuple) and len(res) == 2:
        return bool(res[0]), str(res[1] or "")
    if res is None:
        return True, ""
    return bool(res), ""


# --- high-level ops ---
def _norm_mem(mem):
    """Ensure memory quantity has a unit; bare number -> Gi."""
    if mem is None:
        return mem
    s = str(mem).strip()
    if s and s[0].isdigit() and not any(c.isalpha() for c in s):
        return s + "Gi"
    return s

def _norm_storage(storage):
    """Ensure storage quantity has a unit; bare number -> Gi. Min 1Gi."""
    if storage is None:
        return DEFAULT_STORAGE
    s = str(storage).strip()
    if not s:
        return DEFAULT_STORAGE
    if s and s[0].isdigit() and not any(c.isalpha() for c in s):
        s = s + "Gi"
    return s


def norm_tag(tag):
    """规范化 Pod 标签：strip、限 64 字符、字符白名单；空 → None。

    标签只作元数据（活动分组/批量充值用），不进 manifest，故允许中文。
    """
    if tag is None:
        return None
    s = str(tag).strip()
    if not s:
        return None
    if len(s) > 64:
        raise ValueError("标签最长 64 个字符")
    if not re.fullmatch(r"[\w \-.一-鿿]+", s):
        raise ValueError("标签仅支持中英文、数字、空格、- _ .")
    return s


_norm_tag = norm_tag  # 兼容别名


def normalize_name(name):
    """k8s 资源名：小写 RFC 1123。大写转小写，下划线转连字符。"""
    name = (name or "").strip().lower().replace("_", "-")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", name) or len(name) > 57:
        raise ValueError("组名仅支持小写字母、数字、连字符（大写自动转小写、下划线自动转连字符），且须以字母数字开头结尾")
    return name


def create_group(name, gpus=None, cpu=None, mem=None, storage=None, creator=None,
                 type=None, node="auto", image=None, mounts=None, tag=None,
                 privileged=False):
    # k8s 资源名必须是小写 RFC 1123（[a-z0-9-]，字母数字开头结尾）。
    # 大写/下划线先规范化，否则 kubectl apply 被拒后留下孤儿 manifest 和 home 目录。
    name = normalize_name(name)
    state = load_state()
    if name in state["groups"]:
        raise ValueError(f"组 {name} 已存在")
    is_windows = (type == "windows")
    is_android = (type == "android")
    # node placement: "auto" (default, no placement fields) or a node name
    # from nodes.py. VM groups are forced to auto — /dev/kvm and the
    # VM disk live on the default node only.
    if is_windows or is_android or not node:
        node = "auto"
    node = str(node).strip().lower()
    if node != "auto" and not nodes.valid(node):
        raise ValueError(f"未知节点: {node}（可选: auto, {', '.join(nodes.names())}）")
    _raw_cpu, _raw_mem, _raw_storage = cpu, mem, storage  # 用户显式传入值(校验用)
    is_gpu = bool(gpus) and not is_windows and not is_android
    if cpu is None:
        cpu = (ANDROID_DEFAULT_CPU if is_android
               else WINDOWS_DEFAULT_CPU if is_windows
               else DEFAULT_GPU_CPU if is_gpu else DEFAULT_CPU_CPU)
    if mem is None:
        mem = (ANDROID_DEFAULT_MEM if is_android
               else WINDOWS_DEFAULT_MEM if is_windows
               else DEFAULT_GPU_MEM if is_gpu else DEFAULT_CPU_MEM)
    mem = _norm_mem(mem)
    if is_windows and storage is None:
        storage = "64Gi"
    if is_android and storage is None:
        storage = "64Gi"
    storage = _norm_storage(storage)
    # 活动资源上限兜底：仅约束 UniSSO 用户(admin/super 豁免)。显式超限→拒绝；
    # 未显式指定的默认值按上限夹取，保证受约束用户最终规格不越过上限。
    # (API 主入口已校验；这里防 CLI / 其它入口绕过。)
    if creator:
        import quota
        if quota.scoped(creator):
            quota.validate_create(creator, cpu=_raw_cpu, mem=_raw_mem,
                                  storage=_raw_storage, gpus=gpus)
            cpu, mem, storage, _ = quota.clamp_resize(creator, cpu, mem, storage)
            if not quota.caps()["gpu_allowed"]:
                gpus, is_gpu = None, False
    idx = alloc_index(state)
    g = {
        "name": name,
        "index": idx,
        "type": "android" if is_android else ("windows" if is_windows else ("gpu" if is_gpu else "cpu")),
        "gpus": sorted(gpus) if is_gpu else [],
        "ssh_nodeport": SSH_NODEPORT_BASE + idx,
        "web_nodeport": WEB_NODEPORT_BASE + idx,
        "ssh_public": SSH_PUBLIC_BASE + idx,
        "web_public": WEB_PUBLIC_BASE + idx,
        "password": gen_password(),
        "cpu": cpu,
        "mem": mem,
        "storage": storage,
        "owners": [creator] if creator else [],
        "members": [],
        "pending": [],
        # 平台内部组(运维/被平台自己消费的服务)默认 False = 外部组, 按用量计费。
        # 标记为 True 后结算/提醒都会跳过(见 billing_settle)。
        "internal": False,
        # 活动/分组标签(元数据, 不进 manifest): 管理员可按 tag 批量给 Pod 发额度。
        "tag": norm_tag(tag),
        # 节点落位: "auto" = 不产出任何调度字段(调度器自选); 其余为 nodes.py 里的节点名。
        "node": node,
    }
    # Android groups expose ADB and Appium via ClusterIP internal ports.
    if is_android:
        g["internal_ports"] = [ANDROID_ADB_PORT, ANDROID_APPIUM_PORT]
    # optional custom container image + extra hostPath mounts (service pods).
    # Absent → the group is an ordinary dev box on the platform image.
    if image is not None:
        g["image"] = _check_image(image)
    if mounts is not None:
        g["mounts"] = _check_mounts(mounts)
    # opt-in privileged container (host /dev/net/tun + NET_ADMIN): only for
    # groups that must bring up a network tunnel. Windows groups are always
    # privileged via their own template, so this flag is for ubuntu groups.
    if privileged and not is_windows and not is_android:
        g["privileged"] = True
    # pre-create the persistent dir so it exists with sane perms before the pod
    # mounts it (kubelet DirectoryOrCreate would make it root-only). Windows
    # groups keep their VM disk on the big disk; the container runs as root.
    # The dir is created ON THE TARGET NODE (remote nodes via nodes.run_on).
    try:
        if is_windows:
            os.makedirs(f"{WINVM_ROOT}/{name}", exist_ok=True)
        elif is_android:
            os.makedirs(f"{ANDROID_ROOT}/{name}", exist_ok=True)
        elif node != "auto":
            ok, out = nodes.ensure_home(node, name)
            if not ok:
                raise OSError(f"远端建目录失败({node}): {out.strip()[:200]}")
        else:
            os.makedirs(f"{GROUP_DATA_ROOT}/{name}/home", exist_ok=True)
            # chown to the container login user's uid/gid (siteconf.CLOUD_UID), NOT a
            # hardcoded number: the image builds `cloud` with whatever uid build.sh
            # assigns, and a mismatch leaves the hostPath unwritable for cloud.
            os.chown(f"{GROUP_DATA_ROOT}/{name}/home",
                     siteconf.CLOUD_UID, siteconf.CLOUD_UID)
    except OSError:
        pass
    if not is_windows and not is_android:
        import hdd_quota
        ok, out = hdd_quota.ensure(name, storage, None if node == "auto" else node)
        if not ok:
            raise OSError(f"HDD /data 卷创建失败: {(out or '').strip()[:300]}")
    apply_group(g)
    state["groups"][name] = g
    save_state(state)
    rewrite_frpc(state)
    reload_frpc()
    nok, nmsg = nginx_sync(state)
    if not nok:
        audit.record("nginx_web_sync_error", detail=f"create {name}: {nmsg}"[:500])
    audit.record("create_group", detail=name)
    return g


def _disk_nodes():
    """Machines that can hold a group tree. Placement aliases are skipped."""
    found = []
    for node in nodes.names():
        if nodes.profile(node).get("k8s_node"):
            continue
        if node not in found:
            found.append(node)
    if nodes.DEFAULT_NODE not in found:
        found.append(nodes.DEFAULT_NODE)
    return found


def _erase_group_disks(name):
    """Remove one group's files on every machine. Returns error strings.

    Unmount the loop image everywhere before deleting, so a node that still
    has ``data.img`` open cannot leave the directory behind. Shared NFS is
    the same tree; a copy on another machine is a different tree.
    """
    import hdd_quota
    script = hdd_quota.erase_script(name)
    errors = []
    for node in _disk_nodes():
        ok, out = nodes.run_on(node, script, timeout=180)
        if ok:
            continue
        detail = (out or "").strip().replace("\n", " ")[:200]
        errors.append(f"{node}: {detail or '删除失败'}")
    for root in (WINVM_ROOT, ANDROID_ROOT):
        path = os.path.join(root, name)
        shutil.rmtree(path, ignore_errors=True)
        if os.path.exists(path):
            errors.append(f"残留 {path}")
    return errors


def remove_group(name):
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    delete_group_k8s(name)
    errors = _erase_group_disks(name)
    if errors:
        audit.record("delete_group_leftover", detail=f"{name} " + "; ".join(errors)[:500])
        raise RuntimeError("Pod 数据没删干净: " + "; ".join(errors))
    del state["groups"][name]
    save_state(state)
    rewrite_frpc(state)
    reload_frpc()
    nok, nmsg = nginx_sync(state)
    if not nok:
        audit.record("nginx_web_sync_error", detail=f"delete {name}: {nmsg}"[:500])
    mp = os.path.join(MANIFEST_DIR, f"group-{name}.yaml")
    if os.path.exists(mp):
        os.remove(mp)
    _purge_group_artifacts(name)
    audit.record("delete_group", detail=name)


def _purge_group_artifacts(name):
    """Remove a deleted group's records from deploys.json and any DB/MinIO
    creds whose label matches the group name. Best-effort: failures are logged
    to audit but never abort the group deletion."""
    import logging
    # deploys.json
    try:
        import deploys as _deploys
        st = _deploys.load()
        if name in st.get("deploys", {}):
            del st["deploys"][name]
            _deploys.save(st)
    except Exception as e:
        logging.getLogger(__name__).warning("purge deploys for %s: %s", name, e)
    # DB creds labeled with this group. ClickHouse shares the cred file but
    # its DROP lives in clickhouse_svc. Kafka creds are a separate file.
    try:
        import db_svc as _db
        for c in list(_db.list_creds()):
            if (c.get("label") or "").lower() != name.lower():
                continue
            try:
                if c.get("service") == "clickhouse":
                    import clickhouse_svc
                    clickhouse_svc.remove_cred(c["id"])
                else:
                    _db.remove_cred(c["id"])
            except Exception:
                pass
    except Exception as e:
        logging.getLogger(__name__).warning("purge db_creds for %s: %s", name, e)
    try:
        import kafka_svc
        for c in list(kafka_svc.list_creds()):
            if (c.get("label") or "").lower() == name.lower():
                try:
                    kafka_svc.remove_cred(c["id"])
                except Exception:
                    pass
    except Exception as e:
        logging.getLogger(__name__).warning("purge kafka_creds for %s: %s", name, e)
    # MinIO access keys labeled with this group
    try:
        import minio_svc as _mio
        for k in list(_mio.list_keys()):
            if (k.get("label") or "").lower() == name.lower():
                try:
                    _mio.remove_key(k["id"])
                except Exception:
                    pass
    except Exception as e:
        logging.getLogger(__name__).warning("purge minio_keys for %s: %s", name, e)
    try:
        import proxy_map
        for mapping in list(proxy_map.list_mappings()):
            if mapping.get("pod") == name:
                try:
                    proxy_map.remove(mapping["id"])
                except Exception:
                    pass
    except Exception as e:
        logging.getLogger(__name__).warning("purge proxy for %s: %s", name, e)
    try:
        import podcode
        podcode.forget(name)
    except Exception as e:
        logging.getLogger(__name__).warning("purge podcode for %s: %s", name, e)


def reset_password(name):
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    state["groups"][name]["password"] = gen_password()
    apply_group(state["groups"][name])
    kubectl("rollout", "restart", f"deployment/group-{name}")
    save_state(state)
    audit.record("reset_password", detail=name)
    return state["groups"][name]


def resize_group(name, cpu, mem, storage=None):
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = state["groups"][name]
    restart_needed = False
    manifest_changed = False
    if cpu is not None and str(cpu) != str(g["cpu"]):
        g["cpu"] = cpu; restart_needed = True; manifest_changed = True
    if mem is not None and _norm_mem(mem) != g["mem"]:
        g["mem"] = _norm_mem(mem); restart_needed = True; manifest_changed = True
    if storage is not None and _norm_storage(storage) != g.get("storage"):
        g["storage"] = _norm_storage(storage); manifest_changed = True
    if restart_needed:
        apply_group(g)
        kubectl("rollout", "restart", f"deployment/group-{name}")
    elif manifest_changed:
        # Ephemeral-storage is not supported by Kubernetes in-place pod resize.
        # Persist the desired storage limit/request into the manifest and state,
        # but avoid restarting a healthy pod just for a storage-only edit.
        write_manifest(g)
    save_state(state)
    audit.record("resize_group", detail=f"{name} cpu={g['cpu']} mem={g['mem']} storage={g.get('storage')}")
    return g


# --- rename --------------------------------------------------------------- #
_PORT_FIELDS = ("index", "ssh_nodeport", "web_nodeport", "ssh_public", "web_public")


def _rekey_deploys(old, new):
    """Move deploys.json's list from old to new. Returns True if a list moved."""
    import deploys
    st = deploys.load()
    bucket = st.setdefault("deploys", {})
    if old not in bucket:
        return False
    bucket[new] = bucket.pop(old)
    deploys.save(st)
    return True


def _retarget_store_labels(old, new):
    """Point DB and MinIO cred labels that used the group name at the new name."""
    try:
        import db_svc
        creds = db_svc._creds_load()
        changed = False
        for cred in creds:
            if (cred.get("label") or "").lower() == old.lower():
                cred["label"] = new
                changed = True
        if changed:
            db_svc._creds_save(creds)
    except Exception as e:
        audit.record("rename_label_error", detail=f"db {old}->{new} {e}")
    try:
        import minio_svc
        keys = minio_svc._keys_load()
        changed = False
        for key in keys:
            if (key.get("label") or "").lower() == old.lower():
                key["label"] = new
                changed = True
        if changed:
            minio_svc._keys_save(keys)
    except Exception as e:
        audit.record("rename_label_error", detail=f"minio {old}->{new} {e}")


def rename_group(old, new, progress=None):
    """Rename a group. Ports and index stay, so the ssemarket entry does not move.

    The directory is renamed on the node that holds it, then the state key,
    manifests, frpc proxy names and deploy list follow. A failure after the
    rename puts the directory and the state key back.

    ``progress`` is an optional callable invoked with a dict per step
    (``{"key","label","status","node","pct","detail"}``), so a UI can show how
    far the rename got and on which node. Any error it raises is swallowed.

    The frpc/nginx bookkeeping runs on a second thread, in parallel with the
    k8s release + rebuild (it is the slow part: SSH round trips to the relay),
    and the job only reports done once the new pod is Ready. A relay sync that
    fails is reported as a warning (and audited) instead of being swallowed.
    """
    def _rep(key, label, status="running", node=None, pct=None, detail=""):
        if progress is None:
            return
        try:
            progress({"key": key, "label": label, "status": status,
                      "node": node, "pct": pct, "detail": detail})
        except Exception:
            pass

    new = normalize_name(new)
    state = load_state()
    g = state["groups"].get(old)
    if not g:
        raise ValueError(f"组 {old} 不存在")
    if g.get("type") in ("windows", "android"):
        raise ValueError("VM 组(android/windows)不支持改名")
    if new == old:
        return g
    if new in state["groups"]:
        raise ValueError(f"组 {new} 已存在")
    node = nodes.node_for(g)
    node_label = node or nodes.DEFAULT_NODE
    _rep("check", "校验名称与目标", "done", node=node_label, pct=6, detail=f"{old} → {new}")
    import hdd_quota
    disk_label = f"重命名数据目录（节点 {node_label}）"
    _rep("disk", disk_label, "running", node=node_label, pct=10)
    script = hdd_quota.rename_tree_script(old, new, g.get("storage") or DEFAULT_STORAGE)
    ok, out = nodes.run_on(node, script, timeout=120)
    if not ok:
        _rep("disk", disk_label, "error", node=node_label, detail=str(out)[:500])
        raise RuntimeError(f"目录改名失败: {out}")
    _rep("disk", disk_label, "done", node=node_label, pct=25)
    kept = {field: g.get(field) for field in _PORT_FIELDS}
    g["name"] = new
    del state["groups"][old]
    state["groups"][new] = g
    save_state(state)
    _rep("state", "更新平台状态", "done", node=node_label, pct=35)
    from concurrent.futures import ThreadPoolExecutor
    moved_deploys = False
    warnings = []
    route_label = "重写 frpc / nginx 映射"

    def _route_worker():
        """frpc + nginx rewrite. Neither touches a k8s object, so this runs on
        a second thread while the main one releases and rebuilds the
        Deployment — the relay round trips (~2s) were the bulk of the rename."""
        out = {"frpc": "", "nginx": (True, "")}
        _rep("route", route_label, "running", node=node_label, pct=72)
        try:
            rewrite_frpc(state)
            reload_frpc()
        except Exception as e:
            out["frpc"] = str(e)
        out["nginx"] = nginx_sync(state)
        return out

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        # The ports stay on the same index, so the old Service holds the same
        # nodePorts the new one wants. Delete the old objects first — two
        # Services cannot share a nodePort — and let the rollback re-create
        # them if the new apply fails. The old pod must also be gone before the
        # new one mounts the same hostPath, hence the poll (with sub-progress).
        k8s_label = f"释放旧 Deployment / Service（节点 {node_label}）"
        _rep("k8s", k8s_label, "running", node=node_label, pct=45)
        route_fut = pool.submit(_route_worker)
        gone = delete_group_k8s(
            old, grace=20, timeout=70,
            tick=lambda el, d: _rep("k8s", k8s_label, "running", node=node_label,
                                    detail=f"等待旧 Pod 退出 {int(el)}s｜{d}"))
        if not gone:
            warnings.append("旧 Pod 未在时限内退出（可能仍占用数据目录）")
        _rep("k8s", k8s_label, "done", node=node_label, pct=55)
        dep_label = f"重建 Deployment / Service（节点 {node_label}）"
        _rep("deploy", dep_label, "running", node=node_label, pct=60)
        apply_group(g)
        _rep("deploy", dep_label, "done", node=node_label, pct=72)
        # "done" should mean usable, so wait for the new pod's Ready condition.
        rl_label = f"等待 Pod 就绪（节点 {node_label}）"
        _rep("ready", rl_label, "running", node=node_label, pct=76)
        ready = _wait_pod_ready(
            new, timeout=120,
            tick=lambda el, d: _rep("ready", rl_label, "running", node=node_label,
                                    detail=f"启动中 {int(el)}s｜{d}"))
        _rep("ready", rl_label, "done" if ready else "error", node=node_label,
             pct=90, detail="" if ready else "Pod 启动较慢，改名已完成，请稍后在 Pod 页确认")
        if not ready:
            warnings.append("新 Pod 未在 120s 内就绪")
        # Join before deciding: a bookkeeping thread still running would fight
        # the rollback's own frpc/nginx rewrite.
        route = route_fut.result()
        if route.get("frpc"):
            raise RuntimeError(f"frpc 重载失败: {route['frpc']}")
        nok, nmsg = route.get("nginx") or (False, "未执行")
        if nok:
            _rep("route", route_label, "done", node=node_label, pct=91,
                 detail="" if nmsg in ("", "无变化") else nmsg)
        else:
            warnings.append(f"nginx 同步失败（公网入口可能未更新）: {nmsg}")
            audit.record("nginx_web_sync_error", detail=f"{old}->{new} {nmsg}"[:500])
            _rep("route", route_label, "error", node=node_label, pct=91, detail=nmsg[:300])
        _rep("deploys", "迁移部署记录", "running", node=node_label, pct=94)
        moved_deploys = _rekey_deploys(old, new)
        _retarget_store_labels(old, new)
        old_manifest = os.path.join(MANIFEST_DIR, f"group-{old}.yaml")
        if os.path.exists(old_manifest):
            os.remove(old_manifest)
        _rep("deploys", "迁移部署记录", "done", node=node_label, pct=96)
    except Exception as e:
        pool.shutdown(wait=True)   # never rewrite frpc/nginx behind a rollback
        _rep("rollback", "出错，正在回滚到原名…", "running", node=node_label, detail=str(e)[:300])
        back = hdd_quota.rename_tree_script(new, old, g.get("storage") or DEFAULT_STORAGE)
        nodes.run_on(node, back, timeout=120)
        g["name"] = old
        for field, value in kept.items():
            g[field] = value
        state["groups"].pop(new, None)
        state["groups"][old] = g
        save_state(state)
        # Drop the half-written new manifest too; apply_group(g) below rewrites
        # the old one, but nothing would otherwise clean up group-<new>.yaml.
        try:
            new_manifest = os.path.join(MANIFEST_DIR, f"group-{new}.yaml")
            if os.path.exists(new_manifest):
                os.remove(new_manifest)
        except OSError:
            pass
        if moved_deploys:
            try:
                _rekey_deploys(new, old)
            except Exception:
                pass
        try:
            # Free the nodePorts held by the half-created new objects first,
            # otherwise re-applying the old name collides on the same port.
            delete_group_k8s(new, grace=10, timeout=40)
            apply_group(g)
            rewrite_frpc(state)
            reload_frpc()
            nginx_sync(state)
        except Exception:
            pass
        _rep("rollback", "已回滚到原名", "error", node=node_label, detail=str(e)[:300])
        raise
    finally:
        pool.shutdown(wait=False)
    audit.record("rename_group", detail=f"{old}->{new} ports={kept['ssh_public']}/{kept['web_public']}")
    tail = "；".join(warnings)
    _rep("done", "改名完成", "done", node=node_label, pct=100,
         detail=(f"新名字 {new}；注意：{tail}" if tail else f"新名字 {new}"))
    return g


# --- cross-node move ------------------------------------------------------- #
# 大件（模型权重）按约定不跨节点搬：默认排除常见权重扩展名；组里引用
# /shared 的权重在目标节点各有各的副本，迁移后由组自行补齐。
WEIGHT_EXCLUDES = ("*.pt", "*.pth", "*.safetensors", "*.bin", "*.gguf",
                   "*.ckpt", "*.onnx", "*.engine")


def _check_move_target(g, new_node):
    if g.get("type") in ("windows", "android"):
        raise ValueError("VM 组(android/windows)不支持换节点")
    new_node = str(new_node or "").strip().lower()
    if not new_node or new_node == "auto":
        raise ValueError("换节点须指定具体节点（auto 由调度器决定）")
    if not nodes.valid(new_node):
        raise ValueError(f"未知节点: {new_node}（可选: {', '.join(nodes.names())}）")
    old_node = g.get("node") or "auto"
    if old_node == new_node:
        raise ValueError(f"组 {g['name']} 已在节点 {new_node} 上")
    assigned = g.get("gpus") or []
    if assigned and not set(assigned) <= set(nodes.gpu_ids(new_node)):
        raise ValueError(
            f"组分配的 GPU {assigned} 在节点 {new_node} 上不存在"
            f"（该节点有 {nodes.gpu_ids(new_node)}），请先调整 GPU 分配")
    return old_node, new_node


def migrate_mode(name, new_node):
    """``shared`` when the target already has this group's disk, else ``copy``."""
    state = load_state()
    g = state["groups"].get(name)
    if not g:
        raise ValueError(f"组 {name} 不存在")
    old_node, new_node = _check_move_target(g, new_node)
    shared = nodes.shares_group_storage(nodes.node_for(g), new_node)
    return "shared" if shared else "copy"


def _handoff_data_image(name, src, dst, storage):
    """Move one group's loop image onto ``dst``. Returns True when an image moved.

    A plain directory (no ``data.img``) is already the shared files. Two nodes
    must not loop-mount the same ext4 image.
    """
    import hdd_quota
    img, _mnt = hdd_quota.paths(name)
    present, _out = nodes.run_on(src, f"test -f {img}", timeout=30)
    if not present:
        return False
    ok, out = nodes.run_on(src, hdd_quota.unmount_script(name), timeout=120)
    if not ok:
        raise RuntimeError(f"源端卸下 data 失败: {out}")
    ok, out = nodes.run_on(dst, hdd_quota.ensure_script(name, storage), timeout=900)
    if not ok:
        nodes.run_on(src, hdd_quota.ensure_script(name, storage), timeout=900)
        raise RuntimeError(f"目标挂上 data 失败: {out}")
    return True


def _copy_tree(name, src, dst, exclude_weights):
    """Stream home and data.img from src to dst. No shared staging directory."""
    import hdd_quota
    root = GROUP_DATA_ROOT.rstrip("/")
    excludes = ""
    if exclude_weights:
        excludes = " ".join(f"--exclude={pat}" for pat in WEIGHT_EXCLUDES)
    ok, out = nodes.run_on(src, hdd_quota.unmount_script(name), timeout=120)
    if not ok:
        raise RuntimeError(f"源端卸下 data 失败: {out}")
    src_cmd = (
        f"set -euo pipefail; cd {root}; args=({name}/home); "
        f"if [ -f {name}/data.img ]; then args+=({name}/data.img); fi; "
        f"tar {excludes} -cf - \"${{args[@]}}\""
    )
    uid = siteconf.CLOUD_UID
    dst_cmd = (
        f"set -euo pipefail; mkdir -p {root}/{name}; "
        f"tar -C {root} --numeric-owner -pxf -; "
        f"chown -R {uid}:{uid} {root}/{name}/home; "
        f"test -d {root}/{name}/home"
    )
    ok, out = nodes.pipe_root(src, dst, src_cmd, dst_cmd, timeout=1800)
    if not ok:
        raise RuntimeError(f"拷贝失败: {out}")
    ok, out = nodes.run_on(
        dst, f"test -d {root}/{name}/home", timeout=30)
    if not ok:
        raise RuntimeError(f"目标 home 不存在: {out}")


def migrate_group(name, new_node, exclude_weights=True):
    """Move a group onto another node. Ports stay on the group's index.

    Shared disk: change ``g['node']`` and start there. No copy, no delete.
    A loop-backed ``data.img`` is unmounted on the source and mounted on the
    target so only one node has the ext4 image open. Otherwise stream home
    and data.img over SSH. The source directory is removed only after the
    group starts on the target. A failure starts the group again on the old
    node.
    """
    state = load_state()
    g = state["groups"].get(name)
    if not g:
        raise ValueError(f"组 {name} 不存在")
    old_node, new_node = _check_move_target(g, new_node)
    src = nodes.node_for(g)
    shared = nodes.shares_group_storage(src, new_node)
    import lifecycle
    res = lifecycle.stop_group(name)
    if not res.get("ok"):
        raise RuntimeError(f"停止组失败: {res.get('error')}")
    image_moved = False
    try:
        if not shared:
            _copy_tree(name, src, new_node, exclude_weights)
            import hdd_quota
            nodes.run_on(new_node, hdd_quota.ensure_script(name, g.get("storage") or DEFAULT_STORAGE), timeout=900)
        else:
            image_moved = _handoff_data_image(name, src, new_node, g.get("storage") or DEFAULT_STORAGE)
        g["node"] = new_node
        save_state(state)
        apply_group(g)
        started = lifecycle.start_group(name)
        if not started.get("ok"):
            raise RuntimeError(f"目标节点启动失败: {started.get('error')}")
        if not shared:
            removed, leftover = nodes.run_on(src, f"rm -rf {GROUP_DATA_ROOT.rstrip('/')}/{name}", timeout=120)
            if not removed:
                audit.record("migrate_source_leftover", detail=f"{name} {leftover[:300]}")
    except Exception:
        rollback_error = None
        if image_moved:
            try:
                _handoff_data_image(name, new_node, src, g.get("storage") or DEFAULT_STORAGE)
            except Exception as roll:
                rollback_error = roll
        g["node"] = old_node
        save_state(state)
        if rollback_error is None:
            try:
                apply_group(g)
                lifecycle.start_group(name)
            except Exception:
                pass
        raise
    audit.record("migrate_group", detail=f"{name} {old_node}->{new_node} mode={'shared' if shared else 'copy'}")
    return g


# --- per-pod environment variables (admin-managed) ---
import re as _re
_ENV_KEY_RE = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENV_RESERVED = {"CLOUD_PASSWORD", "NVIDIA_VISIBLE_DEVICES", "INTERNAL_PORTS"}


def _check_env_key(key):
    key = (key or "").strip()
    if not key:
        raise ValueError("变量名不能为空")
    if not _ENV_KEY_RE.match(key):
        raise ValueError("变量名只能含字母数字下划线,且不以数字开头")
    if key in ENV_RESERVED:
        raise ValueError(f"{key} 为系统保留变量,不能改")
    return key


def set_env(name, key, value):
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    key = _check_env_key(key)
    g = state["groups"][name]
    g.setdefault("env", {})
    g["env"][key] = (value or "")
    apply_group(g)
    kubectl("rollout", "restart", f"deployment/group-{name}")
    save_state(state)
    audit.record("env_set", detail=f"{name} {key}={value}")
    return g["env"]


def delete_env(name, key):
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    key = _check_env_key(key)
    g = state["groups"][name]
    env = g.get("env") or {}
    if key not in env:
        raise ValueError(f"变量 {key} 不存在")
    del env[key]
    g["env"] = env
    apply_group(g)
    kubectl("rollout", "restart", f"deployment/group-{name}")
    save_state(state)
    audit.record("env_delete", detail=f"{name} {key}")
    return g["env"]


def gpu_overview(state=None):
    if state is None:
        state = load_state()
    ov = {i: [] for i in range(GPU_COUNT)}
    for g in state["groups"].values():
        for gi in g["gpus"]:
            if gi in ov:
                ov[gi].append(g["name"])
    return ov


def list_groups():
    state = load_state()
    statuses = all_pod_statuses()  # one batch kubectl call instead of N
    groups = []
    for g in sorted(state["groups"].values(), key=lambda x: x["index"]):
        g = dict(g)
        g.setdefault("owners", [])
        g.setdefault("members", [])
        g.setdefault("pending", [])
        g.setdefault("internal", False)
        g["status"] = statuses.get(g["name"], "NotFound")
        groups.append(g)
    return groups, state


def internal_groups():
    """组名集合: 被标记为平台内部(不计费)的组。一次 load_state, 供结算/API 复用。"""
    try:
        state = load_state()
    except Exception:
        return set()
    return {name for name, g in state.get("groups", {}).items() if g.get("internal")}


def set_internal(name, flag):
    """标记/取消「平台内部组」(不计费)。不改 pod 资源, 无需 rollout。"""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = state["groups"][name]
    g["internal"] = bool(flag)
    save_state(state)
    audit.record("group_internal_set", detail=f"{name} internal={bool(flag)}")
    return bool(g["internal"])


def set_tag(name, tag, actor=""):
    """设置/清空 Pod 标签(活动分组、按标签批量充值用)。纯元数据, 无需 rollout。"""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = state["groups"][name]
    g["tag"] = norm_tag(tag)
    save_state(state)
    audit.record("group_tag_set", detail=f"{name} tag={g['tag']}", actor=actor or "")
    return g["tag"]


# --- pod ownership / membership management ---
def _ensure_acl(g):
    g.setdefault("owners", [])
    g.setdefault("members", [])
    g.setdefault("pending", [])
    return g


def apply_to_pod(name, username, reason):
    """User applies to join a pod. Added to pending list (dedup)."""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = _ensure_acl(state["groups"][name])
    # already owner or member?
    if username in g["owners"] or username in g["members"]:
        raise ValueError("已是该 Pod 的成员")
    # already pending?
    for p in g["pending"]:
        if p.get("username") == username:
            raise ValueError("已申请,等待审批")
    g["pending"].append({"username": username, "reason": (reason or "").strip(),
                         "created": time.time()})
    save_state(state)
    audit.record("pod_apply", detail=f"{username} -> {name}")
    return True


def approve_pending(name, username, approved):
    """Owner approves/denies a pending application."""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = _ensure_acl(state["groups"][name])
    pend = [p for p in g["pending"] if p.get("username") == username]
    if not pend:
        raise ValueError("没有该用户的申请")
    g["pending"] = [p for p in g["pending"] if p.get("username") != username]
    if approved:
        if username not in g["members"]:
            g["members"].append(username)
        audit.record("pod_approve", detail=f"{username} -> {name}")
    else:
        audit.record("pod_deny", detail=f"{username} -> {name}")
    save_state(state)
    return True


def invite_member(name, username):
    """Owner directly invites an existing user as member."""
    if not isinstance(username, str) or not 1 <= len(username.strip()) <= 64:
        raise ValueError("用户不存在")
    user = users.get_user(username.strip())
    if not user:
        raise ValueError("用户不存在")
    username = user["username"]
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = _ensure_acl(state["groups"][name])
    if username in g["owners"] or username in g["members"]:
        raise ValueError("该用户已是成员")
    g["members"].append(username)
    # remove from pending if present
    g["pending"] = [p for p in g["pending"] if p.get("username") != username]
    save_state(state)
    audit.record("pod_invite", detail=f"{username} -> {name}")
    return True


def remove_member(name, username):
    """Owner removes a member."""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = _ensure_acl(state["groups"][name])
    if username not in g["members"]:
        raise ValueError("该用户不是成员")
    g["members"] = [m for m in g["members"] if m != username]
    save_state(state)
    audit.record("pod_remove_member", detail=f"{username} <- {name}")
    return True


def add_owner(name, username):
    """Owner promotes an existing user (or member) to co-owner."""
    if not isinstance(username, str) or not 1 <= len(username.strip()) <= 64:
        raise ValueError("用户不存在")
    user = users.get_user(username.strip())
    if not user:
        raise ValueError("用户不存在")
    username = user["username"]
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = _ensure_acl(state["groups"][name])
    if username in g["owners"]:
        raise ValueError("该用户已是 owner")
    g["owners"].append(username)
    # remove from members if present (owner supersedes member)
    g["members"] = [m for m in g["members"] if m != username]
    save_state(state)
    audit.record("pod_add_owner", detail=f"{username} -> {name}")
    return True


def remove_owner(name, username):
    """Owner removes a co-owner. Must leave at least 1 owner."""
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    g = _ensure_acl(state["groups"][name])
    if username not in g["owners"]:
        raise ValueError("该用户不是 owner")
    if len(g["owners"]) <= 1:
        raise ValueError("至少保留 1 个 owner")
    g["owners"] = [o for o in g["owners"] if o != username]
    save_state(state)
    audit.record("pod_remove_owner", detail=f"{username} <- {name}")
    return True


def list_applications(username):
    """Return all pending pod applications for a user."""
    state = load_state()
    apps = []
    for name, g in state["groups"].items():
        for p in g.get("pending", []):
            if p.get("username") == username:
                apps.append({"pod": name, "reason": p.get("reason", ""),
                             "created": p.get("created", 0)})
    return apps
