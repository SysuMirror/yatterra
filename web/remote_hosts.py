#!/usr/bin/env python3
"""Remote host monitoring for the admin dashboard.

Collects the same telemetry shape as :mod:`host_health` from remote
machines over SSH (e.g. the ssedgx DGX "spark" running vLLM), so they
can be shown on the host page without joining k3s or scheduling pods.

Config: /opt/yatterra/remote_hosts.json (root 600), a list of::

    {"name", "desc", "host", "port", "user", "password",
     "sudo_password", "vllm": {"health_url","model","container"},
     "mounts": ["/", ...]}

Collection is best-effort: every sub-collector is guarded and a failed
SSH yields a dict with an ``error`` key, never raises.
"""
import base64
import json
import os
import subprocess

import siteconf

_CONF = siteconf.path("remote_hosts.json")

# --------------------------------------------------------------------------- #
# remote collector — stdlib only, runs on the remote host, prints JSON
# argv[1] = base64(sudo_password), argv[2] = base64(json(vllm_cfg)),
# argv[3] = base64(json(mounts))
# --------------------------------------------------------------------------- #
_COLLECT = r'''
import base64, json, os, re, socket, subprocess, sys, urllib.request

def D(i):
    try:
        return base64.b64decode(sys.argv[i]).decode()
    except Exception:
        return ""

sudo_pw = D(2)
try:
    vllm = json.loads(D(3) or "{}")
except Exception:
    vllm = {}
try:
    mounts = json.loads(D(4) or "[]")
except Exception:
    mounts = ["/"]

def sh(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.stderr, r.returncode
    except Exception as e:
        return "", str(e), 1

def human(n):
    try:
        n = float(n)
    except Exception:
        return "?"
    for u in ("B","KiB","MiB","GiB","TiB","PiB"):
        if abs(n) < 1024 or u == "PiB":
            return ("%d " % n + u) if u == "B" else ("%.1f %s" % (n, u))
        n /= 1024.0
    return "%.1f PiB" % n

out = {}

# disk
disks = []
for mnt in mounts:
    e = {"mount": mnt}
    try:
        st = os.statvfs(mnt)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        used = total - free
        e.update(total=total, used=used, avail=free,
                 used_pct=round(used/total*100,1) if total else 0.0,
                 total_h=human(total), used_h=human(used), avail_h=human(free))
    except Exception as ex:
        e["error"] = str(ex)
    disks.append(e)
out["disk"] = disks

# mem
try:
    info = {}
    with open("/proc/meminfo") as f:
        for ln in f:
            p = ln.split()
            if len(p) >= 2 and p[0].endswith(":"):
                try:
                    info[p[0][:-1]] = int(p[1]) * 1024
                except Exception:
                    pass
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", 0)
    used = max(total - avail, 0)
    out["mem"] = {"total": total, "used": used, "avail": avail,
                  "used_pct": round(used/total*100,1) if total else 0.0,
                  "total_h": human(total), "used_h": human(used), "avail_h": human(avail)}
except Exception as e:
    out["mem"] = {"error": str(e)}

# swap
try:
    info = {}
    with open("/proc/meminfo") as f:
        for ln in f:
            p = ln.split()
            if len(p) >= 2 and p[0].endswith(":"):
                try:
                    info[p[0][:-1]] = int(p[1]) * 1024
                except Exception:
                    pass
    total = info.get("SwapTotal", 0)
    free = info.get("SwapFree", 0)
    used = max(total - free, 0)
    out["swap"] = {"total": total, "used": used, "free": free,
                   "used_pct": round(used/total*100,1) if total else 0.0,
                   "total_h": human(total), "used_h": human(used)}
except Exception as e:
    out["swap"] = {"error": str(e)}

# uptime
try:
    with open("/proc/uptime") as f:
        secs = float(f.read().split()[0])
    d, s = divmod(int(secs), 86400)
    h, s = divmod(s, 3600)
    m, _ = divmod(s, 60)
    hu = ("%dd %dh %dm" % (d,h,m)) if d else (("%dh %dm" % (h,m)) if h else "%dm" % m)
    out["uptime"] = {"seconds": round(secs,1), "human": hu}
except Exception as e:
    out["uptime"] = {"error": str(e)}

# load
try:
    with open("/proc/loadavg") as f:
        p = f.read().split()
    out["load"] = {"load1": float(p[0]), "load5": float(p[1]), "load15": float(p[2])}
except Exception as e:
    out["load"] = {"error": str(e)}

# kernel/os
ko = {}
try:
    u = os.uname()
    ko.update(sysname=u.sysname, release=u.release, machine=u.machine, nodename=u.nodename)
except Exception as e:
    ko["uname_error"] = str(e)
try:
    pretty = ""
    with open("/etc/os-release") as f:
        for ln in f:
            if ln.startswith("PRETTY_NAME="):
                pretty = ln.split("=",1)[1].strip().strip('"')
                break
    ko["os_pretty"] = pretty
except Exception as e:
    ko["os_error"] = str(e)
out["kernel_os"] = ko

# nvidia — per-GPU detail (absent binary => no GPU, not an error)
def toInt(x):
    try:
        return int(x)
    except Exception:
        return None

nv = {"gpus": [], "count": 0}
# detect binary presence
_, _, which_rc = sh("command -v nvidia-smi", 3)
if which_rc != 0:
    out["nvidia"] = nv  # no GPU on this host
else:
    try:
        o, e, rc = sh("nvidia-smi --query-gpu=index,name,driver_version,utilization.gpu,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits", 12)
        if rc == 0:
            for ln in o.strip().splitlines():
                p = [x.strip() for x in ln.split(",")]
                if len(p) >= 7:
                    nv["gpus"].append({"index": toInt(p[0]), "name": p[1], "driver": p[2],
                                       "util": toInt(p[3]), "mem_total": toInt(p[4]),
                                       "mem_used": toInt(p[5]), "temp": toInt(p[6])})
            nv["count"] = len(nv["gpus"])
            nv["driver_version"] = nv["gpus"][0]["driver"] if nv["gpus"] else ""
        else:
            nv["error"] = (e or "nvidia-smi failed").strip()
    except Exception as e:
        nv["error"] = str(e)
    out["nvidia"] = nv

# vllm health — skip entirely if no vllm configured for this host
if not vllm:
    out["vllm"] = None
else:
    vh = {}
    url = vllm.get("health_url", "http://127.0.0.1:8888/health")
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as r:
            vh["healthy"] = (r.status == 200)
            vh["status_code"] = r.status
    except Exception as e:
        vh["healthy"] = False
        vh["error"] = str(e)
    vh["model"] = vllm.get("model", "")
    vh["container"] = vllm.get("container", "")
    # container state via sudo docker
    cname = vllm.get("container", "")
    if cname and sudo_pw:
        try:
            cmd = "echo %s | sudo -S -p '' docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' %s 2>/dev/null" % (__import__("shlex").quote(sudo_pw), __import__("shlex").quote(cname))
            o, e, rc = sh(cmd, 8)
            if rc == 0 and o.strip():
                parts = o.strip().split()
                vh["container_status"] = parts[0] if parts else ""
                vh["container_health"] = parts[1] if len(parts) > 1 else ""
        except Exception:
            pass
    out["vllm"] = vh

print(json.dumps(out))
'''


def _b64(s):
    return base64.b64encode(s.encode()).decode()


def load():
    """Load remote hosts config. Returns list of dicts (empty on any error)."""
    try:
        with open(_CONF) as f:
            return json.load(f)
    except Exception:
        return []


def collect(cfg, timeout=20):
    """Collect telemetry from one remote host over SSH.

    Returns a dict matching host_health shape (plus ``vllm``). Never raises.
    """
    name = cfg.get("name", "?")
    try:
        script_b64 = _b64(_COLLECT)
        sudo_b64 = _b64(cfg.get("sudo_password", ""))
        vllm_b64 = _b64(json.dumps(cfg.get("vllm", {})))
        mounts_b64 = _b64(json.dumps(cfg.get("mounts", ["/"])))
        remote_cmd = (
            'python3 -c "import base64,sys;'
            "exec(base64.b64decode(sys.argv[1]).decode())"
            f'" {script_b64} {sudo_b64} {vllm_b64} {mounts_b64}'
        )
        cmd = [
            "sshpass", "-p", cfg.get("password", ""),
            "ssh", "-o", "ConnectTimeout=8",
            "-o", "StrictHostKeyChecking=accept-new",
            "-p", str(cfg.get("port", 22)),
            f"{cfg.get('user','')}@{cfg.get('host','')}",
            remote_cmd,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            return {"error": (r.stderr or "ssh failed").strip()[:500]}
        return json.loads(r.stdout)
    except subprocess.TimeoutExpired:
        return {"error": "SSH 采集超时"}
    except Exception as e:
        return {"error": str(e)}


def all_hosts():
    """Collect from all configured remote hosts. Returns list of {name,desc,data}."""
    hosts = []
    for cfg in load():
        entry = {"name": cfg.get("name", "?"), "desc": cfg.get("desc", ""),
                 "host": cfg.get("host", ""), "data": collect(cfg)}
        hosts.append(entry)
    return hosts


def _find(name):
    """Look up a remote host config by name. Returns cfg dict or None."""
    for cfg in load():
        if cfg.get("name") == name:
            return cfg
    return None


def run_remote(name, command, sudo=False, timeout=30):
    """Run a command on a configured remote host over SSH.

    Host must be registered in remote_hosts.json (allowlist). When
    ``sudo`` is true, the command is wrapped with ``sudo -S`` fed by the
    host's ``sudo_password`` (the caller never sees the password).

    Returns (ok: bool, output: str). Never raises.
    """
    import shlex
    cfg = _find(name)
    if cfg is None:
        return False, f"【未知远程主机: {name}。可用: {', '.join(c.get('name','?') for c in load())}】"
    try:
        if sudo:
            spw = cfg.get("sudo_password", "")
            if not spw:
                return False, "【该主机未配置 sudo_password,无法提权】"
            remote_cmd = "echo %s | sudo -S -p '' bash -lc %s" % (
                shlex.quote(spw), shlex.quote(command))
        else:
            remote_cmd = "bash -lc %s" % shlex.quote(command)
        cmd = [
            "sshpass", "-p", cfg.get("password", ""),
            "ssh", "-o", "ConnectTimeout=8",
            "-o", "StrictHostKeyChecking=accept-new",
            "-p", str(cfg.get("port", 22)),
            f"{cfg.get('user','')}@{cfg.get('host','')}",
            remote_cmd,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0:
            out += f"\n[exit={r.returncode}]"
        return True, out
    except subprocess.TimeoutExpired:
        return False, f"[远程命令超时 {timeout}s]"
    except Exception as e:
        return False, f"[远程执行异常: {e!r}]"
