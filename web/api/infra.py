"""Infrastructure API blueprint — /api/infra

Host health, remote hosts, metrics, storage (MinIO), databases, proxy mappings.
"""
import json as _json
import subprocess as _sp
from importlib import import_module
from flask import Blueprint, request, jsonify, g
from middleware.error_handler import ApiError, not_found, bad_request

import siteconf
import host_health, remote_hosts, metrics
import cpu_stats
import gpu_stats
import minio_svc as minio_mod
import db_svc as db_mod
import proxy_map
users = import_module("users")
import audit

from api._auth import require_auth, require_pod, current_username, current_user_obj

infra_bp = Blueprint("api_infra", __name__, url_prefix="/api/infra")


import fleet_monitor as _fleet
import time as _time
import math as _math


@infra_bp.route("/fleet", methods=["GET"])
@require_auth("infra.host")
def infra_fleet():
    """Cached fleet readings; never SSH in an HTTP request."""
    return jsonify(_fleet.snapshot())


@infra_bp.route("/fleet/<host_id>/history", methods=["GET"])
@require_auth("infra.host")
def infra_fleet_history(host_id):
    if host_id not in {h["id"] for h in _fleet.inventory()}:
        raise not_found("Fleet host not found")
    try:
        windows = {"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800}
        window = windows[request.args.get("range", "1h")]
        until = float(request.args.get("until", _time.time()))
        if not _math.isfinite(until):
            raise ValueError("until must be finite")
        until = min(until, _time.time())
        since = float(request.args.get("since", until - window))
        limit = int(request.args.get("limit", 240))
        samples = _fleet.Store().history(host_id, since, until, limit)
    except (ValueError, KeyError, OverflowError):
        raise bad_request("Invalid history query: use finite since/until (max 7 days), range 15m/1h/6h/24h/7d, limit 2..2000")
    return jsonify({"schema_version": 1, "host": host_id, "since": since,
                    "until": until, "samples": samples})


# ── host ──────────────────────────────────────────────────────

@infra_bp.route("/host", methods=["GET"])
@require_auth("infra.host")
def infra_host():
    """Host health data."""
    return jsonify(host_health.host_health())


@infra_bp.route("/gpu", methods=["GET"])
@require_auth("infra.host")
def infra_gpu():
    """Per-GPU stats: utilization, memory, temperature, power, assigned groups."""
    return jsonify(gpu_stats.gpu_stats())


@infra_bp.route("/remote-hosts", methods=["GET"])
@require_auth("infra.host")
def infra_remote_hosts():
    """Remote hosts list."""
    return jsonify({"hosts": remote_hosts.all_hosts()})


@infra_bp.route("/metrics", methods=["GET"])
@require_auth("infra.host")
def infra_metrics():
    """System metrics snapshot."""
    return jsonify(metrics.metrics_snapshot())


@infra_bp.route("/cpu-stats", methods=["GET"])
@require_auth("infra.host")
def infra_cpu_stats():
    """CPU stats including per-group resource usage."""
    return jsonify(cpu_stats.cpu_stats())


def _parse_cpu_q(s):
    """Parse Kubernetes CPU quantities into cores (decimal SI supported)."""
    try:
        s = str(s).strip()
        for suffix, factor in (("n", 1e-9), ("u", 1e-6), ("m", 1e-3), ("k", 1e3)):
            if s.endswith(suffix):
                return float(s[:-len(suffix)]) * factor
        return float(s)
    except Exception:
        return 0.0


def _parse_mem_gi_q(s):
    """Parse Kubernetes memory quantities into Gi (binary and decimal SI)."""
    try:
        s = str(s).strip()
        units = {"Ki": 2 ** 10, "Mi": 2 ** 20, "Gi": 2 ** 30, "Ti": 2 ** 40,
                 "K": 10 ** 3, "M": 10 ** 6, "G": 10 ** 9, "T": 10 ** 12}
        for suffix, bytes_per_unit in units.items():
            if s.endswith(suffix):
                return float(s[:-len(suffix)]) * bytes_per_unit / (2 ** 30)
        return float(s) / (2 ** 30)
    except Exception:
        return 0.0


@infra_bp.route("/cpu-requests", methods=["GET"])
@require_auth("infra.host")
def infra_cpu_requests():
    """Per-pod CPU/memory requests + limits (live from k8s) for the pie chart.

    Reads the actual running pods so in-place /resize values are reflected.
    Returns: {allocatable_cpu, allocatable_mem_gi, used_cpu, used_mem_gi,
              pods: [{name, cpu_request, cpu_limit, mem_request_gi,
                      mem_limit_gi, phase}]}
    """
    NS = siteconf.GROUP_NS
    pods_out = []
    used_cpu = 0.0
    used_mem = 0.0
    alloc_cpu = 0.0
    alloc_mem = 0.0
    try:
        r = _sp.run(["kubectl", "get", "pods", "-n", NS, "-o", "json"],
                    capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            data = _json.loads(r.stdout)
            for p in data.get("items", []):
                name = p.get("metadata", {}).get("name", "")
                phase = p.get("status", {}).get("phase", "Unknown")
                # only count scheduled/running pods toward requests
                cspec = (p.get("spec", {}).get("containers") or [{}])[0]
                res = cspec.get("resources", {}) or {}
                req = res.get("requests", {}) or {}
                lim = res.get("limits", {}) or {}
                cr = _parse_cpu_q(req.get("cpu", "0"))
                ml = _parse_cpu_q(lim.get("cpu", "0"))
                mr = _parse_mem_gi_q(req.get("memory", "0"))
                mml = _parse_mem_gi_q(lim.get("memory", "0"))
                if phase in ("Running", "Pending"):
                    used_cpu += cr
                    used_mem += mr
                pods_out.append({
                    "name": name,
                    "cpu_request": round(cr, 3),
                    "cpu_limit": round(ml, 3),
                    "mem_request_gi": round(mr, 3),
                    "mem_limit_gi": round(mml, 3),
                    "phase": phase,
                })
    except Exception:
        pass
    # node allocatable
    try:
        r = _sp.run(["kubectl", "get", "nodes", "-o", "json"],
                    capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            for n in _json.loads(r.stdout).get("items", []):
                a = n.get("status", {}).get("allocatable", {}) or {}
                alloc_cpu += _parse_cpu_q(a.get("cpu", "0"))
                alloc_mem += _parse_mem_gi_q(a.get("memory", "0"))
    except Exception:
        pass
    pods_out.sort(key=lambda x: x["cpu_request"], reverse=True)
    return jsonify({
        "allocatable_cpu": round(alloc_cpu, 2),
        "allocatable_mem_gi": round(alloc_mem, 2),
        "used_cpu": round(used_cpu, 2),
        "used_mem_gi": round(used_mem, 2),
        "pods": pods_out,
    })


# ── storage (MinIO) ──────────────────────────────────────────

@infra_bp.route("/storage", methods=["GET"])
@require_auth("infra.storage.read")
def infra_storage():
    """MinIO status, buckets, and keys.

    Root credentials (conf) and per-key secrets are only included for
    users holding the write perm (infra.storage); read-only viewers
    get status/buckets/key metadata without secrets.
    """
    _uo = current_user_obj() or {}
    _can_manage = users.has_perm(_uo, "infra.storage")
    st = minio_mod.status()
    out = {"status": st, "buckets": [], "keys": minio_mod.list_keys()}
    if _can_manage:
        out["conf"] = minio_mod.conf()
    else:
        out["keys"] = [{k: v for k, v in key.items() if k != "secret"}
                       for key in out["keys"]]
    if st.get("ready"):
        try:
            out["buckets"] = minio_mod.buckets()
        except Exception as e:
            out["error"] = str(e)
    return jsonify(out)


@infra_bp.route("/storage/ensure", methods=["POST"])
@require_auth("infra.storage")
def infra_storage_ensure():
    """Deploy / ensure MinIO is running."""
    ok, msg = minio_mod.ensure()
    audit.record("api_storage_ensure", detail=f"ok={ok}", actor=current_username() or "unknown")
    if not ok:
        return jsonify({"ok": False, "message": msg}), 500
    return jsonify({"ok": True, "message": msg})


@infra_bp.route("/storage/buckets", methods=["POST"])
@require_auth("infra.storage")
def infra_storage_bucket_create():
    """Create a MinIO bucket."""
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        raise bad_request("Bucket name is required")
    try:
        minio_mod.make_bucket(name)
        audit.record("api_bucket_add", detail=name, actor=current_username() or "unknown")
        return jsonify({"ok": True}), 201
    except Exception as e:
        raise bad_request(str(e))


@infra_bp.route("/storage/buckets/<name>", methods=["DELETE"])
@require_auth("infra.storage")
def infra_storage_bucket_delete(name):
    """Delete a MinIO bucket."""
    force = request.args.get("force", "0") in ("1", "true", "yes")
    try:
        minio_mod.remove_bucket(name, force=force)
        audit.record("api_bucket_delete", detail=name, actor=current_username() or "unknown")
        return jsonify({"ok": True})
    except Exception as e:
        raise bad_request(str(e))


@infra_bp.route("/storage/keys", methods=["POST"])
@require_auth("infra.storage")
def infra_storage_key_create():
    """Create a MinIO access key."""
    body = request.get_json(silent=True) or {}
    label = (body.get("label") or "").strip()
    bucket = (body.get("bucket") or "").strip()
    perm = (body.get("perm") or "readwrite").strip()
    try:
        rec = minio_mod.add_key(label, bucket, perm)
        audit.record("api_key_add", detail=f"{label} bucket={bucket} perm={perm}",
                     actor=current_username() or "unknown")
        return jsonify({"ok": True, "key": rec}), 201
    except Exception as e:
        raise bad_request(str(e))


@infra_bp.route("/storage/keys/<kid>", methods=["DELETE"])
@require_auth("infra.storage")
def infra_storage_key_delete(kid):
    """Delete a MinIO access key."""
    try:
        minio_mod.remove_key(kid)
        audit.record("api_key_delete", detail=kid, actor=current_username() or "unknown")
        return jsonify({"ok": True})
    except Exception as e:
        raise bad_request(str(e))


# ── databases ────────────────────────────────────────────────

@infra_bp.route("/databases", methods=["GET"])
@require_auth("infra.db.read")
def infra_databases():
    """Database status and credentials.

    Root passwords (conf/root) and per-cred secrets are only included
    for users holding the write perm (infra.db); read-only viewers
    get status + cred metadata without secrets.
    """
    _uo = current_user_obj() or {}
    _can_manage = users.has_perm(_uo, "infra.db")
    out = {"status": db_mod.status(), "creds": db_mod.list_creds()}
    if _can_manage:
        conf = db_mod.conf()
        out["conf"] = conf
        if conf:
            out["root"] = conf
    else:
        out["creds"] = [{k: v for k, v in c.items() if k != "secret"}
                        for c in out["creds"]]
    return jsonify(out)


@infra_bp.route("/databases/ensure", methods=["POST"])
@require_auth("infra.db")
def infra_databases_ensure():
    """Deploy / ensure databases are running."""
    ok, msg = db_mod.ensure()
    audit.record("api_db_ensure", detail=f"ok={ok}", actor=current_username() or "unknown")
    if not ok:
        return jsonify({"ok": False, "message": msg}), 500
    return jsonify({"ok": True, "message": msg})


@infra_bp.route("/databases/creds", methods=["POST"])
@require_auth("infra.db")
def infra_databases_cred_create():
    """Issue a database credential."""
    body = request.get_json(silent=True) or {}
    service = (body.get("service") or "").strip()
    if service not in ("mysql", "redis", "qdrant"):
        raise bad_request("service must be mysql, redis, or qdrant")
    # Accept the frontend group name while retaining the API label field.
    label = (body.get("label") or body.get("group") or "").strip()
    try:
        rec = db_mod.add_cred(service, label)
        audit.record("api_db_cred_add", detail=f"{service} {rec.get('label', '')}",
                     actor=current_username() or "unknown")
        return jsonify({"ok": True, "cred": rec}), 201
    except Exception as e:
        raise bad_request(str(e))


@infra_bp.route("/databases/creds/<kid>", methods=["DELETE"])
@require_auth("infra.db")
def infra_databases_cred_delete(kid):
    """Revoke a database credential."""
    try:
        db_mod.remove_cred(kid)
        audit.record("api_db_cred_delete", detail=kid, actor=current_username() or "unknown")
        return jsonify({"ok": True})
    except Exception as e:
        raise bad_request(str(e))


# ── proxy ────────────────────────────────────────────────────

def _is_proxy_admin(user):
    """Global proxy admin: super/admin role or the infra.proxy permission."""
    if not user:
        return False
    if user.get("role") in ("super", "admin"):
        return True
    try:
        return users.has_perm(user, "infra.proxy")
    except Exception:
        return False


def _user_pod_names(user):
    """Names of pods the user is owner or member of."""
    import groups as groups_mod
    users_mod = import_module("users")
    try:
        pods = groups_mod.load_state()["groups"]
    except Exception:
        return set()
    return {name for name, p in pods.items()
            if users_mod.pod_role(user, p) is not None}


@infra_bp.route("/proxy", methods=["GET"])
@require_auth()
def infra_proxy_list():
    """List proxy mappings.

    Global proxy admins (infra.proxy / super / admin) get the full status
    overview; everyone else only sees mappings bound to their own pods.
    """
    user = g.api_user
    st = proxy_map.status()
    if _is_proxy_admin(user):
        return jsonify(st)
    mine = _user_pod_names(user)
    st["mappings"] = [m for m in st.get("mappings", []) if m.get("pod") in mine]
    return jsonify(st)


@infra_bp.route("/proxy", methods=["POST"])
@require_auth("infra.proxy")
def infra_proxy_add():
    """Add a proxy mapping (global admin path; may assign any pod or none)."""
    body = request.get_json(silent=True) or {}
    sub = str(body.get("subdomain") or "").strip()
    port = str(body.get("port") or "").strip()
    note = str(body.get("note") or "").strip()
    pod = body.get("pod")
    pod = str(pod).strip() if pod else None
    if pod:
        import groups as groups_mod
        if pod not in groups_mod.load_state()["groups"]:
            raise bad_request(f"Pod {pod} not found")
    ok, msg = proxy_map.add(sub, port, note, pod=pod)
    if not ok:
        raise bad_request(msg)
    audit.record("api_proxy_add", detail=f"{sub}:{port} pod={pod}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "message": msg}), 201


@infra_bp.route("/proxy/<pid>", methods=["PUT"])
@require_auth("infra.proxy")
def infra_proxy_update(pid):
    """Update a proxy mapping (global admin path)."""
    body = request.get_json(silent=True) or {}
    # proxy_map doesn't have a native update; we remove + re-add
    mappings = proxy_map.list_mappings()
    existing = next((m for m in mappings if m.get("id") == pid), None)
    if not existing:
        raise not_found(f"Proxy mapping {pid} not found")
    # Remove old, add new
    proxy_map.remove(pid)
    sub = str(body.get("subdomain") or existing.get("subdomain") or "").strip()
    port = str(body.get("port") or existing.get("port") or "").strip()
    note = str(body.get("note") or existing.get("note") or "").strip()
    pod = body.get("pod", existing.get("pod"))
    pod = str(pod).strip() if pod else None
    ok, msg = proxy_map.add(sub, port, note, pod=pod)
    if not ok:
        # restore the removed record
        proxy_map._save(mappings)
        raise bad_request(msg)
    audit.record("api_proxy_update", detail=f"{pid}→{sub}:{port} pod={pod}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "message": msg})


@infra_bp.route("/proxy/<pid>", methods=["DELETE"])
@require_auth("infra.proxy")
def infra_proxy_delete(pid):
    """Delete a proxy mapping (global admin path, incl. unassigned ones)."""
    ok, msg = proxy_map.remove(pid)
    if not ok:
        raise not_found(msg or f"Proxy mapping {pid} not found")
    audit.record("api_proxy_delete", detail=pid, actor=current_username() or "unknown")
    return jsonify({"ok": True})


# ── pod-scoped proxy ─────────────────────────────────────────

@infra_bp.route("/pods/<name>/proxy", methods=["GET"])
@require_pod("member")
def pod_proxy_list(name):
    """Mappings bound to this pod + the pod's selectable service ports."""
    mappings = [m for m in proxy_map.list_mappings() if m.get("pod") == name]
    return jsonify({"mappings": mappings, "ports": proxy_map.pod_ports(g.api_pod)})


@infra_bp.route("/pods/<name>/proxy", methods=["POST"])
@require_pod("member")
def pod_proxy_add(name):
    """Add a mapping for this pod.

    Self-service: the caller supplies only a prefix; the port is derived from
    the pod's own public ports (web first, then ssh). An explicit ``port`` is
    still honoured if it is one of *this pod's* ports — a caller can never bind
    a mapping to another pod's port.
    """
    body = request.get_json(silent=True) or {}
    sub = str(body.get("subdomain") or "").strip()
    note = str(body.get("note") or "").strip()
    ports = proxy_map.pod_ports(g.api_pod)
    if not ports:
        raise bad_request("该 Pod 没有可用的公网端口")
    allowed = {p["port"] for p in ports}
    port = body.get("port")
    if port in (None, ""):
        # auto-bind: prefer the web port, fall back to the first available
        port = next((p["port"] for p in ports if p["key"] == "web_public"), ports[0]["port"])
    try:
        port = int(port)
    except (TypeError, ValueError):
        raise bad_request("端口必须是该 Pod 的公网端口 (web/ssh)")
    if port not in allowed:
        raise bad_request("端口必须是该 Pod 的公网端口 (web/ssh)")
    ok, msg = proxy_map.add(sub, port, note, pod=name)
    if not ok:
        raise bad_request(msg)
    audit.record("api_proxy_add", detail=f"{sub}:{port} pod={name}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "message": msg}), 201


@infra_bp.route("/pods/<name>/proxy/<pid>", methods=["PUT"])
@require_pod("member")
def pod_proxy_update(name, pid):
    """Toggle/update a mapping of this pod (toggle enabled / edit note)."""
    body = request.get_json(silent=True) or {}
    rec = next((m for m in proxy_map.list_mappings()
                if m.get("id") == pid), None)
    if not rec or rec.get("pod") != name:
        raise not_found(f"Proxy mapping {pid} not found for pod {name}")
    if "subdomain" in body and str(body.get("subdomain")).strip().lower() != rec.get("subdomain"):
        ok, msg = proxy_map.rename(pid, str(body.get("subdomain")))
        if not ok:
            raise bad_request(msg)
        pid = str(body.get("subdomain")).strip().lower()
    if "enabled" in body and bool(body["enabled"]) != bool(rec.get("enabled", True)):
        ok, msg = proxy_map.toggle(pid)
        if not ok:
            raise bad_request(msg)
    if "note" in body and str(body.get("note")).strip() != rec.get("note"):
        ok, msg = proxy_map.set_note(pid, str(body.get("note")).strip())
        if not ok:
            raise bad_request(msg)
    audit.record("api_proxy_update", detail=f"{pid} pod={name}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True})


@infra_bp.route("/pods/<name>/proxy/<pid>", methods=["DELETE"])
@require_pod("member")
def pod_proxy_delete(name, pid):
    """Delete a mapping of this pod."""
    rec = next((m for m in proxy_map.list_mappings()
                if m.get("id") == pid), None)
    if not rec or rec.get("pod") != name:
        raise not_found(f"Proxy mapping {pid} not found for pod {name}")
    ok, msg = proxy_map.remove(pid)
    if not ok:
        raise bad_request(msg)
    audit.record("api_proxy_delete", detail=f"{pid} pod={name}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True})
