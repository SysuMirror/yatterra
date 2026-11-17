#!/usr/bin/env python3
"""UniSSO 活动资源上限（纯逻辑，无 I/O）。

活动期间，通过 UniSSO 登录、平台 JIT 自动建号（``uni_*``）的用户只能开
小机器：

    CPU ≤ 2 核 · 内存 ≤ 2Gi · 存储 ≤ 5Gi · 禁止 GPU

``admin``/``super`` 豁免；本地账号/其它登录来源的用户也完全不受限。

约束在「创建」时**拒绝**、在「resize」时**夹取**：``api/pods.py`` 是主入口，
``groups.create_group`` 里再按 ``creator`` 兜底复核一次（防 CLI / 其它 API
入口绕过）。上限值可读环境变量覆盖，便于活动结束后放宽或收紧而无需改代码。

本模块只做算术与判定，不碰数据库连接；``is_unisso`` 才按需查一次身份表。
"""
import os
import re

# 活动上限的默认值（可被 YATTERRA_QUOTA_* 覆盖）。
DEFAULTS = {"cpu": 2.0, "mem_gib": 2.0, "storage_gib": 5.0, "gpu_allowed": False}

_EXEMPT_ROLES = ("admin", "super")

_GI = 1024 ** 3
_UNIT_GI = {
    "": 1.0, "gi": 1.0, "mi": 1.0 / 1024, "ki": 1.0 / (1024 ** 2),
    "ti": 1024.0, "pi": 1024.0 ** 2,
    "g": 1e9 / _GI, "m": 1e6 / _GI, "k": 1e3 / _GI, "t": 1e12 / _GI,
}


class QuotaError(ValueError):
    """创建/变更超出活动资源上限（子类 ValueError，路由可直接 400）。"""


def _env_num(key, default):
    raw = os.environ.get(key)
    if raw is None or not str(raw).strip():
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _fmt(n):
    """2.0 → '2'；2.5 → '2.5'（用于提示与夹取值的回填）。"""
    n = float(n)
    return str(int(n)) if n == int(n) else str(n)


def caps():
    """当前生效的活动上限（含展示用字符串）。"""
    cpu = _env_num("YATTERRA_QUOTA_CPU", DEFAULTS["cpu"])
    mem = _env_num("YATTERRA_QUOTA_MEM_GIB", DEFAULTS["mem_gib"])
    sto = _env_num("YATTERRA_QUOTA_STORAGE_GIB", DEFAULTS["storage_gib"])
    gpu_ok = os.environ.get("YATTERRA_QUOTA_ALLOW_GPU", "").strip().lower() \
        in ("1", "true", "yes", "on")
    return {
        "cpu": cpu,
        "mem_gib": mem,
        "storage_gib": sto,
        "gpu_allowed": gpu_ok,
        "mem": f"{_fmt(mem)}Gi",
        "storage": f"{_fmt(sto)}Gi",
    }


def parse_gi(q):
    """数量字符串 → Gi 浮点；无法解析时返回 None（如 '2Gi'→2.0, '512Mi'→0.5）。"""
    if q is None:
        return None
    s = str(q).strip().lower()
    if not s:
        return None
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*([a-z]*)", s)
    if not m:
        return None
    factor = _UNIT_GI.get(m.group(2))
    if factor is None:
        return None
    return float(m.group(1)) * factor


def _num(x):
    try:
        return float(str(x).strip())
    except (TypeError, ValueError):
        return None


def is_unisso(username):
    """该用户名是否来自 UniSSO（``uni_*`` 前缀，或身份表里有 unisso 绑定）。"""
    if not username:
        return False
    if str(username).startswith("uni_"):
        return True
    try:
        import users
        return any((i.get("provider") == "unisso")
                   for i in users.list_identities(str(username)))
    except Exception:
        return False


def _user_obj(x):
    """接受用户 dict 或用户名字符串，统一成 dict（查不到时按 'user' 角色兜底）。"""
    if isinstance(x, dict):
        return x
    if not x:
        return None
    try:
        import users
        u = users.get_user(str(x))
        if u:
            return u
    except Exception:
        pass
    return {"username": str(x), "role": "user"}


def scoped(user):
    """该用户是否受活动上限约束：非 admin/super 且来自 UniSSO。"""
    u = _user_obj(user)
    if not u:
        return False
    if u.get("role") in _EXEMPT_ROLES:
        return False
    return is_unisso(u.get("username"))


def _limit_note(c):
    parts = [f"CPU {_fmt(c['cpu'])} 核", f"内存 {c['mem']}", f"存储 {c['storage']}"]
    if not c["gpu_allowed"]:
        parts.append("无 GPU")
    return " / ".join(parts)


def validate_create(user, cpu=None, mem=None, storage=None, gpus=None):
    """创建校验：受约束用户超限时抛 ``QuotaError``（含中文提示）。"""
    if not scoped(user):
        return
    c = caps()
    if gpus and not c["gpu_allowed"]:
        raise QuotaError(f"活动期间不允许开 GPU（上限：{_limit_note(c)}）")
    if cpu is not None:
        n = _num(cpu)
        if n is not None and n > c["cpu"]:
            raise QuotaError(f"CPU 超出活动上限：最多 {_fmt(c['cpu'])} 核（请求 {_fmt(n)} 核）")
    if mem is not None:
        g = parse_gi(mem)
        if g is not None and g > c["mem_gib"] + 1e-9:
            raise QuotaError(f"内存超出活动上限：最多 {c['mem']}（请求 {mem}）")
    if storage is not None:
        g = parse_gi(storage)
        if g is not None and g > c["storage_gib"] + 1e-9:
            raise QuotaError(f"存储超出活动上限：最多 {c['storage']}（请求 {storage}）")


def clamp_resize(user, cpu=None, mem=None, storage=None):
    """resize 夹取：超限维度压到上限，返回 ``(cpu, mem, storage, clamped)``。

    ``clamped`` 是被夹取的维度名列表（空 = 原样放行）。
    """
    if not scoped(user):
        return cpu, mem, storage, []
    c = caps()
    clamped = []
    if cpu is not None:
        n = _num(cpu)
        if n is not None and n > c["cpu"]:
            cpu = int(c["cpu"]) if float(c["cpu"]).is_integer() else c["cpu"]
            clamped.append("cpu")
    if mem is not None:
        g = parse_gi(mem)
        if g is not None and g > c["mem_gib"] + 1e-9:
            mem = c["mem"]
            clamped.append("mem")
    if storage is not None:
        g = parse_gi(storage)
        if g is not None and g > c["storage_gib"] + 1e-9:
            storage = c["storage"]
            clamped.append("storage")
    return cpu, mem, storage, clamped


def limits(user):
    """供 ``GET /api/pods/limits`` 返回给前端约束表单。"""
    c = caps()
    return {
        "scoped": scoped(user),
        "caps": {
            "cpu": c["cpu"],
            "mem_gib": c["mem_gib"],
            "storage_gib": c["storage_gib"],
            "gpu_allowed": c["gpu_allowed"],
            "mem": c["mem"],
            "storage": c["storage"],
        },
    }
