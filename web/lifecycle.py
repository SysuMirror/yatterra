#!/usr/bin/env python3
"""Group lifecycle ops via kubectl in the group namespace.

Every public function is defensive: any exception is caught and returned as an
error-bearing default value. Nothing here ever raises.
"""
import json
import subprocess

import kvcache

import siteconf

NS = siteconf.GROUP_NS
KUBECTL = "kubectl"
_DEFAULT_TIMEOUT = 30


def _run(args, timeout=_DEFAULT_TIMEOUT):
    """Run kubectl -n NS <args>. Returns (rc, stdout, stderr). Never raises."""
    try:
        cmd = [KUBECTL, "-n", NS] + list(args)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout or "", r.stderr or ""
    except Exception as e:
        return 99, "", str(e)


def _deploy(name):
    return f"group-{name}"


def start_group(name):
    """Scale deployment/group-{name} to 1. Returns dict {ok, msg, error}."""
    try:
        rc, out, err = _run(["scale", f"deployment/{_deploy(name)}", "--replicas=1"])
        if rc != 0:
            return {"ok": False, "msg": "", "error": err.strip() or f"scale failed rc={rc}"}
        kvcache.delete(f"lifecycle:{name}")
        kvcache.delete("pod:statuses")
        kvcache.delete("pod:names")
        return {"ok": True, "msg": f"已启动 {name}", "error": ""}
    except Exception as e:
        return {"ok": False, "msg": "", "error": str(e)}


def stop_group(name):
    """Scale deployment/group-{name} to 0. Returns dict {ok, msg, error}."""
    try:
        rc, out, err = _run(["scale", f"deployment/{_deploy(name)}", "--replicas=0"])
        if rc != 0:
            return {"ok": False, "msg": "", "error": err.strip() or f"scale failed rc={rc}"}
        kvcache.delete(f"lifecycle:{name}")
        kvcache.delete("pod:statuses")
        kvcache.delete("pod:names")
        return {"ok": True, "msg": f"已停止 {name}", "error": ""}
    except Exception as e:
        return {"ok": False, "msg": "", "error": str(e)}


def restart_group(name):
    """kubectl rollout restart deployment/group-{name}. Returns dict."""
    try:
        rc, out, err = _run(["rollout", "restart", f"deployment/{_deploy(name)}"])
        if rc != 0:
            return {"ok": False, "msg": "", "error": err.strip() or f"rollout failed rc={rc}"}
        kvcache.delete(f"lifecycle:{name}")
        kvcache.delete(f"events:{name}")
        kvcache.delete("pod:statuses")
        kvcache.delete("pod:names")
        return {"ok": True, "msg": f"已重启 {name}", "error": ""}
    except Exception as e:
        return {"ok": False, "msg": "", "error": str(e)}


def group_logs(name, lines=300):
    """kubectl logs --tail for the group pod. Returns dict {ok, logs, error}."""
    try:
        n = int(lines)
        if n <= 0:
            n = 300
    except Exception:
        n = 300
    try:
        rc, out, err = _run(
            ["logs", f"deployment/{_deploy(name)}", "--tail", str(n), "--timestamps"],
            timeout=40,
        )
        if rc != 0:
            return {"ok": False, "logs": "", "error": err.strip() or f"logs failed rc={rc}"}
        return {"ok": True, "logs": out, "error": ""}
    except Exception as e:
        return {"ok": False, "logs": "", "error": str(e)}


def _group_events_raw(name):
    """Raw kubectl get events for a group. Returns list[dict]."""
    empty = []
    rc, out, err = _run(
        ["get", "events", "--field-selector",
         f"involvedObject.name={_deploy(name)}",
         "-o", "json"],
    )
    if rc != 0:
        # fall back: try without field selector filter (broader)
        rc, out, err = _run(["get", "events", "-o", "json"])
        if rc != 0:
            return empty
    try:
        data = json.loads(out)
    except Exception:
        return empty
    items = data.get("items", []) if isinstance(data, dict) else []
    results = []
    dep = _deploy(name)
    for it in items:
        try:
            involved = it.get("involvedObject", {}) or {}
            iname = involved.get("name", "")
            # keep events for the deployment or its pods (group-{name}-xxxx)
            if dep not in iname:
                continue
            results.append({
                "type": it.get("type", "") or "",
                "reason": it.get("reason", "") or "",
                "message": it.get("message", "") or "",
                "lastTimestamp": it.get("lastTimestamp", "") or "",
            })
        except Exception:
            continue
    # newest first
    try:
        results.sort(key=lambda x: x.get("lastTimestamp", ""), reverse=True)
    except Exception:
        pass
    return results


def group_events(name):
    """kubectl get events related to group, as list[dict] with
    type/reason/message/lastTimestamp. Cached in Redis for 30s. Never raises."""
    cached = kvcache.get(f"events:{name}")
    if cached is not None:
        return cached
    try:
        result = _group_events_raw(name)
        kvcache.set(f"events:{name}", result, ttl=30)
        return result
    except Exception:
        return []


def _group_state_raw(name):
    """Raw kubectl get deployment + pod phase. Returns dict."""
    default = {
        "ok": False,
        "name": name,
        "replicas": 0,
        "readyReplicas": 0,
        "phase": "Unknown",
        "age": "",
        "error": "",
    }
    rc, out, err = _run(["get", "deployment", _deploy(name), "-o", "json"])
    if rc != 0:
        d = dict(default)
        d["error"] = err.strip() or f"deployment not found rc={rc}"
        d["phase"] = "NotFound"
        return d
    try:
        data = json.loads(out)
    except Exception as e:
        d = dict(default)
        d["error"] = f"json parse: {e}"
        return d
    spec_rep = 0
    ready_rep = 0
    created = ""
    try:
        spec_rep = int((data.get("spec", {}) or {}).get("replicas", 0) or 0)
    except Exception:
        spec_rep = 0
    try:
        ready_rep = int((data.get("status", {}) or {}).get("readyReplicas", 0) or 0)
    except Exception:
        ready_rep = 0
    try:
        created = (((data.get("metadata", {}) or {}).get("creationTimestamp")) or "")
    except Exception:
        created = ""

    # pod phase
    phase = "Unknown"
    try:
        prc, pout, perr = _run(
            ["get", "pod", "-l", f"app={_deploy(name)}",
             "-o", "jsonpath={.items[0].status.phase}"],
        )
        if prc == 0 and pout.strip():
            phase = pout.strip()
        elif prc == 0:
            phase = "NoPod"
    except Exception:
        phase = "Unknown"

    d = dict(default)
    d.update({
        "ok": True,
        "replicas": spec_rep,
        "readyReplicas": ready_rep,
        "phase": phase,
        "age": created,
        "error": "",
    })
    return d


def group_state(name):
    """kubectl get deployment -o json -> replicas/readyReplicas + pod phase + age.
    Cached in Redis for 10s. Returns dict. Never raises."""
    cached = kvcache.get(f"lifecycle:{name}")
    if cached is not None:
        return cached
    default = {
        "ok": False, "name": name, "replicas": 0,
        "readyReplicas": 0, "phase": "Unknown", "age": "", "error": "",
    }
    try:
        result = _group_state_raw(name)
        kvcache.set(f"lifecycle:{name}", result, ttl=10)
        return result
    except Exception as e:
        d = dict(default)
        d["error"] = str(e)
        return d


def group_lifecycle(name, log_lines=300):
    """Convenience aggregator returning everything the template needs in one
    dict: {state, logs, events}. Never raises."""
    try:
        return {
            "state": group_state(name),
            "logs": group_logs(name, log_lines),
            "events": group_events(name),
        }
    except Exception as e:
        return {
            "state": {"ok": False, "name": name, "replicas": 0, "readyReplicas": 0,
                      "phase": "Unknown", "age": "", "error": str(e)},
            "logs": {"ok": False, "logs": "", "error": str(e)},
            "events": [],
        }
