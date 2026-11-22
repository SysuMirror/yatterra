#!/usr/bin/env python3
"""平台安全巡检（静态扫描）— 明文密钥 / 危险代码逻辑 / 集群配置。

目标：把"巡检"从纯遥测（磁盘、GPU、证书）扩到**代码与配置层**：找出
  * 硬编码的明文密钥（没有走环境变量 / .env / k8s Secret 的那种）；
  * 危险代码逻辑（eval/exec/shell=True/pickle/yaml.load/verify=False/通配 CORS…）；
  * 集群里裸写的敏感环境变量、特权/挂宿主目录的 Pod、过宽的密钥文件权限。

结果落 SQLite `siteconf.path("scan_results.db")`；后台守护线程按
`YATTERRA_SCAN_INTERVAL_S`（默认 6h）周期跑一遍，发现**新增的 high/critical**
就推 admin（kind='scan-finding'）。启动模式同 cert_alerts：import 时幂等起
单线程，错误全吞，env `YATTERRA_SCAN_DISABLED=1` 可关。

设计取舍：
  * 纯 stdlib、无第三方依赖；单文件；不 import 平台其它模块（除了写结果时
    懒加载 audit/alert，避免 import 环）。
  * 扫描是"启发式"的——宁可少报也不要满屏误报，所以对明显的占位符/示例值、
    `.env`/`*.example`/测试目录一律放过。
  * 结果按 fingerprint 去重：同一处问题重复出现只更新 last_seen，不重复计数。
"""
import hashlib
import logging
import os
import re
import sqlite3
import stat
import threading
import time

import siteconf

log = logging.getLogger(__name__)

DB_PATH = siteconf.path("scan_results.db")
INTERVAL_S = max(600.0, float(os.environ.get("YATTERRA_SCAN_INTERVAL_S", "21600")))
DISABLED = os.environ.get("YATTERRA_SCAN_DISABLED") == "1"
ALERTS = os.environ.get("YATTERRA_SCAN_ALERTS", "1") != "0"

# 扫描根目录（代码层）。可用 env 覆盖；默认 = 平台 web 目录 + 各组 home。
def _roots():
    roots = []
    web = siteconf.WEB_DIR
    if os.path.isdir(web):
        roots.append(web)
    group_root = os.environ.get("YATTERRA_GROUP_ROOT", "/mnt/sdb/groups")
    if os.path.isdir(group_root):
        for name in sorted(os.listdir(group_root)):
            home = os.path.join(group_root, name, "home")
            if os.path.isdir(home):
                roots.append(home)
    extra = os.environ.get("YATTERRA_SCAN_EXTRA_ROOTS", "")
    roots += [p.strip() for p in extra.split(",") if p.strip()]
    return roots


# 目录/文件黑名单：第三方依赖、构建产物、VCS、缓存——扫了全是噪音。
_SKIP_DIRS = {
    "node_modules", ".git", ".hg", ".svn", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".venv", "venv", "site-packages",
    "dist-packages", ".cache", ".npm", ".npm-global", "miniconda3", "anaconda3",
    ".spa-staging", ".next", ".turbo", "coverage", "vendor", "build",
    ".local", ".npm", ".cursor", ".vscode-server", ".trae", "snap",
    ".hf_cache", ".modelscope", ".docker", "conda-meta", ".git-credentials",
    "sseapi-backup", "yatterra-backup",
}
_SKIP_SUFFIX = (
    ".min.js", ".map", ".pyc", ".pyo", ".so", ".o", ".a", ".class",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svgz", ".pdf",
    ".zip", ".gz", ".tar", ".tgz", ".whl", ".bin", ".woff", ".woff2",
    ".ttf", ".eot", ".mp4", ".db", ".sqlite", ".db-wal", ".db-shm",
)
_SKIP_NAMES = {
    "scan_svc.py",  # 本文件自带密钥正则 → 免得自己举报自己
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock",
}
# .env / 示例 / 模板文件是"正确放密钥的地方"，不按硬编码报。
_OK_SECRET_FILES = re.compile(r"(\.env(\..*)?|.*\.example|.*\.template|.*\.sample|\.envrc)$")

_MAX_FILE_BYTES = int(os.environ.get("YATTERRA_SCAN_MAX_FILE_BYTES", str(768 * 1024)))
_MAX_FILES = int(os.environ.get("YATTERRA_SCAN_MAX_FILES", "40000"))

# 测试文件里的"假密钥"是刻意的，不按硬编码密钥报（危险代码逻辑仍照报）。
_TEST_PATH = re.compile(r"(^|/)(tests?|testing|__tests__|spec)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.spec\.[tj]sx?$")
# 匹配落在字符串字面量里（如 `"exec("` / `'eval('`）——多为文档/示例，放过。
_QUOTED_BEFORE = re.compile(r"""[("']{1,2}\s*$""")


# ── 检测规则 ────────────────────────────────────────────────────────────────
# 明文密钥：命中"看起来真的是个密钥字面量"的赋值/结构。
# 每条 = (check_id, severity, 标题, 正则, 说明)。正则用 re.I / re.M。
SECRET_RULES = [
    ("secret/private-key", "critical", "内联私钥",
     re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
     "源码里直接贴了私钥块——应立即作废并改从密钥管理系统/Secrets 注入。"),
    ("secret/aws-akid", "critical", "AWS Access Key ID",
     re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
     "疑似硬编码的 AWS 凭证。"),
    ("secret/openai-key", "high", "API Key（sk-…）",
     re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b"),
     "疑似硬编码的模型/服务 API key。"),
    ("secret/jwt", "high", "内联 JWT",
     re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}\b"),
     "源码里出现了 JWT 字面量。"),
    ("secret/conn-str", "high", "连接串内嵌口令",
     re.compile(r"\b[a-z][a-z0-9+.\-]{2,}://[^\s:/@'\"]+:[^\s:/@'\"]{4,}@[^\s'\"]+", re.I),
     "URL 连接串里直接写了 用户名:口令@主机。"),
    ("secret/assigned", "high", "硬编码口令/密钥赋值",
     re.compile(r"""(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|"""
                r"""access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|"""
                r"""client[_-]?secret|encryption[_-]?key|signing[_-]?key)\b"""
                r"""\s*[:=]\s*['"]([^'"]{6,120})['"]"""),
     "敏感字段被赋成了字符串字面量；应改从 os.environ / .env / Secret 读取。"),
    # 无引号但等号后紧跟一串高熵值（YAML/env 常见：KEY: abc123...）
    ("secret/assigned-raw", "medium", "疑似裸写密钥",
     re.compile(r"""(?im)^\s*(password|passwd|secret|token|api[_-]?key|access[_-]?key|"""
                r"""secret[_-]?key|client[_-]?secret)\s*[:=]\s*([A-Za-z0-9+/=_\-]{12,})"""),
     "看起来是裸写的密钥值（非占位符）。"),
]

# 危险代码逻辑。
DANGER_RULES = [
    ("danger/eval", "high", "动态执行 eval/exec",
     re.compile(r"(?<![\w.])(eval|exec)\s*\("),
     "对不可信输入使用 eval/exec 会导致任意代码执行。"),
    ("danger/os-system", "high", "os.system / os.popen",
     re.compile(r"\bos\.(system|popen)\s*\("),
     "命令注入面；优先用 subprocess + 参数列表。"),
    ("danger/shell-true", "high", "subprocess shell=True",
     re.compile(r"subprocess\.(run|call|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True"),
     "shell=True 且命令含外部输入即命令注入。"),
    ("danger/pickle", "high", "pickle/marshal 反序列化",
     re.compile(r"\b(pickle|marshal)\.loads?\s*\("),
     "对不可信数据反序列化 = 任意代码执行。"),
    ("danger/yaml-load", "medium", "yaml.load 未用 SafeLoader",
     re.compile(r"yaml\.load\s*\((?![^)]*SafeLoader)"),
     "yaml.load 默认加载器可构造任意对象；改 yaml.safe_load。"),
    ("danger/verify-false", "medium", "TLS 校验被关闭",
     re.compile(r"verify\s*=\s*False|_create_unverified_context|check_hostname\s*=\s*False"),
     "关闭证书校验会被中间人攻击。"),
    ("danger/cors-star", "medium", "CORS 通配允许",
     re.compile(r"""(?i)(allow_origins|cors_allowed_origins|Access-Control-Allow-Origin)"""
                r"""\s*[=:]\s*(\[\s*)?['"]\*['"]"""),
     "允许任意来源跨域，等于放弃同源保护。"),
    ("danger/chmod-777", "low", "过宽文件权限 0777/777",
     re.compile(r"(chmod|Chmod)\s*\(?\s*(0o)?0?777\b|\bchmod\s+777\b"),
     "777 权限允许任意用户改写。"),
    ("danger/bind-all", "low", "监听 0.0.0.0",
     re.compile(r"['\"]0\.0\.0\.0['\"]|bind\(['\"]0\.0\.0\.0"),
     "确认该端口确实需要对外暴露（常见但需复核）。"),
    ("danger/innerhtml", "medium", "innerHTML / dangerouslySetInnerHTML",
     re.compile(r"dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\("),
     "直接注入 HTML = XSS 面；确保内容已净化。"),
    ("danger/js-eval", "medium", "前端 eval / new Function",
     re.compile(r"(?<![\w.])eval\s*\(|new\s+Function\s*\("),
     "前端动态执行字符串代码，存在注入与 CSP 绕过风险。"),
    ("danger/sql-concat", "medium", "SQL 字符串拼接",
     re.compile(r"""(execute|executemany|execute_query)\s*\(\s*(f['"]|['"][^'"]*["']\s*(%|\+|\.format\())"""),
     "SQL 由字符串拼接构成 → 注入面；应使用参数化查询。"),
    ("danger/debug-true", "low", "调试开关开启",
     re.compile(r"(?i)\b(debug|DEBUG)\s*[:=]\s*(True|1)\b"),
     "生产环境开启 debug 会泄露堆栈/启用调试器。"),
]

# 明显是占位符/示例的值——放过（这正是"应该"的写法）。
_PLACEHOLDER = re.compile(
    r"(?i)^("
    r"|.*(example|placeholder|changeme|change-me|your[_-]?|xxx+|xxxx|todo|fixme|"
    r"redacted|dummy|sample|test|fake|foo|bar|baz|none|null|secret|password|"
    r"passwd|token|string|value|key|__[a-z_]+__|\.\.\.).*"
    r")$"
)
_ENV_REF = re.compile(r"os\.environ|getenv|env\(|\$\{|%\(|<\$|\{\{|process\.env|import\.meta\.env")


_CJK = re.compile(r"[一-鿿]")


def _is_placeholder(val):
    if not val:
        return True
    v = val.strip().strip("'\"")
    if len(v) < 8:
        return True
    # UI 文案 / 说明性文本（含空格或中日韩字符）不是密钥，是给人看的占位串。
    if _CJK.search(v) or any(ch.isspace() for ch in v):
        return True
    # 真密钥通常混有数字/符号；纯字母的词（如 "keyboard"）多半是字段名/示例。
    if v.isalpha():
        return True
    return bool(_PLACEHOLDER.match(v))


def _iter_files(roots):
    n = 0
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS
                           and not d.startswith(".git")]
            for fn in filenames:
                if fn in _SKIP_NAMES or fn.lower().endswith(_SKIP_SUFFIX):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_FILE_BYTES:
                    continue
                n += 1
                if n > _MAX_FILES:
                    return
                yield p


def _read_text(p):
    try:
        with open(p, "r", encoding="utf-8", errors="strict") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _fingerprint(check, path, line, snippet):
    h = hashlib.sha1(f"{check}|{path}|{line}|{snippet[:120]}".encode()).hexdigest()
    return h[:16]


def _docstring_states(lines, path):
    """对 .py 文件逐行判断"本行是否处于三引号 docstring 内"（近似）。"""
    if not path.endswith(".py"):
        return [False] * len(lines)
    states = []
    in_doc = False
    for line in lines:
        # 统计本行出现的三引号（""" 与 '''）次数，用于翻转状态。
        dq = line.count('"""')
        sq = line.count("'''")
        was = in_doc
        if in_doc:
            # 在 docstring 内：本行只要出现闭合就算结束
            if (dq % 2 == 1) or (sq % 2 == 1):
                in_doc = False
        else:
            if (dq % 2 == 1) or (sq % 2 == 1):
                in_doc = True
        states.append(was)
    return states


def scan_code(roots=None):
    """扫描代码文本：返回 finding dict 列表。"""
    roots = roots or _roots()
    findings = []
    for path in _iter_files(roots):
        base = os.path.basename(path)
        text = _read_text(path)
        if text is None:
            continue
        is_ok_secret_file = bool(_OK_SECRET_FILES.search(base))
        is_test = bool(_TEST_PATH.search(path))
        lines = text.splitlines()
        in_doc = _docstring_states(lines, path)
        for ln_no, line in enumerate(lines, 1):
            s = line.strip()
            if not s or len(s) > 2000:
                continue
            if in_doc[ln_no - 1]:
                continue  # docstring/注释块里的示例不算
            if s.startswith("#"):
                continue
            # 密钥类：.env / example / 测试文件跳过（那些是正确的存放处/假值）
            if not is_ok_secret_file and not is_test:
                for check, sev, title, rx, why in SECRET_RULES:
                    m = rx.search(line)
                    if not m:
                        continue
                    # 取最后一个捕获组当"值"来判断是否占位符
                    val = next((g for g in reversed(m.groups()) if g), m.group(0))
                    if rx.groups and val is not None and _is_placeholder(val):
                        continue
                    if _ENV_REF.search(line):
                        continue
                    findings.append(_mk(check, sev, title, path, ln_no, s, why))
                    break  # 一行最多报一条密钥
            for check, sev, title, rx, why in DANGER_RULES:
                m = rx.search(line)
                if not m:
                    continue
                # 命中落在字符串字面量里（如 "exec("）多为示例，放过
                if m.start() > 0 and _QUOTED_BEFORE.search(line[:m.start()]):
                    continue
                findings.append(_mk(check, sev, title, path, ln_no, s, why))
    return findings


def _mk(check, sev, title, path, line, snippet, detail):
    return {
        "check": check, "severity": sev, "title": title,
        "file": path, "line": line, "snippet": snippet[:300], "detail": detail,
        "fingerprint": _fingerprint(check, path, line, snippet),
    }


# ── 集群配置巡检（明文 env / 特权 Pod / 裸密钥文件）────────────────────────
def _kubectl_json(*args, timeout=25):
    import json as _json
    import subprocess
    env = dict(os.environ)
    if "KUBECONFIG" not in env and os.path.exists("/etc/rancher/k3s/k3s.yaml"):
        env["KUBECONFIG"] = "/etc/rancher/k3s/k3s.yaml"
    try:
        r = subprocess.run(["kubectl", *args, "-o", "json"],
                           capture_output=True, text=True, timeout=timeout, env=env)
        if r.returncode != 0:
            return None
        return _json.loads(r.stdout or "{}")
    except Exception:
        log.debug("kubectl %s failed", args, exc_info=True)
        return None


_SENSITIVE_NAME = re.compile(r"(?i)(pass|secret|token|key|credential|auth)")


def scan_k8s():
    """集群巡检：Pod 容器 env 裸写敏感值 / 特权 / 挂宿主根目录。"""
    findings = []
    for ns in (siteconf.GROUP_NS, siteconf.INFRA_NS):
        data = _kubectl_json("get", "pods", "-n", ns)
        if not data:
            continue
        for item in data.get("items", []):
            meta = item.get("metadata", {}) or {}
            name = meta.get("name", "?")
            spec = (item.get("spec") or {})
            for ci, c in enumerate(spec.get("containers", []) or []):
                cname = c.get("name", f"c{ci}")
                for e in (c.get("env") or []):
                    ename = str(e.get("name", ""))
                    val = e.get("value")
                    if val is None or not _SENSITIVE_NAME.search(ename):
                        continue
                    if _is_placeholder(val) or _ENV_REF.search(str(val)):
                        continue
                    loc = f"pod/{name} container/{cname} env/{ename}"
                    findings.append(_mk(
                        "k8s/plaintext-env", "high", "Pod 环境变量裸写明文密钥",
                        loc, 1, f"{ename}={val}"[:80],
                        "应改为 valueFrom.secretKeyRef 引用 Secret，而非 value 直写。"))
                if c.get("securityContext", {}).get("privileged"):
                    loc = f"pod/{name} container/{cname}"
                    findings.append(_mk(
                        "k8s/privileged", "medium", "特权容器 privileged",
                        loc, 1, "securityContext.privileged=true",
                        "特权容器近乎宿主 root；确认必要并最小化能力集。"))
            if spec.get("hostNetwork"):
                findings.append(_mk(
                    "k8s/host-network", "low", "Pod 使用 hostNetwork",
                    f"pod/{name}", 1, "spec.hostNetwork=true",
                    "共享宿主网络命名空间，攻击面更大。"))
            for vi, v in enumerate(spec.get("volumes", []) or []):
                hp = v.get("hostPath")
                if not hp:
                    continue
                p = hp.get("path", "")
                if p in ("/", "/etc", "/var/run", "/") or p.startswith("/etc") or p == "/mnt/sdb":
                    findings.append(_mk(
                        "k8s/hostpath-broad", "medium", "hostPath 挂载过宽的宿主目录",
                        f"pod/{name} vol/{v.get('name','v%d'%vi)}", 1, p,
                        "挂载宿主敏感目录；确认只读、且容器非特权。"))
    return findings


def scan_secret_files():
    """平台根下含密钥但权限过宽（他人可读）的文件。"""
    findings = []
    root = siteconf.ROOT
    if not os.path.isdir(root):
        return findings
    for fn in os.listdir(root):
        if not (fn.endswith(".conf") or fn.startswith(".env") or fn.endswith(".key")
                or (fn.endswith(".json") and ("cred" in fn or "secret" in fn))):
            continue
        # .env.example / *.sample / *.template 是模板，不含真凭证。
        if _OK_SECRET_FILES.search(fn):
            continue
        p = os.path.join(root, fn)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        world = st.st_mode & (stat.S_IRGRP | stat.S_IROTH)
        if world:
            findings.append(_mk(
                "perm/secret-file", "medium", "密钥文件权限过宽",
                p, 1, oct(st.st_mode & 0o777),
                "该文件可能含凭证且组/其他可读；应收紧为 600（root 独占）。"))
    return findings


SCANS = {"code": scan_code, "k8s": scan_k8s, "perms": scan_secret_files}


# ── 存储 ────────────────────────────────────────────────────────────────────
def _db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    try:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    except OSError:
        pass
    with _db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS scan_run (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,
          trigger TEXT, n_total INTEGER, n_new INTEGER,
          n_crit INTEGER, n_high INTEGER, n_med INTEGER, n_low INTEGER,
          duration_s REAL, error TEXT);
        CREATE TABLE IF NOT EXISTS scan_finding (
          fingerprint TEXT PRIMARY KEY, check_id TEXT, severity TEXT, title TEXT,
          file TEXT, line INTEGER, snippet TEXT, detail TEXT,
          first_seen REAL, last_seen REAL, status TEXT DEFAULT 'open');
        """)


_SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def run_scan(kinds=None, trigger="manual"):
    """跑一遍巡检：写 run + 新增 finding（按 fingerprint 去重），返回摘要。"""
    init_db()
    kinds = kinds or list(SCANS.keys())
    t0 = time.time()
    all_f = []
    err = None
    for k in kinds:
        fn = SCANS.get(k)
        if not fn:
            continue
        try:
            all_f += fn()
        except Exception as e:  # 单项失败不影响其它
            err = f"{k}: {e}"
            log.exception("scan %s failed", k)
    now = time.time()
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    n_new = 0
    new_hi = []
    try:
        with _db() as db:
            for f in all_f:
                counts[f["severity"]] = counts.get(f["severity"], 0) + 1
                row = db.execute("SELECT status FROM scan_finding WHERE fingerprint=?",
                                 (f["fingerprint"],)).fetchone()
                if row is None:
                    n_new += 1
                    if f["severity"] in ("critical", "high"):
                        new_hi.append(f)
                    db.execute(
                        "INSERT INTO scan_finding(fingerprint,check_id,severity,title,"
                        "file,line,snippet,detail,first_seen,last_seen,status) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?, 'open')",
                        (f["fingerprint"], f["check"], f["severity"], f["title"],
                         f["file"], f["line"], f["snippet"], f["detail"], now, now))
                elif row["status"] != "ignored":
                    db.execute("UPDATE scan_finding SET last_seen=?, severity=?, "
                               "snippet=?, detail=? WHERE fingerprint=?",
                               (now, f["severity"], f["snippet"], f["detail"],
                                f["fingerprint"]))
                else:
                    db.execute("UPDATE scan_finding SET last_seen=? WHERE fingerprint=?",
                               (now, f["fingerprint"]))
            cur = db.execute(
                "INSERT INTO scan_run(ts,trigger,n_total,n_new,n_crit,n_high,n_med,"
                "n_low,duration_s,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (now, trigger, len(all_f), n_new, counts["critical"], counts["high"],
                 counts["medium"], counts["low"], round(now - t0, 2), err))
            run_id = cur.lastrowid
    except Exception as e:
        log.exception("scan persist failed")
        return {"ok": False, "error": str(e)}
    _alert_new(new_hi)
    _audit(run_id, trigger, all_f, err)
    return {"ok": True, "run_id": run_id, "total": len(all_f), "new": n_new,
            "counts": counts, "duration_s": round(now - t0, 2), "error": err}


def _alert_new(new_hi):
    if not new_hi or not ALERTS:
        return
    try:
        import cert_alerts
        for f in new_hi[:5]:
            cert_alerts.notify_admins(
                f"scan:{f['fingerprint']}", "scan-finding",
                f"安全巡检发现 [{f['severity']}] {f['title']}",
                f"{f['file']}:{f['line']} — {f['snippet'][:120]}",
                url="/ops/scan", urgency="high")
    except Exception:
        log.exception("scan alert failed")


def _audit(run_id, trigger, findings, err):
    try:
        import audit
        audit.record("scan_run", detail=f"run={run_id} trigger={trigger} "
                     f"total={len(findings)} err={err or '-'}", module="scan_svc")
    except Exception:
        log.exception("scan audit failed")


# ── 查询 ────────────────────────────────────────────────────────────────────
def latest_run():
    init_db()
    with _db() as db:
        r = db.execute("SELECT * FROM scan_run ORDER BY ts DESC LIMIT 1").fetchone()
    return dict(r) if r else None


def history(limit=30):
    init_db()
    with _db() as db:
        rows = db.execute("SELECT * FROM scan_run ORDER BY ts DESC LIMIT ?",
                          (int(limit),)).fetchall()
    return [dict(r) for r in rows]


def list_findings(severity=None, check=None, q=None, status=None,
                  limit=200, offset=0):
    init_db()
    where, args = [], []
    if severity:
        where.append("severity=?"); args.append(severity)
    if check:
        where.append("check_id LIKE ?"); args.append(check + "%")
    if status:
        where.append("status=?"); args.append(status)
    if q:
        where.append("(title LIKE ? OR file LIKE ? OR snippet LIKE ?)")
        args += [f"%{q}%"] * 3
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _db() as db:
        total = db.execute(f"SELECT COUNT(*) c FROM scan_finding {clause}", args).fetchone()["c"]
        rows = db.execute(
            f"SELECT * FROM scan_finding {clause} "
            f"ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
            f"WHEN 'medium' THEN 2 ELSE 3 END, last_seen DESC LIMIT ? OFFSET ?",
            args + [int(limit), int(offset)]).fetchall()
    return {"items": [dict(r) for r in rows], "total": total}


def summary():
    init_db()
    with _db() as db:
        rows = db.execute(
            "SELECT severity, COUNT(*) c FROM scan_finding WHERE status!='ignored' "
            "GROUP BY severity").fetchall()
        per_check = db.execute(
            "SELECT check_id, severity, COUNT(*) c FROM scan_finding WHERE status!='ignored' "
            "GROUP BY check_id, severity ORDER BY c DESC LIMIT 30").fetchall()
        files = db.execute(
            "SELECT COUNT(DISTINCT file) c FROM scan_finding WHERE status!='ignored'").fetchone()["c"]
    by_sev = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for r in rows:
        by_sev[r["severity"]] = r["c"]
    return {"by_severity": by_sev, "total": sum(by_sev.values()),
            "files": files, "by_check": [dict(r) for r in per_check],
            "last_run": latest_run()}


def set_status(fingerprint, status):
    if status not in ("open", "ignored", "resolved"):
        raise ValueError("bad status")
    init_db()
    with _db() as db:
        db.execute("UPDATE scan_finding SET status=? WHERE fingerprint=?",
                   (status, fingerprint))
    return True


# ── 后台守护线程（同 cert_alerts 模式）──────────────────────────────────────
_started = False
_lock = threading.Lock()


def _loop():
    # 启动先跑一次（延迟 90s，让平台自身先起来），随后按 INTERVAL_S 周期跑。
    time.sleep(90)
    while True:
        try:
            run_scan(trigger="schedule")
        except Exception:
            log.exception("scheduled scan failed")
        time.sleep(INTERVAL_S)


def start():
    global _started
    if _started or DISABLED:
        return
    with _lock:
        if _started:
            return
        threading.Thread(target=_loop, name="scan-svc", daemon=True).start()
        _started = True
        log.info("scan_svc thread started (interval=%ss)", INTERVAL_S)


start()
