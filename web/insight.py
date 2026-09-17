#!/usr/bin/env python3
"""Background AI-insight pre-computer.

A daemon thread periodically gathers each page's key data, asks the LLM for a
short ops-insight summary, and stores the result in Redis (via kvcache). The
frontend reads the cached summary instantly on page load — no LLM call per
visit. Users can still force a refresh via POST /api/ai/insight/<page>/refresh.

Architecture mirrors metrics.py: single daemon thread, idempotent start,
swallows all errors, survives worker recycling (max_requests=5000). gunicorn
runs with workers=1 so there is exactly one thread — no leader election.

Pages with dynamic params (pods/$name) or hard-to-gather sources (shared) are
skipped here; the frontend falls back to synchronous generate for those.
"""
import json
import logging
import os
import threading
import time

import kvcache
import siteconf

log = logging.getLogger(__name__)

# ── tunables ───────────────────────────────────────────────────
INTERVAL = 300          # seconds between full sweep cycles
TTL = 600               # Redis TTL (> INTERVAL so cache always warm)
PAGE_STAGGER = 2        # seconds between pages within a sweep (avoid LLM spike)
_MAX_TOKENS = 2048

_PREFIX = "insight:"    # kvcache key prefix (becomes yt:insight:<page>)

# Generic ops-summary prompt (matches AiInsightPanel default)
_DEFAULT_PROMPT = (
    "请根据以下平台数据生成简洁的运维洞察摘要，包括：关键状态、潜在风险、建议操作。控制在 3-5 行以内。"
)

# Per-page custom prompt prefixes (only threat-map overrides)
PROMPT_HINTS = {
    "threat-map": (
        "请根据以下威胁数据生成安全洞察摘要，包括：主要威胁来源、攻击模式分析、封禁状态、安全建议。控制在 3-5 行以内。"
    ),
    "fleet": (
        "请根据以下多主机集群数据生成集群健康洞察摘要，包括：关键状态、潜在风险(单点/资源瓶颈/离线)、建议操作。控制在 3-5 行以内。"
    ),
}


# ── helpers ────────────────────────────────────────────────────
def _safe(fn, *args, **kw):
    """Call fn, return result or None on any error."""
    try:
        return fn(*args, **kw)
    except Exception:
        return None


def _honeypot_feed(window="1d"):
    """Read honeypot threat feed JSON; return dict or None."""
    path = os.path.join(siteconf.HONEYPOT_DIR, f"feed_{window}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── per-page gatherers ─────────────────────────────────────────
# Each returns a context string, or None if data unavailable.

def _g_dashboard():
    import groups, host_health, gpu_stats, agent_conf, mcp_client, llm_conf, audit

    state = groups.load_state()
    pods = state.get("groups", {})
    statuses = groups.all_pod_statuses()
    running = sum(1 for s in statuses.values() if s == "Running")
    stopped = sum(1 for s in statuses.values() if s in ("Stopped", "Succeeded"))
    failed = sum(1 for s in statuses.values() if s in ("Failed", "CrashLoopBackOff", "Error"))

    hh = host_health.host_health()
    gs = gpu_stats.gpu_stats()
    agents = agent_conf.load_agents()
    mcp = mcp_client.load_servers()
    providers = llm_conf.list_providers()
    audit_entries = audit.audit_entries(limit=5)
    threat = _honeypot_feed("1d")

    lines = [f"集群概览:"]
    lines.append(f"Pod: 总 {len(pods)}, 运行 {running}, 停止 {stopped}, 失败 {failed}")
    mem = hh.get("mem", {}) if hh else {}
    disk = (hh.get("disk") or [{}])
    rd = disk[0] if disk else {}
    lines.append(
        f"资源: 内存 {mem.get('used_pct', 0):.1f}%, 磁盘 {rd.get('used_pct', 0):.1f}%, "
        f"GPU {gs.get('count', 0)} 块"
    )
    k3s = hh.get("k3s", {}) if hh else {}
    _kver = next((n.get("version", "") for n in (k3s.get("nodes") or []) if n.get("version")), "")
    lines.append(f"K3s: {k3s.get('count', '?')} 节点, 版本 {_kver or '?'}")
    lines.append(f"Agent: {len(agents)} 个, MCP: {len(mcp)} 个, LLM: {len(providers)} 个")
    lines.append(f"最近审计: {len(audit_entries)} 条")
    if threat:
        st = threat.get("stats", {})
        lines.append(f"威胁: {st.get('total_attacks', 0)} 次攻击, {st.get('total_banned', 0)} 个封禁")
    gpus = gs.get("gpus", []) if gs else []
    if gpus:
        lines.append("GPU 详情:")
        for g in gpus:
            lines.append(
                f"  GPU {g.get('index','?')}: {g.get('name','?')}, 利用率 {g.get('util',0)}%, "
                f"显存 {g.get('mem_used',0)}/{g.get('mem_total',0)}MiB, {g.get('temp',0)}°C"
            )
    # pod list (first 20)
    pod_items = list(pods.items())[:20]
    if pod_items:
        lines.append("Pod 列表:")
        for name, _ in pod_items:
            lines.append(f"  {name} [{statuses.get(name, '?')}]")
    return "\n".join(lines)


def _g_pod():
    import groups

    state = groups.load_state()
    pods = state.get("groups", {})
    statuses = groups.all_pod_statuses()
    running = sum(1 for s in statuses.values() if s == "Running")
    stopped = sum(1 for s in statuses.values() if s in ("Stopped", "Succeeded"))
    failed = sum(1 for s in statuses.values() if s in ("Failed", "CrashLoopBackOff", "Error"))
    lines = [f"Pod 总数: {len(pods)}, 运行 {running}, 停止 {stopped}, 失败 {failed}"]
    for name in list(pods.keys())[:25]:
        lines.append(f"  {name} [{statuses.get(name, '?')}]")
    return "\n".join(lines)


def _g_gpu():
    import gpu_stats

    gs = gpu_stats.gpu_stats()
    gpus = gs.get("gpus", [])
    if not gpus:
        return None
    total = len(gpus)
    avg_util = sum(g.get("util", 0) for g in gpus) / total
    mem_used = sum(g.get("mem_used", 0) for g in gpus)
    mem_total = sum(g.get("mem_total", 0) for g in gpus)
    max_temp = max((g.get("temp", 0) for g in gpus), default=0)
    lines = [f"GPU 总数: {total}, 平均利用率: {avg_util:.1f}%, 显存: {mem_used:.0f}/{mem_total:.0f} MiB, 最高温度: {max_temp}°C"]
    for g in gpus:
        lines.append(
            f"GPU {g.get('index','?')}: {g.get('name','?')}, 利用率 {g.get('util',0)}%, "
            f"显存 {g.get('mem_used',0)}/{g.get('mem_total',0)} MiB, 温度 {g.get('temp',0)}°C"
        )
    return "\n".join(lines)


def _g_host():
    import host_health

    hh = host_health.host_health()
    if not hh:
        return None
    cpu = hh.get("cpu", {})
    mem = hh.get("mem", {})
    disk = (hh.get("disk") or [{}])
    rd = disk[0] if disk else {}
    load = hh.get("load", {})
    uptime = hh.get("uptime", {})
    pods = hh.get("pods", {})
    lines = [
        f"主机: {hh.get('hostname','?')}, OS: {hh.get('os','?')}, 内核: {hh.get('kernel','?')}",
        f"CPU: {cpu.get('cores','?')} 核, 负载: {load.get('load1','?')} / {load.get('load5','?')} / {load.get('load15','?')}",
        f"内存: {mem.get('used_h','?')} / {mem.get('total_h','?')} ({mem.get('used_pct',0):.1f}%)",
        f"磁盘: {rd.get('used_h','?')} / {rd.get('total_h','?')} ({rd.get('used_pct',0):.1f}%)",
        f"运行时间: {uptime.get('human','?')}, Pod 数: {pods.get('count','?')} (运行 {pods.get('running','?')})",
    ]
    return "\n".join(lines)


def _g_infra():
    import host_health, minio_svc, db_svc, proxy_map

    hh = host_health.host_health() or {}
    st = _safe(minio_svc.status) or {}
    buckets = _safe(minio_svc.buckets) or []
    db = _safe(db_svc.status) or {}
    px = _safe(proxy_map.status) or {}
    mem = hh.get("mem", {})
    disk = (hh.get("disk") or [{}])
    rd = disk[0] if disk else {}
    frpc = hh.get("frpc", {})
    cpu = hh.get("cpu", {})
    pods = hh.get("pods", {})
    db_parts = []
    for s in ("mysql", "redis", "qdrant"):
        ok = db.get(s, {}).get("ready")
        db_parts.append(f"{s}={'运行' if ok else '未运行'}")
    lines = [
        f"基础设施概览: 主机 {hh.get('hostname','?')} ({hh.get('os','?')}), "
        f"CPU {cpu.get('cores','?')} 核, Pod {pods.get('count','?')} 个, "
        f"内存 {mem.get('used_pct',0):.1f}%, 磁盘 {rd.get('used_pct',0):.1f}%, "
        f"GPU {hh.get('nvidia',{}).get('count',0)} 块, K3s {hh.get('k3s',{}).get('count',0)} 节点",
        f"存储: MinIO {'运行' if st.get('ready') else '未运行'}, 桶 {len(buckets)} 个",
        f"数据库: {', '.join(db_parts)}",
        f"反代: 映射 {len(px.get('mappings',[]))} 个, 容器 {'运行' if px.get('container_running') else '停止'}, "
        f"FRP {frpc.get('running',0)}/{frpc.get('total',0)}",
    ]
    return "\n".join(lines)


def _g_fleet():
    import fleet_monitor

    snap = _safe(fleet_monitor.snapshot) or {}
    hosts = snap.get("hosts") or []
    if not hosts:
        return None
    online = sum(1 for h in hosts if h.get("status") == "online")
    offline = sum(1 for h in hosts if h.get("status") == "offline")
    stale = sum(1 for h in hosts if h.get("stale"))
    lines = [f"主机集群: 共 {len(hosts)} 台, 在线 {online}, 离线 {offline}, 数据陈旧 {stale}"]
    for h in hosts:
        d = h.get("data") or {}
        cpu = (d.get("cpu") or {}).get("usage_pct")
        mem = (d.get("memory") or {}).get("usage_pct")
        load = (d.get("cpu") or {}).get("load1")
        gpus = d.get("gpus") or []
        parts = [f"{h.get('name') or h.get('id')}: 状态 {h.get('status', '?')}"]
        if cpu is not None:
            parts.append(f"CPU {cpu:.1f}%")
        if mem is not None:
            parts.append(f"内存 {mem:.1f}%")
        if load is not None:
            parts.append(f"负载 {load:.2f}")
        if gpus:
            max_util = max((g.get("utilization_pct") or 0) for g in gpus)
            max_temp = max((g.get("temperature_c") or 0) for g in gpus)
            parts.append(f"GPU {len(gpus)} 块 (最高利用率 {max_util:.0f}%, 最高温 {max_temp:.0f}°C)")
        if h.get("stale"):
            parts.append("数据陈旧")
        lines.append("  " + ", ".join(parts))
    return "\n".join(lines)


def _g_storage():
    import minio_svc

    st = _safe(minio_svc.status) or {}
    buckets = _safe(minio_svc.buckets) or []
    keys = _safe(minio_svc.list_keys) or []
    lines = [
        f"MinIO 状态: {'运行中' if st.get('ready') else '启动中' if st.get('deployed') else '未部署'}",
        f"存储桶: {len(buckets)} 个 ({', '.join(str(b) for b in buckets)})",
        f"访问密钥: {len(keys)} 个",
    ]
    for k in (keys or [])[:10]:
        lines.append(f"  {k.get('label', k.get('id','?'))}: 桶={k.get('bucket','?')}, 权限={k.get('perm','rw')}")
    return "\n".join(lines)


def _g_databases():
    import db_svc

    st = _safe(db_svc.status) or {}
    creds = _safe(db_svc.list_creds) or []
    lines = [
        "数据库状态: " + ", ".join(
            f"{s}={'运行' if st.get(s,{}).get('ready') else '启动中' if st.get(s,{}).get('deployed') else '未部署'}"
            for s in ("mysql", "redis", "qdrant")
        ),
        f"凭证: {len(creds)} 个",
    ]
    for c in creds[:15]:
        lines.append(f"  {c.get('service','?')}: {c.get('group', c.get('username', c.get('id','?')))}")
    return "\n".join(lines)


def _g_proxy():
    import proxy_map, host_health

    px = _safe(proxy_map.status) or {}
    hh = _safe(host_health.host_health) or {}
    frpc = hh.get("frpc", {})
    mappings = px.get("mappings", [])
    enabled = sum(1 for m in mappings if m.get("enabled", True))
    disabled = len(mappings) - enabled
    lines = [
        f"反代映射: {len(mappings)} 个 ({enabled} 启用, {disabled} 禁用), "
        f"FRP 隧道 {frpc.get('running',0)}/{frpc.get('total',0)} 运行, "
        f"反代容器 {'运行中' if px.get('container_running') else '停止'}",
        "映射列表:",
    ]
    for m in mappings[:20]:
        lines.append(f"  {m.get('subdomain','?')} → :{m.get('port','?')} {'✓' if m.get('enabled',True) else '✗'} {m.get('note','')}")
    return "\n".join(lines)


def _g_audit():
    import audit

    entries = audit.audit_entries(limit=100)
    if not entries:
        return None
    # action distribution
    dist = {}
    fail = login = 0
    actors = set()
    for e in entries:
        a = e.get("action", "")
        dist[a] = dist.get(a, 0) + 1
        if "fail" in a or "delete" in a:
            fail += 1
        if "login" in a:
            login += 1
        if e.get("actor"):
            actors.add(e["actor"])
    top = sorted(dist.items(), key=lambda x: -x[1])[:8]
    lines = [
        f"审计日志: 共 {len(entries)} 条, 失败/删除 {fail}, 登录 {login}, 活跃用户 {len(actors)}",
        f"操作分布: {', '.join(f'{a}({c})' for a, c in top)}",
        "最近事件:",
    ]
    for e in entries[:20]:
        lines.append(f"  {e.get('ts','')} {e.get('actor','?')} {e.get('action','')} {e.get('detail','')}")
    return "\n".join(lines)


def _g_ops():
    import audit, host_health

    entries = audit.audit_entries(limit=10)
    threat = _honeypot_feed("1d") or {}
    hh = _safe(host_health.host_health) or {}
    load = hh.get("load", {})
    st = threat.get("stats", {})
    attacks = threat.get("attacks", []) if threat else []
    lines = [
        f"运维概览: 审计 {len(entries)} 条, 威胁 {st.get('total_attacks',0)} 次攻击/{st.get('total_banned',0)} 封禁, 主机负载 {load.get('load1','?')}",
        "最近审计:",
    ]
    for e in entries[:10]:
        lines.append(f"  {e.get('ts','')} {e.get('actor','?')} {e.get('action','')}")
    return "\n".join(lines)


def _g_users():
    import users

    ulist = _safe(users.list_users) or []
    roles = {}
    for u in ulist:
        r = u.get("role", "user")
        roles[r] = roles.get(r, 0) + 1
    lines = [
        f"用户总数: {len(ulist)}",
        f"角色分布: {', '.join(f'{r}={c}' for r, c in sorted(roles.items()))}",
        "用户列表:",
    ]
    for u in ulist[:30]:
        lines.append(f"  {u.get('username', u.get('name','?'))} [{u.get('role','?')}]")
    return "\n".join(lines)


def _g_threat_map():
    threat = _honeypot_feed("1d")
    if not threat:
        return None
    st = threat.get("stats", {})
    attacks = threat.get("attacks", [])
    ips = set(a.get("ip") for a in attacks if a.get("ip"))
    banned = sum(1 for a in attacks if a.get("banned"))
    lines = [
        f"威胁统计: 总攻击 {st.get('total_attacks', len(attacks))}, 封禁 {st.get('total_banned', banned)}, 攻击源IP {len(ips)}",
        "最近攻击:",
    ]
    for a in attacks[:15]:
        lines.append(
            f"  {a.get('ip','?')} ({a.get('city','?')}, {a.get('country','?')}) "
            f"{a.get('pattern','?')} x{a.get('count',1)} {'[封禁]' if a.get('banned') else '[活跃]'}"
        )
    return "\n".join(lines)


def _g_mcp():
    import mcp_client

    servers = mcp_client.load_servers()
    enabled = sum(1 for s in servers if s.get("enabled", True))
    lines = [f"MCP 服务器: {len(servers)} 个 ({enabled} 启用, {len(servers) - enabled} 禁用)"]
    for s in servers:
        lines.append(f"  {s.get('name', s.get('id','?'))} [{s.get('transport','stdio')}] {'(禁用)' if s.get('enabled') is False else '(启用)'}")
    return "\n".join(lines)


def _g_dev():
    import agent_conf, mcp_client, llm_conf, llm_usage

    agents = agent_conf.load_agents()
    mcp = mcp_client.load_servers()
    providers = llm_conf.list_providers()
    usage = _safe(llm_usage.total_summary, 7) or {}
    harnesses = [f for f in os.listdir(siteconf.HARNESSES_DIR) if f.endswith(".json")] if os.path.isdir(siteconf.HARNESSES_DIR) else []
    running = sum(1 for a in agents if a.get("run_id"))
    lines = [
        f"开发概览: Agent {len(agents)} 个 ({running} 运行中), MCP {len(mcp)} 个, LLM {len(providers)} 个, Harness {len(harnesses)} 个",
        f"LLM用量: {usage.get('total',0)} tokens, {usage.get('calls',0)} 次调用",
        "Agent列表:",
    ]
    for a in agents[:10]:
        lines.append(f"  {a.get('label', a.get('id','?'))} [{'运行中' if a.get('run_id') else '空闲'}]")
    return "\n".join(lines)


def _g_harness():
    import agent_conf

    agents = agent_conf.load_agents()
    hdir = siteconf.HARNESSES_DIR
    harnesses = [f for f in os.listdir(hdir) if f.endswith(".json")] if os.path.isdir(hdir) else []
    running = sum(1 for a in agents if a.get("run_id"))
    lines = [
        f"Agent 编排: {len(agents)} 个 Agent ({running} 运行中), {len(harnesses)} 个编排",
        "编排:",
    ]
    for h in harnesses[:15]:
        lines.append(f"  {h}")
    return "\n".join(lines)


def _g_llm():
    import llm_conf, llm_usage

    providers = llm_conf.list_providers()
    usage = _safe(llm_usage.total_summary, 7) or {}
    lines = [f"LLM Providers: {len(providers)} 个"]
    for p in providers:
        lines.append(f"  {p.get('name','?')} [{p.get('model','?')}] {'(默认)' if p.get('is_default') else ''} {'(禁用)' if p.get('enabled') is False else ''}")
    lines.append(f"用量: 总Token {usage.get('total',0)}, Prompt {usage.get('prompt',0)}, Completion {usage.get('completion',0)}, 调用 {usage.get('calls',0)} 次")
    return "\n".join(lines)


def _g_shared():
    import shared

    entries = _safe(shared.list_dir, "") or ([], "")
    items = entries[0] if entries else []
    if not items:
        return None
    dirs = sum(1 for e in items if e.get("is_dir"))
    files = len(items) - dirs
    lines = [f"共享目录: {len(items)} 个条目 ({dirs} 目录, {files} 文件)"]
    for e in items[:20]:
        tag = "📁" if e.get("is_dir") else "📄"
        sz = f"({e.get('size',0)})" if not e.get("is_dir") and e.get("size") else ""
        lines.append(f"  {tag} {e.get('name','?')} {sz}")
    return "\n".join(lines)


# ── gatherer registry ──────────────────────────────────────────
GATHERERS = {
    "dashboard": _g_dashboard,
    "pod": _g_pod,
    "gpu": _g_gpu,
    "host": _g_host,
    "fleet": _g_fleet,
    "infra": _g_infra,
    "storage": _g_storage,
    "databases": _g_databases,
    "proxy": _g_proxy,
    "audit": _g_audit,
    "ops": _g_ops,
    "users": _g_users,
    "threat-map": _g_threat_map,
    "mcp": _g_mcp,
    "dev": _g_dev,
    "harness": _g_harness,
    "llm": _g_llm,
    "shared": _g_shared,
}


# ── compute + store ────────────────────────────────────────────
def _compute_one(page):
    """Gather data for *page*, run LLM summary, store in Redis.

    Returns the result dict {content, ts} on success, None on failure.
    Never raises.
    """
    gatherer = GATHERERS.get(page)
    if not gatherer:
        return None
    try:
        ctx = gatherer()
    except Exception as e:
        log.warning("insight: gather failed for %s: %s", page, e)
        return None
    if not ctx or len(ctx) < 10:
        return None

    hint = PROMPT_HINTS.get(page, _DEFAULT_PROMPT)
    prompt = f"{hint}\n\n数据:\n{ctx}"

    try:
        import ai_service
        content = ai_service.analyze_text(prompt, task="summarize", user="insight-bot")
    except Exception as e:
        log.warning("insight: LLM failed for %s: %s", page, e)
        return None
    if not content:
        return None

    result = {"content": content, "ts": time.time()}
    kvcache.set(_PREFIX + page, result, ttl=TTL)
    log.info("insight: computed %s (%d chars)", page, len(content))
    return result


def _sweep():
    """Run one full sweep across all pages, staggered."""
    for page in GATHERERS:
        _compute_one(page)
        time.sleep(PAGE_STAGGER)


# ── background thread ──────────────────────────────────────────
_started = False
_thread = None


def _loop():
    """Main loop. Runs forever, swallows all errors."""
    while True:
        try:
            _sweep()
        except Exception:
            pass
        try:
            time.sleep(INTERVAL)
        except Exception:
            break


def _start_thread():
    """Start the background thread once (idempotent)."""
    global _started, _thread
    if _started:
        return
    try:
        t = threading.Thread(target=_loop, name="insight-precompute", daemon=True)
        t.start()
        _thread = t
        _started = True
        log.info("insight: pre-compute thread started (interval=%ds, %d pages)", INTERVAL, len(GATHERERS))
    except Exception as e:
        log.warning("insight: failed to start thread: %s", e)


# ── public API ─────────────────────────────────────────────────
def get_insight(page):
    """Return cached {content, ts} for *page*, or None."""
    return kvcache.get(_PREFIX + page)


def refresh(page):
    """Force re-compute one page synchronously. Returns {content, ts} or None."""
    return _compute_one(page)


def available_pages():
    """Return list of pages that have a gatherer."""
    return list(GATHERERS.keys())


# Auto-start on import (same pattern as metrics.py)
_start_thread()
