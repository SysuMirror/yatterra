#!/usr/bin/env python3
"""Per-pod code index (structure + symbols + code map) for the AI assistant.

Why: on a Pod detail page the assistant has only the `pod_file` tool (directory
listings capped at 200 entries, file reads capped at the first 8000 bytes) and
no grep/symbol/vector search, so answering "这个 pod 在干嘛 / login 在哪 /
授权逻辑怎么实现的" means several blind directory walks — each a full LLM round
-trip — and the 6-iteration tool loop usually runs out before it finds anything.

This module maintains, per pod, a cheap on-disk index of the *code* files in the
pod's hostPath home:

  index/<pod>.json   {rel: {size, sha, lang, lines, symbols:[{name,kind,line}],
                            head}}  +  {"tree":…, "code_map":…, "built":…}
  state/<pod>.json   {rel: sha}   (what we have indexed — for increments)

The `code_map` is a compact (≤_MAP_CHARS) human/LLM-readable summary that gets
injected into the pod-page system prompt, so most questions need **zero** tool
calls; `pod_code_outline` / `pod_code_grep` cover the rest. File *contents* are
never stored here — grep reads the hostPath on demand (same realpath jail the
`pod_file` tool uses), so nothing goes stale a second time.

Freshness comes from podwatch: podwatch already walks every pod home every
INTERVAL seconds and diffs a {rel: [size, mtime, sha1]} manifest. We piggyback
on that diff via `on_scan()` — no second walk, only the changed files are
re-indexed. `rebuild()` / `rebuild_all()` do a one-off own walk for the initial
build.

Filtering is *stricter* than podwatch: podwatch's manifest is a superset
(it counts toolchain/IDE-cache noise such as .rustup, .cargo, .codebuddy,
.trae-cn, .zcode — enough to hit its 8000-file cap on a few pods), so the
changed set is filtered again here.

Architecture mirrors podwatch.py / insight.py: no thread of its own (podwatch
drives it), never raises, atomic JSON writes, per-pod locks, platform root.
"""
import json
import logging
import os
import re
import threading
import time

import siteconf

log = logging.getLogger(__name__)

# ── tunables ───────────────────────────────────────────────────
_MAX_FILE = 128 * 1024        # skip files bigger than this for indexing
_MAX_FILES = 4000             # per-pod cap on indexed files
_MAX_HEAD_LINES = 40          # lines of file head kept in the index (for the map)
_MAX_SYMBOLS = 80             # symbols kept per file
_MAP_CHARS = 2500             # hard cap on the rendered code map
_MAP_FILES = 40               # files listed in the code map
_BUDGET_PER_POD = 300         # files (re)indexed per pod per sweep
_DOC_PER_POD = 40             # cap for .md/.txt/.html/.json files (noise-prone)

# ── vector (semantic) index tunables ───────────────────────────
_VEC_MAX_FILE = 32 * 1024     # don't embed files bigger than this
_VEC_MAX_CHUNKS_PER_FILE = 20
_VEC_MAX_FILES_PER_POD = 400  # cap on embedded files per pod
_VEC_BUDGET_FILES = 60        # files embedded per pod per worker tick
_VEC_TICK_FILES = 120         # total files embedded per worker tick (all pods)
_VEC_INTERVAL = 20            # seconds between worker ticks
_VEC_SUFFIX = "podcode"       # collection name: <COLL_PREFIX>podcode

_ENABLED = os.environ.get("PODCODE_ENABLED", "1") not in ("0", "false", "no")

_ROOT = siteconf.path("podcode")
_INDEX_DIR = os.path.join(_ROOT, "index")
_STATE_DIR = os.path.join(_ROOT, "state")

_LOCKS = {}
_LOCKS_GUARD = threading.Lock()

# Directories that are never project code. Superset of podwatch._SKIP_DIRS:
# the extra entries are toolchain / IDE-agent caches measured to dominate a few
# pod homes (e.g. `test` = 65k files under .rustup, `ocr` = 9k under .codebuddy)
# and to consume podwatch's whole 8000-file budget.
# NOTE: do NOT blanket-skip dot-dirs — .octop/plugins/*/main.py is real code.
_NOISE_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "site-packages",
    ".cache", ".npm", ".nvm", ".local", ".ssh", ".vscode-server", ".codex",
    ".copilot", ".harness-browser", ".mypy_cache", ".pytest_cache",
    ".ipynb_checkpoints", "dist", "build", ".next", ".turbo",
    # extra vs podwatch:
    ".rustup", ".cargo", ".trae", ".trae-cn", ".trae-cn-server",
    ".trae-aicc", ".codebuddy", ".codebuddy-server-cn", ".zcode", ".triton",
    ".nv", ".cursor-server", ".cursor", ".kaggle", ".modelscope", ".hf_cache",
    ".anaconda", ".conda", "miniconda3", "node_modules",
}

# Source-code extensions: always indexed.
_SRC_EXT = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift", ".scala",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm", ".lua", ".sh", ".bash",
    ".zsh", ".fish", ".ps1", ".sql", ".proto", ".graphql", ".pl", ".r",
}
# Config / manifest files: indexed, but they carry few useful symbols.
_CFG_EXT = {".toml", ".ini", ".conf", ".cfg", ".yaml", ".yml", ".env"}
# Documentation-ish: noisy (bulk dumps); capped per pod.
_DOC_EXT = {".md", ".rst", ".txt", ".html", ".htm", ".json"}
_SRC_NAMES = {
    "Dockerfile", "Makefile", "CMakeLists.txt", "requirements.txt",
    "pyproject.toml", "package.json", "go.mod", "Cargo.toml", "Procfile",
    "supervisord.conf", ".env",
}

_LANG_EXT = {
    ".py": "python", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
    ".ts": "ts", ".tsx": "tsx", ".vue": "vue", ".svelte": "svelte",
    ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
    ".rb": "ruby", ".php": "php", ".cs": "csharp", ".swift": "swift",
    ".scala": "scala", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp",
    ".hpp": "cpp", ".m": "objc", ".mm": "objc", ".lua": "lua",
    ".sh": "sh", ".bash": "sh", ".zsh": "sh", ".fish": "sh", ".ps1": "ps1",
    ".sql": "sql", ".proto": "proto", ".graphql": "graphql", ".r": "r",
    ".pl": "perl", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".ini": "ini", ".conf": "conf", ".cfg": "conf", ".json": "json",
    ".md": "markdown", ".rst": "rst", ".txt": "text", ".html": "html",
    ".htm": "html", ".css": "css", ".scss": "css", ".less": "css",
}

# Files that are certainly not the project's own code even if the extension
# matches (vendored/generated blobs that live outside the noise dirs).
_NOISE_NAME_RE = re.compile(
    r"(\.min\.(js|css)$|\.bundle\.js$|-lock\.json$|package-lock\.json$)", re.I)


# ── paths / io ─────────────────────────────────────────────────
def _home(pod):
    """Host path of a pod's persistent home (== /home/cloud in-container)."""
    import groups
    return os.path.join(groups.GROUP_DATA_ROOT, pod, "home")


def _ensure_dirs():
    for d in (_INDEX_DIR, _STATE_DIR):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass


def _index_file(pod):
    return os.path.join(_INDEX_DIR, f"{pod}.json")


def _state_file(pod):
    return os.path.join(_STATE_DIR, f"{pod}.json")


def _pod_lock(pod):
    with _LOCKS_GUARD:
        lk = _LOCKS.get(pod)
        if lk is None:
            lk = _LOCKS[pod] = threading.Lock()
        return lk


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
        log.warning("podcode: write %s failed: %s", path, e)
        return False


def _read_text(path, max_bytes=_MAX_FILE):
    try:
        if os.path.getsize(path) > max_bytes:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def _sha1(path):
    import hashlib
    try:
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()[:16]
    except Exception:
        return ""


# ── file classification ────────────────────────────────────────
def _lang_of(fname):
    if fname in _SRC_NAMES:
        return "dockerfile" if fname == "Dockerfile" else (
            "make" if fname == "Makefile" else "conf")
    ext = os.path.splitext(fname)[1].lower()
    return _LANG_EXT.get(ext, ext.lstrip(".") or "text")


def _kind_of(fname):
    """'src' | 'cfg' | 'doc' | None (not indexed)."""
    if _NOISE_NAME_RE.search(fname):
        return None
    if fname in _SRC_NAMES:
        return "cfg"
    ext = os.path.splitext(fname)[1].lower()
    if ext in _SRC_EXT:
        return "src"
    if ext in _CFG_EXT:
        return "cfg"
    if ext in _DOC_EXT:
        return "doc"
    return None


def _accept(rel, fname):
    return _kind_of(fname) is not None


# ── symbol extraction ──────────────────────────────────────────
_RE_JS = (
    ("class", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)")),
    ("def", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")),
    ("def", re.compile(r"^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)")),
    ("var", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=")),
    ("def", re.compile(r"^\s*(?:public\s+|private\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{")),
)
_RE_GO = (
    ("def", re.compile(r"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)")),
    ("class", re.compile(r"^type\s+([A-Za-z_]\w*)")),
    ("var", re.compile(r"^(?:var|const)\s+([A-Za-z_]\w*)")),
)
_RE_RS = (
    ("def", re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)")),
    ("class", re.compile(r"^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)")),
    ("var", re.compile(r"^\s*(?:pub\s+)?(?:static|const)\s+([A-Za-z_]\w*)")),
)
_RE_SH = (
    ("def", re.compile(r"^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{")),
    ("var", re.compile(r"^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=")),
)
_RE_GENERIC = (
    ("class", re.compile(r"^\s*(?:public\s+|private\s+|final\s+|abstract\s+)*class\s+(\w+)")),
    ("def", re.compile(r"^\s*#\s*define\s+(\w+)")),
)
# Control-flow keywords the loose `name(...) {` heuristics would otherwise
# mistake for definitions (JS/C/Java all match `if (x) {`, `for (…) {` …).
_KEYWORDS = {
    "if", "else", "for", "while", "switch", "case", "catch", "try", "do",
    "return", "function", "class", "new", "typeof", "delete", "throw", "await",
    "async", "with", "match", "loop", "fn", "let", "const", "var", "def",
    "print", "super", "this", "and", "or", "not", "in", "is", "as",
}

_RE_YAML_KEY = re.compile(r"^([A-Za-z_][\w.-]*)\s*:")
_RE_CSS = re.compile(r"^([.#]?[A-Za-z][\w-]*)\s*[,{]")


def _symbols_py(text):
    import ast
    import warnings
    out = []
    try:
        # Indexed files are other people's code; their bad escape sequences
        # and syntax nits must not spam podwatch's log.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(text)
    except Exception:
        return _symbols_regex(text, ("def", re.compile(r"^\s*(?:async\s+)?def\s+(\w+)")),
                              ("class", re.compile(r"^\s*class\s+(\w+)")))
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append({"name": node.name, "kind": "def", "line": node.lineno})
        elif isinstance(node, ast.ClassDef):
            out.append({"name": node.name, "kind": "class", "line": node.lineno})
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out.append({"name": f"{node.name}.{sub.name}",
                                "kind": "method", "line": sub.lineno})
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            tgts = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in tgts[:3]:
                if isinstance(t, ast.Name):
                    out.append({"name": t.id, "kind": "var", "line": node.lineno})
        if len(out) >= _MAX_SYMBOLS:
            break
    return out[:_MAX_SYMBOLS]


def _symbols_regex(text, *patterns):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if len(line) > 200:
            continue
        for kind, rx in patterns:
            m = rx.match(line)
            if m:
                name = m.group(1)
                if name and len(name) >= 2 and name not in _KEYWORDS:
                    out.append({"name": name, "kind": kind, "line": i})
                break
        if len(out) >= _MAX_SYMBOLS:
            break
    return out


def _symbols(text, lang):
    if lang == "python":
        return _symbols_py(text)
    if lang in ("js", "jsx", "ts", "tsx", "vue", "svelte", "mjs", "cjs"):
        return _symbols_regex(text, *_RE_JS)
    if lang == "go":
        return _symbols_regex(text, *_RE_GO)
    if lang == "rust":
        return _symbols_regex(text, *_RE_RS)
    if lang == "sh":
        return _symbols_regex(text, *_RE_SH)
    if lang in ("yaml", "toml", "ini", "conf"):
        out = []
        for i, line in enumerate(text.splitlines(), 1):
            if line[:1].strip() and not line.startswith(("#", " ", "\t")):
                m = _RE_YAML_KEY.match(line)
                if m:
                    out.append({"name": m.group(1), "kind": "key", "line": i})
            if len(out) >= 40:
                break
        return out
    if lang == "css":
        return _symbols_regex(text, ("sel", _RE_CSS))
    if lang in ("c", "cpp", "java", "kotlin", "csharp", "swift", "scala",
                "objc", "php", "proto"):
        return _symbols_regex(text, *_RE_GENERIC,
                              ("def", re.compile(r"^\s*[\w:<>,\*&\s]+\s+(\w+)\s*\([^;]*\)\s*[{;]")))
    return []


# ── per-file indexing ──────────────────────────────────────────
def _index_entry(root, rel):
    """Build the index entry for one file, or None if unreadable/oversized."""
    path = os.path.join(root, rel)
    try:
        st = os.stat(path)
    except OSError:
        return None
    if st.st_size > _MAX_FILE:
        return None
    fname = os.path.basename(rel)
    lang = _lang_of(fname)
    text = _read_text(path)
    if text is None:
        return None
    if "\x00" in text[:4000]:
        return None
    lines = text.count("\n") + 1
    head = "\n".join(text.splitlines()[:_MAX_HEAD_LINES])
    return {
        "size": st.st_size,
        "sha": _sha1(path),
        "lang": lang,
        "kind": _kind_of(fname),
        "lines": lines,
        "symbols": _symbols(text, lang),
        "head": head,
    }


# ── code map rendering ─────────────────────────────────────────
def _render_map(pod, entries):
    """Compact (≤_MAP_CHARS) overview: dir tree + the most informative files."""
    if not entries:
        return ""
    out = [f"# 代码地图 {pod}（索引 {len(entries)} 个文件）"]
    # directory tree with per-dir file counts (depth ≤ 3)
    dirs = {}
    for rel in entries:
        parts = rel.split("/")[:-1]              # ancestor dirs only
        for d in range(1, len(parts) + 1):
            key = "/".join(parts[:d])
            dirs[key] = dirs.get(key, 0) + 1
    shown = 0
    for d in sorted(dirs):
        if d == "" or d.count("/") > 2:
            continue
        out.append(f"  {d}/ ({dirs[d]})")
        shown += 1
        if shown >= 30 or sum(len(x) + 1 for x in out) > _MAP_CHARS // 2:
            break
    # most informative files: source files ranked by #symbols then size
    cand = []
    for rel, e in entries.items():
        if e.get("kind") != "src":
            continue
        score = len(e.get("symbols") or []) * 10 + min(e.get("lines", 0), 400)
        cand.append((score, rel, e))
    cand.sort(key=lambda t: -t[0])
    out.append("核心文件:")
    used = sum(len(x) + 1 for x in out)
    for _score, rel, e in cand[:_MAP_FILES]:
        syms, seen = [], set()
        for s in (e.get("symbols") or []):
            if s.get("kind") in ("def", "class", "method") and s["name"] not in seen:
                seen.add(s["name"])
                syms.append(s["name"])
            if len(syms) >= 8:
                break
        line = f"  {rel} [{e.get('lang','')} {e.get('lines',0)}行]"
        if syms:
            line += " :: " + ", ".join(syms)
        if used + len(line) > _MAP_CHARS:
            break
        out.append(line)
        used += len(line) + 1
    if len(cand) > _MAP_FILES:
        out.append(f"  …（其余 {len(cand) - _MAP_FILES} 个源文件见 pod_code_outline）")
    return "\n".join(out)[:_MAP_CHARS]


# ── build / incremental ────────────────────────────────────────
def _walk(pod):
    """Own walk (only for the initial build / rebuild). Applies our filter."""
    root = _home(pod)
    found = []
    if not os.path.isdir(root):
        return root, found
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _NOISE_DIRS]
        for fn in filenames:
            if n >= _MAX_FILES:
                break
            if not _accept(dirpath, fn):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            found.append(rel)
            n += 1
        if n >= _MAX_FILES:
            break
    return root, found


def rebuild(pod):
    """Full (re)build of one pod's index by walking its home. Never raises."""
    with _pod_lock(pod):
        try:
            r = _rebuild_locked(pod)
            _ensure_worker()
            return r
        except Exception as e:
            log.warning("podcode: rebuild(%s) failed: %s", pod, e)
            return None


def _rebuild_locked(pod):
    root, rels = _walk(pod)
    if not os.path.isdir(root):
        return None
    _ensure_dirs()
    entries = {}
    for rel in rels[:_MAX_FILES]:
        if _kind_of(os.path.basename(rel)) == "doc" and \
                sum(1 for r in entries if entries[r].get("kind") == "doc") >= _DOC_PER_POD:
            continue
        e = _index_entry(root, rel)
        if e:
            entries[rel] = e
    data = {"pod": pod, "built": time.strftime("%Y-%m-%d %H:%M:%S"),
            "files": entries, "code_map": _render_map(pod, entries)}
    _write_json(_index_file(pod), data)
    _write_json(_state_file(pod), {r: e["sha"] for r, e in entries.items()})
    return {"pod": pod, "files": len(entries), "map_chars": len(data["code_map"])}


def rebuild_all(pods=None):
    """Rebuild every pod (or the given list). Returns per-pod result dicts."""
    import groups
    if pods is None:
        statuses = groups.all_pod_statuses()
        pods = sorted(n for n, s in statuses.items() if s == "Running")
    out = []
    for pod in pods:
        out.append(rebuild(pod))
        time.sleep(0.2)
    return out


def on_scan(pod, manifest, added, modified, removed):
    """podwatch hook: re-index only what changed in its 600s diff.

    Called on *every* podwatch scan (also the no-change fast path), so a pod
    that predates this module still gets its first index built here.
    """
    if not _ENABLED:
        return None
    _ensure_worker()
    try:
        with _pod_lock(pod):
            return _on_scan_locked(pod, manifest, added, modified, removed)
    except Exception as e:
        log.warning("podcode: on_scan(%s) failed: %s", pod, e)
        return None


def _on_scan_locked(pod, manifest, added, modified, removed):
    root = _home(pod)
    if not os.path.isdir(root):
        return None
    data = _read_json(_index_file(pod), None)
    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        return _rebuild_locked(pod)

    entries = data["files"]
    todo = [r for r in (list(added) + list(modified))
            if _accept(r, os.path.basename(r))][:_BUDGET_PER_POD]
    docs = sum(1 for e in entries.values() if e.get("kind") == "doc")
    changed = 0
    for rel in todo:
        if _kind_of(os.path.basename(rel)) == "doc" and docs >= _DOC_PER_POD:
            continue
        e = _index_entry(root, rel)
        if e:
            if entries.get(rel, {}).get("kind") == "doc":
                docs += 1
            entries[rel] = e
            changed += 1
    for rel in removed:
        if rel in entries:
            entries.pop(rel, None)
            changed += 1
    if not changed:
        return {"pod": pod, "changed": 0}

    data["files"] = entries
    data["built"] = time.strftime("%Y-%m-%d %H:%M:%S")
    data["code_map"] = _render_map(pod, entries)
    _write_json(_index_file(pod), data)
    _write_json(_state_file(pod), {r: e["sha"] for r, e in entries.items()})
    return {"pod": pod, "changed": changed, "files": len(entries)}


# ── vector (semantic) index ────────────────────────────────────
# Single Qdrant collection for every pod; isolation is a payload filter on
# `pod` (the tool layer already enforces the member check, exactly like
# pod_file). Point IDs are deterministic (uuid5 of pod#rel#chunk) so a
# re-embed is an idempotent upsert.
#
# This half runs on its *own* daemon thread rather than inline in the podwatch
# sweep: embedding hits a shared gateway (batches of 16, ~1s each), and we must
# not stall podwatch's 600s loop. The thread drains a self-healing worklist —
# "indexed src files whose sha differs from what we've already vectorized" —
# so nothing needs to be queued explicitly and a restart resumes automatically.
def _coll():
    import kb_service
    return kb_service.COLL_PREFIX + _VEC_SUFFIX


def _vec_state_file(pod):
    return os.path.join(_STATE_DIR, f"{pod}.vec.json")


_COLL_READY = {"ok": False}


def _ensure_collection():
    """Create the podcode collection + a `pod` payload index once. Returns name."""
    import kb_service
    coll = _coll()
    if _COLL_READY["ok"]:
        return coll
    try:
        kb_service._qdrant("GET", f"/collections/{coll}")
        _COLL_READY["ok"] = True
        return coll
    except Exception:
        pass
    kb_service._qdrant("PUT", f"/collections/{coll}",
                       {"vectors": {"size": 1024, "distance": "Cosine"}})
    try:
        kb_service._qdrant("PUT", f"/collections/{coll}/index?wait=true",
                           {"field_name": "pod", "field_schema": "keyword"})
    except Exception:
        pass                      # index is an optimisation, not required
    _COLL_READY["ok"] = True
    return coll


def _embed_file(pod, rel, e, root):
    """Text chunks for one file (or None if unembeddable). Never raises."""
    import kb_service
    text = _read_text(os.path.join(root, rel), _VEC_MAX_FILE)
    if not text or "\x00" in text[:4000]:
        return None
    chunks = kb_service.chunk_text(text)[:_VEC_MAX_CHUNKS_PER_FILE]
    if not chunks:
        return None
    # Prefix every chunk with the file path so the embedder (and the model
    # reading a hit) keeps the provenance in-band.
    return [f"{rel}\n{c}" for c in chunks]


def _upsert_vecs(pod, rel, e, chunks):
    """Embed + upsert one file's chunks. Raises on gateway errors."""
    import kb_service
    import uuid
    coll = _ensure_collection()
    vecs = kb_service.embed(chunks)
    pts = []
    for i, (chunk, vec) in enumerate(zip(chunks, vecs)):
        pid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"podcode:{pod}#{rel}#{i}"))
        pts.append({"id": pid, "vector": vec,
                    "payload": {"pod": pod, "rel": rel, "lang": e.get("lang", ""),
                                "text": chunk[:2000],
                                "ingested_at": int(time.time())}})
    for i in range(0, len(pts), 64):
        kb_service._qdrant("PUT", f"/collections/{coll}/points?wait=true",
                           {"points": pts[i:i + 64]})
    return len(pts)


def _delete_vecs(pod, rels):
    """Drop the vectors of removed files (filter: pod == pod AND rel in rels)."""
    if not rels:
        return
    import kb_service
    try:
        kb_service._qdrant("POST", f"/collections/{_coll()}/points/delete?wait=true",
                           {"filter": {"must": [
                               {"key": "pod", "match": {"value": pod}},
                               {"key": "rel", "match": {"any": list(rels)}}]}})
    except Exception as e:
        log.warning("podcode: delete vectors for %s failed: %s", pod, e)


def _drain_pod(pod, budget):
    """Embed up to `budget` pending files of one pod. Returns files done.

    Raises on embedding-gateway failure (caller aborts the tick to back off).
    """
    root = _home(pod)
    if not os.path.isdir(root):
        return 0
    data = _read_json(_index_file(pod), None)
    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        return 0
    entries = data["files"]
    vs = _read_json(_vec_state_file(pod), {})
    if not isinstance(vs, dict):
        vs = {}

    # 1) deletions: vectorized but no longer in the index
    gone = [r for r in vs if r not in entries]
    if gone:
        _delete_vecs(pod, gone)
        for r in gone:
            vs.pop(r, None)

    # 2) pending: src files whose sha differs from what we vectorized
    pend = []
    for rel, e in entries.items():
        if e.get("kind") != "src" or e.get("size", 0) > _VEC_MAX_FILE:
            continue
        if vs.get(rel) == e.get("sha"):
            continue
        score = len(e.get("symbols") or []) * 10 + min(e.get("lines", 0), 400)
        pend.append((-score, rel, e))
    pend.sort(key=lambda t: t[0])

    done = 0
    for _s, rel, e in pend:
        if done >= budget or len(vs) >= _VEC_MAX_FILES_PER_POD:
            break
        try:
            chunks = _embed_file(pod, rel, e, root)
        except Exception:
            chunks = None
        if chunks is None:
            vs[rel] = e.get("sha")      # unembeddable → don't retry forever
            done += 1
        else:
            _upsert_vecs(pod, rel, e, chunks)   # raises → abort tick
            vs[rel] = e.get("sha")
            done += 1
    if gone or done:
        _ensure_dirs()
        _write_json(_vec_state_file(pod), vs)
    return done


def _worker_tick():
    """One pass: drain a bounded number of files across all Running pods."""
    try:
        import groups
        statuses = groups.all_pod_statuses()
        pods = sorted(n for n, s in statuses.items() if s == "Running")
    except Exception:
        pods = sorted(os.path.splitext(f)[0]
                      for f in os.listdir(_INDEX_DIR)
                      if f.endswith(".json")) if os.path.isdir(_INDEX_DIR) else []
    left = _VEC_TICK_FILES
    for pod in pods:
        if left <= 0:
            break
        try:
            left -= _drain_pod(pod, min(_VEC_BUDGET_FILES, left))
        except Exception as e:
            # gateway likely down / rate-limited — stop this tick, retry later
            log.warning("podcode: embed backoff for %s: %s", pod, e)
            break


_WORKER = {"thread": None}
_WORKER_GUARD = threading.Lock()


def _ensure_worker():
    if not _ENABLED:
        return
    with _WORKER_GUARD:
        t = _WORKER.get("thread")
        if t and t.is_alive():
            return
        t = threading.Thread(target=_worker_loop, name="podcode-vec", daemon=True)
        _WORKER["thread"] = t
        t.start()


def _worker_loop():
    while True:
        try:
            _worker_tick()
        except Exception as e:
            log.warning("podcode: worker tick failed: %s", e)
        time.sleep(_VEC_INTERVAL)


def semantic(pod, query, k=6):
    """Vector search over one pod's indexed code. Returns [{rel,text,score}]."""
    try:
        import kb_service
        coll = _coll()
        vec = kb_service.embed([query])[0]
        out = kb_service._qdrant("POST", f"/collections/{coll}/points/query",
                                 {"query": vec, "limit": k, "with_payload": True,
                                  "filter": {"must": [{"key": "pod",
                                                       "match": {"value": pod}}]}})
        hits = []
        for p in out.get("result", {}).get("points", []):
            pl = p.get("payload", {}) or {}
            hits.append({"rel": pl.get("rel", "?"),
                         "text": (pl.get("text", "") or "")[:900],
                         "score": round(float(p.get("score", 0.0)), 4)})
        return hits
    except Exception as e:
        log.warning("podcode: semantic(%s) failed: %s", pod, e)
        return []


def vectorize_all():
    """Blocking full vector build (admin/CLI use). Returns total files done."""
    _ensure_collection()
    total = 0
    try:
        import groups
        statuses = groups.all_pod_statuses()
        pods = sorted(n for n, s in statuses.items() if s == "Running")
    except Exception:
        pods = []
    for pod in pods:
        try:
            while True:
                n = _drain_pod(pod, _VEC_MAX_FILES_PER_POD)
                total += n
                if n < _VEC_MAX_FILES_PER_POD:
                    break
        except Exception as e:
            log.warning("podcode: vectorize_all(%s) aborted: %s", pod, e)
    return total


def vec_stats(pod):
    vs = _read_json(_vec_state_file(pod), {})
    return {"vectorized": len(vs) if isinstance(vs, dict) else 0}


# ── public read API (used by the AI tools / prompt / HTTP routes) ──
def get_index(pod):
    d = _read_json(_index_file(pod), None)
    return d if isinstance(d, dict) else None


def code_map_block(pod):
    """The compact code map injected into the pod-page system prompt."""
    try:
        import kvcache
        key = f"podcode:map:{pod}"
        cached = kvcache.get(key)
        if cached:
            return cached
    except Exception:
        key = None
    d = get_index(pod)
    txt = (d or {}).get("code_map") or ""
    if txt and key:
        try:
            import kvcache
            kvcache.set(key, txt, ttl=3600)
        except Exception:
            pass
    return txt


def outline(pod, path=""):
    """Directory tree + symbol outline for a file/dir, from the index."""
    d = get_index(pod)
    if not d:
        return None
    files = d.get("files") or {}
    rel = (path or "").strip().replace("\\", "/").lstrip("/")
    if rel and rel in files:
        e = files[rel]
        syms = e.get("symbols") or []
        lines = [f"{rel} ({e.get('lang','')}, {e.get('lines',0)} 行, {e.get('size',0)} 字节)"]
        for s in syms:
            lines.append(f"  {s.get('line',0):>5}  {s.get('kind','')}  {s.get('name','')}")
        if not syms:
            lines.append("  (未提取到符号)")
        lines.append("--- head ---")
        lines.append(e.get("head") or "")
        return "\n".join(lines)
    prefix = rel + "/" if rel else ""
    sub = {r: e for r, e in files.items() if r.startswith(prefix)}
    if not sub:
        return None
    # aggregate: show dirs and files under prefix (one level if the prefix is a dir)
    dirs, direct = {}, []
    for r in sorted(sub):
        rest = r[len(prefix):]
        if "/" in rest:
            dirs.setdefault(rest.split("/")[0], 0)
            dirs[rest.split("/")[0]] += 1
        else:
            direct.append(r)
    lines = [f"/home/cloud/{rel}" if rel else "/home/cloud"]
    for dname in sorted(dirs):
        lines.append(f"  d  {dname}/  ({dirs[dname]} 个已索引文件)")
    for r in direct[:120]:
        e = files[r]
        syms = [s["name"] for s in (e.get("symbols") or [])
                if s.get("kind") in ("def", "class", "method")][:6]
        lines.append(f"  -  {e.get('lang','')}  {r}" + (" :: " + ", ".join(syms) if syms else ""))
    if len(direct) > 120:
        lines.append(f"  …（其余 {len(direct) - 120} 个文件）")
    return "\n".join(lines)


def grep(pod, pattern, path="", limit=60):
    """Regex grep over the pod's indexed files, read from the hostPath.

    Returns (text, n_hits) or (None, error). Never raises.
    """
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return None, f"正则无效: {e}"
    d = get_index(pod)
    if not d:
        return None, "该 Pod 还没有代码索引（podwatch 下一轮会建立，或请管理员触发重建）"
    files = list((d.get("files") or {}).keys())
    rel = (path or "").strip().replace("\\", "/").lstrip("/")
    if rel:
        if rel in files:
            files = [rel]
        else:
            files = [f for f in files if f.startswith(rel.rstrip("/") + "/")]
    root = _home(pod)
    hits = []
    scanned = 0
    for r in sorted(files):
        if len(hits) >= limit or scanned >= 400:
            break
        scanned += 1
        txt = _read_text(os.path.join(root, r), 256 * 1024)
        if txt is None:
            continue
        for i, line in enumerate(txt.splitlines(), 1):
            if len(line) > 500:
                continue
            if rx.search(line):
                hits.append(f"{r}:{i}: {line.strip()[:200]}")
                if len(hits) >= limit:
                    break
    if not hits:
        return f"未命中（在 {scanned} 个已索引文件中搜索 /{pattern}/）", 0
    return "\n".join(hits), len(hits)


def find_symbol(pod, name, limit=40):
    """Locate a definition by (partial) symbol name across the index."""
    d = get_index(pod)
    if not d:
        return None, "该 Pod 还没有代码索引"
    q = (name or "").strip().lower()
    if not q:
        return None, "缺少符号名"
    hits = []
    for rel, e in sorted((d.get("files") or {}).items()):
        for s in (e.get("symbols") or []):
            if q in (s.get("name") or "").lower():
                hits.append((len(s.get("name", "")), f"{rel}:{s.get('line',0)}: "
                             f"{s.get('kind','')} {s.get('name','')}"))
    if not hits:
        return f"未找到匹配 '{name}' 的符号（可用 pod_code_grep 兜底）", 0
    hits.sort(key=lambda t: t[0])          # exact-ish matches first
    out = [h for _l, h in hits[:limit]]
    return "\n".join(out), len(hits)


def stats(pod):
    d = get_index(pod)
    if not d:
        return {"pod": pod, "indexed": False}
    files = d.get("files") or {}
    return {
        "pod": pod, "indexed": True, "files": len(files),
        "langs": _lang_counts(files), "built": d.get("built"),
        "map_chars": len(d.get("code_map") or ""),
        "vectorized": vec_stats(pod)["vectorized"],
    }


def _lang_counts(files):
    out = {}
    for e in files.values():
        out[e.get("lang", "?")] = out.get(e.get("lang", "?"), 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1])[:12])
