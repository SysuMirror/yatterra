#!/usr/bin/env python3
"""ARTEX 自主渗透平台客户端 — 驱动端到端渗透测试。

ARTEX(github.com/mhtsec/ARTEX)部署在 `clouds/group-artex` pod，Go 单体后端，
把 Next.js 前端内嵌在二进制里，对外是纯 REST：
  POST /api/tasks                       建任务(description + goal) → 自动起跑
  GET  /api/tasks                       任务列表 + 当前 active
  GET  /api/exploration/findings        漏洞结果(可分页/按任务/按等级过滤)
  GET  /api/stats                       全局统计(资产/流量/引擎状态)
  POST /api/tasks/{id}/control          pause / resume

鉴权只有一条路：JWT(HS256, sub=ARTEX, TTL 7 天)。没有服务 token / API key。
本模块直接读 ARTEX 的签名密钥 `jwt.key`(32 随机字符)自签 token —— 这样平台侧
不必持有 ARTEX 的管理员口令，也不会因管理员改密而失效。密钥路径/URL 走
`siteconf.ARTEX_URL` / `siteconf.ARTEX_KEY_FILE`(env 可覆盖)。

纯 stdlib；任何网络/解析错误都收敛成 (ok, ...) 或抛 ArtexError，绝不 500。
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request

import siteconf

log = logging.getLogger(__name__)

BASE = siteconf.ARTEX_URL.rstrip("/")
KEY_FILE = siteconf.ARTEX_KEY_FILE
_TIMEOUT = float(os.environ.get("YATTERRA_ARTEX_TIMEOUT", "30"))

_tok_cache = {"token": None, "exp": 0}


class ArtexError(RuntimeError):
    pass


# ── JWT 自签 ────────────────────────────────────────────────────────────────
def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=")


def _mint():
    try:
        key = open(KEY_FILE, "rb").read().strip()
    except OSError as e:
        raise ArtexError(f"读不到 ARTEX 签名密钥 {KEY_FILE}: {e}")
    if len(key) < 16:
        raise ArtexError("ARTEX 签名密钥异常(过短)")
    now = int(time.time())
    exp = now + 3600  # 自签 1h，比 ARTEX 的 7 天短——过期内按需重签
    hdr = _b64(json.dumps({"alg": "HS256", "typ": "JWT"},
                          separators=(",", ":")).encode())
    pl = _b64(json.dumps({"sub": "ARTEX", "iat": now, "exp": exp},
                         separators=(",", ":")).encode())
    sig = _b64(hmac.new(key, hdr + b"." + pl, hashlib.sha256).digest())
    return (hdr + b"." + pl + b"." + sig).decode(), exp


def _token(force=False):
    if not force and _tok_cache["token"] and _tok_cache["exp"] - 60 > time.time():
        return _tok_cache["token"]
    tok, exp = _mint()
    _tok_cache.update(token=tok, exp=exp)
    return tok


# ── HTTP ────────────────────────────────────────────────────────────────────
def _request(method, path, body=None, retry=True):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + _token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 401 and retry:
            _token(force=True)  # 可能密钥轮换了/时钟偏差，重签一次
            return _request(method, path, body, retry=False)
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise ArtexError(f"ARTEX {method} {path} → HTTP {e.code} {detail}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ArtexError(f"连不上 ARTEX({BASE}): {e}")


def _get(path):
    return _request("GET", path)


def _post(path, body):
    return _request("POST", path, body)


# ── 对外 API ────────────────────────────────────────────────────────────────
def status():
    """连通性 + 全局统计 + 任务概览。失败也返回结构体（ok=False），不抛。"""
    out = {"ok": False, "url": BASE, "reachable": False}
    try:
        h = _get("/api/health")
        out["reachable"] = bool(h.get("ok"))
        out["version"] = h.get("version")
    except ArtexError as e:
        out["error"] = str(e)
        return out
    try:
        out["stats"] = _get("/api/stats")
    except ArtexError:
        pass
    try:
        tasks = list_tasks()
        out["tasks"] = tasks.get("tasks", [])
        out["active"] = tasks.get("active")
        out["ok"] = True
    except ArtexError as e:
        out["error"] = str(e)
    return out


def list_tasks():
    d = _get("/api/tasks")
    return {"tasks": d.get("tasks", []) or [], "active": d.get("active") or ""}


def create_task(description, goal="", name=None, category_id=None,
                company_ids=None, timeout_seconds=None):
    """建一个渗透任务并让它自动起跑。返回 TaskDTO。"""
    body = {"description": (description or "").strip() or "未命名任务",
            "goal": (goal or "").strip()}
    if name:
        body["name"] = name
    if category_id:
        body["category_id"] = category_id
    if company_ids:
        body["company_ids"] = company_ids
    if timeout_seconds:
        body["timeout_seconds"] = int(timeout_seconds)
    return _post("/api/tasks", body)


def task_detail(task_id):
    return _get(f"/api/tasks/{task_id}")


def control_task(task_id, action):
    if action not in ("pause", "resume"):
        raise ValueError("action 只能是 pause/resume")
    return _post(f"/api/tasks/{task_id}/control", {"action": action})


def set_active(task_id):
    return _post("/api/active", {"id": str(task_id)})


def list_findings(task=None, severity=None, status=None, q=None,
                  page=1, limit=50):
    """漏洞结果。带 page/limit 时 ARTEX 返回 {items,total,page,page_size}。"""
    from urllib.parse import urlencode
    params = {"page": int(page), "limit": int(limit)}
    if task:
        params["task"] = str(task)
    if severity:
        params["severity"] = severity
    if status:
        params["status"] = status
    if q:
        params["q"] = q
    return _get("/api/exploration/findings?" + urlencode(params))


def finding_detail(fid):
    return _get(f"/api/exploration/findings/{fid}")


def findings_stats():
    return _get("/api/exploration/findings/stats")
