"""Agent harness configuration.

Global settings live in /opt/yatterra/agent.conf (INI):
  [limits]  max_iters max_wall cmd_timeout out_max_kb
  [compact] enabled threshold_tokens keep_last max_tokens
  [fanout]  enabled max_parallel max_depth sub_max_iters sub_max_wall

The agent registry (one entry per agent type: ops/build/db/storage/custom)
lives in /opt/yatterra/agents.json. Harness definitions (low-code DAGs)
live as one JSON file each under /opt/yatterra/harnesses/.

load() returns the global config dict with defaults merged. Never raises on
read; falls back to defaults.
"""
import configparser
import json
import os

import siteconf

CONF_FILE = siteconf.path("agent.conf")
AGENTS_FILE = siteconf.path("agents.json")
HARNESSES_DIR = siteconf.HARNESSES_DIR
HARNESSES_PUBLIC_DIR = siteconf.HARNESSES_PUBLIC_DIR

_DEFAULTS = {
    "limits": {"max_iters": "12", "max_wall": "180", "cmd_timeout": "30", "out_max_kb": "20"},
    "compact": {"enabled": "1", "threshold_tokens": "180000", "keep_last": "4", "max_tokens": "1024"},
    "fanout": {"enabled": "1", "max_parallel": "8", "max_depth": "3",
               "sub_max_iters": "12", "sub_max_wall": "300"},
}

_ALL_TOOLS = ["run", "run_remote", "read_file", "write_file", "spawn", "web_search",
              "fetch_url", "edit_file", "grep", "list_dir",
              "inspect", "memory_save", "memory_load", "memory_list"]


def _default_agents():
    """The built-in agent registry written on first run."""
    def tools(*names):
        return {t: (t in names) for t in _ALL_TOOLS}
    return [
        {"id": "ops", "label": "运维助手", "icon": "🛠", "runner": "host",
         "tools": tools("run", "run_remote", "spawn", "web_search", "fetch_url", "edit_file", "grep", "list_dir"),
         "system_prompt": "你是平台的运维助手(ops agent),在平台宿主机以 root 执行命令,专管 K3s 集群运维:Pod 增删改查、日志排查、资源监控、故障诊断、安全审计。先诊断再操作,危险操作先确认,给出根因分析。"},
        {"id": "build", "label": "编程助手", "icon": "💻", "runner": "pod",
         "tools": tools("run", "read_file", "write_file", "spawn", "web_search", "fetch_url",
                        "edit_file", "grep", "list_dir"),
         "system_prompt": "你是组容器里的编程助手(build agent),在 Ubuntu 24.04 容器以 cloud 用户执行,专管代码开发调试:项目构建、依赖管理、代码审查、Bug 修复、测试运行。先读代码再改,改完即测,遵循项目现有代码风格。"},
        {"id": "db", "label": "数据库助手", "icon": "🗄", "runner": "host",
         "tools": tools("run", "web_search", "fetch_url", "grep", "list_dir"),
         "system_prompt": "你是平台的数据库助手(db agent),在平台宿主机以 root 执行命令,专管数据库运维:MySQL/PostgreSQL/Redis 连接、查询优化、备份恢复、用户权限、慢查询分析。查询先 EXPLAIN,写操作先备份,不明文显示密码。"},
        {"id": "storage", "label": "存储助手", "icon": "📦", "runner": "host",
         "tools": tools("run", "web_search", "fetch_url", "grep", "list_dir"),
         "system_prompt": "你是平台的存储助手(storage agent),在平台宿主机以 root 执行命令,专管存储运维:MinIO 对象存储、NFS 共享、磁盘容量、PV/PVC、备份策略。容量先查再操作,桶策略最小权限,备份验证可恢复。"},
    ]


def _to_cfg(d):
    """Convert nested dict {section: {key: value}} to configparser.
    Booleans serialize as 1/0 so load() round-trips."""
    cp = configparser.ConfigParser()
    for sec, kv in d.items():
        out = {}
        for k, v in kv.items():
            if isinstance(v, bool):
                out[k] = "1" if v else "0"
            else:
                out[k] = str(v)
        cp[sec] = out
    return cp


def load():
    """Return {section: {key: value}} for global settings, defaults merged."""
    cp = configparser.ConfigParser()
    try:
        cp.read(CONF_FILE, encoding="utf-8")
    except Exception:
        cp = _to_cfg(_DEFAULTS)
    out = {}
    for sec, kv in _DEFAULTS.items():
        out[sec] = {}
        for k, default in kv.items():
            out[sec][k] = cp.get(sec, k, fallback=default)
    out["limits"]["max_iters"] = int(out["limits"]["max_iters"])
    out["limits"]["max_wall"] = int(out["limits"]["max_wall"])
    out["limits"]["cmd_timeout"] = int(out["limits"]["cmd_timeout"])
    out["limits"]["out_max_kb"] = int(out["limits"]["out_max_kb"])
    out["compact"]["enabled"] = str(out["compact"]["enabled"]).lower() in ("1", "true", "yes", "on")
    out["compact"]["threshold_tokens"] = int(out["compact"]["threshold_tokens"])
    out["compact"]["keep_last"] = int(out["compact"]["keep_last"])
    out["compact"]["max_tokens"] = int(out["compact"]["max_tokens"])
    out["fanout"]["enabled"] = str(out["fanout"]["enabled"]).lower() in ("1", "true", "yes", "on")
    out["fanout"]["max_parallel"] = int(out["fanout"]["max_parallel"])
    out["fanout"]["max_depth"] = int(out["fanout"]["max_depth"])
    out["fanout"]["sub_max_iters"] = int(out["fanout"]["sub_max_iters"])
    out["fanout"]["sub_max_wall"] = int(out["fanout"]["sub_max_wall"])
    return out


def save(cfg):
    """Write global config (nested dict) to CONF_FILE. Caller ensures root perms."""
    cp = _to_cfg(cfg)
    with open(CONF_FILE, "w", encoding="utf-8") as f:
        cp.write(f)


# --- agent registry ---
def _normalize_agent(a):
    """Coerce a loaded agent dict to canonical form (all tools present, typed)."""
    a = dict(a)
    a["id"] = str(a.get("id", "")).strip()
    a["label"] = str(a.get("label", a["id"] or "agent"))
    a["icon"] = str(a.get("icon", "🤖"))
    a["runner"] = "pod" if a.get("runner") == "pod" else "host"
    tools = a.get("tools") or {}
    a["tools"] = {t: bool(tools.get(t, False)) for t in _ALL_TOOLS}
    a["system_prompt"] = str(a.get("system_prompt", "") or "")
    a["mcp"] = [str(s).strip() for s in (a.get("mcp") or []) if str(s).strip()]
    return a


def load_agents():
    """Return list of agent defs. Writes defaults on first run/missing/corrupt."""
    try:
        with open(AGENTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        agents = [_normalize_agent(a) for a in (data.get("agents") or [])]
        if not agents:
            raise ValueError("empty")
    except Exception:
        agents = [_normalize_agent(a) for a in _default_agents()]
        save_agents(agents)
    return agents


def save_agents(agents):
    with open(AGENTS_FILE, "w", encoding="utf-8") as f:
        json.dump({"agents": [_normalize_agent(a) for a in agents]}, f,
                  ensure_ascii=False, indent=2)
    try:
        os.chmod(AGENTS_FILE, 0o600)
    except OSError:
        pass


def get_agent(agent_id):
    """Return one agent def by id, or None."""
    if not agent_id:
        return None
    for a in load_agents():
        if a["id"] == agent_id:
            return a
    return None


# --- harness definitions (low-code DAGs, per-user) ---
def _safe_name(name):
    """Validate harness name (no path traversal)."""
    if not name or "/" in name or ".." in name or "\\" in name:
        return False
    return True


def _user_dir(username):
    """Return the per-user harness directory, creating it if needed."""
    import re as _re
    safe = _re.sub(r'[^A-Za-z0-9._-]', '_', username or "_shared")
    d = os.path.join(HARNESSES_DIR, safe)
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return d


def _ensure_dir():
    try:
        os.makedirs(HARNESSES_DIR, exist_ok=True)
    except OSError:
        pass


def list_harnesses(username=None):
    """List harness names for a user. If username is None, list shared (legacy)."""
    if username:
        d = _user_dir(username)
    else:
        _ensure_dir()
        d = HARNESSES_DIR
    try:
        names = [f[:-5] for f in os.listdir(d) if f.endswith(".json")]
    except OSError:
        return []
    return sorted(names)


def load_harness(name, username=None):
    """Return harness doc dict, or None."""
    if not _safe_name(name):
        return None
    if username:
        path = os.path.join(_user_dir(username), name + ".json")
    else:
        path = os.path.join(HARNESSES_DIR, name + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_harness(name, doc, username=None):
    if not _safe_name(name):
        raise ValueError("非法 harness 名称")
    if username:
        d = _user_dir(username)
    else:
        _ensure_dir()
        d = HARNESSES_DIR
    path = os.path.join(d, name + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def delete_harness(name, username=None):
    if not _safe_name(name):
        return
    if username:
        path = os.path.join(_user_dir(username), name + ".json")
    else:
        path = os.path.join(HARNESSES_DIR, name + ".json")
    try:
        os.remove(path)
    except OSError:
        pass


# --- public harness store ---
def _ensure_public_dir():
    try:
        os.makedirs(HARNESSES_PUBLIC_DIR, exist_ok=True)
    except OSError:
        pass


def list_public_harnesses():
    """List all public harnesses. Returns list of {name, author, published_at}."""
    _ensure_public_dir()
    out = []
    try:
        files = [f for f in os.listdir(HARNESSES_PUBLIC_DIR) if f.endswith(".json")]
    except OSError:
        return []
    for f in files:
        path = os.path.join(HARNESSES_PUBLIC_DIR, f)
        try:
            with open(path, encoding="utf-8") as fh:
                meta = json.load(fh)
            out.append({
                "name": f[:-5],
                "author": meta.get("author", ""),
                "published_at": meta.get("published_at", 0),
                "title": (meta.get("doc") or {}).get("name", f[:-5]),
            })
        except Exception:
            continue
    out.sort(key=lambda x: x.get("published_at", 0), reverse=True)
    return out


def load_public_harness(name):
    """Return the public harness doc, or None."""
    if not _safe_name(name):
        return None
    path = os.path.join(HARNESSES_PUBLIC_DIR, name + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            meta = json.load(f)
        return meta.get("doc")
    except Exception:
        return None


def publish_harness(name, username):
    """Copy a personal harness to the public store.
    Returns (ok, error). Can overwrite own, not others'."""
    if not _safe_name(name):
        return False, "非法名称"
    doc = load_harness(name, username)
    if not doc:
        return False, f"harness {name} 不存在"
    _ensure_public_dir()
    path = os.path.join(HARNESSES_PUBLIC_DIR, name + ".json")
    # check existing: can only overwrite your own
    try:
        with open(path, encoding="utf-8") as f:
            existing = json.load(f)
        if existing.get("author", "") != username:
            return False, f"公开商店中已存在同名 harness(作者: {existing.get('author', '?')})"
    except (OSError, json.JSONDecodeError):
        pass
    import time as _time
    meta = {"author": username, "published_at": _time.time(), "doc": doc}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return True, None


def unpublish_harness(name, username):
    """Remove a harness from the public store. Only the author can unpublish."""
    if not _safe_name(name):
        return False, "非法名称"
    path = os.path.join(HARNESSES_PUBLIC_DIR, name + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            existing = json.load(f)
        if existing.get("author", "") != username:
            return False, "只能取消发布自己的 harness"
    except (OSError, json.JSONDecodeError):
        return False, "该 harness 不在商店中"
    try:
        os.remove(path)
    except OSError:
        return False, "删除失败"
    return True, None


def import_public_harness(name, username):
    """Copy a public harness to the user's personal store. Returns (ok, error)."""
    doc = load_public_harness(name)
    if not doc:
        return False, f"公开 harness {name} 不存在"
    save_harness(name, doc, username)
    return True, None
