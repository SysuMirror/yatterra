#!/usr/bin/env python3
"""Git-repo deploy into a group pod, supervised by supervisord.

State: /opt/yatterra/deploys.json (root 600).
Each group has a list of deploy records. "部署" clones/pulls the repo inside the
pod (as cloud), writes a supervisord [program:deploy-<id>] config (with the
group's DB/MinIO creds injected as env), and (re)starts it via supervisorctl.
supervisord runs in the pod (pip --user, persistent in /home/cloud) so deployed
services survive pod restart and auto-restart on crash. Logs go to logfiles in
~/deploy/<name>/logs/; the platform tails them on demand.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import shlex
import subprocess
import threading
import time
from urllib.parse import urlparse

import audit
import groups
import siteconf

STATE_FILE = siteconf.path("deploys.json")
WEBHOOK_CONF = siteconf.path("webhook.conf")
ALLOWED_HOSTS = ("github.com", "gitee.com")
CLONE_TIMEOUT = 180            # clone/pull cap (s)
LOG_TAIL = 400                 # lines returned by logs()
HEALTH_POLL_S = 2
HEALTH_DEFAULT_TIMEOUT = 60
MPS_TRAIN_COPERCENT = 35       # max active-thread % for training co-resident with serve (MPS)

SUPERVISORD_CONF = "/home/cloud/deploy/supervisord.conf"
PROGRAMS_DIR = "/home/cloud/deploy/programs"
DEPLOY_ROOT = "/home/cloud/deploy"

# base supervisord config (written into the pod as cloud)
_BASE_CONF = """[unix_http_server]
file=/home/cloud/deploy/supervisor.sock

[supervisord]
logfile=/home/cloud/deploy/supervisord.log
pidfile=/home/cloud/deploy/supervisord.pid
nodaemon=false

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///home/cloud/deploy/supervisor.sock

[include]
files = /home/cloud/deploy/programs/*.conf
"""


# --- state ---
def load():
    if not os.path.exists(STATE_FILE):
        return {"deploys": {}}
    try:
        with open(STATE_FILE) as f:
            d = json.load(f)
        if "deploys" not in d:
            d = {"deploys": {}}
        return d
    except Exception:
        return {"deploys": {}}


def save(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass


def list_for(group):
    return load().get("deploys", {}).get(group, [])


def get(group, did):
    for d in list_for(group):
        if d["id"] == did:
            return d
    return None


def _mutate(group, did, fn):
    state = load()
    deps = state.setdefault("deploys", {}).setdefault(group, [])
    for d in deps:
        if d["id"] == did:
            fn(d)
            save(state)
            return d
    return None


def add(group, spec):
    state = load()
    deps = state.setdefault("deploys", {}).setdefault(group, [])
    dep = {
        "id": secrets.token_hex(8),
        "name": spec["name"],
        "source": spec.get("source", "repo"),  # repo | local
        "script": spec.get("script", ""),      # local: pod 内脚本绝对路径
        "repo": spec["repo"],
        "branch": spec.get("branch", ""),
        "subdir": spec.get("subdir", ""),
        "token": spec.get("token", ""),
        "mode": spec.get("mode", "service"),   # service | oneshot (autorestart)
        "kind": spec.get("kind", "serve"),      # serve | train (scheduling class)
        "gpu": spec.get("gpu", ""),             # serve: pinned GPU id; train: ""
        "vram": spec.get("vram", ""),           # train: VRAM need in MiB (int)
        "auto_deploy": spec.get("auto_deploy", False),  # webhook push 触发
        "health": spec.get("health", ""),       # 健康检查路径,如 /health
        "health_timeout": spec.get("health_timeout", HEALTH_DEFAULT_TIMEOUT),
        "report_token": secrets.token_hex(16),  # pod app 上报鉴权
        "last_ref": "",                         # 当前部署的 git ref
        "last_good_ref": "",                    # 最近通过健康检查的 ref
        "report": None,                         # 最新 app 上报 {state,metrics,message,ts}
        "created": int(time.time()),
        "last_status": "pending",
        "last_msg": "",
    }
    deps.append(dep)
    save(state)
    return dep


def update(group, did, **fields):
    return _mutate(group, did, lambda d: d.update(fields))


def remove_record(group, did):
    state = load()
    deps = state.get("deploys", {}).get(group, [])
    state["deploys"][group] = [d for d in deps if d["id"] != did]
    save(state)


# --- validation / helpers ---
def validate_repo(url):
    u = (url or "").strip()
    if not u:
        return False, "仓库地址不能为空"
    if not u.startswith("https://"):
        return False, "仅支持 https:// 仓库地址"
    host = urlparse(u).hostname or ""
    if host not in ALLOWED_HOSTS:
        return False, f"仅支持 {', '.join(ALLOWED_HOSTS)} 仓库"
    return True, ""


# local 模式允许的脚本路径前缀(避免跑系统脚本)
_SCRIPT_PREFIXES = ("/home/cloud/", "/shared/")


def validate_script(path):
    """Validate a local deploy.sh path inside the pod. Returns (ok, msg)."""
    p = (path or "").strip()
    if not p:
        return False, "脚本路径不能为空"
    if not p.startswith("/"):
        return False, "脚本路径必须是绝对路径"
    if ".." in p.split("/"):
        return False, "路径不能含 .."
    if not any(p.startswith(pre) for pre in _SCRIPT_PREFIXES):
        return False, "脚本路径仅允许 /home/cloud/ 或 /shared/ 下"
    return True, ""


def normalize_repo(url):
    """Normalize a repo URL for matching: strip token, drop .git, lower host+path."""
    p = urlparse((url or "").strip())
    host = (p.hostname or "").lower()
    path = p.path or ""
    if path.endswith(".git"):
        path = path[:-4]
    return f"{host}{path}"


def load_webhook_secret():
    """Read (or lazily create) the webhook signing secret.

    Prefer env var WEBHOOK_SECRET, fallback to webhook.conf.
    """
    if os.environ.get("WEBHOOK_SECRET"):
        return os.environ["WEBHOOK_SECRET"]
    import configparser
    if not os.path.exists(WEBHOOK_CONF):
        try:
            with open(WEBHOOK_CONF, "w") as f:
                f.write("[webhook]\nsecret = %s\n" % secrets.token_hex(16))
            os.chmod(WEBHOOK_CONF, 0o600)
        except OSError:
            return ""
    try:
        cp = configparser.ConfigParser()
        cp.read(WEBHOOK_CONF)
        return cp.get("webhook", "secret", fallback="")
    except Exception:
        return ""


def verify_webhook(source, headers, body):
    """Verify a webhook callback signature. Returns True/False."""
    secret = load_webhook_secret()
    if not secret:
        return False
    if source == "github":
        sig = headers.get("X-Hub-Signature-256", "")
        if not sig.startswith("sha256="):
            return False
        mac = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, "sha256=" + mac)
    # gitee: X-Gitee-Token header carries the secret verbatim
    tok = headers.get("X-Gitee-Token", "")
    return bool(tok) and hmac.compare_digest(tok, secret)


def find_by_repo_branch(repo_url, branch):
    """Find all (group, dep) whose repo matches repo_url and branch matches.
    Only deploys with auto_deploy=True and a non-empty branch are eligible."""
    norm = normalize_repo(repo_url)
    out = []
    for group, deps in load().get("deploys", {}).items():
        for d in deps:
            if not d.get("auto_deploy"):
                continue
            if not (d.get("branch") or "").strip():
                continue
            if normalize_repo(d["repo"]) == norm and d["branch"] == branch:
                out.append((group, d))
    return out


def resolve_pod(group):
    """Resolve pod name for a group (uses batch cache, falls back to kubectl)."""
    name = groups.resolve_pod_name(group)
    if name:
        return name
    # cache miss — fallback to direct query
    r = groups.kubectl("get", "pod", "-l", f"app=group-{group}",
                       "-o", "jsonpath={.items[0].metadata.name}", check=False)
    if r.returncode != 0 or not r.stdout:
        return ""
    return r.stdout.strip()


def _clone_url(repo, token):
    if not token:
        return repo
    p = urlparse(repo)
    return f"https://{token}@{p.netloc}{p.path}"


# --- exec helpers (run as cloud inside the pod) ---
def _exec(group, as_cloud_cmd, input_text=None, timeout=60):
    """Run a command in the pod. as_cloud_cmd is a single shell string run via
    `su -l cloud -c`. Returns (rc, stdout, stderr)."""
    pod = resolve_pod(group)
    if not pod:
        raise RuntimeError("找不到 Pod")
    args = ["kubectl", "-n", groups.NS, "exec", "-i", pod,
            "--", "su", "-l", "cloud", "-c", as_cloud_cmd]
    r = subprocess.run(args, input=input_text, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def _supctl(group, *args, timeout=30):
    """Run supervisorctl as cloud. Returns (rc, stdout, stderr)."""
    inner = "~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf " + " ".join(args)
    return _exec(group, inner, timeout=timeout)


def _write_file(group, path, content, timeout=30):
    """Write a file in the pod as cloud via stdin -> cat > path."""
    inner = "cat > " + path
    rc, out, err = _exec(group, inner, input_text=content, timeout=timeout)
    if rc != 0:
        raise RuntimeError(f"写 {path} 失败: {(err or out).strip()}")


def _rm(group, path, timeout=30):
    _exec(group, f"rm -rf {path}", timeout=timeout)


def browse(group, path):
    """List entries at `path` in the pod as cloud. Returns {ok, entries, error}.
    entries: [{name, path, is_dir, is_exec}]. Never raises."""
    p = (path or "/home/cloud").strip() or "/home/cloud"
    norm = os.path.normpath(p)
    allowed = any(norm == pre.rstrip("/") or norm.startswith(pre) for pre in _SCRIPT_PREFIXES)
    if not allowed:
        return {"ok": False, "entries": [], "error": "仅允许浏览 /home/cloud/ 或 /shared/"}
    try:
        cmd = ("find %s -maxdepth 1 -mindepth 1 -printf '%%y\\t%%m\\t%%p\\n' 2>/dev/null"
               % shlex.quote(norm))
        rc, out, err = _exec(group, cmd, timeout=15)
    except Exception as e:
        return {"ok": False, "entries": [], "error": str(e)}
    if rc != 0 and not (out or "").strip():
        return {"ok": False, "entries": [], "error": (err or "").strip() or f"rc={rc}"}
    entries = []
    for line in (out or "").splitlines():
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        typ, perms, full = parts
        name = full.rsplit("/", 1)[-1]
        is_dir = typ == "d"
        try:
            is_exec = not is_dir and bool(int(perms, 8) & 0o111)
        except Exception:
            is_exec = False
        entries.append({"name": name, "path": full, "is_dir": is_dir, "is_exec": is_exec})
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"ok": True, "entries": entries, "error": ""}


# --- credential injection ---
def _env_for_group(group):
    """Build env dict for a group's deploy.sh: endpoints + matching creds.
    Creds are matched by label == group name (case-insensitive)."""
    env = {
        "PORT": "8080",
        "LOG_DIR": "/home/cloud/logs",
        "MINIO_ENDPOINT": f"http://{siteconf.MINIO_SERVICE}:9000",
        "MYSQL_HOST": siteconf.MYSQL_SERVICE,
        "MYSQL_PORT": "3306",
        "REDIS_HOST": siteconf.REDIS_SERVICE,
        "REDIS_PORT": "6379",
        "QDRANT_ENDPOINT": f"http://{siteconf.QDRANT_SERVICE}:6333",
        "QDRANT_GRPC": f"{siteconf.QDRANT_SERVICE}:6334",
        "SHARED_DIR": "/shared",
    }
    try:
        import db_svc
        for c in db_svc.list_creds():
            if (c.get("label") or "").lower() != group.lower():
                continue
            svc = c["service"]
            if svc == "mysql":
                env.update(MYSQL_USER=c["username"], MYSQL_PASSWORD=c["secret"],
                           MYSQL_DB=c["database"])
            elif svc == "redis":
                env.update(REDIS_USER=c["username"], REDIS_PASSWORD=c["secret"],
                           REDIS_PREFIX=c["prefix"])
            elif svc == "qdrant":
                env.update(QDRANT_API_KEY=c["secret"], QDRANT_PREFIX=c["prefix"])
    except Exception:
        pass
    try:
        import minio_svc
        for k in minio_svc.list_keys():
            if (k.get("label") or "").lower() != group.lower():
                continue
            env.update(MINIO_ACCESS_KEY=k["access_key"], MINIO_SECRET=k["secret"],
                       MINIO_BUCKET=k["bucket"])
    except Exception:
        pass
    # group identity / public URL / resource limits (best-effort: a missing or
    # malformed group record must never break deploys). Does not clobber any
    # existing key (endpoints/creds win on name collision).
    try:
        g = groups.load_state().get("groups", {}).get(group)
        if g:
            gpus = g.get("gpus") or []
            web_public = g.get("web_public")
            ssh_public = g.get("ssh_public")
            _extra = {
                "GROUP_NAME": group,
                "GROUP_TYPE": str(g.get("type", "")),
                "GPU_IDS": ",".join(map(str, gpus)),
                "GPU_COUNT": str(len(gpus)),
                "PUBLIC_HOST": siteconf.PUBLIC_HOST,
                "PUBLIC_PORT": str(web_public or ""),
                "PUBLIC_SSH_PORT": str(ssh_public or ""),
                "CPU_LIMIT": str(g.get("cpu", "")),
                "MEM_LIMIT": str(g.get("mem", "")),
                "PLATFORM_URL": siteconf.PLATFORM_URL,
            }
            if web_public:
                _extra["PUBLIC_URL"] = siteconf.public_url(web_public)
            for k, v in _extra.items():
                if k not in env:
                    env[k] = v
            # merge group-level env (app-specific vars like UNISSO_SECRET_KEY)
            for k, v in (g.get("env") or {}).items():
                env[k] = str(v)
    except Exception:
        pass
    # host facts (best-effort; never break deploys)
    try:
        import socket as _sock
        host = {
            "HOST_NAME": _sock.gethostname(),
            "HOST_KERNEL": subprocess.run(
                ["uname", "-r"], capture_output=True, text=True, timeout=3).stdout.strip(),
            "HOST_CPU_COUNT": str(os.cpu_count() or ""),
        }
        try:
            mem = subprocess.run(["free", "-m"], capture_output=True, text=True, timeout=3)
            for line in (mem.stdout or "").splitlines():
                if line.startswith("Mem:"):
                    host["HOST_MEM_MB"] = line.split()[1]
                    break
        except Exception:
            pass
        try:
            gm = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=6)
            names, mtot = [], []
            for line in (gm.stdout or "").splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2:
                    names.append(parts[0])
                    mtot.append(parts[1])
            if names:
                host["GPU_MODELS"] = ",".join(names)
                host["GPU_MEM_TOTAL_MB"] = ",".join(mtot)
        except Exception:
            pass
        for k, v in host.items():
            if k not in env:
                env[k] = v
    except Exception:
        pass
    return env


def _scheduling_ctx(dep, env):
    """Build the scheduling block for context.json from the alloc table."""
    base = {"model": "pooled", "kind": (dep.get("kind") or "serve").lower()}
    try:
        import scheduler
        rec = scheduler.get(dep["id"])
        if rec:
            base["gpu"] = rec.get("gpu")
            base["status"] = rec.get("status")
            base["preemptable"] = base["kind"] == "train"
        if base["kind"] == "train":
            base["vram_mb"] = dep.get("vram") or scheduler.DEFAULT_TRAIN_VRAM_MB
            base["ckpt_dir"] = env.get("CKPT_DIR", "")
            base["ckpt_bucket"] = env.get("CKPT_BUCKET", "")
            base["resume"] = env.get("RESUME") == "true"
        else:
            base["pinned_gpu"] = dep.get("gpu")
    except Exception:
        pass
    return base


def _write_context_json(group, dep, env):
    """Write a structured JSON context file to /home/cloud/deploy/context.json
    inside the pod. Best-effort: never raises — a failure here must not break a
    deploy run. Built from the same group record + env used for the program conf."""
    try:
        g = groups.load_state().get("groups", {}).get(group) or {}
        gpus = g.get("gpus") or []
        web_public = g.get("web_public")
        ssh_public = g.get("ssh_public")
        ctx = {
            "group": group,
            "type": g.get("type", ""),
            "gpus": gpus,
            "public": {
                "host": siteconf.PUBLIC_HOST,
                "web_port": web_public,
                "web_url": siteconf.public_url(web_public) if web_public else "",
                "ssh_port": ssh_public,
            },
            "resources": {
                "cpu": g.get("cpu", ""),
                "memory": g.get("mem", ""),
                "gpu_count": len(gpus),
            },
            "platform": {
                "url": siteconf.PLATFORM_URL,
                "shared_dir": env.get("SHARED_DIR", "/shared"),
            },
            "host": {
                "name": env.get("HOST_NAME", ""),
                "kernel": env.get("HOST_KERNEL", ""),
                "cpu_count": env.get("HOST_CPU_COUNT", ""),
                "mem_mb": env.get("HOST_MEM_MB", ""),
                "gpu_models": (env.get("GPU_MODELS", "") or "").split(",") if env.get("GPU_MODELS") else [],
                "gpu_mem_total_mb": (env.get("GPU_MEM_TOTAL_MB", "") or "").split(",") if env.get("GPU_MEM_TOTAL_MB") else [],
            },
            "services": {
                "mysql": {
                    "host": env.get("MYSQL_HOST", ""),
                    "port": env.get("MYSQL_PORT", ""),
                    "database": env.get("MYSQL_DB", ""),
                },
                "minio": {
                    "endpoint": env.get("MINIO_ENDPOINT", ""),
                    "bucket": env.get("MINIO_BUCKET", ""),
                },
                "redis": {
                    "host": env.get("REDIS_HOST", ""),
                    "port": env.get("REDIS_PORT", ""),
                },
                "qdrant": {
                    "endpoint": env.get("QDRANT_ENDPOINT", ""),
                    "grpc": env.get("QDRANT_GRPC", ""),
                },
            },
            "scheduling": _scheduling_ctx(dep, env),
            "logging": {
                "dir": "/home/cloud/logs",
                "pattern": "*.log",
                "hint": "应用可将日志写到此目录，平台自动收集展示",
            },
        }
        _write_file(group, "/home/cloud/deploy/context.json",
                    json.dumps(ctx, indent=2, sort_keys=True))
    except Exception:
        pass


def _write_deploy_json(group, dep, env):
    """Write per-deploy info to /home/cloud/deploy/deploy-<id>.json (best-effort).
    The app reads this to know who it is, where to report, and its public URL."""
    try:
        g = groups.load_state().get("groups", {}).get(group) or {}
        web_public = g.get("web_public")
        d = {
            "id": dep["id"],
            "name": dep["name"],
            "repo": dep["repo"],
            "branch": dep.get("branch", ""),
            "ref": dep.get("last_ref", ""),
            "kind": dep.get("kind", "serve"),
            "mode": dep.get("mode", "service"),
            "port": env.get("PORT", "8080"),
            "public_url": siteconf.public_url(web_public) if web_public else "",
            "report_url": env.get("REPORT_URL", ""),
            "report_token": env.get("REPORT_TOKEN", ""),
            "health": dep.get("health", ""),
            "created": dep.get("created", 0),
        }
        _write_file(group, f"/home/cloud/deploy/deploy-{dep['id']}.json",
                    json.dumps(d, indent=2, sort_keys=True))
    except Exception:
        pass


def _program_conf(dep, env):
    pid, name = dep["id"], dep["name"]
    subdir = (dep.get("subdir") or "").strip()
    mode = dep.get("mode", "service")
    source = dep.get("source", "repo")
    autorestart = "true" if mode == "service" else "false"
    env_str = ",".join(f'{k}="{v}"' for k, v in env.items())
    if source == "local":
        script = (dep.get("script") or "").strip()
        workdir = script.rsplit("/", 1)[0] or "/home/cloud"
        command = f"bash {script}"
    else:
        workdir = f"/home/cloud/deploy/{name}" + (f"/{subdir}" if subdir else "")
        command = f"bash {workdir}/deploy.sh"
    return f"""[program:deploy-{pid}]
command={command}
directory={workdir}
autostart=true
autorestart={autorestart}
startsecs=3
stopasgroup=true
killasgroup=true
stdout_logfile=/home/cloud/deploy/{name}/logs/stdout.log
stdout_logfile_maxbytes=2MB
stdout_logfile_backups=3
stderr_logfile=/home/cloud/deploy/{name}/logs/stderr.log
stderr_logfile_maxbytes=2MB
stderr_logfile_backups=3
environment={env_str}
"""


# --- clone/pull (bash via base64 to avoid shell quoting) ---
def _clone_script(dep):
    name = dep["name"]
    source = dep.get("source", "repo")
    if source == "local":
        script = (dep.get("script") or "").strip()
        return f"""set -e
test -x {script} || {{ echo "【未找到可执行脚本 {script}】"; exit 1; }}
echo "【脚本就绪 {script}】\""""
    repo = _clone_url(dep["repo"], dep.get("token", ""))
    branch = (dep.get("branch") or "").strip()
    subdir = (dep.get("subdir") or "").strip()
    clone_branch = f"-b {branch}" if branch else ""
    if branch:
        fetch_reset = f"git fetch --all && git reset --hard origin/{branch} && git clean -fd -- web/dist server/dist"
    else:
        fetch_reset = "git fetch --all && git reset --hard origin/$(git rev-parse --abbrev-ref HEAD) && git clean -fd -- web/dist server/dist"
    target = f"{name}/{subdir}" if subdir else name
    return f"""set -e
mkdir -p ~/deploy && cd ~/deploy
if [ -d {name}/.git ]; then
  cd {name} && {fetch_reset} && cd ..
else
  git clone --depth 1 {clone_branch} {repo} {name}
fi
cd {target}
test -x ./deploy.sh || {{ echo "【仓库未找到可执行 deploy.sh】"; exit 1; }}
echo "【clone 完成,deploy.sh 就绪】\""""


def _ensure_supervisor(group):
    """Ensure supervisord conf exists and supervisord is running in the pod."""
    # write base conf if missing
    rc, out, err = _exec(group, "test -e ~/deploy/supervisord.conf && echo yes || echo no", timeout=15)
    if "no" in (out or ""):
        _write_file(group, "~/deploy/supervisord.conf", _BASE_CONF)
    # start supervisord if not running
    rc, out, err = _supctl(group, "status", timeout=10)
    if rc != 0:
        # not running — start it (entrypoint usually does, but be safe)
        _exec(group, "~/.local/bin/supervisord -c ~/deploy/supervisord.conf", timeout=15)
        time.sleep(1)


# --- public ops ---
def _current_ref(group, dep):
    """Capture the deployed git ref (HEAD) inside the pod. Best-effort."""
    name = dep["name"]
    subdir = (dep.get("subdir") or "").strip()
    target = f"~/deploy/{name}" + (f"/{subdir}" if subdir else "")
    try:
        rc, out, err = _exec(group, f"git -C {target} rev-parse HEAD 2>/dev/null", timeout=10)
        if rc == 0:
            return out.strip()
    except Exception:
        pass
    return ""


def _health_probe(group, dep, env):
    """One HTTP health probe inside the pod (curl localhost:$PORT<health>).
    Returns True if 2xx."""
    port = env.get("PORT", "8080")
    path = (dep.get("health") or "/").strip() or "/"
    cmd = f"curl -sf -m 3 -o /dev/null http://127.0.0.1:{port}{path}"
    try:
        rc, out, err = _exec(group, cmd, timeout=8)
        return rc == 0
    except Exception:
        return False


def _rollback(group, dep, env):
    """Reset the repo to last_good_ref and restart the program. Returns (ok, msg)."""
    good = dep.get("last_good_ref", "")
    if not good:
        return False, "无 last_good_ref,无法回滚"
    name = dep["name"]
    subdir = (dep.get("subdir") or "").strip()
    target = f"~/deploy/{name}" + (f"/{subdir}" if subdir else "")
    try:
        _exec(group, f"git -C {target} reset --hard -q {good}", timeout=30)
    except Exception as e:
        return False, f"reset 失败: {e}"
    update(group, dep["id"], last_ref=good)
    _write_deploy_json(group, dep, env)
    prog = f"deploy-{dep['id']}"
    _supctl(group, "restart", prog, timeout=30)
    return True, f"已回滚到 {good[:12]}"


def _health_gate(group, dep, env):
    """After start, wait for readiness. Pass if HTTP probe ok OR app reports
    state=ready within timeout. On pass: last_good_ref=last_ref. On fail: rollback.
    Returns (ok, msg)."""
    timeout = int(dep.get("health_timeout") or HEALTH_DEFAULT_TIMEOUT)
    deadline = time.time() + timeout
    dep_id = dep["id"]
    while time.time() < deadline:
        if _health_probe(group, dep, env):
            update(group, dep_id, last_good_ref=dep.get("last_ref", ""))
            return True, "健康检查通过"
        # also accept an app self-report of state=ready
        r = get(group, dep_id) or {}
        rep = r.get("report") or {}
        if (rep.get("state") or "").lower() == "ready":
            update(group, dep_id, last_good_ref=dep.get("last_ref", ""))
            return True, "app 上报 ready"
        time.sleep(HEALTH_POLL_S)
    # failed — rollback if we have a good ref
    good = (get(group, dep_id) or {}).get("last_good_ref", "")
    if good:
        ok, msg = _rollback(group, dep, env)
        audit.record("deploy_rollback", detail=f"{group}/{dep['name']} ref={dep.get('last_ref','')[:12]} -> {good[:12]}", actor="platform")
        return False, f"健康检查未通过,已回滚: {msg}"
    return False, "健康检查未通过(无 last_good_ref 可回滚)"


def run(group, dep):
    """Clone/pull, (re)write program conf, (re)start via supervisorctl.
    Returns (ok, msg)."""
    if groups.pod_status(group) != "Running":
        msg = "Pod 未运行"
        update(group, dep["id"], last_status="failed", last_msg=msg)
        return False, msg
    try:
        _ensure_supervisor(group)
    except Exception as e:
        msg = f"supervisord 未就绪: {e}"
        update(group, dep["id"], last_status="failed", last_msg=msg)
        return False, msg

    # 1) clone/pull
    script = _clone_script(dep)
    b64 = base64.b64encode(script.encode()).decode()
    try:
        rc, out, err = _exec(group, "echo %s | base64 -d | bash" % b64, timeout=CLONE_TIMEOUT)
    except subprocess.TimeoutExpired:
        msg = f"clone 超时(>{CLONE_TIMEOUT}s)"
        update(group, dep["id"], last_status="failed", last_msg=msg)
        return False, msg
    clone_out = (out + err).strip()
    if rc != 0:
        msg = f"clone 失败: {clone_out[-500:]}"
        update(group, dep["id"], last_status="failed", last_msg=msg)
        return False, msg

    # 2) write program conf
    env = _env_for_group(group)
    _per_deploy_env(dep, env)
    # 2a) GPU placement + scheduling-class / checkpoint env
    try:
        import scheduler
        kind = (dep.get("kind") or "serve").lower()
        gpu = scheduler.gpu_for_deploy(dep, group)
        if gpu is not None:
            env["CUDA_VISIBLE_DEVICES"] = str(gpu)
            # MPS: dynamic cap when training co-resident with a serve deploy
            if kind == "train" and gpu in scheduler.serve_gpus():
                pct = scheduler.mps_target_percent(gpu)
                env["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] = str(pct)
                scheduler.set_mps_pct(dep["id"], pct)
        env["KIND"] = kind
        env["CKPT_DIR"] = f"/home/cloud/ckpt/{dep['name']}"
        env["CKPT_BUCKET"] = env.get("MINIO_BUCKET", "")
        env["CKPT_KEY"] = f"deploys/{dep['id']}/ckpt"
        env["RESUME"] = "true" if dep.get("resume") else "false"
        if dep.get("vram"):
            env["TRAIN_VRAM_MB"] = str(dep["vram"])
    except Exception:
        pass

    # 2a.1) capture deployed git ref
    ref = _current_ref(group, dep)
    if ref:
        update(group, dep["id"], last_ref=ref)
        dep["last_ref"] = ref
        env["DEPLOY_REF"] = ref

    # ensure log dir exists (supervisord refuses to load conf if logfile dir is missing)
    _exec(group, f"mkdir -p ~/deploy/{dep['name']}/logs", timeout=10)

    try:
        _write_file(group, f"~/deploy/programs/deploy-{dep['id']}.conf", _program_conf(dep, env))
    except Exception as e:
        msg = f"写 program 配置失败: {e}"
        update(group, dep["id"], last_status="failed", last_msg=msg)
        return False, msg

    # 2b) write structured context.json + per-deploy deploy.json (best-effort)
    _write_context_json(group, dep, env)
    _write_deploy_json(group, dep, env)

    # 2c) symlink deploy logs into /home/cloud/logs/ (best-effort)
    try:
        _exec(group, "mkdir -p /home/cloud/logs", timeout=10)
        _exec(group, f"ln -sf /home/cloud/deploy/{dep['name']}/logs/stdout.log /home/cloud/logs/deploy-{dep['name']}.log", timeout=10)
        _exec(group, f"ln -sf /home/cloud/deploy/{dep['name']}/logs/stderr.log /home/cloud/logs/deploy-{dep['name']}.error.log", timeout=10)
    except Exception:
        pass

    # 3) reread + update + (re)start
    _supctl(group, "reread", timeout=15)
    _supctl(group, "update", timeout=15)
    prog = f"deploy-{dep['id']}"
    rc, out, err = _supctl(group, "restart", prog, timeout=30)
    # restart may fail if not running yet; try start
    if rc != 0:
        rc, out, err = _supctl(group, "start", prog, timeout=30)
    sup_out = (out + err).strip()
    started = rc == 0

    # 4) health gate + rollback (only if health path configured)
    gate_msg = ""
    if started and (dep.get("health") or "").strip():
        # re-read latest dep (last_ref updated above) for the gate
        dep = get(group, dep["id"]) or dep
        gok, gate_msg = _health_gate(group, dep, env)
        if gok:
            ok = True
            msg = (clone_out + "\n" + sup_out + "\n" + gate_msg).strip()
            update(group, dep["id"], last_status="ok", last_msg=msg[-1000:])
            audit.record("deploy_run", detail=f"{group}/{dep['name']} id={dep['id']} ok=True health=pass", module="deploys")
            return True, msg
        else:
            ok = False
            msg = (clone_out + "\n" + sup_out + "\n" + gate_msg).strip()
            update(group, dep["id"], last_status="rolled_back" if dep.get("last_good_ref") else "failed", last_msg=msg[-1000:])
            audit.record("deploy_run", detail=f"{group}/{dep['name']} id={dep['id']} ok=False health=fail", module="deploys")
            return False, msg

    ok = started
    msg = (clone_out + "\n" + sup_out + "\n" + gate_msg).strip()
    update(group, dep["id"], last_status="ok" if ok else "failed", last_msg=msg[-1000:])
    audit.record("deploy_run", detail=f"{group}/{dep['name']} id={dep['id']} ok={ok}", module="deploys")
    return ok, msg


def _build_env(group, dep, gpu=None, resume=False):
    """Build the full env dict for a deploy's supervisord program, including
    GPU placement + scheduling/ckpt vars. Used by run() and migrate()."""
    env = _env_for_group(group)
    _per_deploy_env(dep, env)
    try:
        import scheduler
        kind = (dep.get("kind") or "serve").lower()
        if gpu is None:
            gpu = scheduler.gpu_for_deploy(dep, group)
        if gpu is not None:
            env["CUDA_VISIBLE_DEVICES"] = str(gpu)
            # MPS: dynamic cap when training co-resident with a serve deploy
            if kind == "train" and gpu in scheduler.serve_gpus():
                pct = scheduler.mps_target_percent(gpu)
                env["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] = str(pct)
                scheduler.set_mps_pct(dep["id"], pct)
        env["KIND"] = kind
        env["CKPT_DIR"] = f"/home/cloud/ckpt/{dep['name']}"
        env["CKPT_BUCKET"] = env.get("MINIO_BUCKET", "")
        env["CKPT_KEY"] = f"deploys/{dep['id']}/ckpt"
        env["RESUME"] = "true" if resume else "false"
        if dep.get("vram"):
            env["TRAIN_VRAM_MB"] = str(dep["vram"])
    except Exception:
        pass
    return env


def _per_deploy_env(dep, env):
    """Per-deploy identity + uplink report env. Does not clobber existing keys."""
    _d = {
        "DEPLOY_ID": dep["id"],
        "DEPLOY_NAME": dep["name"],
        "DEPLOY_REF": dep.get("last_ref", ""),
        "DEPLOY_BRANCH": dep.get("branch", ""),
        "REPORT_URL": siteconf.PLATFORM_URL + "/deploy-internal/report",
        "REPORT_TOKEN": dep.get("report_token", ""),
    }
    for k, v in _d.items():
        if k not in env:
            env[k] = v
    # per-deploy custom env (dep["env"] dict in deploys.json) — overrides defaults
    for k, v in (dep.get("env") or {}).items():
        env[k] = str(v)


def _restart_with_env(group, dep, env):
    """Rewrite program conf with env, reread/update/restart. Returns (ok, msg)."""
    try:
        _ensure_supervisor(group)
    except Exception as e:
        return False, f"supervisord 未就绪: {e}"
    try:
        _write_file(group, f"~/deploy/programs/deploy-{dep['id']}.conf",
                    _program_conf(dep, env))
    except Exception as e:
        return False, f"写 program 配置失败: {e}"
    _write_context_json(group, dep, env)
    _supctl(group, "reread", timeout=15)
    _supctl(group, "update", timeout=15)
    prog = f"deploy-{dep['id']}"
    rc, out, err = _supctl(group, "restart", prog, timeout=30)
    if rc != 0:
        rc, out, err = _supctl(group, "start", prog, timeout=30)
    ok = rc == 0
    update(group, dep["id"], last_status="ok" if ok else "failed",
           last_msg=(out + err).strip()[-500:])
    return ok, (out + err).strip()


def migrate(group, dep, new_gpu):
    """Move a running train deploy to new_gpu with RESUME=true (checkpoint
    contract: deploy.sh saves on SIGTERM, loads on start when RESUME=true)."""
    env = _build_env(group, dep, gpu=new_gpu, resume=True)
    ok, msg = _restart_with_env(group, dep, env)
    audit.record("deploy_migrate", detail=f"{group}/{dep['name']} -> gpu{new_gpu} ok={ok}",
                 actor="scheduler")
    return ok, msg


def restart_with_mps(group, dep, gpu, mps_pct):
    """Restart a co-located train in-place with a new MPS compute cap (RESUME=true).
    Used by gpu_loop dynamic MPS rebalance — does NOT change GPU, only the % cap."""
    env = _build_env(group, dep, gpu=gpu, resume=True)
    env["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] = str(mps_pct)
    ok, msg = _restart_with_env(group, dep, env)
    try:
        import scheduler
        scheduler.set_mps_pct(dep["id"], mps_pct)
    except Exception:
        pass
    audit.record("deploy_mps_rebalance",
                 detail=f"{group}/{dep['name']} gpu{gpu} mps={mps_pct}% ok={ok}",
                 actor="scheduler")
    return ok, msg


def park(group, dep):
    """Stop a train deploy's program but keep it as queued (not released) so the
    scheduler loop can re-place it when a GPU frees. Used for eviction."""
    try:
        _supctl(group, "stop", f"deploy-{dep['id']}", timeout=20)
    except Exception:
        pass
    try:
        import scheduler
        scheduler.mark(dep["id"], "queued", gpu=None)
    except Exception:
        pass
    update(group, dep["id"], last_status="queued",
           last_msg="推理压力,已退让排队(已 checkpoint)")


def stop(group, dep):
    """Stop the supervised program."""
    try:
        _supctl(group, "stop", f"deploy-{dep['id']}", timeout=20)
        update(group, dep["id"], last_status="stopped")
        return True, "已停止"
    except Exception as e:
        return False, str(e)
    finally:
        try:
            import scheduler
            # serve stays pinned (keep alloc); train releases its GPU
            if (dep.get("kind") or "serve").lower() == "train":
                scheduler.release(dep["id"])
        except Exception:
            pass


def delete(group, dep):
    """Stop, remove program conf + repo dir, reread/update."""
    pid = dep["id"]
    name = dep["name"]
    try:
        _supctl(group, "stop", f"deploy-{pid}", timeout=20)
    except Exception:
        pass
    try:
        import scheduler
        scheduler.release(pid)
    except Exception:
        pass
    _rm(group, f"~/deploy/programs/deploy-{pid}.conf")
    # local 模式不删用户应用目录,只清 program conf;repo 模式删 clone 下来的仓库目录
    if (dep.get("source") or "repo") != "local":
        _rm(group, f"~/deploy/{name}")
    try:
        _supctl(group, "reread", timeout=15)
        _supctl(group, "update", timeout=15)
    except Exception:
        pass
    remove_record(group, pid)


def status(group, dep_id):
    """Live state from supervisorctl. Returns {state, raw, pill}."""
    try:
        rc, out, err = _supctl(group, "status", f"deploy-{dep_id}", timeout=10)
    except Exception as e:
        return {"state": "unknown", "raw": str(e), "pill": "neutral"}
    text = (out + err).strip()
    low = text.lower()
    if "no such" in low or "not running" in low or "not found" in low:
        return {"state": "unloaded", "raw": text, "pill": "neutral"}
    for st, pill in (("RUNNING", "ok"), ("STARTING", "warn"), ("BACKOFF", "warn"),
                     ("STOPPING", "warn"), ("FATAL", "bad"), ("EXITED", "neutral"),
                     ("STOPPED", "neutral"), ("UNKNOWN", "neutral")):
        if st in text:
            return {"state": st.lower(), "raw": text, "pill": pill}
    return {"state": "unknown", "raw": text, "pill": "neutral"}


def logs(group, dep, lines=LOG_TAIL):
    """Tail stdout+stderr logfiles from the pod."""
    name = dep["name"]
    cmd = (f"tail -n {lines} ~/deploy/{name}/logs/stdout.log ~/deploy/{name}/logs/stderr.log 2>/dev/null "
           f"|| echo '(无日志)'")
    try:
        rc, out, err = _exec(group, cmd, timeout=15)
        return (out + err).strip() or "(无日志)"
    except Exception as e:
        return f"(取日志失败: {e})"


def stream_logs(group, dep):
    """Generator yielding log lines (SSE data) from `tail -f` in the pod.
    Yields keepalive comments when idle. Kills the subprocess on generator close."""
    name = dep["name"]
    pod = resolve_pod(group)
    if not pod:
        yield "data: (找不到 Pod)\n\n"
        return
    cmd = (f"tail -n 200 -f ~/deploy/{name}/logs/stdout.log ~/deploy/{name}/logs/stderr.log 2>/dev/null")
    args = ["kubectl", "-n", groups.NS, "exec", "-i", pod,
            "--", "su", "-l", "cloud", "-c", cmd]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    last = time.time()
    try:
        while True:
            line = proc.stdout.readline()
            if line:
                yield "data: " + line.rstrip() + "\n\n"
                last = time.time()
            else:
                if time.time() - last > 10:
                    yield ": keepalive\n\n"
                    last = time.time()
                if proc.poll() is not None:
                    yield "data: (日志流结束)\n\n"
                    return
                time.sleep(0.2)
    finally:
        try:
            proc.kill()
        except Exception:
            pass


def record_report(deploy_id, token, state, metrics=None, message=None):
    """Store an app self-report on its deploy record. Token must match.
    Returns (ok, msg)."""
    for group, deps in load().get("deploys", {}).items():
        for d in deps:
            if d["id"] == deploy_id and d.get("report_token") == token:
                update(group, deploy_id, report={
                    "state": state, "metrics": metrics or "",
                    "message": message or "", "ts": int(time.time()),
                })
                return True, "ok"
    return False, "deploy_id/token 不匹配"
