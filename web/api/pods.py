#!/usr/bin/env python3
"""Pod API Blueprint — /api/pods

REST API for pod/group management. Token-authed, JSON in/out.
Mounted at /api/pods via Flask Blueprint.
Re-uses auth helpers (api_auth, api_pod, _actor, _body) from the api package.
"""
import os, subprocess, time, shlex, codecs, select, base64, json
from importlib import import_module
from flask import Blueprint, request, jsonify, g, Response

import siteconf
users = import_module("users")
import groups, lifecycle, audit, deploys
import minio_svc as minio_mod
import db_svc as db_mod
import cpu_stats, gpu_stats, metrics

from api._auth import require_auth, require_pod, current_username as _actor_fn
from api import _body

# Credential-card enrichment: the SPA CredentialCard expects host/port/user/password
# (minio: access_key/secret_key), but db_svc/minio_svc store username/secret only.
_SVC_ENDPOINTS = {
    "mysql": ("mysql.platform-infra.svc.cluster.local", 3306),
    "redis": ("redis.platform-infra.svc.cluster.local", 6379),
    "qdrant": ("qdrant.platform-infra.svc.cluster.local", 6333),
}

def _db_cred_card(c):
    host, port = _SVC_ENDPOINTS.get(c.get("service"), ("", 0))
    out = dict(c)
    out["host"] = host
    out["port"] = port
    out["user"] = c.get("username", "")
    out["password"] = c.get("secret", "")
    return out

def _minio_cred_card(k):
    out = dict(k)
    out["host"] = "minio.platform-infra.svc.cluster.local"
    out["port"] = 9000
    out["secret_key"] = k.get("secret", "")
    return out


# Compatibility aliases — map old decorators to new session-aware ones
def api_auth(perm=None):
    return require_auth(perm)
def api_pod(level="member"):
    return require_pod(level)
def _actor():
    return _actor_fn() or g.api_user.get("username", "unknown")

def _parse_health_timeout(value):
    try:
        text = str(value).strip()
        if not text or not text.isdigit():
            raise ValueError
        timeout = int(text)
    except (TypeError, ValueError):
        from middleware.error_handler import bad_request
        raise bad_request("health_timeout must be an integer between 1 and 3600 seconds")
    if not 1 <= timeout <= 3600:
        from middleware.error_handler import bad_request
        raise bad_request("health_timeout must be an integer between 1 and 3600 seconds")
    return timeout

pods_bp = Blueprint("pods", __name__, url_prefix="/api/pods")

# ── Quickstart templates (mirrored from app.py) ───────────────
_TEMPLATES = {
    "flask": {
        "name": "flask-app",
        "files": {
            "app.py": """from flask import Flask, jsonify, request
import os, logging, time

# --- 平台日志: 写到 LOG_DIR，平台自动收集展示 ---
LOG_DIR = os.environ.get('LOG_DIR', '/home/cloud/logs')
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, 'app.log'), encoding='utf-8'),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger('flask-app')

app = Flask(__name__)
start_time = time.time()

@app.route('/')
def hello():
    log.info('GET / from %s', request.remote_addr)
    # 展示平台注入的环境变量，帮助用户了解可用服务
    platform_env = {k: os.environ.get(k, '') for k in [
        'PORT', 'LOG_DIR', 'DEPLOY_ID', 'DEPLOY_NAME',
        'MINIO_ENDPOINT', 'MINIO_BUCKET',
        'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DB',
        'REDIS_HOST', 'REDIS_PORT',
        'QDRANT_ENDPOINT',
        'CUDA_VISIBLE_DEVICES',
    ]}
    return jsonify({
        'status': 'ok',
        'uptime': round(time.time() - start_time, 1),
        'platform': {k: v for k, v in platform_env.items() if v},
    })

@app.route('/health')
def health():
    return jsonify({'health': 'ok'})

if __name__ == '__main__':
    log.info('Flask starting on port %s', os.environ.get('PORT', '8080'))
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
""",
            "requirements.txt": "flask\n",
            "deploy.sh": """#!/bin/bash
set -e
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/bin/pip install -q -r requirements.txt
.venv/bin/python app.py
""",
        },
    },
    "fastapi": {
        "name": "fastapi-app",
        "files": {
            "main.py": """from fastapi import FastAPI, Request
import os, logging, time

# --- 平台日志: 写到 LOG_DIR，平台自动收集展示 ---
LOG_DIR = os.environ.get('LOG_DIR', '/home/cloud/logs')
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, 'app.log'), encoding='utf-8'),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger('fastapi-app')

app = FastAPI()
start_time = time.time()

@app.get('/')
async def root(request: Request):
    log.info('GET / from %s', request.client.host if request.client else '?')
    platform_env = {k: os.environ.get(k, '') for k in [
        'PORT', 'LOG_DIR', 'DEPLOY_ID', 'DEPLOY_NAME',
        'MINIO_ENDPOINT', 'MINIO_BUCKET',
        'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DB',
        'REDIS_HOST', 'REDIS_PORT',
        'QDRANT_ENDPOINT',
        'CUDA_VISIBLE_DEVICES',
    ]}
    return {
        'status': 'ok',
        'uptime': round(time.time() - start_time, 1),
        'platform': {k: v for k, v in platform_env.items() if v},
    }

@app.get('/health')
async def health():
    return {'health': 'ok'}

if __name__ == '__main__':
    import uvicorn
    log.info('FastAPI starting on port %s', os.environ.get('PORT', '8080'))
    uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
""",
            "requirements.txt": "fastapi\nuvicorn\n",
            "deploy.sh": """#!/bin/bash
set -e
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/bin/pip install -q -r requirements.txt
.venv/bin/python main.py
""",
        },
    },
    "node": {
        "name": "node-app",
        "files": {
            "server.js": """const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 8080;
const startTime = Date.now();

// --- 平台日志: 写到 LOG_DIR，平台自动收集展示 ---
const logDir = process.env.LOG_DIR || '/home/cloud/logs';
fs.mkdirSync(logDir, {recursive: true});
const logStream = fs.createWriteStream(path.join(logDir, 'app.log'), {flags: 'a'});
function log(level, msg) {
  const line = new Date().toISOString() + ' [' + level + '] ' + msg + '\\n';
  process.stdout.write(line);
  logStream.write(line);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({health: 'ok'}));
    return;
  }
  log('INFO', req.method + ' ' + req.url + ' from ' + req.socket.remoteAddress);
  // 展示平台环境变量
  const platformKeys = [
    'PORT','LOG_DIR','DEPLOY_ID','DEPLOY_NAME',
    'MINIO_ENDPOINT','MINIO_BUCKET',
    'MYSQL_HOST','MYSQL_PORT','MYSQL_DB',
    'REDIS_HOST','REDIS_PORT',
    'QDRANT_ENDPOINT','CUDA_VISIBLE_DEVICES',
  ];
  const platform = {};
  platformKeys.forEach(k => { if (process.env[k]) platform[k] = process.env[k]; });
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({
    status: 'ok',
    uptime: Math.round((Date.now() - startTime) / 1000 * 10) / 10,
    platform,
  }));
});
server.listen(port, '0.0.0.0', () => log('INFO', 'Server on port ' + port));
""",
            "deploy.sh": """#!/bin/bash
set -e
node server.js
""",
        },
    },
    "streamlit": {
        "name": "streamlit-app",
        "files": {
            "app.py": """import streamlit as st
import os, logging, time

# --- 平台日志: 写到 LOG_DIR，平台自动收集展示 ---
LOG_DIR = os.environ.get('LOG_DIR', '/home/cloud/logs')
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, 'app.log'), encoding='utf-8'),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger('streamlit-app')
log.info('Streamlit app starting')

st.title('Hello from ' + os.environ.get('DEPLOY_NAME', os.environ.get('GROUP_NAME', 'Pod')))
st.write('This is a Streamlit app running on sseinfra platform.')

# 展示平台环境变量
with st.expander('Platform Env', expanded=False):
    platform_keys = [
        'PORT','LOG_DIR','DEPLOY_ID','DEPLOY_NAME',
        'MINIO_ENDPOINT','MINIO_BUCKET',
        'MYSQL_HOST','MYSQL_PORT','MYSQL_DB',
        'REDIS_HOST','REDIS_PORT',
        'QDRANT_ENDPOINT','CUDA_VISIBLE_DEVICES',
    ]
    for k in platform_keys:
        v = os.environ.get(k)
        if v:
            st.code(f'{k}={v}', language='bash')

name = st.text_input('Your name')
if name:
    log.info('User input: name=%s', name)
    st.success(f'Hello, {name}!')
""",
            "requirements.txt": "streamlit\n",
            "deploy.sh": """#!/bin/bash
set -e
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/bin/pip install -q -r requirements.txt
.venv/bin/streamlit run app.py --server.port "${PORT:-8080}" --server.address 0.0.0.0 --server.headless true
""",
        },
    },
    "vllm": {
        "name": "vllm-serve",
        "files": {
            "deploy.sh": """#!/bin/bash
set -e
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/bin/pip install -q vllm

MODEL="${VLLM_MODEL:-Qwen/Qwen2.5-7B-Instruct}"
PORT="${PORT:-8080}"
LOG_DIR="${LOG_DIR:-/home/cloud/logs}"
mkdir -p "$LOG_DIR"

echo "[$(date -Iseconds)] Starting vLLM with model: $MODEL" | tee -a "$LOG_DIR/app.log"

.venv/bin/python -m vllm.entrypoints.openai.api_server \\
  --model "$MODEL" \\
  --host 0.0.0.0 \\
  --port "$PORT" \\
  --served-model-name "${VLLM_SERVED_NAME:-$(basename $MODEL)}" \\
  --trust-remote-code \\
  2>&1 | while IFS= read -r line; do
    echo "$line"
    echo "[$(date -Iseconds)] $line" >> "$LOG_DIR/app.log"
  done
""",
        },
    },
}

_SVC_LABELS = {"mysql": "MySQL", "redis": "Redis", "qdrant": "Qdrant", "minio": "MinIO"}


# ═══════════════════════════════════════════════════════════════
#  GET /api/pods  — list pods (search / status filter / pagination)
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/", methods=["GET"])
@api_auth()
def list_pods():
    u = g.api_user
    search = (request.args.get("search") or "").strip().lower()
    status_filter = (request.args.get("status") or "").strip()
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (ValueError, TypeError):
        page = 1
    try:
        per_page = min(100, max(1, int(request.args.get("per_page", 50))))
    except (ValueError, TypeError):
        per_page = 50

    state = groups.load_state()
    all_pods = []
    for pname, pod in state["groups"].items():
        role = users.pod_role(u, pod)
        if role is None and u.get("role") not in ("super", "admin"):
            continue
        st = groups.pod_status(pname)
        if search and search not in pname.lower():
            continue
        if status_filter and status_filter != st:
            continue
        all_pods.append({
            "name": pname,
            "type": pod.get("type"),
            "gpus": pod.get("gpus", []),
            "cpu": pod.get("cpu"),
            "mem": pod.get("mem"),
            "storage": pod.get("storage"),
            "status": st,
            "owners": pod.get("owners", []),
            "members": pod.get("members", []),
            "pending": pod.get("pending", []),
            "my_role": role,
        })

    total = len(all_pods)
    start = (page - 1) * per_page
    return jsonify({
        "pods": all_pods[start:start + per_page],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


# ═══════════════════════════════════════════════════════════════
#  POST /api/pods  — create pod
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/", methods=["POST"])
@api_auth("group.create")
def create_pod():
    b = _body()
    gpus = None
    if b.get("gpus"):
        gpus = [int(x) for x in str(b["gpus"]).split(",") if x.strip()]
    try:
        pod = groups.create_group(
            b.get("name", ""), gpus=gpus or None,
            cpu=b.get("cpu"), mem=b.get("mem"),
            storage=b.get("storage"), creator=_actor())
        audit.record("api_create_pod", detail=pod["name"], actor=_actor())
        return jsonify({"ok": True, "name": pod["name"]}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  GET /api/pods/<name>  — pod detail (status, role, creds, env, deps)
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>", methods=["GET"])
@api_pod("member")
def get_pod(name):
    pod = g.api_pod
    u = g.api_user
    st = groups.pod_status(name)
    role = users.pod_role(u, pod)
    lc = lifecycle.group_state(name)
    _gn = name.lower()
    grp_db = [_db_cred_card(c) for c in db_mod.list_creds() if (c.get("label") or "").lower() == _gn]
    grp_mk = [_minio_cred_card(k) for k in minio_mod.list_keys() if (k.get("label") or "").lower() == _gn]
    env = pod.get("env", {})
    deps = deploys.list_for(name)
    return jsonify({
        "name": name,
        # connection info (was on the old SSR detail page, lost in SPA rewrite)
        "ssh": {
            "host": siteconf.PUBLIC_HOST,
            "port": pod.get("ssh_public"),
            "user": "cloud",
            "password": pod.get("password"),
        },
        "web_url": (siteconf.public_url(pod['web_public'])
                    if pod.get("web_public") else None),
        "type": pod.get("type"),
        "gpus": pod.get("gpus", []),
        "cpu": pod.get("cpu"),
        "mem": pod.get("mem"),
        "storage": pod.get("storage"),
        "status": st,
        "owners": pod.get("owners", []),
        "members": pod.get("members", []),
        "pending": pod.get("pending", []),
        "my_role": role,
        "password": pod.get("password", ""),
        "ssh_public": pod.get("ssh_public", 0),
        "web_public": pod.get("web_public", 0),
        "env": env,
        "internal_ports": groups.normalize_internal_ports(pod),
        "internal_host": f"{groups.internal_service_name(name)}.{groups.NS}.svc.cluster.local",
        "lifecycle": lc,
        "credentials": {"databases": grp_db, "minio": grp_mk},
        "deploys": [{"id": d["id"], "name": d.get("name"), "repo": d.get("repo"),
                     "branch": d.get("branch", ""), "kind": d.get("kind", "serve"),
                     "state": deploys.status(name, d["id"]).get("state")}
                    for d in deps],
    })


# ═══════════════════════════════════════════════════════════════
#  DELETE /api/pods/<name>  — delete pod
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>", methods=["DELETE"])
@api_pod("owner")
def delete_pod(name):
    try:
        groups.remove_group(name)
        audit.record("api_delete_pod", detail=name, actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  Lifecycle: start / stop / restart
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/start", methods=["POST"])
@api_pod("owner")
def start_pod(name):
    res = lifecycle.start_group(name)
    audit.record("api_start_pod", detail=name, actor=_actor())
    return jsonify(res)


@pods_bp.route("/<name>/stop", methods=["POST"])
@api_pod("owner")
def stop_pod(name):
    res = lifecycle.stop_group(name)
    audit.record("api_stop_pod", detail=name, actor=_actor())
    return jsonify(res)


@pods_bp.route("/<name>/restart", methods=["POST"])
@api_pod("owner")
def restart_pod(name):
    res = lifecycle.restart_group(name)
    audit.record("api_restart_pod", detail=name, actor=_actor())
    return jsonify(res)


# ═══════════════════════════════════════════════════════════════
#  POST /api/pods/<name>/resize  — resize pod resources
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/resize", methods=["POST"])
@api_pod("owner")
def resize_pod(name):
    b = _body()
    cpu = b.get("cpu")
    mem = b.get("mem")
    storage = b.get("storage")
    try:
        g = groups.resize_group(name, cpu, mem, storage=storage)
        audit.record("api_resize_pod",
                     detail=f"{name} cpu={cpu} mem={mem} storage={storage}",
                     actor=_actor())
        return jsonify({"ok": True, "cpu": g["cpu"], "mem": g["mem"],
                        "storage": g.get("storage")})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  POST /api/pods/<name>/reset-pw  — reset password
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/reset-pw", methods=["POST"])
@api_pod("owner")
def reset_pw(name):
    try:
        g = groups.reset_password(name)
        audit.record("api_reset_password", detail=name, actor=_actor())
        return jsonify({"ok": True, "password": g.get("password")})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  POST /api/pods/<name>/join  — request to join pod
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/join", methods=["POST"])
@api_auth()
def join_pod(name):
    """Any authenticated user can apply to join."""
    b = _body()
    state = groups.load_state()
    pod = state["groups"].get(name)
    if not pod:
        return jsonify({"error": f"Pod {name} 不存在"}), 404
    try:
        groups.apply_to_pod(name, _actor(), b.get("reason", ""))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  Metrics
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/metrics", methods=["GET"])
@api_pod("member")
def get_metrics(name):
    pod = g.api_pod
    result = {"cpu": "", "mem": "", "gpus": []}
    # CPU/mem usage plus percent vs the group's resource limits
    # (the monitor cards read cpu_percent / mem_used / mem_total / mem_percent).
    try:
        per = cpu_stats._per_group()
        lim_mc = metrics._parse_cpu_millicores(str(pod.get("cpu") or "")) if pod.get("cpu") else None
        lim_mm = metrics._parse_mem_mib(str(pod.get("mem") or "")) if pod.get("mem") else None
        for p in per:
            if p["name"] == name:
                result["cpu"] = p["cpu"]
                result["mem"] = p["mem"]
                mc = metrics._parse_cpu_millicores(p["cpu"]) if p.get("cpu") else None
                mm = metrics._parse_mem_mib(p["mem"]) if p.get("mem") else None
                if mc is not None and lim_mc:
                    result["cpu_percent"] = round(min(mc / lim_mc * 100.0, 999.0), 1)
                if mm is not None:
                    result["mem_used"] = mm
                if lim_mm:
                    result["mem_total"] = lim_mm
                    if mm is not None:
                        result["mem_percent"] = round(min(mm / lim_mm * 100.0, 999.0), 1)
                break
    except Exception:
        pass
    try:
        gpus = pod.get("gpus") or []
        if gpus:
            gs = gpu_stats.gpu_stats()
            own = gpu_stats.per_pod_usage().get(name, {})
            for gi in gs.get("gpus") or []:
                if gi.get("index") in gpus:
                    result["gpus"].append({
                        "index": gi["index"],
                        "name": gi.get("name", ""),
                        "util": gi.get("util", 0),
                        "mem_used": gi.get("mem_used", 0),
                        "mem_total": gi.get("mem_total", 0),
                        # this pod's own processes on this card
                        "own_mem_used": own.get(gi["index"], 0),
                        "temp": gi.get("temp", 0),
                        "power": gi.get("power", 0),
                    })
    except Exception:
        pass
    try:
        lc = lifecycle.group_state(name)
        result["phase"] = lc.get("phase", "Unknown")
        result["replicas"] = lc.get("replicas", 0)
        result["readyReplicas"] = lc.get("readyReplicas", 0)
    except Exception:
        result["phase"] = "Unknown"
    return jsonify(result)


@pods_bp.route("/<name>/metrics/history", methods=["GET"])
@api_pod("member")
def get_metrics_history(name):
    pod = g.api_pod
    try:
        snap = metrics.metrics_snapshot()
        grp = snap.get("groups", {}).get(name, {})
        # history charts plot a 0-100% axis: convert raw millicores / MiB
        # to percent of the group's resource limits.
        lim_mc = metrics._parse_cpu_millicores(str(pod.get("cpu") or "")) if pod.get("cpu") else None
        lim_mm = metrics._parse_mem_mib(str(pod.get("mem") or "")) if pod.get("mem") else None
        cpu = grp.get("cpu", [])
        mem = grp.get("mem", [])
        if lim_mc:
            cpu = [round(min(c / lim_mc * 100.0, 999.0), 1) for c in cpu]
        if lim_mm:
            mem = [round(min(m / lim_mm * 100.0, 999.0), 1) for m in mem]
        return jsonify({
            "cpu": cpu,
            "mem": mem,
            "samples": snap.get("samples", 0),
        })
    except Exception as e:
        return jsonify({"cpu": [], "mem": [], "error": str(e)})


# ═══════════════════════════════════════════════════════════════
#  GET /api/pods/<name>/events  — k8s events
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/events", methods=["GET"])
@api_pod("member")
def get_events(name):
    events = lifecycle.group_events(name)
    return jsonify({"events": events})


# ═══════════════════════════════════════════════════════════════
#  Container logs (text + SSE stream)
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/logs", methods=["GET"])
@api_pod("member")
def get_logs(name):
    try:
        tail = int(request.args.get("tail", "300"))
    except (ValueError, TypeError):
        tail = 300
    lg = lifecycle.group_logs(name, tail)
    if lg.get("ok"):
        return Response(lg.get("logs", ""), mimetype="text/plain")
    return jsonify({"error": lg.get("error", "读取失败")}), 500


def _iter_log_process(args, heartbeat=10.0, poll_interval=0.5):
    proc = None
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        fd = proc.stdout.fileno(); dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""; last = time.monotonic()
        while True:
            ready, _, _ = select.select([fd], [], [], poll_interval)
            if ready:
                chunk = os.read(fd, 4096)
                if chunk:
                    pending += dec.decode(chunk); lines = pending.split("\n"); pending = lines.pop()
                    for line in lines: yield "data: " + line.rstrip("\r") + "\n\n"
                    last = time.monotonic()
                else:
                    pending += dec.decode(b"", final=True)
                    if pending: yield "data: " + pending.rstrip("\r") + "\n\n"
                    yield "data: (日志流结束)\n\n"; return
            if time.monotonic()-last >= heartbeat:
                yield ": keepalive\n\n"; last=time.monotonic()
            if proc.poll() is not None: return
    finally:
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=2)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=2)
            if proc.stdout is not None: proc.stdout.close()


@pods_bp.route("/<name>/logs/stream", methods=["GET"])
@api_pod("member")
def stream_logs(name):
    pod = deploys.resolve_pod(name)
    if not pod:
        return jsonify({"error": "Pod 未运行"}), 404

    def _stream():
        args = ["kubectl", "-n", groups.NS, "logs", "-f", "--tail=100", pod]
        yield from _iter_log_process(args)

    resp = Response(_stream(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


# ═══════════════════════════════════════════════════════════════
#  App logs (list / read / SSE stream)
# ═══════════════════════════════════════════════════════════════
_APP_LOG_SCRIPT = r"""import json, pathlib, sys
base = pathlib.Path('/home/cloud/logs')
mode = sys.argv[1]
if mode == 'list':
    files = [] if not base.exists() else [
        {'name': path.name, 'size': path.stat().st_size, 'mtime': path.stat().st_mtime,
         'symlink': path.is_symlink(), 'source': str(path)}
        for path in sorted(base.iterdir(), key=lambda item: item.name)
        if path.name.endswith('.log') and path.is_file()]
    print(json.dumps({'files': files}, ensure_ascii=False))
    raise SystemExit(0)
if mode != 'read' or len(sys.argv) != 4:
    print('invalid log request', file=sys.stderr); raise SystemExit(2)
name = sys.argv[2]
try: tail = int(sys.argv[3])
except ValueError:
    print('tail must be an integer', file=sys.stderr); raise SystemExit(2)
if not name or pathlib.PurePosixPath(name).name != name or not name.endswith('.log'):
    print('invalid log filename', file=sys.stderr); raise SystemExit(2)
path = base / name
if not path.is_file():
    print('log file not found', file=sys.stderr); raise SystemExit(3)
from collections import deque
with path.open('r', encoding='utf-8', errors='replace', newline='') as handle:
    lines = deque(handle, maxlen=tail)
sys.stdout.write(''.join(lines))
"""

def _run_app_log_command(name, mode, filename=None, tail=None):
    encoded = base64.b64encode(_APP_LOG_SCRIPT.encode()).decode()
    command = "python3 -c " + shlex.quote("import base64,sys; code=base64.b64decode(sys.argv.pop(1)); exec(compile(code, 'app_logs', 'exec'), {})")
    command += " " + shlex.quote(encoded) + " " + shlex.quote(mode)
    if filename is not None: command += " " + shlex.quote(filename) + " " + shlex.quote(str(tail))
    return deploys._exec(name, command, timeout=15)

@pods_bp.route("/<name>/app-logs", methods=["GET"])
@api_pod("member")
def get_app_logs(name):
    if not deploys.resolve_pod(name): return jsonify({"error": "Pod 未运行"}), 404
    filename = request.args.get("file", "")
    if filename:
        try: tail_n = int(request.args.get("tail", "200"))
        except (ValueError, TypeError): return jsonify({"error": "tail 必须是 1 到 2000 的整数"}), 400
        if not 1 <= tail_n <= 2000: return jsonify({"error": "tail 必须是 1 到 2000 的整数"}), 400
        if ".." in filename or "/" in filename or "\\" in filename or not filename.endswith(".log"):
            return jsonify({"error": "非法文件名"}), 400
        try: rc, out, err = _run_app_log_command(name, "read", filename, tail_n)
        except Exception as exc: return jsonify({"error": str(exc)}), 500
        if rc != 0: return jsonify({"error": (err or out).strip() or "读取日志失败"}), (404 if rc == 3 else 502)
        return Response(out, mimetype="text/plain")
    try: rc, out, err = _run_app_log_command(name, "list")
    except Exception as exc: return jsonify({"error": str(exc)}), 500
    if rc != 0: return jsonify({"error": (err or out).strip() or "列出日志失败"}), 502
    try: return jsonify(json.loads(out))
    except (TypeError, ValueError): return jsonify({"error": "日志列表响应无效"}), 502


@pods_bp.route("/<name>/app-logs/stream", methods=["GET"])
@api_pod("member")
def stream_app_logs(name):
    filename = request.args.get("file", "").strip()
    if not filename or ".." in filename or "/" in filename or not filename.endswith(".log"):
        return jsonify({"error": "非法文件名"}), 400
    pod = deploys.resolve_pod(name)
    if not pod:
        return jsonify({"error": "Pod 未运行"}), 404

    def _stream():
        cmd = f"tail -n 100 -f /home/cloud/logs/{shlex.quote(filename)} 2>/dev/null"
        args = ["kubectl", "-n", groups.NS, "exec", "-i", pod, "--", "su", "-l", "cloud", "-c", cmd]
        yield from _iter_log_process(args)

    resp = Response(_stream(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


# ═══════════════════════════════════════════════════════════════
#  File browser: list / content / create / delete / save
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/files", methods=["GET"])
@api_pod("member")
def list_files(name):
    path = request.args.get("path", "/home/cloud")
    return jsonify(deploys.browse(name, path))


@pods_bp.route("/<name>/files/content", methods=["GET"])
@api_pod("member")
def get_file_content(name):
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "缺少 path"}), 400
    norm = os.path.normpath(path)
    allowed = any(norm == pre.rstrip("/") or norm.startswith(pre)
                  for pre in ("/home/cloud/", "/shared/"))
    if not allowed:
        return jsonify({"error": "仅允许读取 /home/cloud/ 或 /shared/"}), 403
    try:
        rc, out, err = deploys._exec(
            name,
            f"head -c 262144 {shlex.quote(norm)} 2>/dev/null "
            "&& echo -n '__EOF__' || echo -n '__ERR__'",
            timeout=15)
        if "__ERR__" in out and "__EOF__" not in out:
            return jsonify({"error": (err or "读取失败").strip()}), 500
        content = out.replace("__EOF__", "") if "__EOF__" in out else out
        is_binary = (any(ord(c) < 8 and c not in ('\n', '\r', '\t')
                        for c in content[:4096]) if content else False)
        return jsonify({"ok": True, "content": content, "binary": is_binary,
                        "path": norm})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@pods_bp.route("/<name>/files/create", methods=["POST"])
@api_pod("owner")
def create_file(name):
    b = _body()
    path = b.get("path", "")
    ftype = b.get("type", "file")
    if not path:
        return jsonify({"error": "缺少 path"}), 400
    norm = os.path.normpath(path)
    if not any(norm.startswith(pre) for pre in ("/home/cloud/", "/shared/")):
        return jsonify({"error": "仅允许在 /home/cloud/ 或 /shared/ 下创建"}), 403
    try:
        if ftype == "folder":
            rc, out, err = deploys._exec(name, f"mkdir -p {shlex.quote(norm)}",
                                         timeout=10)
        else:
            rc, out, err = deploys._exec(name, f"touch {shlex.quote(norm)}",
                                         timeout=10)
        if rc != 0:
            return jsonify({"error": (err or out or "创建失败").strip()}), 500
        return jsonify({"ok": True, "path": norm})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@pods_bp.route("/<name>/files", methods=["DELETE"])
@api_pod("owner")
def delete_file(name):
    """Delete a file/dir. ?path=/home/cloud/foo"""
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "缺少 path"}), 400
    norm = os.path.normpath(path)
    if norm in ("/home/cloud", "/home/cloud/", "/shared", "/shared/"):
        return jsonify({"error": "不能删除根目录"}), 400
    if not any(norm.startswith(pre) for pre in ("/home/cloud/", "/shared/")):
        return jsonify({"error": "仅允许删除 /home/cloud/ 或 /shared/ 下的文件"}), 403
    try:
        deploys._rm(name, norm)
        return jsonify({"ok": True, "path": norm})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@pods_bp.route("/<name>/files/save", methods=["PUT"])
@api_pod("owner")
def save_file(name):
    b = _body()
    path = b.get("path", "")
    content = b.get("content", "")
    if not path:
        return jsonify({"error": "缺少 path"}), 400
    norm = os.path.normpath(path)
    if not any(norm.startswith(pre) for pre in ("/home/cloud/", "/shared/")):
        return jsonify({"error": "仅允许保存到 /home/cloud/ 或 /shared/"}), 403
    try:
        deploys._write_file(name, norm, content)
        return jsonify({"ok": True, "path": norm})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════════════════════════════
#  POST /api/pods/<name>/apply-template  — quickstart template
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/apply-template", methods=["POST"])
@api_pod("member")
def apply_template(name):
    b = _body()
    tpl_id = b.get("template", "")
    tpl = _TEMPLATES.get(tpl_id)
    if not tpl:
        return jsonify({"error": "未知模板: " + tpl_id}), 400
    if groups.pod_status(name) != "Running":
        return jsonify({"error": "Pod 未运行"}), 400

    tpl_name = tpl["name"]
    # Re-run if deploy already exists
    existing = [d for d in deploys.list_for(name) if d.get("name") == tpl_name]
    if existing:
        ok, msg = deploys.run(name, existing[0])
        return jsonify({"ok": ok, "msg": msg or "已重新部署",
                        "deploy_id": existing[0]["id"]})

    # Write template files into the pod
    try:
        deploys._exec(name, f"mkdir -p /home/cloud/{tpl_name}", timeout=10)
        for fname, content in tpl["files"].items():
            deploys._write_file(name, f"/home/cloud/{tpl_name}/{fname}", content)
        if "deploy.sh" in tpl["files"]:
            deploys._exec(name, f"chmod +x /home/cloud/{tpl_name}/deploy.sh",
                          timeout=10)
    except Exception as e:
        return jsonify({"error": f"写文件失败: {e}"}), 500

    # Create local-script deploy and auto-run
    try:
        spec = {
            "name": tpl_name,
            "source": "local",
            "script": f"/home/cloud/{tpl_name}/deploy.sh",
            "repo": "", "branch": "", "subdir": "", "token": "",
            "mode": "service", "kind": "serve", "gpu": "", "vram": "",
            "auto_deploy": False, "health": "/health", "health_timeout": 60,
        }
        dep = deploys.add(name, spec)
        ok, msg = deploys.run(name, dep)
        audit.record("api_template_apply",
                     detail=f"{name}/{tpl_name} ok={ok}", actor=_actor())
        return jsonify({"ok": ok, "msg": msg, "deploy_id": dep["id"]})
    except Exception as e:
        return jsonify({"error": f"创建部署失败: {e}"}), 500


# ═══════════════════════════════════════════════════════════════
#  Credentials: list / apply / revoke
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/credentials", methods=["GET"])
@api_pod("member")
def list_credentials(name):
    _gn = name.lower()
    grp_db = [_db_cred_card(c) for c in db_mod.list_creds()
              if (c.get("label") or "").lower() == _gn]
    grp_mk = [_minio_cred_card(k) for k in minio_mod.list_keys()
              if (k.get("label") or "").lower() == _gn]
    return jsonify({"databases": grp_db, "minio": grp_mk})


@pods_bp.route("/<name>/credentials/apply", methods=["POST"])
@api_pod("owner")
def apply_credential(name):
    b = _body()
    service = (b.get("service") or "").strip()
    if service not in _SVC_LABELS:
        return jsonify({"error": "未知服务"}), 400
    _gn = name.lower()
    try:
        if service == "minio":
            if any((k.get("label") or "").lower() == _gn
                   for k in minio_mod.list_keys()):
                return jsonify({"error": "本组已有 MinIO 密钥(每种最多一个),请先撤销"}), 400
            bucket = (b.get("bucket") or "").strip() or name
            perm = (b.get("perm") or "readwrite").strip()
            try:
                minio_mod.make_bucket(bucket)
            except Exception:
                pass  # bucket already exists
            minio_mod.add_key(name, bucket, perm)
            audit.record("api_pod_cred_apply",
                         detail=f"minio {name} bucket={bucket} perm={perm}",
                         actor=_actor())
            return jsonify({"ok": True, "service": "minio", "bucket": bucket})
        else:
            if any((c.get("label") or "").lower() == _gn and c.get("service") == service
                   for c in db_mod.list_creds()):
                return jsonify({"error": f"本组已有 {_SVC_LABELS[service]} 凭证(每种最多一个),请先撤销"}), 400
            db_mod.add_cred(service, name)
            audit.record("api_pod_cred_apply",
                         detail=f"{service} {name}", actor=_actor())
            return jsonify({"ok": True, "service": service})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@pods_bp.route("/<name>/credentials/<kid>", methods=["DELETE"])
@api_pod("owner")
def revoke_credential(name, kid):
    """Revoke a credential. ?kind=db|minio"""
    kind = request.args.get("kind", "db").strip()
    _gn = name.lower()
    try:
        if kind == "minio":
            rec = next((k for k in minio_mod.list_keys() if k.get("id") == kid), None)
            if not rec or (rec.get("label") or "").lower() != _gn:
                return jsonify({"error": "密钥不存在或不属于本组"}), 404
            minio_mod.remove_key(kid)
            audit.record("api_pod_cred_revoke",
                         detail=f"minio {kid}", actor=_actor())
        else:
            rec = next((c for c in db_mod.list_creds() if c.get("id") == kid), None)
            if not rec or (rec.get("label") or "").lower() != _gn:
                return jsonify({"error": "凭证不存在或不属于本组"}), 404
            db_mod.remove_cred(kid)
            audit.record("api_pod_cred_revoke",
                         detail=f"{rec.get('service')} {kid}", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  Environment variables: list / set / delete
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/env", methods=["GET"])
@api_pod("member")
def list_env(name):
    pod = g.api_pod
    return jsonify({"env": pod.get("env", {})})


# ═══════════════════════════════════════════════════════════════
#  Internal (cluster-only) service ports
#  Declared on the group's Service with no nodePort, so only Pods inside the
#  cluster can reach them. Editing does NOT restart the Pod.
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/internal-ports", methods=["GET"])
@api_pod("member")
def list_internal_ports(name):
    pod = g.api_pod
    return jsonify({"ports": groups.normalize_internal_ports(pod)})


@pods_bp.route("/<name>/internal-ports", methods=["POST"])
@api_pod("owner")
def set_internal_ports(name):
    b = _body()
    ports = b.get("ports")
    if ports is None:
        return jsonify({"error": "缺少 ports"}), 400
    if isinstance(ports, str):
        ports = [x for x in ports.replace(",", " ").split() if x.strip()]
    try:
        clean = groups.set_internal_ports(name, ports)
        audit.record("api_internal_ports_set",
                     detail=f"{name} ports={','.join(map(str, clean))}",
                     actor=_actor())
        return jsonify({"ok": True, "ports": clean})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@pods_bp.route("/<name>/env", methods=["POST"])
@api_pod("owner")
def set_env(name):
    b = _body()
    key = b.get("key", "")
    value = b.get("value", "")
    if not key:
        return jsonify({"error": "缺少 key"}), 400
    try:
        groups.set_env(name, key, value)
        audit.record("api_env_set", detail=f"{name} {key}=***", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@pods_bp.route("/<name>/env/<key>", methods=["DELETE"])
@api_pod("owner")
def delete_env(name, key):
    try:
        groups.delete_env(name, key)
        audit.record("api_env_delete", detail=f"{name} {key}", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  Members: list / invite / approve / remove
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/members/candidates", methods=["GET"])
@api_pod("owner")
def member_candidates(name):
    """Owner-only username discovery for invitations or promotions."""
    prefix = request.args.get("q", "").strip()
    if len(prefix) > 64:
        return jsonify({"error": "搜索词最多 64 个字符"}), 400
    mode = request.args.get("mode", "invite")
    if mode not in {"invite", "owner"}:
        return jsonify({"error": "invalid mode"}), 400
    if not prefix:
        return jsonify({"items": []})
    try:
        limit = min(max(int(request.args.get("limit", 10)), 1), 20)
    except (TypeError, ValueError):
        limit = 10
    pod = g.api_pod
    excluded = set(pod.get("owners", []))
    if mode == "invite":
        excluded.update(pod.get("members", []))
        excluded.update(p.get("username", "") for p in pod.get("pending", []) if isinstance(p, dict))
    return jsonify({"items": users.search_users_prefix(prefix, limit=limit, excluded=excluded)})


@pods_bp.route("/<name>/members", methods=["GET"])
@api_pod("member")
def list_members(name):
    pod = g.api_pod
    return jsonify({
        "owners": pod.get("owners", []),
        "members": pod.get("members", []),
        "pending": pod.get("pending", []),
    })


@pods_bp.route("/<name>/members/invite", methods=["POST"])
@api_pod("owner")
def invite_member(name):
    b = _body()
    username = b.get("username", "")
    if not username:
        return jsonify({"error": "缺少 username"}), 400
    try:
        groups.invite_member(name, username)
        audit.record("api_member_invite",
                     detail=f"{name} {username}", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@pods_bp.route("/<name>/members/approve", methods=["POST"])
@api_pod("owner")
def approve_member(name):
    b = _body()
    username = (b.get("username", "") or "").strip()
    approved = b.get("approved", False)
    if not username:
        return jsonify({"error": "缺少 username"}), 400
    try:
        groups.approve_pending(name, username, approved)
        audit.record("api_member_approve",
                     detail=f"{name} {username} approved={approved}",
                     actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@pods_bp.route("/<name>/members/<username>", methods=["DELETE"])
@api_pod("owner")
def remove_member(name, username):
    try:
        groups.remove_member(name, username)
        audit.record("api_member_remove",
                     detail=f"{name} {username}", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  Owners: add / remove
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/owners/add", methods=["POST"])
@api_pod("owner")
def add_owner(name):
    b = _body()
    username = b.get("username", "")
    if not username:
        return jsonify({"error": "缺少 username"}), 400
    try:
        groups.add_owner(name, username)
        audit.record("api_owner_add",
                     detail=f"{name} {username}", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@pods_bp.route("/<name>/owners/<username>", methods=["DELETE"])
@api_pod("owner")
def remove_owner(name, username):
    try:
        groups.remove_owner(name, username)
        audit.record("api_owner_remove",
                     detail=f"{name} {username}", actor=_actor())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
#  Deploys: list / add / delete / run / stop / status / logs / stream / browse
# ═══════════════════════════════════════════════════════════════
@pods_bp.route("/<name>/deploys", methods=["GET"])
@api_pod("member")
def list_deploys(name):
    out = []
    for d in deploys.list_for(name):
        st = deploys.status(name, d["id"])
        out.append({
            "id": d["id"], "name": d.get("name"), "repo": d.get("repo"),
            "branch": d.get("branch", ""), "kind": d.get("kind", "serve"),
            "source": d.get("source", "repo"),
            "state": st.get("state"), "auto_deploy": d.get("auto_deploy", False),
            "last_ref": (d.get("last_ref") or "")[:12],
        })
    return jsonify({"deploys": out})


@pods_bp.route("/<name>/deploys", methods=["POST"])
@api_pod("owner")
def add_deploy(name):
    b = _body()
    source = (b.get("source") or "repo").strip()
    repo = (b.get("repo") or "").strip()
    script = (b.get("script") or "").strip()
    nm = (b.get("name") or "").strip()

    if source == "local":
        ok, err = deploys.validate_script(script)
        if not ok:
            return jsonify({"error": err}), 400
        if not nm:
            return jsonify({"error": "本地部署需填写名称"}), 400
        repo = ""
    else:
        ok, err = deploys.validate_repo(repo)
        if not ok:
            return jsonify({"error": err}), 400
        if not nm:
            from urllib.parse import urlparse
            path = urlparse(repo).path.rstrip("/")
            nm = path.rsplit("/", 1)[-1].replace(".git", "") or "deploy"

    spec = {
        "name": nm, "source": source, "script": script, "repo": repo,
        "branch": (b.get("branch") or "").strip() if source != "local" else "",
        "subdir": (b.get("subdir") or "").strip() if source != "local" else "",
        "token": (b.get("token") or "").strip() if source != "local" else "",
        "mode": (b.get("mode") or "service").strip(),
        "kind": (b.get("kind") or "serve").strip(),
        "gpu": (b.get("gpu") or "").strip(),
        "vram": (b.get("vram") or "").strip(),
        "auto_deploy": bool(b.get("auto_deploy", False)) and source != "local",
        "health": (b.get("health") or "").strip(),
        "health_timeout": _parse_health_timeout(b.get("health_timeout", "60")),
    }
    d = deploys.add(name, spec)
    audit.record("api_deploy_add",
                 detail=f"{name}/{d['name']} id={d['id']}", actor=_actor())
    return jsonify({"ok": True, "id": d["id"], "name": d["name"]}), 201


@pods_bp.route("/<name>/deploys", methods=["DELETE"])
@api_pod("owner")
def delete_deploy(name):
    """Delete a deploy. ?id=<deploy_id>"""
    did = request.args.get("id", "")
    if not did:
        return jsonify({"error": "缺少 id 参数"}), 400
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    deploys.delete(name, d)
    audit.record("api_deploy_delete", detail=f"{name}/{did}", actor=_actor())
    return jsonify({"ok": True})


@pods_bp.route("/<name>/deploys/<did>/run", methods=["POST"])
@api_pod("owner")
def run_deploy(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    ok, msg = deploys.run(name, d)
    audit.record("api_deploy_run",
                 detail=f"{name}/{did} ok={ok}", actor=_actor())
    return jsonify({"ok": ok, "msg": msg})


@pods_bp.route("/<name>/deploys/<did>/stop", methods=["POST"])
@api_pod("owner")
def stop_deploy(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    deploys.stop(name, d)
    audit.record("api_deploy_stop", detail=f"{name}/{did}", actor=_actor())
    return jsonify({"ok": True})


@pods_bp.route("/<name>/deploys/<did>/status", methods=["GET"])
@api_pod("member")
def get_deploy_status(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    st = deploys.status(name, did)
    st.update(name=d.get("name"), auto_deploy=d.get("auto_deploy", False),
              last_ref=(d.get("last_ref") or "")[:12])
    return jsonify(st)


@pods_bp.route("/<name>/deploys/<did>/logs", methods=["GET"])
@api_pod("member")
def get_deploy_logs(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404
    try:
        lines = int(request.args.get("lines", "200"))
    except (ValueError, TypeError):
        lines = 200
    return jsonify({"logs": deploys.logs(name, d, lines=lines)})


@pods_bp.route("/<name>/deploys/<did>/logs/stream", methods=["GET"])
@api_pod("member")
def stream_deploy_logs(name, did):
    d = deploys.get(name, did)
    if not d:
        return jsonify({"error": "部署不存在"}), 404

    def _stream():
        for chunk in deploys.stream_logs(name, d):
            yield chunk

    return Response(_stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no"})


@pods_bp.route("/<name>/deploys/browse", methods=["GET"])
@api_pod("member")
def browse_deploy_files(name):
    """File browser for deploy script picker. ?path=..."""
    path = request.args.get("path", "/home/cloud")
    return jsonify(deploys.browse(name, path))
