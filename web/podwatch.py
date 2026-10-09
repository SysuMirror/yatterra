#!/usr/bin/env python3
"""Per-pod code-change watcher + project-profile maintainer.

A daemon thread periodically walks each running pod's persistent home
(hostPath: <GROUP_DATA_ROOT>/<name>/home — the web process runs as root, so it
reads it directly, no exec needed), builds a manifest of code-relevant files,
and diffs it against the previous sweep. When something changed it asks the
configured LLM (llm_conf.get_active(), i.e. whatever is selected in
开发→LLM 配置) to summarize *what changed* and to maintain a per-pod
"项目画像" (what the project inside that container does). Large changes /
first-time pods escalate to a subagent that inspects the container in place.

The rendered profile is also written to the insight cache key
"insight:pod:<name>" (via kvcache) so the Pod detail AI-insight panel shows it
instantly — that is the fix for the detail page reusing the list page's
cluster-wide insight.

Architecture mirrors insight.py / metrics.py: single daemon thread started on
import, idempotent, swallows all errors, survives worker recycling
(gunicorn workers=1 + max_requests → exactly one thread; app.py imports this
module for its side effect).

State layout (under <platform root>/podwatch/):
  state/<pod>.json     {relpath: [size, mtime, sha1]}  (previous manifest)
  profiles/<pod>.json  structured profile + recent-change ring
  profiles/<pod>.md    human-readable rendering
"""
import hashlib
import json
import logging
import os
import re
import threading
import time

import siteconf

log = logging.getLogger(__name__)

# ── tunables ───────────────────────────────────────────────────
INTERVAL = 600                 # seconds between sweeps (10 min)
INSIGHT_TTL = 3600             # per-pod insight cache TTL (> INTERVAL)
_MAX_FILE = 256 * 1024         # skip files bigger than this for hashing/reading
_MAX_FILES = 8000              # per-pod cap on tracked files
_MAX_CTX = 14000               # max chars of change context fed to the LLM
_MAX_MAP_CTX = 2200            # max chars of podcode code map fed to the LLM
_DIFF_LINES = 120              # max unified-diff lines per modified file
_HEAD_LINES = 60               # max lines shown for a new file
_BIG_CHANGE = 5                # >= this many changed files → deep-scan eligible
_DEEP_SCAN = True              # allow subagent deep scans
_DEEP_MAX_PER_CYCLE = 1        # bound subagent cost per sweep
_PROFILE_HISTORY = 20          # recent-change entries kept per pod

# ── risk → alert bridge tunables ───────────────────────────────
# When the LLM flags a change as high-risk (structured risk_level == "high")
# we push it to the pod's members through pwa_alerts' at-most-once channel
# (same SQLite claim as pod-down alerts). See _high_risk: prose keywords are
# only a fallback for replies that lack a risk_level, never an override of an
# explicit low/none verdict. Set YATTERRA_PODWATCH_RISK_ALERT=0 to disable
# without a redeploy.
RISK_ALERT = os.environ.get("YATTERRA_PODWATCH_RISK_ALERT", "1").strip().lower() not in (
    "0", "false", "no", "off", "")
_RISK_KEYWORDS = (
    "高危", "高风险", "严重", "致命", "崩溃", "数据丢失", "数据泄露", "数据损坏",
    "安全漏洞", "漏洞", "注入", "后门", "木马", "挖矿", "勒索", "提权", "越权",
    "删库", "灾难", "不可逆", "篡改", "泄露",
    "critical", "severe", "high risk", "data loss", "leak", "vulnerab",
    "backdoor", "malware", "ransom", "privilege escal",
)
_RISK_URL = "/pods/{pod}"        # deep-link target for a risk alert
_SUGGEST_URL = "/ops/approvals"  # deep-link target once a remedy is queued

_BOT_USER = "podwatch-bot"       # synthetic actor for LLM usage / audit / perms

# Profile fields that carry no information. Some models answer the profile
# prompt with a single placeholder letter ("p"/"s"/"e"/"m"); storing those is
# worse than storing nothing — they overwrite a good profile and get rendered
# into the insight panel as "项目：p / 技术栈：s".
_PLACEHOLDER = {"", "-", "?", "n/a", "na", "none", "null", "无", "无。", "未知", "unknown", "todo"}

_ROOT = siteconf.path("podwatch")
_STATE_DIR = os.path.join(_ROOT, "state")
_PROFILE_DIR = os.path.join(_ROOT, "profiles")
_INSIGHT_PREFIX = "insight:pod:"     # → real key yt:insight:pod:<name>

# Directories that are build artifacts / caches / VCS internals — never code.
# NOTE: do NOT blanket-skip dot-dirs; e.g. .octop/plugins/*/main.py is real code.
_SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "site-packages",
    ".cache", ".npm", ".nvm", ".local", ".ssh", ".vscode-server", ".codex",
    ".copilot", ".harness-browser", ".mypy_cache", ".pytest_cache",
    ".ipynb_checkpoints", "dist", "build", ".next", ".turbo",
    # Runtime churn, never code: log dirs and the browser profile/session tree
    # (ZAP's jbrofuzz logs, firefox profiles.ini / xulstore.json / session
    # checkpoints) used to be walked as if they were source.
    "log", "logs", ".mozilla",
}

# Code / config file types worth tracking.
_INCLUDE_EXT = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift", ".scala",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm", ".lua", ".sh", ".bash",
    ".zsh", ".fish", ".ps1", ".sql", ".proto", ".graphql",
    ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".env", ".json",
    ".html", ".htm", ".css", ".scss", ".sass", ".less", ".md", ".rst", ".txt",
    ".dockerfile", ".mk", ".make",
}
_INCLUDE_NAMES = {
    "Dockerfile", "Makefile", "CMakeLists.txt", "requirements.txt",
    "pyproject.toml", "package.json", "go.mod", "Cargo.toml", "Procfile",
    "supervisord.conf", ".env",
}

# Runtime artifacts that are written continuously and carry no code — log files
# and app/browser session state that happen to have a tracked extension (.txt /
# .json / .ini). They churn on every sweep, so tracking them made a growing log
# look like a code change: the LLM summarised a one-file churn and the risk
# bridge pushed an alert on each rewrite. Matched on the path (not just the
# basename) so a name like "datareporting/state.json" is caught whole.
_RUNTIME_RE = re.compile(
    r"(?i)(?:^|/)("
    r".*[-_.]log\.txt"                    # 07.10.2026-log.txt, foo_log.txt
    r"|profiles\.ini"                     # firefox profile registry
    r"|.*[-_.]state\.json"                # sync_state.json, session-state.json
    r"|state\.json"                       # datareporting/state.json
    r"|(?:sessioncheckpoints|xulstore)\.json"
    r")$"
)

_LOCKS = {}                    # pod -> Lock (per-pod, see _pod_lock)
_LOCKS_GUARD = threading.Lock()
_started = False
_thread = None
# Deep-scan (subagent) budget, enforced only during an automatic sweep so that
# an operator-triggered manual scan is never throttled.
_sweeping = False
_deep_budget = _DEEP_MAX_PER_CYCLE


def _pod_lock(pod):
    """Per-pod lock so the background sweep and an operator-triggered manual
    scan of *another* pod never block each other (the old single global lock
    serialised everything, so clicking 刷新 in the UI could wait minutes for the
    sweep's current LLM call / deep scan to finish)."""
    with _LOCKS_GUARD:
        lk = _LOCKS.get(pod)
        if lk is None:
            lk = _LOCKS[pod] = threading.Lock()
        return lk


def _deep_allowed():
    """Consume one unit of deep-scan budget. Unlimited outside a sweep."""
    global _deep_budget
    if not _sweeping:
        return True
    if _deep_budget <= 0:
        return False
    _deep_budget -= 1
    return True


# ── paths / state ──────────────────────────────────────────────
def _home(pod):
    """Host path of a pod's persistent home (== /home/cloud in-container)."""
    import groups
    return os.path.join(groups.GROUP_DATA_ROOT, pod, "home")


def _ensure_dirs():
    for d in (_STATE_DIR, _PROFILE_DIR):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass


def _state_file(pod):
    return os.path.join(_STATE_DIR, f"{pod}.json")


def _profile_file(pod):
    return os.path.join(_PROFILE_DIR, f"{pod}.json")


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, data):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except Exception as e:
        log.warning("podwatch: write %s failed: %s", path, e)
        return False


# ── scanning ───────────────────────────────────────────────────
def _is_code(rel, fname):
    if _RUNTIME_RE.search(rel.replace(os.sep, "/")):
        return False
    if fname in _INCLUDE_NAMES:
        return True
    ext = os.path.splitext(fname)[1].lower()
    return ext in _INCLUDE_EXT


def _tracked(rel):
    """Whether *rel* belongs in the manifest — the same rule the walk applies
    (skip-dir segments + _is_code), usable on a bare path so a previously stored
    manifest can be filtered to match a tightened rule."""
    parts = rel.replace(os.sep, "/").split("/")
    if any(p in _SKIP_DIRS for p in parts[:-1]):
        return False
    return _is_code(rel, parts[-1])


def _sha1(path):
    try:
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()[:16]
    except Exception:
        return ""


def _scan_manifest(pod, prev):
    """Walk pod home → {rel: [size, mtime, sha1]}.

    Reuses the previous sha1 when size+mtime are unchanged (steady-state sweeps
    don't re-read file contents). Never raises.
    """
    root = _home(pod)
    manifest = {}
    if not os.path.isdir(root):
        return manifest
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for fn in filenames:
            if n >= _MAX_FILES:
                break
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            if not _is_code(rel, fn):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            if st.st_size > _MAX_FILE:
                continue
            size, mt = st.st_size, int(st.st_mtime)
            old = prev.get(rel)
            if old and old[0] == size and old[1] == mt:
                sha = old[2]
            else:
                sha = _sha1(full)
            manifest[rel] = [size, mt, sha]
            n += 1
        if n >= _MAX_FILES:
            break
    return manifest


def _diff(old, new):
    added = [k for k in new if k not in old]
    removed = [k for k in old if k not in new]
    modified = [k for k in new if k in old and new[k][2] != old[k][2]]
    return sorted(added), sorted(modified), sorted(removed)


# ── change context for the LLM ─────────────────────────────────
def _read_text(path, max_bytes=_MAX_FILE):
    try:
        if os.path.getsize(path) > max_bytes:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def _unified(rel, path, max_lines=_DIFF_LINES):
    """Best-effort diff for a modified file: we only kept hashes, not old text,
    so show the current content head instead of a real diff."""
    txt = _read_text(path, 64 * 1024)
    if txt is None:
        return f"  ~ {rel} (binary or too large)"
    lines = txt.splitlines()[:_HEAD_LINES]
    body = "\n".join("    " + ln for ln in lines)
    return f"  ~ {rel}\n{body}"


def _podcode_map(pod):
    """podcode 的压缩代码地图（"" 表示尚未建索引）。只读、尽力而为，绝不抛出。"""
    try:
        import podcode
        return podcode.code_map_block(pod) or ""
    except Exception:
        return ""


def _change_context(pod, added, modified, removed, root):
    parts = [f"本轮检测到代码变更（Pod {pod}）:",
             f"新增 {len(added)} 个, 修改 {len(modified)} 个, 删除 {len(removed)} 个"]
    # 先喂代码结构概览，让 LLM 能判断「这个项目整体在做什么」——只看一次变更
    # 往往会猜（"可能用于…"），有了真实目录树+核心文件，画像才落地。
    cmap = _podcode_map(pod)
    if cmap:
        parts.append("代码结构概览（用于判断项目整体在做什么）:")
        parts.append(cmap[:_MAX_MAP_CTX])
    for rel in added[:15]:
        parts.append(f"  + {rel}")
    for rel in removed[:15]:
        parts.append(f"  - {rel}")
    budget = _MAX_CTX
    for rel in modified[:10]:
        snippet = _unified(rel, os.path.join(root, rel))
        if len(snippet) > budget:
            break
        parts.append(snippet)
        budget -= len(snippet)
    for rel in added[:4]:
        snip = _unified(rel, os.path.join(root, rel), max_lines=30)
        if len(snip) > budget:
            break
        parts.append(snip)
        budget -= len(snip)
    # Managed deploys give a strong hint about what the pod runs.
    try:
        import deploys
        deps = deploys.list_for(pod) or []
        if deps:
            parts.append("已部署应用:")
            for d in deps[:10]:
                parts.append(f"  {d.get('name','?')} [{d.get('kind','?')}] repo={d.get('repo','')} branch={d.get('branch','')}")
    except Exception:
        pass
    return "\n".join(parts)


# ── LLM analysis ───────────────────────────────────────────────
_PROFILE_SYS = (
    "你是容器项目巡检助手。你会收到某个容器开发环境的**代码结构概览**"
    "（目录树 + 核心文件，用于判断这个项目整体在做什么）以及**最近发生的代码变更**。"
    "请先概括项目全貌，再说明本次变动，只输出一个 JSON 对象（不要额外文字、不要代码块围栏），字段：\n"
    '{"what_changed": "本次变动的简述", "risk": "潜在风险或空字符串", '
    '"risk_level": "none|low|medium|high", '
    '"suggested_actions": [{"cmd": "处置命令", "why": "原因"}], '
    '"profile": {"purpose": "项目整体用途（2-3 句，应描述这个项目长期在做什么，'
    '不依赖本次变更也成立）", "stack": "技术栈", '
    '"entrypoints": "入口文件/命令", "modules": "主要模块一览"}}\n'
    "risk_level 用 none/low/medium/high 描述本次变动的风险严重度。\n"
    "suggested_actions 仅当 risk_level 为 medium 或 high 时给出（否则必须是空数组 []），"
    "最多 2 条，每条只允许**可逆**的处置命令，且仅限以下四种形式：\n"
    "  kubectl -n <命名空间> rollout restart deploy/<名字>\n"
    "  kubectl -n <命名空间> delete pod <名字>\n"
    "  systemctl restart yatterra-<名字>.service\n"
    "  supervisorctl restart <程序名>\n"
    "命令必须是单条，且不含 ; & | $ ( ) > < 反引号 等任何字符。"
    "不确定、或没有把握就给出空数组——绝不编造命令。"
)


def _analyze(pod, ctx):
    """Ask the LLM to summarize the change + (re)build the project profile.

    Returns (summary_text, profile_dict, risk_text, risk_level, actions). Any
    of them may be empty/None on failure; risk_text and risk_level are returned
    separately so the risk→alert bridge can gate on them without re-parsing the
    composed summary, and ``actions`` is the LLM's list of *candidate* remedy
    commands (unvalidated — the caller runs them through _validate_remedy).
    """
    try:
        import llm
        content = llm.chat(
            [{"role": "user", "content": f"Pod: {pod}\n\n{ctx}"}],
            system=_PROFILE_SYS, max_tokens=2000,
            caller="podwatch", user=_BOT_USER,
        )
    except Exception as e:
        log.warning("podwatch: LLM failed for %s: %s", pod, e)
        return None, None, "", "", []
    if not content:
        return None, None, "", "", []
    data = _parse_json(content)
    if not isinstance(data, dict):
        # The reply wasn't valid JSON — usually a truncated object (a large
        # change blows past max_tokens). Salvaging what_changed/risk is still
        # useful; dumping the raw JSON blob into the insight panel is not.
        salvaged, salvaged_risk = _salvage(content)
        if salvaged:
            return salvaged, None, salvaged_risk, "", []
        if content.lstrip()[:1] in "{[":
            return None, None, "", "", []   # raw JSON blob: retry next sweep
        return content.strip(), None, "", "", []
    prof = data.get("profile") if isinstance(data.get("profile"), dict) else {}
    what = str(data.get("what_changed", "")).strip()
    risk = str(data.get("risk", "")).strip()
    risk_level = str(data.get("risk_level", "")).strip().lower()
    if risk_level not in ("none", "low", "medium", "high"):
        risk_level = ""
    actions = _clean_actions(data.get("suggested_actions"))
    summary = what + (f"（风险：{risk}）" if risk else "")
    return summary.strip() or content.strip(), prof, risk, risk_level, actions


def _clean_actions(raw):
    """Normalise the LLM's suggested_actions into [{"cmd","why"}] (max 2)."""
    out = []
    if not isinstance(raw, list):
        return out
    for a in raw:
        if isinstance(a, dict):
            cmd = str(a.get("cmd", "")).strip()
            why = str(a.get("why", "")).strip()
        elif isinstance(a, str):
            cmd, why = a.strip(), ""
        else:
            continue
        if cmd:
            out.append({"cmd": cmd[:200], "why": why[:300]})
        if len(out) >= _REMEDY_MAX:
            break
    return out


def _salvage(text):
    """Extract what_changed/risk from a JSON-ish reply that failed to parse.

    Returns (summary, risk): the "…（风险：…）" summary (or "" when nothing
    usable is found) plus the raw risk text for the alert bridge.
    """
    import re
    if text.lstrip()[:1] not in "{[":
        return "", ""

    def field(name):
        m = re.search(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % name, text)
        return m.group(1).strip() if m else ""

    what, risk = field("what_changed"), field("risk")
    if not what:
        return "", risk
    return what + (f"（风险：{risk}）" if risk else ""), risk


def _parse_json(text):
    """Fence-stripping + substring JSON extraction, shared with the rest of the
    platform via llm_json.extract_json (see llm_json for the exact rules)."""
    import llm_json
    return llm_json.extract_json(text)


# ── risk → alert bridge ────────────────────────────────────────
# Negated risk wording ("无明确高风险迹象", "不涉及漏洞", "no critical issues")
# must not trip the keyword fallback below. Only a negator sitting right in
# front of a keyword is dropped, so a sentence like "存在数据丢失风险" survives.
_NEGATED_RISK = re.compile(
    r"(?:无|没有|不存在|不涉及|不包含|未发现|未涉及|非|并非|不会)"
    r"[^，。；！？,.;!?\n]{0,10}?"
    r"(?:高危|高风险|严重|致命|崩溃|数据丢失|数据泄露|数据损坏|安全漏洞|漏洞|注入|"
    r"后门|木马|挖矿|勒索|提权|越权|删库|灾难|不可逆|篡改|泄露)"
    r"|(?:no|not|without|free of)\s+[\w\s]{0,20}?"
    r"(?:critical|severe|high risk|data loss|leak|vulnerab|backdoor|malware|"
    r"ransom|privilege escal)",
    re.I,
)


def _high_risk(risk, summary="", risk_level=""):
    """Decide whether an analysis warrants a push alert.

    The model's structured ``risk_level`` is authoritative. An explicit
    none/low/medium is *never* overridden by scary-sounding prose — that is what
    keeps the gate from firing on benign context: "ZAP 漏洞扫描界面" (a scanner),
    "keys.json … 属于敏感凭据泄露风险" (a hypothetical), "无明确高风险迹象"
    (an explicit denial). Every one of those used to trip the old bare substring
    match and pushed a fresh alert on each sweep.

    Only when the level is missing/unknown (a truncated or older reply) do we
    fall back to a keyword gate — and then only after stripping negated wording.
    """
    if not RISK_ALERT:
        return False
    rl = str(risk_level or "").strip().lower()
    if rl in ("none", "low", "medium"):
        return False
    if rl == "high":
        return True
    for text in (risk, summary):
        t = _NEGATED_RISK.sub("", str(text or "")).lower()
        if t and any(k in t for k in _RISK_KEYWORDS):
            return True
    return False


def _risk_event_key(pod, risk, summary):
    """Stable dedup token: pod + a hash of the risk/what_changed text.

    Same wording → same key → delivered once (at-most-once via pwa_alerts).
    Wording that changes materially yields a new key and a fresh alert.
    """
    seed = f"{pod}|{(risk or '').strip()}|{(summary or '').strip()}"
    return "pod-risk:" + pod + ":" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def _notify_risk(pod, risk, summary, proposed=0):
    """Push a high-risk change to the pod's members via pwa_alerts.

    Reuses pwa_alerts.notify_event (SQLite claim → at-most-once) so restarts or
    overlapping scans cannot double-send. Never raises; returns True if this
    call delivered it. When ``proposed`` > 0 the alert also tells the recipient
    how many remedy suggestions are waiting, and deep-links to the approval
    queue instead of the pod page.
    """
    try:
        import pwa_alerts
        key = _risk_event_key(pod, risk, summary)
        title = f"Pod「{pod}」高风险变更提醒"
        body = summary or risk or f"Pod「{pod}」检测到潜在高风险变更。"
        url = _RISK_URL.format(pod=pod)
        if proposed:
            body = f"{body}\n\n已生成 {proposed} 条待审批处置建议，请前往审批队列确认。"
            url = _SUGGEST_URL
        sent = pwa_alerts.notify_event(key, pod, title, body, url, kind="pod-risk")
        if sent:
            log.info("podwatch: risk alert sent for %s (%s, %d suggestions)",
                     pod, key, proposed)
        return bool(sent)
    except Exception as e:
        log.warning("podwatch: risk notify failed for %s: %s", pod, e)
        return False


# ── 处置建议白名单(AI 只提可逆命令,人工审批后才执行) ────────────
# 安全核心:LLM 的建议先过"注入字符否决",再必须**完整匹配**下面某一条极窄
# 白名单(附执行位置 runner)。匹配不到一律丢弃——宁可漏报,不可乱提;命令只
# 进审批队列,绝不由 podwatch 自动执行。白名单只含**可逆**处置(重启/滚动重启
# /删 Pod),不含删数据、改配置、改权限类。
_REMEDY_MAX = 2
_REMEDY_BAD = re.compile(r"[;&|`$()<>\\\n\r]")
_REMEDY_RULES = (
    (r"kubectl -n [a-z0-9-]+ rollout restart deploy/[a-z0-9-]+", "host"),
    (r"kubectl -n [a-z0-9-]+ delete pod [a-z0-9-]+", "host"),
    (r"systemctl restart yatterra-[a-z0-9-]+\.service", "host"),
    (r"supervisorctl restart [A-Za-z0-9_.:-]+", "pod"),
)


def _validate_remedy(cmd, pod=""):
    """校验一条 AI 处置命令,通过返回 runner(host/pod),否则 None。

    双重闸:先否决任何含 shell 元字符(串联/注入/替换)的串,再要求整串
    **完整匹配**某条白名单正则(re.fullmatch)。任何不确定 → 丢弃并记日志。
    """
    c = str(cmd or "").strip()
    if not c or len(c) > 200:
        return None
    if _REMEDY_BAD.search(c):
        log.info("podwatch: remedy rejected (metachars) for %s: %s", pod, c[:120])
        return None
    for pat, runner in _REMEDY_RULES:
        if re.fullmatch(pat, c):
            return runner
    log.info("podwatch: remedy rejected (no whitelist match) for %s: %s", pod, c[:120])
    return None


def _propose(pod, why, cmd, runner):
    """把一条**已校验**的处置命令登记进审批队列(不执行)。返回是否登记成功。

    复用 approvals.submit 的 actor+tool+args 去重:同一条命令不会重复入队。
    runner 必须显式给 host/pod,resume_approved 回放时才找得对执行位置。
    """
    try:
        import approvals
        approvals.submit("run", {"cmd": cmd}, runner, agent_def=None,
                         pod=(pod if runner == "pod" else ""), run_id="",
                         user=_BOT_USER, reason=why or f"podwatch 处置建议:{pod}",
                         origin="podwatch")
        log.info("podwatch: remedy queued for %s [%s] %s", pod, runner, cmd)
        return True
    except Exception as e:
        log.warning("podwatch: propose failed for %s: %s", pod, e)
        return False


# ── rendering ──────────────────────────────────────────────────
def _useful(v):
    """True if a profile field carries real information (see _PLACEHOLDER)."""
    if not isinstance(v, str):
        return False
    s = v.strip()
    return len(s) >= 2 and s.lower() not in _PLACEHOLDER


def _render_md(prof):
    lines = [f"# 项目画像: {prof.get('pod', '?')}", ""]
    if _useful(prof.get("purpose")):
        lines.append(f"- **项目用途**: {prof['purpose']}")
    if _useful(prof.get("stack")):
        lines.append(f"- **技术栈**: {prof['stack']}")
    if _useful(prof.get("entrypoints")):
        lines.append(f"- **入口**: {prof['entrypoints']}")
    if _useful(prof.get("modules")):
        lines.append(f"- **主要模块**: {prof['modules']}")
    if prof.get("last_change_summary"):
        lines.append(f"- **最近变更**: {prof['last_change_summary']}")
    if prof.get("last_scan"):
        lines.append(f"- **画像更新**: {prof['last_scan']}")
    hist = prof.get("changes") or []
    if hist:
        lines += ["", "## 最近变更历史", ""]
        for h in hist:
            lines.append(f"- `{h.get('ts','')}` {h.get('summary','')}"
                         f"（+{h.get('added',0)} ~{h.get('modified',0)} -{h.get('removed',0)}）")
    return "\n".join(lines)


def _insight_content(prof):
    """Short text the AI-insight panel shows for this pod.

    读法：先「这个 pod 整体在干什么」（项目全貌），再「最近改了什么」。
    旧的写法把最近一次变更顶在最前面，导致一个安静运行的重要 pod 看起来
    只剩一条流水账——详情页需要的是先看懂它是什么。
    """
    overall = []
    if _useful(prof.get("purpose")):
        overall.append(f"用途：{prof['purpose']}")
    if _useful(prof.get("stack")):
        overall.append(f"技术栈：{prof['stack']}")
    if _useful(prof.get("entrypoints")):
        overall.append(f"入口：{prof['entrypoints']}")
    if _useful(prof.get("modules")):
        overall.append(f"主要模块：{prof['modules']}")

    out = []
    if overall:
        out.append("【项目全貌】" + "；".join(overall))
    recent = prof.get("summary") or prof.get("last_change_summary")
    if _useful(recent):
        out.append(f"【最近变更】{recent}")
    return "\n".join(out) or (prof.get("last_change_summary") or "暂无信息")


def _has_insight(prof):
    """Whether a profile has enough *usable* text for the Pod detail panel.

    Uses _useful() on the summary too, so a junk profile (e.g. a model that
    answered "x") counts as missing and gets re-analysed instead of being served.
    """
    return bool(_useful(prof.get("summary")) or _useful(prof.get("last_change_summary"))
                or _useful(prof.get("purpose")))


def _warm_insight(pod, prof):
    """(Re)write the per-pod insight cache entry the detail panel reads.

    Called on **every** sweep, not only when the profile changed: the entry has
    a TTL and podwatch only re-analyses a pod when its files change, so an idle
    pod's key would silently expire (panel goes blank again) even though its
    profile is perfectly good. Re-warming is free — no LLM call.
    """
    if not _has_insight(prof):
        return False
    try:
        import kvcache
        kvcache.set(_INSIGHT_PREFIX + pod,
                    {"content": _insight_content(prof), "ts": time.time()},
                    ttl=INSIGHT_TTL)
        return True
    except Exception:
        return False


def _priority(pod):
    """Sweep ordering key: pods with no usable per-pod insight go first.

    A full sweep over ~34 pods (each first-time pod hashes thousands of files
    and makes an LLM call) can outlast INTERVAL, so with plain alphabetical
    order the pods at the end of the list could wait many minutes for their
    first profile. Sorting by "needs work" makes the sweep close those gaps
    first, then fall back to plain order for the steady state.
    """
    prof = _read_json(_profile_file(pod), {}) or {}
    return (1 if _has_insight(prof) else 0)


# ── deep scan (subagent) ───────────────────────────────────────
def _deep_scan(pod, prev_profile):
    """Spawn a pod-runner subagent to inspect the container in place.

    Returns a short notes string, or None. Best-effort, never raises.
    """
    try:
        import agent
        import agent_conf
        import groups

        agent_def = agent_conf.get_agent("build")
        if not agent_def or agent_def.get("runner") != "pod":
            # Was a silent return: deep scans could then never happen (for every
            # pod, forever) with nothing in the log to explain why. Say so.
            log.warning(
                "podwatch: deep scan skipped for %s: agent \"build\" is %s (runner=%s), "
                "expected runner=pod", pod,
                "missing" if not agent_def else "present",
                (agent_def or {}).get("runner", "-"))
            return None
        k8s_pod = groups.resolve_pod_name(pod)
        if not k8s_pod:
            return None
        goal = (
            "巡检这个容器开发环境，弄清项目在做什么：列出 /home/cloud 下的主要代码目录与入口文件、"
            "supervisord 管理的程序（~/deploy/supervisord.conf）、监听端口与依赖。"
            "只做只读检查（grep/list_dir/读文件），不要修改任何文件。用中文输出一段简明结论。"
        )
        ctx = prev_profile.get("purpose", "") if prev_profile else ""
        ok, summary = agent._subagent_run(
            agent_def, k8s_pod, goal, ctx,
            run_id=f"podwatch:{pod}:{int(time.time())}",
            depth=0, cfg=agent_conf.load(),
            user={"username": _BOT_USER, "role": "admin"},
        )
        if ok and summary:
            summary = summary.strip()
            # Safety net: if the subagent never produced a final answer the
            # "summary" is just its last raw tool call, useless as notes.
            # (agent._parse_action now understands <tool_call>, so a model that
            # emits that format runs to completion instead of landing here.)
            head = summary[:200].lstrip()
            if head.startswith("<tool_call") or head.startswith("ACTION:"):
                return None
            if head.startswith("{") and '"tool' in head:
                return None
            return summary[:4000]
    except Exception as e:
        log.warning("podwatch: deep scan failed for %s: %s", pod, e)
    return None


# ── per-pod pipeline ───────────────────────────────────────────
def scan_one(pod, force=False):
    """Scan one pod, diff, and (on change / force) update its profile.

    Returns a result dict, or None if the pod has no home dir. Never raises.
    """
    with _pod_lock(pod):
        try:
            return _scan_one_locked(pod, force)
        except Exception as e:
            log.warning("podwatch: scan_one(%s) failed: %s", pod, e)
            return None


def _scan_one_locked(pod, force):
    root = _home(pod)
    if not os.path.isdir(root):
        return None
    _ensure_dirs()

    # NOTE: "first time" is the *absence of the state file*, not an empty
    # manifest — a pod whose home holds no tracked code files stores "{}"
    # forever, and testing truthiness would re-analyse it on every sweep.
    prev_state = _read_json(_state_file(pod), None)
    prev_manifest = prev_state if isinstance(prev_state, dict) else {}
    # Drop now-ignored runtime paths from the *previous* manifest too, so the
    # first sweep after tightening the filter doesn't see a burst of "removed"
    # files (they were tracked under the old rules) and fire a spurious change.
    prev_manifest = {k: v for k, v in prev_manifest.items() if _tracked(k)}
    manifest = _scan_manifest(pod, prev_manifest)
    added, modified, removed = _diff(prev_manifest, manifest)
    changed = bool(added or modified or removed)
    first_time = prev_state is None

    # Piggyback the per-pod code index (podcode) on this diff — it re-indexes
    # only the changed files. Called on every scan (incl. the no-change fast
    # path below) so a pod that predates podcode still gets a first build here.
    # Never let it break the podwatch sweep.
    try:
        import podcode
        podcode.on_scan(pod, manifest, added, modified, removed)
    except Exception as e:
        log.warning("podwatch: podcode hook for %s failed: %s", pod, e)

    prev_prof = _read_json(_profile_file(pod), None)
    prof = prev_prof if isinstance(prev_prof, dict) else {"pod": pod, "changes": []}
    prof["pod"] = pod

    # We owe an analysis if this pod has never been looked at, has no profile
    # yet, its files changed, we're forced, or a previous attempt failed (the
    # LLM was down). Without the "no profile yet" clause a pod whose home holds
    # no tracked code files would never get a profile at all — and therefore
    # never a per-pod insight.
    #
    # Plus a one-shot "grounded" pass: a pod profiled *before* podcode existed
    # has a purpose guessed from a lone diff ("可能用于…"). Once its code map
    # is available, re-analyse once so the 全貌 reflects the real structure.
    has_map = bool(_podcode_map(pod))
    need = (first_time or prev_prof is None or changed or force
            or bool(prof.pop("needs_analysis", False))
            or (has_map and manifest and not prof.get("overview_grounded")))
    if not need:
        _write_json(_state_file(pod), manifest)
        # Keep the detail page's insight alive even when nothing changed.
        warm = _warm_insight(pod, prof)
        return {"pod": pod, "changed": False, "warm": warm}

    ctx = _change_context(pod, added, modified, removed, root)
    summary, new_prof, risk, risk_level, actions = _analyze(pod, ctx)
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    if new_prof:
        # Only merge fields that actually say something: a model that answers
        # the profile prompt with single letters must not clobber a good
        # profile (or seed a junk one — cf. the "p"/"s"/"e"/"m" case).
        for k in ("purpose", "stack", "entrypoints", "modules"):
            if _useful(new_prof.get(k)):
                prof[k] = new_prof[k].strip()

    analysis_ok = bool(summary or new_prof)
    if not analysis_ok:
        # LLM unavailable — remember to try again next sweep.
        prof["needs_analysis"] = True
    elif has_map:
        # This analysis saw the code map, so the profile's 全貌 is grounded;
        # don't trigger the one-shot re-analysis again.
        prof["overview_grounded"] = True

    if summary:
        prof["summary"] = summary
        prof["last_change_summary"] = summary
        prof["last_scan"] = now
        prof["changes"] = ([{"ts": now, "summary": summary,
                             "added": len(added), "modified": len(modified),
                             "removed": len(removed)}] + (prof.get("changes") or []))[:_PROFILE_HISTORY]

    # Keep the latest LLM risk verdict on the profile (surfaced by the insight
    # panel); a fresh analysis with no risk clears a stale one.
    if analysis_ok:
        if risk:
            prof["risk"] = risk
        else:
            prof.pop("risk", None)
        if risk_level:
            prof["risk_level"] = risk_level
        else:
            prof.pop("risk_level", None)

    # Deep scan: a brand-new pod with actual code, or a large change (only when
    # the LLM worked). An empty home is skipped — nothing to inspect.
    deep_done = False
    if (analysis_ok and _DEEP_SCAN
            and (force or (first_time and manifest)
                 or (len(added) + len(modified)) >= _BIG_CHANGE)
            and _deep_allowed()):
        notes = _deep_scan(pod, prof)
        if notes:
            prof["deep_notes"] = notes
            deep_done = True

    _write_json(_state_file(pod), manifest)
    _write_json(_profile_file(pod), prof)
    try:
        with open(os.path.join(_PROFILE_DIR, f"{pod}.md"), "w", encoding="utf-8") as f:
            f.write(_render_md(prof))
    except OSError:
        pass

    # Warm the insight cache the Pod detail panel reads.
    _warm_insight(pod, prof)

    # 感知 → 建议 → 审批：LLM 给出处置建议时，逐条过白名单后登记进审批队列
    # (只入队，绝不由 podwatch 执行)；判定高风险时再经 pwa_alerts 的
    # at-most-once 通道推给成员。
    proposed = 0
    if analysis_ok and actions:
        for act in actions[:_REMEDY_MAX]:
            cmd = str(act.get("cmd", "")).strip()
            runner = _validate_remedy(cmd, pod)
            if runner and _propose(pod, str(act.get("why", "")).strip(), cmd, runner):
                proposed += 1

    risk_alerted = False
    risk_high = _high_risk(risk, summary, risk_level)
    if analysis_ok and risk_high:
        risk_alerted = _notify_risk(pod, risk, summary, proposed)

    try:
        import audit
        audit.record("podwatch_scan",
                     detail=f"{pod} +{len(added)} ~{len(modified)} -{len(removed)}"
                            f"{' deep' if deep_done else ''}"
                            f"{' risk-alert' if risk_alerted else ''}"
                            f"{f' propose={proposed}' if proposed else ''}"
                            f"{'' if analysis_ok else ' (LLM 不可用,待重试)'}",
                     module="podwatch")
    except Exception:
        pass

    return {"pod": pod, "changed": changed or force, "added": added,
            "modified": modified, "removed": removed, "summary": summary,
            "deep": deep_done, "pending": not analysis_ok, "risk": risk,
            "risk_level": risk_level, "risk_alert": risk_alerted,
            "proposed": proposed}


def scan_all():
    """Scan every running pod. Returns the list of result dicts."""
    global _sweeping, _deep_budget
    import groups
    statuses = groups.all_pod_statuses()
    running = [n for n, s in statuses.items() if s == "Running"]
    # Pods without a usable insight first, so a slow sweep closes the gaps
    # instead of leaving the tail of the (alphabetical) list unprofiled.
    running.sort(key=_priority)
    _sweeping = True
    _deep_budget = _DEEP_MAX_PER_CYCLE
    out = []
    t0 = time.time()
    try:
        for pod in running:
            out.append(scan_one(pod))
            time.sleep(1)
    finally:
        _sweeping = False
    done = sum(1 for r in out if r and r.get("changed"))
    log.info("podwatch: sweep done in %.0fs (%d pods, %d changed, %d warmed, %d pending)",
             time.time() - t0, len(out), done,
             sum(1 for r in out if r and r.get("warm")),
             sum(1 for r in out if r and r.get("pending")))
    return out


# ── public read API ────────────────────────────────────────────
def get_profile(pod):
    """Return the maintained profile dict for *pod*, or None."""
    p = _read_json(_profile_file(pod), None)
    return p if isinstance(p, dict) else None


def get_changes(pod):
    """Return the recent-change ring for *pod* (list, newest first)."""
    p = get_profile(pod) or {}
    return p.get("changes") or []


# ── background thread ──────────────────────────────────────────
def _loop():
    """Sweep forever. Note a full sweep can take longer than INTERVAL while pods
    are still being profiled for the first time (file hashing + one LLM call
    each), so the loop simply continues — it never runs two sweeps at once."""
    while True:
        try:
            scan_all()
        except Exception:
            pass
        try:
            time.sleep(INTERVAL)
        except Exception:
            break


def _start_thread():
    global _started, _thread
    if _started:
        return
    try:
        t = threading.Thread(target=_loop, name="podwatch", daemon=True)
        t.start()
        _thread = t
        _started = True
        log.info("podwatch: started (interval=%ds)", INTERVAL)
    except Exception as e:
        log.warning("podwatch: failed to start thread: %s", e)


# Auto-start on import (same pattern as insight.py / metrics.py)
_start_thread()
