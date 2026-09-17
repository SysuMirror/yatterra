"""子域名 → 公网端口 反向代理管理。

在 yatterra GUI 上维护 `<sub>.ssemarket.cn → host.docker.internal:<port>` 映射,
底层通过 SSH 编辑公网服务器 ssemarket.cn 上 nginx_proxy 容器的 nginx.conf,
在一个固定标记段内整段重写 server 块,改完 `nginx -t` 校验通过才 reload,
失败自动回滚。

状态文件 /opt/yatterra/proxy_mappings.json (root 600) 是权威,nginx 段由它生成。
"""
import json
import os
import re
import base64
import secrets
from datetime import datetime

import remote_hosts
import audit
import siteconf

STATE_FILE = siteconf.path("proxy_mappings.json")
REMOTE_HOST = siteconf.RELAY_HOST_NAME
NGINX_CONF = siteconf.NGINX_PROXY_CONF
CONTAINER = siteconf.NGINX_PROXY_CONTAINER

MARK_BEGIN = "# === yatterra managed subdomains BEGIN ==="
MARK_END = "# === yatterra managed subdomains END ==="
MARK_HEADER = "# 由 yatterra /proxy 页自动管理,勿手工编辑此段。手工子域 server 块请放段外。"
# 段插入锚点(http {} 内的已知行)
ANCHOR = "  upstream backend {"

RESERVED = siteconf.RESERVED_SUBDOMAINS
SUB_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")

DOMAIN = siteconf.DOMAIN  # 父域


# ---------------------------------------------------------------- state
def _load():
    try:
        with open(STATE_FILE) as f:
            data = json.load(f)
        data = data if isinstance(data, list) else []
    except Exception:
        return []
    return _migrate(data)


def _migrate(state):
    """One-shot migration: ensure every mapping has a "pod" field.

    Guesses ownership by matching the mapping's port against each pod's
    public ports (groups.json), falling back to subdomain == pod name.
    Unmatched mappings get pod: null (unassigned; admin/super only).
    Saves back only when something changed.
    """
    if not any("pod" not in m for m in state):
        return state
    try:
        import groups as groups_mod
        pods = groups_mod.load_state()["groups"]
    except Exception:
        pods = {}
    port_to_pod = {}
    for pname, p in pods.items():
        for key in ("web_public", "ssh_public"):
            try:
                port_to_pod[int(p[key])] = pname
            except (KeyError, TypeError, ValueError):
                pass
    for m in state:
        if "pod" in m:
            continue
        pod = port_to_pod.get(m.get("port"))
        if pod is None and m.get("subdomain") in pods:
            pod = m["subdomain"]
        m["pod"] = pod  # None = unassigned
    try:
        _save(state)
    except Exception:
        pass
    return state


def _save(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass


def list_mappings():
    return _load()


# ---------------------------------------------------------------- nginx block
def _server_blocks(sub, port):
    """生成一对 80/443 server 块(2 空格缩进,http {} 内)。"""
    sn = f"{sub}.{DOMAIN}"
    return f"""  server {{
    listen 80;
    server_name {sn};

    location ^~ /.well-known/acme-challenge/ {{
      root /var/www/certbot;
    }}

    location / {{
      return 301 https://$server_name$request_uri;
    }}
  }}

  server {{
    listen 443 ssl;
    http2 on;
    server_name {sn};

    ssl_certificate     /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;

    ssl_session_timeout 5m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4:!DHE;
    ssl_prefer_server_ciphers on;

    client_max_body_size 200m;

    location / {{
      proxy_pass http://host.docker.internal:{port};
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
      proxy_buffering off;
    }}
  }}"""


def _section_text(state):
    blocks = [_server_blocks(m["subdomain"], m["port"])
              for m in state if m.get("enabled")]
    body = "\n\n".join(blocks)
    inner = MARK_HEADER + "\n" + body if body else MARK_HEADER
    return f"{MARK_BEGIN}\n{inner}\n{MARK_END}"


def _strip_old_hand_blocks(conf, subs):
    """剥离段外旧的 `# === <sub>.ssemarket.cn ... BEGIN/END ===` 块(迁移收编)。"""
    for sub in subs:
        pat = re.compile(
            r"\n*# === " + re.escape(sub) + r"\." + re.escape(DOMAIN) +
            r".*?BEGIN ===.*?# === " + re.escape(sub) + r"\." + re.escape(DOMAIN) +
            r".*?END ===\n*", re.DOTALL)
        conf = pat.sub("\n", conf)
    return conf


def _splice(conf, section, subs):
    """替换/插入托管段,并清理段外旧手加块。"""
    conf = _strip_old_hand_blocks(conf, subs)
    if MARK_BEGIN in conf and MARK_END in conf:
        pat = re.compile(re.escape(MARK_BEGIN) + r".*?" + re.escape(MARK_END), re.DOTALL)
        conf = pat.sub(section, conf, count=1)
    else:
        conf = conf.replace(ANCHOR, section + "\n\n" + ANCHOR, 1)
    return conf


# ---------------------------------------------------------------- remote I/O
def _run(cmd, sudo=True, timeout=30):
    return remote_hosts.run_remote(REMOTE_HOST, cmd, sudo=sudo, timeout=timeout)


def _read_conf():
    ok, out = _run(f"cat {NGINX_CONF}", timeout=20)
    if not ok:
        raise RuntimeError(out)
    return out


def _write_conf(text):
    b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
    cmd = f"echo {b64} | base64 -d | tee {NGINX_CONF} > /dev/null"
    ok, out = _run(cmd, timeout=30)
    if not ok:
        raise RuntimeError(out)


def _backup_conf():
    _run(f"cp {NGINX_CONF} {NGINX_CONF}.bak.$(date +%Y%m%d_%H%M%S)", timeout=15)


def _nginx_test():
    ok, out = _run(f"docker exec {CONTAINER} nginx -t", timeout=25)
    return ok and "test is successful" in out, out


def _nginx_reload():
    ok, out = _run(f"docker exec {CONTAINER} nginx -s reload", timeout=20)
    return ok, out


# ---------------------------------------------------------------- apply
def apply():
    """根据状态重写 nginx 托管段,test 通过才 reload,失败回滚。返 (ok, msg)。"""
    state = _load()
    section = _section_text(state)
    subs = [m["subdomain"] for m in state]
    try:
        old = _read_conf()
    except RuntimeError as e:
        return False, f"读 nginx.conf 失败: {e}"
    new = _splice(old, section, subs)
    if new == old:
        # 无变化也要确认段在位;但仍 reload 一次以保险?跳过,无变化直接 ok。
        return True, "无变化"
    try:
        _backup_conf()
        _write_conf(new)
    except RuntimeError as e:
        return False, f"写 nginx.conf 失败: {e}"
    ok, out = _nginx_test()
    if not ok:
        # 回滚
        try:
            _write_conf(old)
        except Exception:
            pass
        return False, f"nginx -t 失败已回滚: {out.strip().splitlines()[-1] if out.strip() else '未知'}"
    ok, out = _nginx_reload()
    if not ok:
        return False, f"reload 失败: {out}"
    return True, "已应用并 reload"


# ---------------------------------------------------------------- ops
def _conf_has_servername(sub):
    """conf 里段外是否已有该子域的 server_name(冲突检测)。"""
    try:
        conf = _read_conf()
    except Exception:
        return False
    # 剥掉托管段,只看段外
    if MARK_BEGIN in conf and MARK_END in conf:
        conf = re.sub(re.escape(MARK_BEGIN) + r".*?" + re.escape(MARK_END), "", conf, flags=re.DOTALL)
    sn = f"{sub}.{DOMAIN}"
    return any(sn in line for line in conf.splitlines() if "server_name" in line)


def pod_ports(pod):
    """Public service ports of a pod dict (from groups.json), for the frontend picker."""
    out = []
    for key, label in (("web_public", "Web (HTTPS)"), ("ssh_public", "SSH")):
        try:
            out.append({"port": int(pod[key]), "label": label, "key": key})
        except (KeyError, TypeError, ValueError):
            pass
    return out


def add(subdomain, port, note="", pod=None):
    sub = (subdomain or "").strip().lower()
    if not SUB_RE.match(sub):
        return False, "子域只允许小写字母数字和连字符,1-63 字符"
    if sub in RESERVED:
        return False, f"子域 {sub} 是保留名,禁止"
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False, "端口必须是整数"
    if not (1 <= port <= 65535):
        return False, "端口范围 1-65535"
    state = _load()
    if any(m["subdomain"] == sub for m in state):
        return False, f"子域 {sub} 已存在"
    if any(m["port"] == port for m in state):
        return False, f"端口 {port} 已被其他映射占用"
    if _conf_has_servername(sub):
        return False, f"nginx 里段外已有 {sub}.{DOMAIN} 的 server_name,请先手工清理"
    rec = {
        "id": sub,
        "subdomain": sub,
        "port": port,
        "note": (note or "").strip()[:120],
        "enabled": True,
        "pod": pod,
        "created": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
    }
    state.append(rec)
    _save(state)
    ok, msg = apply()
    if not ok:
        # apply 失败:回退状态,避免状态与 conf 漂移
        _save([m for m in state if m["id"] != sub])
        return False, msg
    audit.record("proxy_add", detail=f"{sub}.{DOMAIN}:{port} note={rec['note']}", module="proxy_map")
    return True, f"已添加 {sub}.{DOMAIN} → :{port}"


def remove(sub_id):
    state = _load()
    new = [m for m in state if m["id"] != sub_id]
    if len(new) == len(state):
        return False, "映射不存在"
    _save(new)
    ok, msg = apply()
    if not ok:
        return False, msg
    audit.record("proxy_delete", detail=sub_id, module="proxy_map")
    return True, f"已删除 {sub_id}"


def toggle(sub_id):
    state = _load()
    rec = next((m for m in state if m["id"] == sub_id), None)
    if not rec:
        return False, "映射不存在"
    rec["enabled"] = not rec.get("enabled", True)
    _save(state)
    ok, msg = apply()
    if not ok:
        return False, msg
    audit.record("proxy_toggle", detail=f"{sub_id} enabled={rec['enabled']}", module="proxy_map")
    return True, f"{sub_id} 已{'启用' if rec['enabled'] else '停用'}"


def set_note(sub_id, note):
    """Update a mapping's note. Returns (ok, msg)."""
    state = _load()
    rec = next((m for m in state if m["id"] == sub_id), None)
    if not rec:
        return False, "映射不存在"
    rec["note"] = (note or "").strip()[:120]
    _save(state)
    audit.record("proxy_note", detail=f"{sub_id} note={rec['note']}", module="proxy_map")
    return True, "已更新备注"


def rename(sub_id, new_sub):
    """Change a mapping's subdomain prefix (id follows the prefix).

    The port and pod binding are preserved — callers that want to move a
    mapping to a different port must remove + add instead.
    """
    sub = (new_sub or "").strip().lower()
    if not SUB_RE.match(sub):
        return False, "子域只允许小写字母数字和连字符,1-63 字符"
    if sub in RESERVED:
        return False, f"子域 {sub} 是保留名,禁止"
    state = _load()
    rec = next((m for m in state if m["id"] == sub_id), None)
    if not rec:
        return False, "映射不存在"
    if sub == rec["subdomain"]:
        return True, "无变化"
    if any(m["subdomain"] == sub for m in state):
        return False, f"子域 {sub} 已存在"
    if _conf_has_servername(sub):
        return False, f"nginx 里段外已有 {sub}.{DOMAIN} 的 server_name,请先手工清理"
    old_sub = rec["subdomain"]
    old_id = rec["id"]
    rec["subdomain"] = sub
    rec["id"] = sub
    _save(state)
    ok, msg = apply()
    if not ok:
        # roll back so state never drifts from nginx.conf
        rec["subdomain"] = old_sub
        rec["id"] = old_id
        _save(state)
        return False, msg
    audit.record("proxy_rename", detail=f"{old_sub}→{sub}", module="proxy_map")
    return True, f"已重命名为 {sub}.{DOMAIN}"


# ---------------------------------------------------------------- status
def status():
    st = {"mappings": _load(), "container_running": False, "conf_present": False}
    ok, out = _run(f"docker inspect -f '{{{{.State.Running}}}}' {CONTAINER}", timeout=15)
    if ok and out.strip() == "true":
        st["container_running"] = True
    try:
        st["conf_present"] = MARK_BEGIN in _read_conf()
    except Exception:
        pass
    return st
