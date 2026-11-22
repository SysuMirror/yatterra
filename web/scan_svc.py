#!/usr/bin/env python3
"""平台安全巡检（静态脚本层 / L1）— 明文密钥 / 危险代码 / 依赖 / 容器配置 / 文件权限 / 主机。

多层筛选：
  L1 规则层（本文件，纯 stdlib 正则/启发式）：快、召回高，覆盖**每一个 Pod** 的
     home 代码 + 平台自身代码 + k8s 清单 + 主机配置。结果落 SQLite
     `siteconf.path("scan_results.db")`，每条带 `scope`（哪个 Pod / platform / host）
     与 `category`（secret/danger/depend/config/file/host），供按 Pod 筛选。
  L2 LLM 复核层：由 **podwatch**（每-Pod 定时 LLM 巡检）拉本 Pod 的 L1 候选，
     让 LLM 判真/误报并校准等级，再回写本库（见下方 candidates_for_scope /
     apply_llm_verdict）。scan_svc 自身**不调用 LLM**。
  L3 LLM 语义层：同样由 podwatch 在每-Pod 巡检里做逻辑级审计（越权/IDOR/竞态/
     注入/业务逻辑），以 `llm/*` 写回本库（见 ingest_llm_findings）。
  L4 动态层：运维「安全巡检」页另一 Tab 的 ARTEX 端到端渗透。

设计取舍：纯 stdlib、单文件；后台线程只跑便宜的 L1（`YATTERRA_SCAN_INTERVAL_S`，
默认 6h），发现新增 high/critical 推管理员（kind='scan-finding'）。按 fingerprint
去重。env `YATTERRA_SCAN_DISABLED=1` 可关。
"""
import hashlib
import json
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

# 分类（check_id 前缀 → 语义；见 _category 的别名表）
CATEGORIES = {
    "secret": "明文密钥",
    "danger": "危险代码",
    "depend": "供应链/依赖",
    "config": "集群/容器配置",
    "file": "文件/权限",
    "host": "主机配置",
    "llm": "LLM 语义审查",
}
_CAT_ALIAS = {"k8s": "config", "perm": "file"}   # 兼容历史行


def _category(check):
    p = (check or "").split("/", 1)[0]
    return _CAT_ALIAS.get(p, p)


# ── 扫描根 / scope ──────────────────────────────────────────────────────────
_GROUP_ROOT = os.environ.get("YATTERRA_GROUP_ROOT", "/mnt/sdb/groups")


def _extra_roots():
    return [p.strip() for p in os.environ.get("YATTERRA_SCAN_EXTRA_ROOTS", "").split(",") if p.strip()]


def _roots():
    """代码层扫描根：平台 web 目录 + 每个 Pod 的 home + 额外目录。"""
    roots = []
    web = siteconf.WEB_DIR
    if os.path.isdir(web):
        roots.append(web)
    if os.path.isdir(_GROUP_ROOT):
        for name in sorted(os.listdir(_GROUP_ROOT)):
            home = os.path.join(_GROUP_ROOT, name, "home")
            if os.path.isdir(home):
                roots.append(home)
    roots += _extra_roots()
    return roots


def _scope_of(path):
    """把文件路径映射到 scope：Pod 名 / platform / external:<name>。"""
    ap = os.path.abspath(path)
    gr = os.path.abspath(_GROUP_ROOT)
    if ap.startswith(gr + os.sep):
        return ap[len(gr) + 1:].split(os.sep, 1)[0]
    if ap.startswith(os.path.abspath(siteconf.WEB_DIR)):
        return "platform"
    for r in _extra_roots():
        if ap.startswith(os.path.abspath(r)):
            return "external:" + os.path.basename(os.path.abspath(r))
    return "platform"


# ── 跳过规则 ────────────────────────────────────────────────────────────────
# Pod home 里常混着整套 SDK / 依赖 / 运行时数据（Flutter、Android AVD、GOPATH
# 模块缓存、conda/venv、agent transcript…），体量可达几十万文件却都不是「这个
# Pod 自己的代码」。不剪掉这些：(a) 扫描要跑几分钟，(b) 全是三方代码的误报。
_SKIP_DIRS = {
    # 依赖 / 虚拟环境 / 构建产物
    "node_modules", "bower_components", "jspm_packages", ".pnpm-store",
    "pnpm-store", ".pnpm", ".yarn", ".npm", ".npm-global", ".nvm",
    ".venv", "venv", "env", ".tox", "site-packages", "dist-packages",
    "miniconda3", "anaconda3", ".conda", "conda-meta", ".pyenv",
    "dist", "build", "out", "target", "coverage", ".nyc_output", ".parcel-cache",
    ".next", ".nuxt", ".svelte-kit", ".turbo", ".spa-staging", "vendor",
    ".gradle", ".m2", ".ivy2", ".sbt", ".cargo", ".rustup", ".cocoapods",
    "Pods", ".pub-cache", ".dart_tool", "flutter", "ephemeral",
    ".terraform", ".serverless", ".angular", ".expo", "Godeps",
    # VCS / 缓存 / 工具
    ".git", ".hg", ".svn", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".ipynb_checkpoints", ".cache", ".local", ".cursor",
    ".cursor-server", ".vscode-server", ".trae", ".trae-cn", ".trae-aicc",
    ".gemini", ".grok", ".opencode", ".codex", ".kaggle", ".modelscope",
    ".hf_cache", ".triton", ".zap", ".mozilla", ".steam", ".pki", ".dotnet",
    ".gradle", ".android", "avd", ".humming", "snap",
    ".oneapi", "conda", ".node-gyp", "node-gyp",
    # 运行时数据 / 产物目录（不是代码）
    "site-packages", "transcripts", "sessions", "checkpoints", "wandb",
    "tensorboard", "logs", "log", "runs", "outputs", "backup", "backups",
    "sseapi-backup", "yatterra-backup", "snapshots", ".git-credentials",
    "dump", "dumps", ".trash",
}
_SKIP_SUFFIX = (
    ".min.js", ".map", ".pyc", ".pyo", ".pyi", ".so", ".o", ".a", ".class",
    ".jar", ".war", ".dex", ".apk", ".aar", ".bin", ".whl", ".egg",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svgz", ".pdf",
    ".zip", ".gz", ".bz2", ".xz", ".tar", ".tgz", ".7z", ".rar",
    ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".wav", ".flac",
    ".db", ".sqlite", ".db-wal", ".db-shm", ".mdb",
    ".jsonl", ".jsonlines", ".ndjson", ".csv", ".tsv", ".parquet",
    ".npy", ".npz", ".pt", ".pth", ".ckpt", ".safetensors", ".onnx",
    ".cubin", ".cubin", ".ptx", ".fatbin", ".nii", ".h5", ".pkl", ".pickle",
    ".lock",
)
_SKIP_NAMES = {
    "scan_svc.py",   # 本文件自带密钥正则 → 免得自己举报自己
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock",
    "Pipfile.lock", "composer.lock", "Cargo.lock", ".DS_Store",
}
_OK_SECRET_FILES = re.compile(r"(\.env(\..*)?|.*\.example|.*\.template|.*\.sample|\.envrc)$")
_TEST_PATH = re.compile(r"(^|/)(tests?|testing|__tests__|spec)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.spec\.[tj]sx?$")
_QUOTED_BEFORE = re.compile(r"""[("']{1,2}\s*$""")

# 只看可能含代码/配置的扩展名与文件名——把数据文件（.jsonl/.log/.csv…）挡在门外。
_CODE_EXT = {
    "py", "js", "ts", "tsx", "jsx", "mjs", "cjs", "vue", "svelte",
    "go", "rs", "java", "kt", "kts", "rb", "php", "cs", "swift", "scala",
    "c", "cc", "cpp", "cxx", "h", "hpp", "m", "mm", "lua", "pl", "r", "dart",
    "sh", "bash", "zsh", "fish", "ksh", "ps1", "bat", "cmd", "sql", "proto",
    "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "properties",
    "json", "html", "htm", "css", "scss", "sass", "less", "xml", "gradle",
    "tf", "hcl", "dockerfile", "mk", "makefile",
}
_CODE_NAMES = {
    "dockerfile", "containerfile", "makefile", "cmakelists.txt",
    "requirements.txt", "pyproject.toml", "package.json", "go.mod",
    "cargo.toml", "procfile", "supervisord.conf", ".env", ".envrc",
    ".npmrc", ".dockerignore", ".netrc", ".pgpass", "nginx.conf",
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
}

_MAX_FILE_BYTES = int(os.environ.get("YATTERRA_SCAN_MAX_FILE_BYTES", str(512 * 1024)))
# 全局扫描文件数上限。配合 _walk 的公平轮转（每根目录每轮取一个文件），
# 上限一旦到顶，每个 Pod 拿到的份额 ≈ 上限 / 根目录数——按比例而非「先到先得」，
# 所以即便调小也不会出现「后面的 Pod 一个都没扫到」。默认 30000 兼顾覆盖与耗时。
_MAX_FILES = int(os.environ.get("YATTERRA_SCAN_MAX_FILES", "20000"))
# 单文件最多看的行数（防个别超大生成文件把整轮拖垮）。
_MAX_LINES = int(os.environ.get("YATTERRA_SCAN_MAX_LINES", "6000"))
# 每个 (scope, check) 的封顶条数（抑制 vendored/生成树的同规则刷屏）。
_CAP_PER_CHECK = int(os.environ.get("YATTERRA_SCAN_CAP_PER_CHECK", "25"))


def _is_code_file(fname):
    b = fname.lower()
    if b in _CODE_NAMES:
        return True
    dot = b.rfind(".")
    if dot <= 0:
        return False
    return b[dot + 1:] in _CODE_EXT

_DOCKER_NAMES = {"dockerfile", "containerfile"}
_COMPOSE_NAMES = {"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"}


def _file_tags(path):
    base = os.path.basename(path).lower()
    tags = set()
    if "." in base:
        tags.add(base.rsplit(".", 1)[1])
    if base in _DOCKER_NAMES:
        tags.add("dockerfile")
    if base in _COMPOSE_NAMES:
        tags.add("compose")
    if base.endswith((".yml", ".yaml")):
        tags.add("yaml")
    return tags


def _R(check, sev, title, rx, why, exts=None):
    """一条规则：check_id / 等级 / 标题 / 正则 / 说明 / 适用扩展名(可选集合)。"""
    return (check, sev, title, rx, why, exts)


# ── 规则表 ──────────────────────────────────────────────────────────────────
# 1) 明文密钥（category=secret）。正则有捕获组时，最后一个捕获组当"值"判占位符。
SECRET_RULES = [
    _R("secret/private-key", "critical", "内联私钥",
       re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
       "源码里直接贴了私钥块——应立即作废并改从密钥管理系统/Secrets 注入。"),
    _R("secret/putty-key", "high", "内联 PuTTY 私钥",
       re.compile(r"PuTTY-User-Key-File-\d"),
       "PuTTY 私钥块出现在源码里。"),
    _R("secret/aws-akid", "critical", "AWS Access Key ID",
       re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
       "疑似硬编码的 AWS 凭证。"),
    _R("secret/aws-secret", "high", "AWS Secret Access Key",
       re.compile(r"""(?i)aws_secret_access_key\s*[:=]\s*['"]([A-Za-z0-9/+]{30,})['"]"""),
       "硬编码的 AWS Secret。"),
    _R("secret/gcp-sa", "critical", "GCP 服务账号密钥",
       re.compile(r"""['"]type['"]\s*:\s*['"]service_account['"]"""),
       "GCP 服务账号 JSON（含私钥）被写进了代码/配置。"),
    _R("secret/google-api", "high", "Google API Key",
       re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
       "硬编码的 Google API key。"),
    _R("secret/openai-key", "high", "API Key（sk-…）",
       re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b"),
       "疑似硬编码的模型/服务 API key。"),
    _R("secret/anthropic-key", "high", "Anthropic API Key",
       re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b"),
       "硬编码的 Anthropic key。"),
    _R("secret/hf-token", "high", "HuggingFace Token",
       re.compile(r"\bhf_[A-Za-z0-9]{30,}\b"),
       "硬编码的 HuggingFace 访问令牌。"),
    _R("secret/slack-token", "high", "Slack Token",
       re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
       "硬编码的 Slack 令牌。"),
    _R("secret/github-pat", "high", "GitHub PAT",
       re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b"),
       "硬编码的 GitHub 个人访问令牌。"),
    _R("secret/gitlab-pat", "high", "GitLab PAT",
       re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b"),
       "硬编码的 GitLab 访问令牌。"),
    _R("secret/stripe-key", "high", "Stripe 密钥",
       re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b"),
       "硬编码的 Stripe live 密钥。"),
    _R("secret/twilio-key", "high", "Twilio 密钥",
       re.compile(r"\bSK[0-9a-fA-F]{32}\b"),
       "疑似硬编码的 Twilio key。"),
    _R("secret/sendgrid-key", "high", "SendGrid Key",
       re.compile(r"\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b"),
       "硬编码的 SendGrid key。"),
    _R("secret/telegram-bot", "high", "Telegram Bot Token",
       re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b"),
       "硬编码的 Telegram 机器人令牌。"),
    _R("secret/discord-webhook", "medium", "Discord Webhook",
       re.compile(r"https://discord(?:app)?\.com/api/webhooks/\d+/\S+"),
       "硬编码的 Discord webhook（可被滥用发消息）。"),
    _R("secret/npm-token", "medium", "npm _authToken",
       re.compile(r"_authToken\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{20,})"),
       "npm registry 令牌被明文写入（应放 ~/.npmrc 且文件 600）。"),
    _R("secret/docker-auth", "medium", "Docker registry 凭据",
       re.compile(r"""['"]auth['"]\s*:\s*['"]([A-Za-z0-9+/=]{16,})['"]"""),
       "Docker config.json 里的 base64 凭据。"),
    _R("secret/jwt", "high", "内联 JWT",
       re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}\b"),
       "源码里出现了 JWT 字面量。"),
    _R("secret/conn-str", "high", "连接串内嵌口令",
       re.compile(r"\b(?:https?|ftp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|smtp|ldap|ldaps|ssh)://[^\s:/@'\"]+:[^\s:/@'\"]{4,}@[^\s'\"]+", re.I),
       "URL 连接串里直接写了 用户名:口令@主机。"),
    _R("secret/basic-auth", "medium", "Authorization Basic",
       re.compile(r"(?i)authorization['\"]?\s*[:=]\s*['\"]basic\s+([A-Za-z0-9+/=]{16,})"),
       "内联 Basic 认证头，等价于明文口令。"),
    _R("secret/assigned", "high", "硬编码口令/密钥赋值",
       re.compile(r"""(?i)\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|"""
                  r"""access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|"""
                  r"""client[_-]?secret|encryption[_-]?key|signing[_-]?key|bearer|"""
                  r"""refresh[_-]?token|session[_-]?secret|cookie[_-]?secret|"""
                  r"""jwt[_-]?(?:secret|key)|salt)\b"""
                  r"""\s*[:=]\s*['"]([^'"]{6,120})['"]"""),
       "敏感字段被赋成了字符串字面量；应改从 os.environ / .env / Secret 读取。"),
    _R("secret/assigned-raw", "medium", "疑似裸写密钥",
       re.compile(r"""(?im)^\s*(password|passwd|secret|token|api[_-]?key|access[_-]?key|"""
                  r"""secret[_-]?key|client[_-]?secret)\s*[:=]\s*([A-Za-z0-9+/=_\-]{12,})"""),
       "看起来是裸写的密钥值（非占位符）。"),
    _R("secret/high-entropy", "medium", "高熵字面量赋值",
       re.compile(r"""(?i)\b(key|token|secret|credential|passwd|password)\w*\s*[:=]\s*['"]"""
                  r"""([A-Za-z0-9+/]{32,}={0,2})['"]"""),
       "疑似 base64/高熵密钥字面量。"),
]

# 2) 危险代码逻辑（category=danger）。exts=适用扩展名，None=全部文本。
DANGER_RULES = [
    _R("danger/eval", "high", "动态执行 eval/exec",
       re.compile(r"(?<![\w.])(eval|exec)\s*\("), "对不可信输入 eval/exec = 任意代码执行。"),
    _R("danger/os-system", "high", "os.system / os.popen",
       re.compile(r"\bos\.(system|popen)\s*\("), "命令注入面；优先 subprocess + 参数列表。"),
    _R("danger/shell-true", "high", "subprocess shell=True",
       re.compile(r"subprocess\.(run|call|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True"),
       "shell=True 且命令含外部输入即命令注入。"),
    _R("danger/subprocess-fmt", "medium", "subprocess 命令由字符串拼接",
       re.compile(r"subprocess\.\w+\s*\(\s*(f['\"]|['\"][^'\"]*['\"]\s*(%|\+|\.format\())"),
       "命令由字符串拼成，注入风险；用参数列表。"),
    _R("danger/pickle", "high", "pickle/marshal/dill 反序列化",
       re.compile(r"\b(pickle|marshal|dill|jsonpickle)\.loads?\s*\("),
       "对不可信数据反序列化 = 任意代码执行。"),
    _R("danger/yaml-load", "medium", "yaml.load 未用 SafeLoader",
       re.compile(r"yaml\.load\s*\((?![^)]*SafeLoader)"), "改 yaml.safe_load。"),
    _R("danger/verify-false", "medium", "TLS 校验被关闭",
       re.compile(r"verify\s*=\s*False|_create_unverified_context|check_hostname\s*=\s*False"),
       "关闭证书校验会被中间人攻击。"),
    _R("danger/xxe", "medium", "XML 解析未防 XXE",
       re.compile(r"(etree|lxml|minidom|xml\.dom)\.\w*[Pp]arse|ElementTree\.parse|fromstring\s*\("),
       "XML 解析默认可能解析外部实体（XXE）；需禁用 DTD/实体。", {"py"}),
    _R("danger/template-inject", "medium", "模板字符串注入 (SSTI)",
       re.compile(r"render_template_string\s*\(|jinja2\.(?:Template|from_string)\s*\("),
       "模板由字符串动态构造可致 SSTI/RCE。", {"py", "js", "ts"}),
    _R("danger/sql-concat", "medium", "SQL 字符串拼接",
       re.compile(r"""(execute|executemany|execute_query)\s*\(\s*(f['\"]|['\"][^'\"]*['\"]\s*(%|\+|\.format\())"""),
       "SQL 由字符串拼接构成 → 注入面；应参数化查询。"),
    _R("danger/orm-raw", "medium", "ORM 原生 SQL",
       re.compile(r"\.(raw|extra)\s*\(|RawSQL|sequelize\.query\s*\(|knex\.raw\s*\("),
       "绕过 ORM 的原生 SQL，确认已参数化。"),
    _R("danger/weak-hash", "medium", "弱哈希用于口令",
       re.compile(r"(?i)(hashlib\.(md5|sha1)|MessageDigest\.getInstance\(\s*['\"](?:MD5|SHA-?1))"),
       "MD5/SHA1 不适合口令；用 bcrypt/scrypt/argon2。"),
    _R("danger/random-secret", "medium", "非密码学随机生成密钥",
       re.compile(r"(?i)(random\.(random|randint|choice|randrange)|Math\.random)\s*\([^)]*\)\s*(?:.*(?:token|secret|password|otp|nonce|salt|id))"),
       "用非密码学随机数生成安全令牌；改用 secrets / crypto.randomBytes。"),
    _R("danger/tar-slip", "medium", "归档解压未防路径穿越",
       re.compile(r"(?i)(tarfile|zipfile)\.\w*extract(?:all)?\s*\("),
       "解压未校验成员路径 → Zip-Slip/Tar-Slip 任意写。"),
    _R("danger/js-eval", "medium", "前端 eval / new Function",
       re.compile(r"(?<![\w.])eval\s*\(|new\s+Function\s*\("),
       "前端动态执行字符串代码。", {"js", "ts", "tsx", "jsx"}),
    _R("danger/child-process", "medium", "Node child_process 执行",
       re.compile(r"child_process\.(exec|execSync|spawn|spawnSync)\s*\("),
       "Node 子进程执行；命令拼接即注入。", {"js", "ts", "tsx", "jsx"}),
    _R("danger/innerhtml", "medium", "innerHTML / dangerouslySetInnerHTML",
       re.compile(r"dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\("),
       "直接注入 HTML = XSS 面；确保内容已净化。", {"js", "ts", "tsx", "jsx", "html"}),
    _R("danger/proto-pollution", "medium", "原型链污染",
       re.compile(r"__proto__\s*[=:]|constructor\s*\]\s*\(|Object\.assign\(\s*\w+\.prototype"),
       "把外部输入并入对象原型 → 原型污染。", {"js", "ts", "tsx", "jsx"}),
    _R("danger/jwt-none", "medium", "JWT 校验被削弱",
       re.compile(r"algorithms?\s*:\s*\[?\s*['\"]none['\"]|jwt\.verify\s*\([^)]*verify\s*=\s*False|ignoreExpiration\s*:\s*true"),
       "允许 alg=none / 忽略过期 → 伪造令牌。", {"js", "ts", "tsx", "jsx", "py"}),
    _R("danger/open-redirect", "medium", "开放重定向",
       re.compile(r"(res\.redirect|location\s*=|window\.location\s*=)\s*[^;]*(req\.|request\.(args|query|form|get)|params\.)"),
       "跳转目标取自请求参数 → 开放重定向。", {"js", "ts", "tsx", "jsx", "py"}),
    _R("danger/go-exec", "medium", "Go exec 命令注入面",
       re.compile(r"exec\.Command\s*\(\s*['\"](?:sh|bash)['\"]|exec\.Command\s*\(\s*fmt\.Sprintf"),
       "经 shell 执行拼接命令 → 注入。", {"go"}),
    _R("danger/go-insecure-skip", "medium", "Go 跳过 TLS 校验",
       re.compile(r"InsecureSkipVerify\s*:\s*true"), "跳过证书校验会被 MITM。", {"go"}),
    _R("danger/go-sql-sprintf", "medium", "Go SQL 拼接",
       re.compile(r"\.(Query|QueryRow|Exec)\s*\(\s*fmt\.Sprintf"), "SQL 由 fmt.Sprintf 拼成 → 注入。", {"go"}),
    _R("danger/php-exec", "high", "PHP 命令执行",
       re.compile(r"(?<![.\w])(system|exec|shell_exec|passthru|popen|proc_open)\s*\("),
       "命令执行函数；外部输入直达即 RCE。", {"php"}),
    _R("danger/php-unserialize", "medium", "PHP unserialize",
       re.compile(r"unserialize\s*\("), "对不可信数据反序列化 → 对象注入。", {"php"}),
    _R("danger/php-include", "medium", "PHP 动态 include",
       re.compile(r"(include|require)(_once)?\s*\(?\s*\$"), "动态包含 → 本地/远程文件包含。", {"php"}),
    _R("danger/java-runtime-exec", "high", "Java Runtime.exec",
       re.compile(r"Runtime\.getRuntime\(\)\.exec|ProcessBuilder\s*\("),
       "Java 命令执行；拼接输入即注入。", {"java", "kt"}),
    _R("danger/java-deser", "medium", "Java 反序列化",
       re.compile(r"ObjectInputStream|readObject\s*\("), "Java 反序列化 gadget 链 → RCE。", {"java", "kt"}),
    _R("danger/bind-all", "low", "监听 0.0.0.0",
       re.compile(r"['\"]0\.0\.0\.0['\"]|bind\(['\"]0\.0\.0\.0"),
       "确认该端口确实需要对外暴露。"),
    _R("danger/cors-star", "medium", "CORS 通配允许",
       re.compile(r"(?i)(allow_origins|cors_allowed_origins|Access-Control-Allow-Origin|origin)\s*[=:]\s*(\[\s*)?['\"]\*['\"]"),
       "允许任意来源跨域，等于放弃同源保护。"),
    _R("danger/debug-true", "low", "调试开关开启",
       re.compile(r"(?i)\b(debug|DEBUG)\s*[:=]\s*(True|1)\b"), "生产开 debug 会泄露堆栈/启用调试器。"),
    _R("danger/chmod-777", "low", "过宽文件权限 0777/777",
       re.compile(r"(chmod|Chmod)\s*\(?\s*(0o)?0?777\b|\bchmod\s+777\b"), "777 允许任意用户改写。"),
]

# 3) 供应链 / 依赖（category=depend）。
DEPEND_RULES = [
    _R("depend/curl-pipe-shell", "high", "curl/wget 管道到 shell",
       re.compile(r"(?i)(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b"),
       "远程脚本直接执行，供应链投毒面大；应下载后校验再运行。",
       {"sh", "bash", "dockerfile", "yml", "yaml"}),
    _R("depend/pip-url", "medium", "pip 从 URL/git 安装",
       re.compile(r"pip3?\s+install\b[^\n]*(https?://|git\+https?)"),
       "从 URL/git 直接安装，未经索引校验。", {"sh", "bash", "dockerfile", "yml", "yaml", "txt", "toml"}),
    _R("depend/pip-trusted-host", "medium", "pip --trusted-host",
       re.compile(r"--trusted-host\b"), "绕过 TLS 校验安装包。", {"sh", "bash", "dockerfile", "yml", "yaml", "txt"}),
    _R("depend/npm-http", "medium", "npm 从 http 源安装",
       re.compile(r"npm\s+(?:i|install)\b[^\n]*http://"), "明文 http 源安装，易被篡改。", {"sh", "bash", "dockerfile", "yml", "yaml"}),
    _R("depend/npm-git", "low", "npm 从 git 安装",
       re.compile(r"npm\s+(?:i|install)\b[^\n]*(github:|git\+)"), "从 git 直接安装，锁不严。", {"sh", "bash", "dockerfile"}),
    _R("depend/dockerfile-latest", "low", "基础镜像 :latest",
       re.compile(r"(?im)^\s*FROM\s+\S+:latest\b"), "latest 不固定，构建不可复现。", {"dockerfile"}),
    _R("depend/dockerfile-add-http", "medium", "Dockerfile ADD 远程 URL",
       re.compile(r"(?im)^\s*ADD\s+https?://"), "ADD 远程 URL 未经校验拉取产物。", {"dockerfile"}),
]

# 4) 容器/编排配置（代码里的 docker/compose）（category=config）。
CONFIG_CODE_RULES = [
    _R("config/compose-privileged", "high", "compose 特权容器",
       re.compile(r"(?im)^\s*privileged\s*:\s*true"), "privileged 近乎宿主 root。", {"compose"}),
    _R("config/compose-docker-sock", "high", "compose 挂载 docker.sock",
       re.compile(r"/var/run/docker\.sock"), "挂 docker.sock = 取得宿主 root 能力。", {"compose"}),
    _R("config/compose-host-network", "medium", "compose host 网络",
       re.compile(r"(?im)^\s*network_mode\s*:\s*['\"]?host"), "共享宿主网络命名空间。", {"compose"}),
    _R("config/compose-cap-add", "medium", "compose 增加特权 capability",
       re.compile(r"(?im)^\s*cap_add\s*:|SYS_ADMIN|NET_ADMIN|SYS_PTRACE"), "授予额外内核能力。", {"compose"}),
    _R("config/dockerfile-user-root", "low", "Dockerfile 以 root 运行",
       re.compile(r"(?im)^\s*USER\s+root\b"), "容器以 root 运行；应降权。", {"dockerfile"}),
    _R("config/dockerfile-env-secret", "medium", "Dockerfile ENV 写密钥",
       re.compile(r"(?im)^\s*(?:ENV|ARG)\s+\w*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL)\w*\s*[= ]"),
       "密钥进镜像层会永久留在镜像历史。", {"dockerfile"}),
]

CODE_RULES = DANGER_RULES + DEPEND_RULES + CONFIG_CODE_RULES

# 单遍预筛：绝大多数源码行不含任何下面这个 token，逐条跑 60+ 正则太慢。
# 用一串**宽松的下界 token** 先过一遍（任一命中即放行），只有候选行才跑完整
# 规则表——token 只需是"规则的必然子串"，是超集即可（宁可多跑，不可漏）。
_PRE_TOKENS = (
    # 密钥
    "akia", "asia", "aiza", "sk-", "hf_", "xox", "ghp_", "gho_", "ghu_", "ghs_",
    "ghr_", "github_pat", "glpat-", "sk_live_", "rk_live_", "sg.", "discord",
    "webhook", "_authtoken", '"auth"', "'auth'", "eyj", "putty-user-key",
    "service_account", "aws_secret", "-----begin", "-----begin",
    "password", "passwd", "pwd", "passphrase", "secret", "token", "api_key",
    "apikey", "access_key", "accesskey", "client_secret", "signing_key",
    "private_key", "encryption_key", "auth_token", "bearer", "refresh_token",
    "session_secret", "cookie_secret", "salt", "://", "credential", "otp",
    # 危险代码
    "eval(", "exec(", "os.system", "os.popen", "shell=true", "subprocess",
    "pickle", "marshal", "dill", "jsonpickle", "yaml.load", "verify=false",
    "verify = false", "unverified", "check_hostname", "etree", "lxml",
    "minidom", "elementtree", "fromstring", "render_template_string", "jinja2",
    "template(", "execute", "executemany", ".raw(", ".extra(", "rawsql",
    "sequelize.query", "knex.raw", "hashlib", "messagedigest", "random.",
    "math.random", "tarfile", "zipfile", "extractall", "new function",
    "child_process", "innerhtml", "dangerouslysetinnerhtml", "document.write",
    "__proto__", "algorithms", "ignoreexpiration", "res.redirect",
    "window.location", "location =", "exec.command", "insecureskipverify",
    "fmt.sprintf", "shell_exec", "passthru", "popen", "proc_open", "system(",
    "unserialize", "runtime.getruntime", "objectinputstream", "readobject",
    "include(", "require(", "0.0.0.0", "allow_origins", "cors_allowed_origins",
    "access-control-allow-origin", "origins", "debug", "chmod", "777",
    # 依赖 / 容器
    "curl", "wget", "pip install", "pip3 install", "npm i", "npm install",
    "trusted-host", "from ", "add http", "add https", "privileged",
    "network_mode", "cap_add", "sys_admin", "net_admin", "sys_ptrace",
    "docker.sock", "user root", "env ", "arg ",
)


def _pre_ok(low):
    for t in _PRE_TOKENS:
        if t in low:
            return True
    return False


# 预编译的等价 alternation（对已 lower 的行做一次线性扫描）。实测比逐个 `in`
# 快约 2x，且召回完全一致；注意**不要**加 re.IGNORECASE——在 140 路 alternation
# 上开忽略大小写会让单次 search 从 ~7µs 涨到 ~40µs（实测），得不偿失。
_PRE_RX = re.compile("|".join(re.escape(t) for t in
                              sorted(set(_PRE_TOKENS), key=len, reverse=True)))

# 占位符 / 环境变量引用判定
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
    v = str(val).strip().strip("'\"")
    if len(v) < 8:
        return True
    if _CJK.search(v) or any(ch.isspace() for ch in v):
        return True
    if v.isalpha():
        return True
    return bool(_PLACEHOLDER.match(v))


def _walk(roots, code_only=True, limit=None):
    limit = _MAX_FILES if limit is None else limit
    """Yields candidate files; fair round-robin across roots.

    Round-robin (one file per root per turn) means a global cap can never starve
    the alphabetically-last Pods — every Pod gets its share before the cap bites,
    which is what "每个 Pod 都要巡检到" requires.
    """
    gens = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        def gen(root=root):
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
                for fn in filenames:
                    if fn in _SKIP_NAMES or fn.lower().endswith(_SKIP_SUFFIX):
                        continue
                    if code_only and not _is_code_file(fn):
                        continue
                    p = os.path.join(dirpath, fn)
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_FILE_BYTES:
                        continue
                    yield p
        gens.append(gen())
    n = 0
    while gens and n < limit:
        for g in list(gens):
            try:
                p = next(g)
            except StopIteration:
                gens.remove(g)
                continue
            n += 1
            yield p
            if n >= limit:
                return


def _iter_files(roots):
    """Code/config files only (see _CODE_EXT) — the L1 code scan input."""
    return _walk(roots, code_only=True)


def _iter_all_files(roots):
    """All files — used by the cheap stat-only file/permission scan."""
    return _walk(roots, code_only=False, limit=_MAX_FILES * 2)


def _read_text(p):
    try:
        with open(p, "r", encoding="utf-8", errors="strict") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _fingerprint(check, path, line, snippet):
    h = hashlib.sha1(f"{check}|{path}|{line}|{snippet[:120]}".encode()).hexdigest()
    return h[:16]


def _mk(check, sev, title, path, line, snippet, detail, scope=None,
        confidence="rule", source="static"):
    return {
        "check": check, "severity": sev, "title": title,
        "file": path, "line": line, "snippet": str(snippet)[:300], "detail": detail,
        "scope": scope or _scope_of(path), "category": _category(check),
        "confidence": confidence, "source": source,
        "fingerprint": _fingerprint(check, path, line, snippet),
    }


def _docstring_states(lines, path):
    if not path.endswith(".py"):
        return [False] * len(lines)
    states, in_doc = [], False
    for line in lines:
        dq, sq = line.count('"""'), line.count("'''")
        was = in_doc
        if in_doc:
            if (dq % 2 == 1) or (sq % 2 == 1):
                in_doc = False
        else:
            if (dq % 2 == 1) or (sq % 2 == 1):
                in_doc = True
        states.append(was)
    return states


def scan_code(roots=None):
    """扫描代码文本（密钥 + 危险代码 + 依赖 + 容器配置）。"""
    roots = roots or _roots()
    findings = []
    # 每个 (scope, check) 最多留 _CAP 条样本：一份 vendored/生成树里同一条规则
    # 命中几百次并不比命中 1 次更该报——封顶后噪声可控，真问题仍会被 L2 LLM 复核。
    counts = {}
    for path in _iter_files(roots):
        base = os.path.basename(path)
        text = _read_text(path)
        if text is None:
            continue
        scope = _scope_of(path)
        is_ok_secret_file = bool(_OK_SECRET_FILES.search(base))
        is_test = bool(_TEST_PATH.search(path))
        tags = _file_tags(path)
        lines = text.splitlines()
        in_doc = _docstring_states(lines, path)
        for ln_no, line in enumerate(lines[: _MAX_LINES], 1):
            s = line.strip()
            if not s or len(s) > 2000:
                continue
            if in_doc[ln_no - 1] or s.startswith("#"):
                continue
            if not _PRE_RX.search(line.lower()):
                continue
            hit = None
            if not is_ok_secret_file and not is_test:
                for check, sev, title, rx, why, exts in SECRET_RULES:
                    if exts and not (tags & set(exts)):
                        continue
                    m = rx.search(line)
                    if not m:
                        continue
                    val = next((g for g in reversed(m.groups()) if g), m.group(0))
                    if rx.groups and val is not None and _is_placeholder(val):
                        continue
                    if _ENV_REF.search(line):
                        continue
                    hit = (check, sev, title, why)
                    break   # 一行最多报一条密钥
            if hit is None:
                for check, sev, title, rx, why, exts in CODE_RULES:
                    if exts and not (tags & set(exts)):
                        continue
                    m = rx.search(line)
                    if not m:
                        continue
                    if m.start() > 0 and _QUOTED_BEFORE.search(line[:m.start()]):
                        continue
                    hit = (check, sev, title, why)
                    break
            if hit is None:
                continue
            check, sev, title, why = hit
            key = (scope, check)
            if counts.get(key, 0) >= _CAP_PER_CHECK:
                continue
            counts[key] = counts.get(key, 0) + 1
            findings.append(_mk(check, sev, title, path, ln_no, s, why, scope=scope))
    return findings


# ── 集群巡检（k8s）────────────────────────────────────────────────────────
def _kubectl_json(*args, timeout=25):
    import subprocess
    env = dict(os.environ)
    if "KUBECONFIG" not in env and os.path.exists("/etc/rancher/k3s/k3s.yaml"):
        env["KUBECONFIG"] = "/etc/rancher/k3s/k3s.yaml"
    try:
        r = subprocess.run(["kubectl", *args, "-o", "json"],
                           capture_output=True, text=True, timeout=timeout, env=env)
        if r.returncode != 0:
            return None
        return json.loads(r.stdout or "{}")
    except Exception:
        log.debug("kubectl %s failed", args, exc_info=True)
        return None


_SENSITIVE_NAME = re.compile(r"(?i)(pass|secret|token|key|credential|auth)")
_PRIV_CAPS = {"SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "DAC_READ_SEARCH"}


def _pod_findings(item, ns):
    out = []
    meta = item.get("metadata", {}) or {}
    name = meta.get("name", "?")
    scope = name
    spec = item.get("spec") or {}
    for c in spec.get("containers", []) or []:
        cname = c.get("name", "?")
        sc = c.get("securityContext", {}) or {}
        for e in (c.get("env") or []):
            ename = str(e.get("name", ""))
            val = e.get("value")
            if val is None or not _SENSITIVE_NAME.search(ename):
                continue
            if _is_placeholder(val) or _ENV_REF.search(str(val)):
                continue
            out.append(_mk("config/pod-plaintext-env", "high", "Pod 环境变量裸写明文密钥",
                           f"pod/{name} container/{cname} env/{ename}", 1, f"{ename}={val}"[:80],
                           "应改为 valueFrom.secretKeyRef 引用 Secret，而非 value 直写。", scope=scope))
        if sc.get("privileged"):
            out.append(_mk("config/privileged", "high", "特权容器 privileged", f"pod/{name} container/{cname}",
                           1, "securityContext.privileged=true", "特权容器近乎宿主 root。", scope=scope))
        if sc.get("allowPrivilegeEscalation") is not False:
            out.append(_mk("config/priv-escalation", "low", "允许权限提升",
                           f"pod/{name} container/{cname}", 1, "allowPrivilegeEscalation != false",
                           "应显式设为 false 阻断提权。", scope=scope))
        if sc.get("runAsUser") == 0 or sc.get("runAsNonRoot") is False:
            out.append(_mk("config/run-as-root", "medium", "以 root 运行容器",
                           f"pod/{name} container/{cname}", 1, "runAsUser=0 / runAsNonRoot=false",
                           "容器以 root 运行，逃逸后危害更大。", scope=scope))
        for cap in (sc.get("capabilities", {}) or {}).get("add", []) or []:
            if str(cap).upper() in _PRIV_CAPS:
                out.append(_mk("config/cap-add", "high", "授予危险 capability",
                               f"pod/{name} container/{cname}", 1, f"cap add {cap}",
                               "授予内核级能力，等同放权。", scope=scope))
        img = str(c.get("image", ""))
        if img and (img.endswith(":latest") or (":" not in img.split("/")[-1])):
            out.append(_mk("config/image-untagged", "low", "镜像标签不固定",
                           f"pod/{name} container/{cname}", 1, img,
                           "用 :latest/无 tag，回滚与审计困难。", scope=scope))
        res = c.get("resources", {}) or {}
        if not (res.get("limits") or {}):
            out.append(_mk("config/no-limits", "low", "容器未设资源上限",
                           f"pod/{name} container/{cname}", 1, "resources.limits 缺失",
                           "无上限易拖垮节点（含统一内存节点）。", scope=scope))
    for f, chk in (("hostNetwork", "config/host-network"), ("hostPID", "config/host-pid"),
                   ("hostIPC", "config/host-ipc")):
        if spec.get(f):
            sev = "medium" if f != "hostNetwork" else "low"
            out.append(_mk(chk, sev, f"Pod 使用 {f}", f"pod/{name}", 1, f"spec.{f}=true",
                           "共享宿主命名空间，攻击面更大。", scope=scope))
    for vi, v in enumerate(spec.get("volumes", []) or []):
        hp = v.get("hostPath")
        if not hp:
            continue
        p = hp.get("path", "")
        if p == "/" or p.startswith("/etc") or p in ("/var/run", "/mnt/sdb", "/root"):
            sev = "high" if p == "/" else "medium"
            out.append(_mk("config/hostpath-broad", sev, "hostPath 挂载过宽的宿主目录",
                           f"pod/{name} vol/{v.get('name', 'v%d' % vi)}", 1, p,
                           "挂宿敏目录；确认只读且容器非特权。", scope=scope))
    if spec.get("automountServiceAccountToken") is True or spec.get("serviceAccountName"):
        out.append(_mk("config/sa-token", "low", "Pod 可能自动挂载 SA token",
                       f"pod/{name}", 1, "serviceAccount/automount", "确认不需要时关闭自动挂载。", scope=scope))
    return out


def scan_k8s():
    """集群巡检：Pod / ConfigMap / RBAC / Service / Ingress。"""
    findings = []
    for ns in (siteconf.GROUP_NS, siteconf.INFRA_NS):
        pods = _kubectl_json("get", "pods", "-n", ns)
        if pods:
            for item in pods.get("items", []):
                findings += _pod_findings(item, ns)
        cms = _kubectl_json("get", "configmaps", "-n", ns)
        if cms:
            for item in cms.get("items", []):
                name = (item.get("metadata") or {}).get("name", "?")
                for k, v in (item.get("data") or {}).items():
                    if _SENSITIVE_NAME.search(k) and isinstance(v, str) \
                            and not _is_placeholder(v) and not _ENV_REF.search(v):
                        findings.append(_mk("config/secret-in-configmap", "high", "ConfigMap 里含明文密钥",
                                            f"configmap/{name} key/{k}", 1, f"{k}={v}"[:80],
                                            "应放 Secret 而非 ConfigMap。", scope=name))
        services = _kubectl_json("get", "services", "-n", ns)
        if services:
            for item in services.get("items", []):
                name = (item.get("metadata") or {}).get("name", "?")
                if (item.get("spec") or {}).get("type") == "LoadBalancer":
                    findings.append(_mk("config/svc-loadbalancer", "low", "Service 类型 LoadBalancer",
                                        f"svc/{name}", 1, "type=LoadBalancer",
                                        "直接对外暴露端口；确认必要。", scope=name))
        ings = _kubectl_json("get", "ingress", "-n", ns)
        if ings:
            for item in ings.get("items", []):
                name = (item.get("metadata") or {}).get("name", "?")
                for rule in (item.get("spec") or {}).get("tls", []) or []:
                    _ = rule
                tls = (item.get("spec") or {}).get("tls")
                if not tls:
                    findings.append(_mk("config/ingress-no-tls", "medium", "Ingress 未配置 TLS",
                                        f"ingress/{name}", 1, "spec.tls 缺失",
                                        "对外入口明文 HTTP。", scope=name))
    # RBAC：集群角色通配
    for kind in ("clusterrole", "role"):
        data = _kubectl_json("get", kind) if kind == "clusterrole" else _kubectl_json("get", kind, "-n", siteconf.GROUP_NS)
        if not data:
            continue
        for item in data.get("items", []):
            name = (item.get("metadata") or {}).get("name", "?")
            for rule in item.get("rules", []) or []:
                verbs = rule.get("verbs") or []
                res = rule.get("resources") or []
                if "*" in verbs or "*" in res:
                    findings.append(_mk("config/rbac-wildcard", "high", "RBAC 通配授权",
                                        f"{kind}/{name}", 1, f"verbs={verbs} resources={res}",
                                        "通配 * 权限过大；按最小权限收敛。", scope=name))
                    break
    return findings


# ── 文件 / 权限巡检 ──────────────────────────────────────────────────────────
_SENSITIVE_FILENAMES = re.compile(
    r"(?i)(^\.env$|^\.env\..+|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^credentials$|"
    r"^credentials\.json$|service[-_]?account.*\.json$|^\.pgpass$|^\.netrc$|"
    r"^\.git-credentials$|^\.npmrc$|^kubeconfig$|^config\.json$|"
    r"^terraform\.tfstate$|.*\.(pem|key|p12|pfx|jks|keystore|kdbx)$)"
)
# 这些"目录内文件名"才敏感（config.json / id_rsa 等需要在特定目录）
_SENSITIVE_DIRS = {".aws", ".ssh", ".docker", ".kube", ".gnupg"}


def _sensitive_hit(path):
    base = os.path.basename(path)
    if _SENSITIVE_FILENAMES.match(base):
        return True
    if os.path.basename(os.path.dirname(path)) in _SENSITIVE_DIRS:
        return True
    return False


def scan_files(roots=None):
    """敏感文件存在性 / 权限过宽 / setuid。覆盖平台根 + 每个 Pod home。"""
    roots = roots or _roots()
    findings = []
    # (a) 平台根下的密钥文件权限（历史 perm/secret-file 逻辑，改 category=file）
    root = siteconf.ROOT
    if os.path.isdir(root):
        for fn in os.listdir(root):
            if not (fn.endswith(".conf") or fn.startswith(".env") or fn.endswith(".key")
                    or (fn.endswith(".json") and ("cred" in fn or "secret" in fn))):
                continue
            if _OK_SECRET_FILES.search(fn):
                continue
            p = os.path.join(root, fn)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if st.st_mode & (stat.S_IRGRP | stat.S_IROTH):
                findings.append(_mk("file/perm-wide", "medium", "密钥文件权限过宽", p, 1,
                                    oct(st.st_mode & 0o777),
                                    "该文件可能含凭证且组/其他可读；应收紧为 600。", scope="platform"))
    # (b) 遍历各根：敏感文件名 + setuid（stat-only，用全量 walk + 公平轮转）
    for p in _iter_all_files(roots):
        scope = _scope_of(p)
        try:
            st = os.stat(p)
        except OSError:
            continue
        mode = st.st_mode
        if mode & (stat.S_ISUID | stat.S_ISGID):
            findings.append(_mk("file/setuid", "medium", "setuid/setgid 文件", p, 1, oct(mode & 0o7777),
                                "带 suid/sgid 位的可执行文件可能被用来提权。", scope=scope))
        if _sensitive_hit(p) and not _OK_SECRET_FILES.search(os.path.basename(p)):
            world = mode & (stat.S_IRGRP | stat.S_IROTH)
            sev = "high" if (scope != "platform" and world) else "medium"
            findings.append(_mk("file/sensitive-name", sev, "发现敏感/凭据文件", p, 1,
                                os.path.basename(p),
                                "该路径含凭据/私钥类文件；确认不该提交/应移入密钥管理，权限收紧 600。",
                                scope=scope))
    return findings


# ── 主机配置巡检 ────────────────────────────────────────────────────────────
def _read_lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except OSError:
        return []


def scan_host():
    findings = []
    ssh_files = ["/etc/ssh/sshd_config"]
    d = "/etc/ssh/sshd_config.d"
    if os.path.isdir(d):
        ssh_files += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".conf")]
    for p in ssh_files:
        for i, line in enumerate(_read_lines(p), 1):
            s = line.strip()
            if s.startswith("#") or not s:
                continue
            low = s.lower().replace(" ", "")
            if low.startswith("permitrootlogin") and "no" not in low.split("no")[0].replace("permitrootlogin", ""):
                if "permitrootloginno" not in low:
                    findings.append(_mk("host/sshd-root", "medium", "sshd 允许 root 登录", p, i, s,
                                        "PermitRootLogin 非 no；应禁用 root 直登。", scope="host"))
            if low.startswith("passwordauthenticationyes"):
                findings.append(_mk("host/sshd-password", "medium", "sshd 允许口令登录", p, i, s,
                                    "PasswordAuthentication yes 易被爆破；建议仅密钥。", scope="host"))
    sud = "/etc/sudoers.d"
    if os.path.isdir(sud):
        for f in sorted(os.listdir(sud)):
            p = os.path.join(sud, f)
            for i, line in enumerate(_read_lines(p), 1):
                if "NOPASSWD" in line and not line.strip().startswith("#"):
                    findings.append(_mk("host/sudoers-nopasswd", "medium", "sudoers NOPASSWD",
                                        p, i, line.strip()[:120], "免密 sudo 放大提权影响。", scope="host"))
    return findings


SCANS = {"code": scan_code, "files": scan_files, "k8s": scan_k8s, "host": scan_host}


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
        cols = {r["name"] for r in db.execute("PRAGMA table_info(scan_finding)")}
        for col, ddl in (("scope", "TEXT"), ("category", "TEXT"),
                         ("confidence", "TEXT"), ("source", "TEXT DEFAULT 'static'")):
            if col not in cols:
                db.execute(f"ALTER TABLE scan_finding ADD COLUMN {col} {ddl}")
        db.execute("CREATE INDEX IF NOT EXISTS ix_scan_scope ON scan_finding(scope)")
        db.execute("CREATE INDEX IF NOT EXISTS ix_scan_cat ON scan_finding(category)")
    return


_SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _persist(all_f, now):
    """写入/更新 findings，返回 (n_new, new_high_critical)。按 fingerprint 去重。"""
    n_new = 0
    new_hi = []
    seen = set()
    with _db() as db:
        for f in all_f:
            fp = f["fingerprint"]
            if fp in seen:
                continue
            seen.add(fp)
            row = db.execute("SELECT status FROM scan_finding WHERE fingerprint=?", (fp,)).fetchone()
            if row is None:
                n_new += 1
                if f["severity"] in ("critical", "high"):
                    new_hi.append(f)
                db.execute(
                    "INSERT INTO scan_finding(fingerprint,check_id,severity,title,file,line,"
                    "snippet,detail,first_seen,last_seen,status,scope,category,confidence,source) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?, 'open',?,?,?,?)",
                    (fp, f["check"], f["severity"], f["title"], f["file"], f["line"],
                     f["snippet"], f["detail"], now, now, f.get("scope"), f.get("category"),
                     f.get("confidence", "rule"), f.get("source", "static")))
            elif row["status"] != "ignored":
                db.execute("UPDATE scan_finding SET last_seen=?, severity=?, snippet=?, detail=?, "
                           "scope=?, category=?, confidence=?, source=? WHERE fingerprint=?",
                           (now, f["severity"], f["snippet"], f["detail"], f.get("scope"),
                            f.get("category"), f.get("confidence", "rule"),
                            f.get("source", "static"), fp))
            else:
                db.execute("UPDATE scan_finding SET last_seen=? WHERE fingerprint=?", (now, fp))
    return n_new, new_hi


def run_scan(kinds=None, trigger="manual"):
    """跑一遍 L1 静态巡检：写 run + 新增 finding，返回摘要。"""
    init_db()
    kinds = [k for k in (kinds or list(SCANS.keys())) if SCANS.get(k)]
    t0 = time.time()
    all_f, err = [], None
    # 四层相互独立，并行跑：code 是 CPU 密集（正则/GIL），files 以 stat I/O 为主，
    # k8s 走子进程（释放 GIL）——线程并行能把总耗时压到 ≈ 最慢一层的耗时。
    results = {}
    if len(kinds) > 1:
        from concurrent.futures import ThreadPoolExecutor
        try:
            with ThreadPoolExecutor(max_workers=len(kinds)) as ex:
                futs = {ex.submit(SCANS[k]): k for k in kinds}
                for fut in futs:
                    k = futs[fut]
                    try:
                        results[k] = fut.result()
                    except Exception as e:
                        err = f"{k}: {e}"
                        log.exception("scan %s failed", k)
        except Exception as e:  # 兜底：线程池不可用则退回串行
            log.exception("parallel scan failed, fallback serial")
            results = {}
    if not results:
        for k in kinds:
            try:
                results[k] = SCANS[k]()
            except Exception as e:
                err = f"{k}: {e}"
                log.exception("scan %s failed", k)
    for k in kinds:
        all_f += results.get(k, [])
    now = time.time()
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for f in all_f:
        counts[f["severity"]] = counts.get(f["severity"], 0) + 1
    try:
        n_new, new_hi = _persist(all_f, now)
        with _db() as db:
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
                f"[{f.get('scope', '?')}] {f['file']}:{f['line']} — {f['snippet'][:120]}",
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


# ── L2/L3 写回接口（供 podwatch 的每-Pod LLM 审查调用）─────────────────────
def candidates_for_scope(scope, limit=30):
    """取某 Pod 的 L1 候选（未忽略、非 llm 来源），供 LLM 复核。"""
    limit = max(1, min(100, int(limit)))
    init_db()
    with _db() as db:
        rows = db.execute(
            "SELECT fingerprint,check_id,severity,title,file,line,snippet,detail "
            "FROM scan_finding WHERE scope=? AND status='open' AND "
            "COALESCE(source,'static')!='llm' "
            "ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
            "WHEN 'medium' THEN 2 ELSE 3 END, last_seen DESC LIMIT ?",
            (scope, limit)).fetchall()
    return [dict(r) for r in rows]


def apply_llm_verdict(fingerprint, verdict, severity=None, reason=None, model=""):
    """把 LLM 对某条 L1 候选的判定写回。

    verdict: true_positive | false_positive | uncertain
      false_positive → 直接置 ignored（并记原因）
      severity 覆盖 → 校准等级
    所有被 LLM 处理过的行标记 confidence='llm'。
    """
    v = str(verdict or "").lower()
    if v not in ("true_positive", "false_positive", "uncertain"):
        return False
    init_db()
    note = (f"[LLM复核:{model or '?'}] {v}"
            + (f" 等级→{severity}" if severity else "")
            + (f" {reason}" if reason else ""))[:300]
    with _db() as db:
        row = db.execute("SELECT detail FROM scan_finding WHERE fingerprint=?", (fingerprint,)).fetchone()
        if row is None:
            return False
        detail = (str(row["detail"] or "") + " | " + note)[:600]
        if v == "false_positive":
            db.execute("UPDATE scan_finding SET status='ignored', confidence='llm', "
                       "source='static+llm', detail=?, last_seen=? WHERE fingerprint=?",
                       (detail, time.time(), fingerprint))
        else:
            sets, args = ["confidence='llm'", "source='static+llm'", "detail=?", "last_seen=?"], [detail, time.time()]
            if severity in ("critical", "high", "medium", "low"):
                sets.append("severity=?"); args.append(severity)
            args.append(fingerprint)
            db.execute(f"UPDATE scan_finding SET {', '.join(sets)} WHERE fingerprint=?", args)
    return True


def ingest_llm_findings(scope, items, model=""):
    """写入 L3 LLM 语义发现（category=llm）。items: [{severity,title,file,line,reason,fix}]。"""
    if not items:
        return 0
    now = time.time()
    findings = []
    for it in items:
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        sev = str(it.get("severity") or "medium").lower()
        if sev not in ("critical", "high", "medium", "low"):
            sev = "medium"
        fpath = str(it.get("file") or f"pod/{scope}")
        try:
            line = int(it.get("line") or 0)
        except (ValueError, TypeError):
            line = 0
        reason = str(it.get("reason") or "").strip()
        fix = str(it.get("fix") or "").strip()
        cwe = str(it.get("cwe") or "").strip()
        slug = re.sub(r"[^a-z0-9]+", "-", (cwe or title).lower())[:24].strip("-") or "issue"
        check = f"llm/{slug}"
        detail = (f"{reason}" + (f" 修复：{fix}" if fix else "")
                  + (f" ({cwe})" if cwe else ""))[:400]
        findings.append({
            "check": check, "severity": sev, "title": title, "file": fpath, "line": line,
            "snippet": str(it.get("snippet") or reason)[:300], "detail": detail,
            "scope": scope, "category": "llm", "confidence": "llm", "source": "llm",
            "fingerprint": _fingerprint(check, fpath, line, title + "|" + reason),
        })
    if not findings:
        return 0
    init_db()
    n_new, _ = _persist(findings, now)
    # LLM 新发现里若含高危，顺带提醒
    _alert_new([f for f in findings if f["severity"] in ("critical", "high")])
    return len(findings)


# ── 查询 ────────────────────────────────────────────────────────────────────
def latest_run():
    init_db()
    with _db() as db:
        r = db.execute("SELECT * FROM scan_run ORDER BY ts DESC LIMIT 1").fetchone()
    return dict(r) if r else None


def history(limit=30):
    init_db()
    with _db() as db:
        rows = db.execute("SELECT * FROM scan_run ORDER BY ts DESC LIMIT ?", (int(limit),)).fetchall()
    return [dict(r) for r in rows]


def list_findings(severity=None, check=None, q=None, status=None, scope=None,
                  category=None, source=None, limit=200, offset=0):
    init_db()
    where, args = [], []
    if severity:
        where.append("severity=?"); args.append(severity)
    if check:
        where.append("check_id LIKE ?"); args.append(check + "%")
    if status:
        where.append("status=?"); args.append(status)
    if scope:
        where.append("scope=?"); args.append(scope)
    if category:
        where.append("category=?"); args.append(category)
    if source:
        where.append("COALESCE(source,'static')=?"); args.append(source)
    if q:
        where.append("(title LIKE ? OR file LIKE ? OR snippet LIKE ? OR scope LIKE ?)")
        args += [f"%{q}%"] * 4
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _db() as db:
        total = db.execute(f"SELECT COUNT(*) c FROM scan_finding {clause}", args).fetchone()["c"]
        rows = db.execute(
            f"SELECT * FROM scan_finding {clause} "
            f"ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
            f"WHEN 'medium' THEN 2 ELSE 3 END, last_seen DESC LIMIT ? OFFSET ?",
            args + [int(limit), int(offset)]).fetchall()
    return {"items": [dict(r) for r in rows], "total": total}


def scope_summary():
    """按 scope（Pod / platform / host）聚合，供前端"按 Pod 筛选"下拉。"""
    init_db()
    with _db() as db:
        rows = db.execute(
            "SELECT COALESCE(scope,'platform') scope, severity, COUNT(*) c "
            "FROM scan_finding WHERE status!='ignored' GROUP BY scope, severity").fetchall()
        llm = db.execute(
            "SELECT COALESCE(scope,'platform') scope, COUNT(*) c FROM scan_finding "
            "WHERE status!='ignored' AND COALESCE(source,'static')='llm' GROUP BY scope").fetchall()
    llm_map = {r["scope"]: r["c"] for r in llm}
    agg = {}
    for r in rows:
        sc = r["scope"]
        d = agg.setdefault(sc, {"scope": sc, "total": 0, "critical": 0, "high": 0,
                                "medium": 0, "low": 0, "llm": llm_map.get(sc, 0)})
        d["total"] += r["c"]
        d[r["severity"]] = d.get(r["severity"], 0) + r["c"]
    return sorted(agg.values(), key=lambda x: (-(x["critical"] + x["high"]), -x["total"]))


def category_summary():
    init_db()
    with _db() as db:
        rows = db.execute(
            "SELECT COALESCE(category, substr(check_id,1,instr(check_id||'/', '/')-1)) category, "
            "COUNT(*) c FROM scan_finding WHERE status!='ignored' GROUP BY category "
            "ORDER BY c DESC").fetchall()
    # 库里 category 可能有 NULL（老行）与别名（k8s/perm）；这里按「归一化后的类目」
    # 在 Python 侧再合并一次，避免出现两行同名类目。
    agg = {}
    for r in rows:
        cat = _CAT_ALIAS.get(r["category"], r["category"])
        agg[cat] = agg.get(cat, 0) + r["c"]
    return [{"category": c, "label": CATEGORIES.get(c, c), "n": n}
            for c, n in sorted(agg.items(), key=lambda kv: -kv[1])]


def summary():
    init_db()
    with _db() as db:
        rows = db.execute(
            "SELECT severity, COUNT(*) c FROM scan_finding WHERE status!='ignored' "
            "GROUP BY severity").fetchall()
        per_check = db.execute(
            "SELECT check_id, severity, COUNT(*) c FROM scan_finding WHERE status!='ignored' "
            "GROUP BY check_id, severity ORDER BY c DESC LIMIT 40").fetchall()
        files = db.execute(
            "SELECT COUNT(DISTINCT file) c FROM scan_finding WHERE status!='ignored'").fetchone()["c"]
    by_sev = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for r in rows:
        by_sev[r["severity"]] = r["c"]
    return {"by_severity": by_sev, "total": sum(by_sev.values()),
            "files": files, "by_check": [dict(r) for r in per_check],
            "by_category": category_summary(), "by_scope": scope_summary(),
            "last_run": latest_run()}


def set_status(fingerprint, status):
    if status not in ("open", "ignored", "resolved"):
        raise ValueError("bad status")
    init_db()
    with _db() as db:
        db.execute("UPDATE scan_finding SET status=? WHERE fingerprint=?", (status, fingerprint))
    return True


# ── 后台守护线程（只跑便宜的 L1；LLM 由 podwatch 负责）────────────────────
_started = False
_lock = threading.Lock()


def _loop():
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
