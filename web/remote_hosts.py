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
    try:
        script_b64 = _b64(_COLLECT)
        sudo_b64 = _b64(cfg.get("sudo_password", ""))
        vllm_b64 = _b64(json.dumps(cfg.get("vllm", {})))
        try:
            import fleet_monitor
            mounts = fleet_monitor.mounts_of(cfg)
        except Exception:
            mounts = cfg.get("mounts") or ["/"]
        mounts_b64 = _b64(json.dumps(mounts))
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


def _ssh_argv(cfg, remote_cmd):
    return [
        "sshpass", "-p", cfg.get("password", ""),
        "ssh", "-o", "ConnectTimeout=8",
        "-o", "StrictHostKeyChecking=accept-new",
        "-p", str(cfg.get("port", 22)),
        f"{cfg.get('user','')}@{cfg.get('host','')}",
        remote_cmd,
    ]


def pipe_root(src_host, src_command, dst_host, dst_command, timeout=1800):
    """Pipe one root shell's stdout into another root shell's stdin.

    ``None`` means this machine. Remote commands run as root via sudo.
    The byte stream is not returned. Returns (ok, error tail).
    """
    procs = []
    try:
        src = _popen_root(src_host, src_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        procs.append(src)
        dst, password = _popen_root_stdin(dst_host, dst_command)
        procs.append(dst)
        if password:
            dst.stdin.write((password + "\n").encode())
        while True:
            chunk = src.stdout.read(1024 * 1024)
            if not chunk:
                break
            dst.stdin.write(chunk)
        dst.stdin.close()
        src_rc = src.wait(timeout=timeout)
        dst_rc = dst.wait(timeout=timeout)
        err = ((src.stderr.read() or b"") + (dst.stderr.read() or b""))[-800:].decode("utf-8", "replace")
        if src_rc != 0 or dst_rc != 0:
            return False, err or f"src={src_rc} dst={dst_rc}"
        return True, ""
    except Exception as e:
        for proc in procs:
            try:
                proc.kill()
            except Exception:
                pass
        return False, str(e)
    finally:
        for proc in procs:
            for stream in (proc.stdout, proc.stderr, proc.stdin):
                if stream is None:
                    continue
                try:
                    stream.close()
                except Exception:
                    pass


def _popen_root(host, command, **kwargs):
    if host is None:
        argv = ["bash", "-c", command] if os.geteuid() == 0 else ["sudo", "-n", "bash", "-c", command]
        return subprocess.Popen(argv, **kwargs)
    cfg = _find(host)
    if cfg is None:
        raise RuntimeError(f"未知远程主机: {host}")
    import shlex
    remote = "echo %s | sudo -S -p '' bash -lc %s" % (
        shlex.quote(cfg.get("sudo_password", "")), shlex.quote(command))
    return subprocess.Popen(_ssh_argv(cfg, remote), **kwargs)


def _popen_root_stdin(host, command):
    """Return (proc, password_or_empty). Password is written by the caller
    before the byte stream, because sudo -S consumes the first line."""
    if host is None:
        argv = ["bash", "-c", command] if os.geteuid() == 0 else ["sudo", "-n", "bash", "-c", command]
        return subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE), ""
    cfg = _find(host)
    if cfg is None:
        raise RuntimeError(f"未知远程主机: {host}")
    import shlex
    remote = "sudo -S -p '' bash -lc %s" % shlex.quote(command)
    return subprocess.Popen(_ssh_argv(cfg, remote), stdin=subprocess.PIPE, stderr=subprocess.PIPE), cfg.get("sudo_password", "")


def run_remote(name, command, sudo=False, timeout=30, stdin_data=None):
    """Run a command on a configured remote host over SSH.

    Host must be registered in remote_hosts.json (allowlist). When
    ``sudo`` is true, the command is wrapped with ``sudo -S`` fed by the
    host's ``sudo_password`` (the caller never sees the password).

    ``stdin_data`` (str) is streamed to the remote command's stdin — use it for
    large payloads (nginx configs, htpasswd files …) instead of embedding them
    in ``command``: a base64 blob passed as an argument eventually exceeds the
    kernel's per-arg limit (MAX_ARG_STRLEN = 128 KiB, total ARG_MAX ~2 MiB) and
    exec() dies with OSError(7, 'Argument list too long'). The blob grows with
    every new group, so a busy site *will* hit it.

    ``stdin_data`` may only be combined with ``sudo=False``: with sudo the
    password is fed on stdin (see below), which would corrupt the payload.
    Use :func:`write_remote_file` for "large data + root" — it transfers the
    data unprivileged, then installs it with a short sudo command.

    Returns (ok: bool, output: str). Never raises.
    """
    import shlex
    cfg = _find(name)
    if cfg is None:
        return False, f"【未知远程主机: {name}。可用: {', '.join(c.get('name','?') for c in load())}】"
    if sudo and stdin_data is not None:
        return False, "【run_remote: stdin_data 不能与 sudo 同时使用(密码占用了 stdin),请用 write_remote_file】"
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
        kwargs = {} if stdin_data is None else {"input": stdin_data}
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           **kwargs)
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0:
            # 远端命令失败 = 整体失败。附上退出码方便排错,但 ok 必须是 False,
            # 否则调用方(proxy_map/groups/agent)会把失败当成功,报错只剩一个
            # "[exit=1]" 尾巴而丢掉真实原因。
            out += f"\n[exit={r.returncode}]"
            return False, out
        return True, out
    except subprocess.TimeoutExpired:
        return False, f"[远程命令超时 {timeout}s]"
    except Exception as e:
        return False, f"[远程执行异常: {e!r}]"


def write_remote_file(name, path, data, sudo=True, mode=None, timeout=30):
    """Write text ``data`` to ``path`` on host ``name`` — safe for large files.

    Two-phase, so the payload never becomes a command-line argument (which is
    what breaks at ~128 KiB with ``Argument list too long``):

      1. unprivileged: stream ``data`` over stdin into a private temp file
         (``/tmp/.yatterra-w-*``, mode 600);
      2. short command: install the temp file into ``path`` (root via sudo when
         requested) and delete the temp file.

    Step 2 uses ``cat tmp > path``, which truncates the destination in place —
    the file keeps its **inode**. The relay binds single files into the nginx
    container, so a fresh inode would silently not take effect until a restart.

    Returns (ok: bool, output: str). Never raises.
    """
    import secrets
    tmp = "/tmp/.yatterra-w-%s" % secrets.token_hex(8)
    ok, out = run_remote(name, "umask 077; cat > %s" % tmp, sudo=False,
                         timeout=timeout, stdin_data=data)
    if not ok:
        run_remote(name, "rm -f %s" % tmp, sudo=False, timeout=10)
        return False, f"[传输到临时文件失败: {out}]"
    chmod = " && chmod %s %s" % (mode, path) if mode else ""
    cmd = "cat %s > %s%s; rc=$?; rm -f %s; exit $rc" % (tmp, path, chmod, tmp)
    ok, out = run_remote(name, cmd, sudo=sudo, timeout=timeout)
    if not ok:
        return False, f"[安装到 {path} 失败: {out}]"
    return True, out
