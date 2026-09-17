#!/usr/bin/env python3
"""Core logic for the platform groups: state, manifests, frpc, kubectl."""
import json, os, secrets, string, subprocess, textwrap, shutil, time, threading
import audit
import req_estimate
import siteconf

# --- constants ---
STATE_FILE = siteconf.path("groups.json")
FRPC_FILE = os.environ.get("YATTERRA_FRPC_FILE", "/opt/frp/frpc.toml")
MANIFEST_DIR = siteconf.path("manifests")
NS = siteconf.GROUP_NS
IMAGE = os.environ.get("YATTERRA_GROUP_IMAGE",
                       os.environ.get("YATTERRA_STUDENT_IMAGE",
                                      "docker.io/sse/cloud-ubuntu:24.04"))

SSH_NODEPORT_BASE = int(os.environ.get("YATTERRA_SSH_NODEPORT_BASE", "31000"))
WEB_NODEPORT_BASE = int(os.environ.get("YATTERRA_WEB_NODEPORT_BASE", "32000"))
SSH_PUBLIC_BASE = siteconf.SSH_PUBLIC_BASE
WEB_PUBLIC_BASE = siteconf.WEB_PUBLIC_BASE
GPU_COUNT = 3
MAX_GROUPS = 50  # public ports 22001-22050 / 23001-23050

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

DEFAULT_CPU_CPU = "2"
DEFAULT_CPU_MEM = "4Gi"
DEFAULT_GPU_CPU = "4"
DEFAULT_GPU_MEM = "16Gi"
EPHEMERAL = "20Gi"

# per-group persistent home (survives rollout restart). hostPath on the big disk;
# size is a recorded soft cap (local-path/ext4 don't hard-enforce -> advisory).
GROUP_DATA_ROOT = siteconf.GROUP_DATA_ROOT
DEFAULT_STORAGE = "10Gi"

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
  chown -R 1001:1001 /home/cloud 2>/dev/null || true
fi
su -l cloud -c "mkdir -p ~/deploy/programs ~/deploy/logs ~/logs"
if [ ! -x /home/cloud/.local/bin/supervisord ]; then
  su -l cloud -c "pip install --user --break-system-packages -q supervisor" >/tmp/sup_install.log 2>&1 || true
fi
SUP_PID=$(cat /home/cloud/deploy/supervisord.pid 2>/dev/null || true)
if [ -e /home/cloud/deploy/supervisord.conf ] && [ -x /home/cloud/.local/bin/supervisord ] && { [ -z "$SUP_PID" ] || ! kill -0 "$SUP_PID" 2>/dev/null; }; then
  su -l cloud -c "~/.local/bin/supervisord -c ~/deploy/supervisord.conf" >>/home/cloud/deploy/supervisord.boot.log 2>&1 &
  sleep 1
fi
exec /usr/sbin/sshd -D -e"""


def _cmd_block():
    """YAML for the pod command (tini -> bash -c INIT_SCRIPT).

    Container fields live at 8 spaces; the block-scalar content must be indented
    past the sibling fields (env:/ports: at 8) so the scalar terminates correctly.
    """
    return (
        "        command:\n"
        "        - /usr/bin/tini\n"
        "        - --\n"
        "        - /bin/bash\n"
        "        - -c\n"
        "        - |\n"
        + textwrap.indent(INIT_SCRIPT, "            ")
    )


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
        raise ValueError("已达最大组数 10(公网端口只放了10个)")
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
def _all_gpu_ids():
    """Detect all GPU indices on the node via nvidia-smi. Falls back to [0].
    Cached after first success. Used so GPU group pods see every card and the
    per-deploy scheduler (CUDA_VISIBLE_DEVICES) can place work on any of them."""
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


def deployment_yaml(g):
    name = g["name"]
    is_gpu = g["type"] == "gpu"
    cpu = g["cpu"]; mem = g["mem"]
    # limits = user-set cap; requests = EWMA estimate from actual usage
    req_cpu, req_mem = req_estimate.request_for(g)
    env_lines = [
        f'        - name: CLOUD_PASSWORD\n          value: "{g["password"]}"',
        '        - name: LOG_DIR\n          value: "/home/cloud/logs"',
    ]
    runtime_class = ""
    if is_gpu:
        # Pod sees only its assigned GPUs (g["gpus"]); falls back to all if
        # unset. This isolates the group's interactive environment at the CUDA
        # driver level. The per-deploy scheduler further places supervised
        # jobs within this visible set (scheduler.place_train respects g["gpus"]).
        assigned = g.get("gpus") or []
        vis = ",".join(map(str, assigned)) if assigned else ",".join(map(str, _all_gpu_ids()))
        env_lines.append(
            f'        - name: NVIDIA_VISIBLE_DEVICES\n          value: "{vis}"'
        )
        # MPS (Multi-Process Service): cooperative GPU sharing for co-resident
        # processes. Pipe+log dirs are host-mounted so all GPU pods share the
        # single host MPS daemon. Non-MPS fallback if daemon is down.
        env_lines.append('        - name: CUDA_MPS_PIPE_DIRECTORY\n          value: "/tmp/nvidia-mps"')
        env_lines.append('        - name: CUDA_MPS_LOG_DIRECTORY\n          value: "/var/log/nvidia-mps"')
        # Host CUDA toolkit (nvcc + headers) mounted read-only so JIT-compiled
        # kernels (e.g. deep_gemm used by MoE/FP4 models like Ling-3.0) can
        # build inside the pod. The driver alone (via nvidia runtime) is not enough.
        env_lines.append('        - name: CUDA_HOME\n          value: "/usr/local/cuda"')
        runtime_class = "      runtimeClassName: nvidia\n"
    # admin-managed custom env vars (g["env"] = {KEY: VALUE})
    for k, v in sorted((g.get("env") or {}).items()):
        env_lines.append(f'        - name: {k}\n          value: {json.dumps(str(v))}')
    env_block = "\n".join(env_lines)
    cmd = _cmd_block()
    # MPS pipe/log dir mounts (GPU pods only, shared with host daemon)
    mps_mounts = ""
    mps_volumes = ""
    if is_gpu:
        mps_mounts = """        - name: mps-pipe
          mountPath: /tmp/nvidia-mps
        - name: mps-log
          mountPath: /var/log/nvidia-mps
        - name: host-cuda
          mountPath: /usr/local/cuda
          readOnly: true"""
        mps_volumes = """      - name: mps-pipe
        hostPath:
          path: /tmp/nvidia-mps
          type: DirectoryOrCreate
      - name: mps-log
        hostPath:
          path: /var/log/nvidia-mps
          type: DirectoryOrCreate
      - name: host-cuda
        hostPath:
          path: /usr/local/cuda
          type: Directory"""
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
  selector:
    matchLabels:
      app: group-{name}
  template:
    metadata:
      labels:
        app: group-{name}
    spec:
{runtime_class}      containers:
      - name: ubuntu
        image: {IMAGE}
        imagePullPolicy: IfNotPresent
{cmd}
        env:
{env_block}
        ports:
        - containerPort: 22
        - containerPort: 8080
        resources:
          limits:
            cpu: "{cpu}"
            memory: "{mem}"
            ephemeral-storage: "{EPHEMERAL}"
          requests:
            cpu: "{req_cpu}"
            memory: "{req_mem}"
        securityContext:
          privileged: false
        volumeMounts:
        - name: shared
          mountPath: /shared
          readOnly: true
        - name: group-home
          mountPath: /home/cloud
{mps_mounts}
      volumes:
      - name: shared
        hostPath:
          path: {siteconf.SHARED_ROOT}
          type: DirectoryOrCreate
      - name: group-home
        hostPath:
          path: {GROUP_DATA_ROOT}/{name}/home
          type: DirectoryOrCreate
{mps_volumes}
"""


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
    targetPort: 8080
    nodePort: {g["web_nodeport"]}
"""


def write_manifest(g):
    os.makedirs(MANIFEST_DIR, exist_ok=True)
    path = os.path.join(MANIFEST_DIR, f"group-{g['name']}.yaml")
    with open(path, "w") as f:
        f.write(deployment_yaml(g))
        f.write("---\n")
        f.write(service_yaml(g))
    return path


def apply_group(g):
    path = write_manifest(g)
    kubectl("apply", "-f", path)


def delete_group_k8s(name):
    kubectl("delete", "deployment,service", f"group-{name}", "--ignore-not-found=true", check=False)


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
        post = content.split(FRPC_MARK_END)[1] if FRPC_MARK_END in content else ""
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
def _web_ssl_block(public_port):
    """Generate one nginx server block: listen <port> ssl → proxy_pass 127.0.0.1:<port-10000>."""
    inner = public_port - 10000
    return f"""server {{
    listen {public_port} ssl;
    listen [::]:{public_port} ssl;
    server_name {siteconf.DOMAIN};
    ssl_certificate     {NGINX_SSL_CERT};
    ssl_certificate_key {NGINX_SSL_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    location / {{
        proxy_pass http://127.0.0.1:{inner};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }}
}}"""


def build_nginx_web_block(state):
    """Build the managed marker section with all web-ssl server blocks."""
    lines = [NGINX_MARK_BEGIN]
    lines.append(_web_ssl_block(PLATFORM_GUI_PORT))
    for g in state["groups"].values():
        lines.append(_web_ssl_block(g["web_public"]))
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


def rewrite_nginx_web(state):
    """Sync cloud nginx https-web.conf: rewrite all 23xxx/24000 SSL server blocks
    from state. Reads → strips → inserts → nginx -t → reload, with rollback.
    Returns (ok, msg). Never raises (best-effort)."""
    import base64, remote_hosts
    section = build_nginx_web_block(state)
    try:
        ok, out = remote_hosts.run_remote(
            NGINX_REMOTE_HOST, f"cat {NGINX_WEB_CONF}", sudo=True, timeout=20)
        if not ok:
            return False, f"读 {NGINX_WEB_CONF} 失败: {out}"
        old = out
    except Exception as e:
        return False, f"读远程 nginx 配置异常: {e}"

    new = _strip_web_ssl_blocks(old)
    # insert managed section before the first remaining server { block, else append
    import re as _re
    m = _re.search(r"^\s*server\s*\{", new, _re.MULTILINE)
    if m:
        new = new[:m.start()] + section + "\n\n" + new[m.start():]
    else:
        new = new.rstrip() + "\n\n" + section + "\n"
    if new == old:
        return True, "无变化"

    try:
        b64 = base64.b64encode(new.encode("utf-8")).decode("ascii")
        ok, out = remote_hosts.run_remote(
            NGINX_REMOTE_HOST,
            f"echo {b64} | base64 -d | tee {NGINX_WEB_CONF} > /dev/null",
            sudo=True, timeout=30)
        if not ok:
            return False, f"写 {NGINX_WEB_CONF} 失败: {out}"
    except Exception as e:
        return False, f"写远程 nginx 配置异常: {e}"

    # nginx -t
    ok, out = remote_hosts.run_remote(
        NGINX_REMOTE_HOST, "nginx -t", sudo=True, timeout=25)
    if not (ok and "test is successful" in out):
        # rollback
        try:
            b64 = base64.b64encode(old.encode("utf-8")).decode("ascii")
            remote_hosts.run_remote(
                NGINX_REMOTE_HOST,
                f"echo {b64} | base64 -d | tee {NGINX_WEB_CONF} > /dev/null",
                sudo=True, timeout=30)
        except Exception:
            pass
        return False, f"nginx -t 失败已回滚: {out.strip().splitlines()[-1] if out.strip() else '未知'}"

    # reload
    ok, out = remote_hosts.run_remote(
        NGINX_REMOTE_HOST, "nginx -s reload", sudo=True, timeout=20)
    if not ok:
        return False, f"reload 失败: {out}"
    return True, "已应用并 reload"


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


def create_group(name, gpus=None, cpu=None, mem=None, storage=None, creator=None):
    # k8s 资源名必须是小写 RFC 1123（[a-z0-9-]，字母数字开头结尾）。
    # 大写/下划线先规范化，否则 kubectl apply 被拒后留下孤儿 manifest 和 home 目录。
    import re as _re
    name = name.strip().lower().replace("_", "-")
    if not _re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", name) or len(name) > 57:
        raise ValueError("组名仅支持小写字母、数字、连字符（大写自动转小写、下划线自动转连字符），且须以字母数字开头结尾")
    state = load_state()
    if name in state["groups"]:
        raise ValueError(f"组 {name} 已存在")
    is_gpu = bool(gpus)
    if cpu is None: cpu = DEFAULT_GPU_CPU if is_gpu else DEFAULT_CPU_CPU
    if mem is None: mem = DEFAULT_GPU_MEM if is_gpu else DEFAULT_CPU_MEM
    mem = _norm_mem(mem)
    storage = _norm_storage(storage)
    idx = alloc_index(state)
    g = {
        "name": name,
        "index": idx,
        "type": "gpu" if is_gpu else "cpu",
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
    }
    # pre-create the persistent home dir so it exists with sane perms before the
    # pod mounts it (kubelet DirectoryOrCreate would make it root-only).
    try:
        os.makedirs(f"{GROUP_DATA_ROOT}/{name}/home", exist_ok=True)
        os.chown(f"{GROUP_DATA_ROOT}/{name}/home", 1001, 1001)
    except OSError:
        pass
    apply_group(g)
    state["groups"][name] = g
    save_state(state)
    rewrite_frpc(state)
    reload_frpc()
    try:
        rewrite_nginx_web(state)
    except Exception as e:
        audit.record("nginx_web_sync_error", detail=str(e))
    audit.record("create_group", detail=name)
    return g


def remove_group(name):
    state = load_state()
    if name not in state["groups"]:
        raise ValueError(f"组 {name} 不存在")
    delete_group_k8s(name)
    del state["groups"][name]
    save_state(state)
    rewrite_frpc(state)
    reload_frpc()
    try:
        rewrite_nginx_web(state)
    except Exception as e:
        audit.record("nginx_web_sync_error", detail=str(e))
    # remove manifest file
    mp = os.path.join(MANIFEST_DIR, f"group-{name}.yaml")
    if os.path.exists(mp):
        os.remove(mp)
    # drop the persistent home dir (the group's /home/cloud data)
    shutil.rmtree(f"{GROUP_DATA_ROOT}/{name}", ignore_errors=True)
    # clean up per-group state in other modules so deleted groups don't linger
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
    # DB creds (mysql/redis/qdrant) labeled with this group
    try:
        import db_svc as _db
        for c in list(_db.list_creds()):
            if (c.get("label") or "").lower() == name.lower():
                try:
                    _db.remove_cred(c["id"])
                except Exception:
                    pass
    except Exception as e:
        logging.getLogger(__name__).warning("purge db_creds for %s: %s", name, e)
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
    changed = False
    if cpu is not None and cpu != g["cpu"]:
        g["cpu"] = cpu; changed = True
    if mem is not None and _norm_mem(mem) != g["mem"]:
        g["mem"] = _norm_mem(mem); changed = True
    if storage is not None and _norm_storage(storage) != g.get("storage"):
        g["storage"] = _norm_storage(storage); changed = True
    if changed:
        apply_group(g)
        kubectl("rollout", "restart", f"deployment/group-{name}")
    save_state(state)
    audit.record("resize_group", detail=f"{name} cpu={g['cpu']} mem={g['mem']} storage={g.get('storage')}")
    return g


# --- per-pod environment variables (admin-managed) ---
import re as _re
_ENV_KEY_RE = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENV_RESERVED = {"CLOUD_PASSWORD", "NVIDIA_VISIBLE_DEVICES"}


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
        g["status"] = statuses.get(g["name"], "NotFound")
        groups.append(g)
    return groups, state


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
    """Owner directly invites a user as member."""
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
    """Owner promotes a member (or any user) to co-owner."""
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
