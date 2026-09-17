"""RAG knowledge-base service for the YatTerra AI assistant.

Permission-partitioned Qdrant collections:
  g3dfc5d61_kb_public — platform docs (parsed read-only from docs.tsx), all users
  g3dfc5d61_kb_ops    — ops/runbook knowledge from /opt/yatterra/kb/*.md,
                        requires any infra.* / ops.* permission

Embeddings: bge-m3 (1024-dim, cosine) via the ssemarket OpenAI-compatible
gateway. NOTE: the gateway rejects single-element `input` lists, so every
request is padded with a dummy text and data[0] is taken.

Config (all from /opt/yatterra/llm.conf key=value, qdrant key from db.conf):
  embedding_base_url / embedding_api_key / embedding_model / qdrant_url
"""
import datetime
import json
import os
import re
import time
import urllib.request
import urllib.error
import uuid

import siteconf

LLM_CONF = siteconf.path("llm.conf")
DB_CONF = siteconf.path("db.conf")
KB_DIR = siteconf.path("kb")
DOCS_TSX = siteconf.web_path("frontend", "src", "routes", "docs.tsx")
STATE_FILE = siteconf.web_path("kb_state.json")

# Uploaded docs are stored as markdown files so the full ingest stays
# idempotent: ops uploads under kb/uploads/, public uploads under
# kb/uploads-public/ (a separate dir so the full ingest can route them
# to kb_public instead of kb_ops).
UPLOADS_OPS_DIR = os.path.join(KB_DIR, "uploads")
UPLOADS_PUBLIC_DIR = os.path.join(KB_DIR, "uploads-public")
UPLOAD_DIRS = {"ops": UPLOADS_OPS_DIR, "public": UPLOADS_PUBLIC_DIR}

COLL_PREFIX = os.environ.get("YATTERRA_KB_PREFIX", "g3dfc5d61_")
COLL_PUBLIC = COLL_PREFIX + "kb_public"
COLL_OPS = COLL_PREFIX + "kb_ops"

EMBED_DIM = 1024
BATCH_SIZE = 16
CHUNK_MIN = 300
CHUNK_MAX = 800
DEFAULT_K = 5
DEFAULT_THRESHOLD = 0.35


# ── config ────────────────────────────────────────────────────
def _read_llm_conf():
    conf = {}
    try:
        with open(LLM_CONF) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                conf[k.strip()] = v.strip()
    except OSError:
        pass
    return conf


def _qdrant_api_key():
    try:
        with open(DB_CONF) as f:
            return json.load(f).get("qdrant_api_key", "")
    except Exception:
        return os.environ.get("QDRANT_API_KEY", "")


def _qdrant_url():
    return _read_llm_conf().get("qdrant_url",
                                f"http://{siteconf.QDRANT_SERVICE}:6333")


def _embed_config():
    conf = _read_llm_conf()
    return {
        "url": conf.get("embedding_base_url",
                        siteconf._env("EMBEDDING_BASE_URL",
                            f"https://api.{siteconf.DOMAIN}/v1/embeddings")),
        "key": os.environ.get("EMBEDDING_API_KEY")
               or conf.get("embedding_api_key", ""),
        "model": conf.get("embedding_model", "bge-m3"),
    }


# ── HTTP helpers (stdlib only) ────────────────────────────────
def _http_json(method, url, payload=None, headers=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body) if body else {}


def _qdrant(method, path, payload=None):
    headers = {"api-key": _qdrant_api_key()}
    return _http_json(method, _qdrant_url().rstrip("/") + path,
                      payload=payload, headers=headers)


# ── embeddings ────────────────────────────────────────────────
def embed(texts):
    """Embed a list of texts. Returns list of 1024-dim vectors.

    The gateway rejects single-element input lists, so batches of one are
    padded with a dummy string and data[0] is used.
    """
    cfg = _embed_config()
    if not cfg["key"]:
        raise RuntimeError("embedding_api_key not configured in llm.conf")
    vectors = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = [t[:4000] for t in texts[i:i + BATCH_SIZE]]
        pad = len(batch) < 2
        if pad:
            batch = batch + ["."]
        body = {"model": cfg["model"], "input": batch}
        req = urllib.request.Request(
            cfg["url"], data=json.dumps(body).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", "Bearer " + cfg["key"])
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = json.loads(resp.read())
        data = sorted(out["data"], key=lambda d: d.get("index", 0))
        vecs = [d["embedding"] for d in data]
        if pad:
            vecs = vecs[:1]
        if len(vecs) != len(batch) - (1 if pad else 0):
            raise RuntimeError("embedding count mismatch")
        vectors.extend(vecs)
    return vectors


# ── permission → collection routing ───────────────────────────
def _expand_perms(user):
    """Accept a user dict, a perm set/list, or None → set of perms."""
    if user is None:
        return set()
    if isinstance(user, (set, frozenset, list, tuple)):
        return set(user)
    if isinstance(user, dict):
        try:
            import users
            return users.expanded_perms(user)
        except Exception:
            return set()
    return set()


def has_ops_access(user):
    """kb_ops access: any infra.* / ops.* permission (or super).

    The guest role carries infra.host for viewing host health, but must not
    read ops/runbook knowledge — require a real account (role >= user).
    """
    if isinstance(user, dict) and user.get("role") == "guest":
        return False
    perms = _expand_perms(user)
    return "*" in perms or any(
        p.startswith(("infra.", "ops.")) for p in perms)


def collections_for(user):
    cols = [COLL_PUBLIC]
    if has_ops_access(user):
        cols.append(COLL_OPS)
    return cols


# ── chunking ──────────────────────────────────────────────────
def _heading_prefix(path):
    return " > ".join(path) + "\n" if path else ""


def chunk_text(text, min_len=CHUNK_MIN, max_len=CHUNK_MAX):
    """Split plain text into 300-800 char chunks on paragraph boundaries."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, cur = [], ""
    for p in paragraphs:
        # hard-split over-long paragraphs
        while len(p) > max_len:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(p[:max_len])
            p = p[max_len:]
        if len(cur) + len(p) + 2 > max_len and len(cur) >= min_len:
            chunks.append(cur)
            cur = p
        else:
            cur = (cur + "\n\n" + p) if cur else p
    if cur:
        chunks.append(cur)
    return chunks


def chunk_markdown(text):
    """Markdown → chunks with heading-path context prefix.

    Splits on heading boundaries and paragraphs; each chunk is prefixed
    with its heading hierarchy (e.g. "MinIO 运维 > 连接方法").
    """
    lines = text.splitlines()
    chunks = []
    heads = []          # [(level, title)]
    buf = []            # current paragraph lines
    buf_start_heads = None

    def flush():
        body = "\n".join(buf).strip()
        buf.clear()
        if not body:
            return
        for c in chunk_text(body):
            chunks.append(_heading_prefix(buf_start_heads or
                                          [h for _, h in heads]) + c)

    for line in lines:
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            # flush pending paragraph before starting a new section
            flush()
            level, title = len(m.group(1)), m.group(2).strip()
            heads = [(l, t) for l, t in heads if l < level]
            heads.append((level, title))
            continue
        if not line.strip():
            flush()
            continue
        if not buf:
            buf_start_heads = [h for _, h in heads]
        buf.append(line)
    flush()
    return chunks


# ── docs.tsx parser (read-only) ───────────────────────────────
# Strings that are tailwind class names / route boilerplate, not content.
_CLASSY = re.compile(
    r"text-|bg-|rounded|border-|px-|py-|mb-|mt-|ml-|mr-|space-|list-|"
    r"font-|overflow-|whitespace-|leading-|max-w|mx-|inline-|gap-|w-full|"
    r"left-|top-|z-|h-\d|grid|flex|shadow|underline|italic|font-bold|"
    r"transition|hover:|dark:|sticky|backdrop|tracking|uppercase|"
    r"divide-|ring-|opacity-|scale-|translate|animate|accent-|cursor-")


def _clean_tsx_strings(span):
    """Extract human-readable single-quoted strings from a tsx span."""
    out = []
    for s in re.findall(r"'((?:[^'\\\n]|\\.)*)'", span):
        s = s.replace("\\'", "'").strip()
        if len(s) < 2:
            continue
        if _CLASSY.search(s):
            continue
        if re.fullmatch(r"[a-z0-9-]{2,30}", s) and " " not in s:
            # bare kebab ids like 'quickstart' — skip (section ids, keys)
            continue
        out.append(s)
    return out


def parse_docs_tsx(path=DOCS_TSX):
    """Parse docs.tsx (read-only) into [{title, text}] items.

    Structure: sections[] with title + items[] each having title + JSX
    content built from P()/UL()/H4()/TB()/CODE()/LINK() helpers whose
    arguments are string literals.
    """
    with open(path) as f:
        src = f.read()
    items = []
    # matches `title: '...'` followed by either `icon:` (section) or
    # `content:` (item) — captures the section/item split points
    markers = list(re.finditer(
        r"title:\s*'((?:[^'\\]|\\.)*)'\s*,?\s*\n\s*(icon|content)\s*[:=]", src))
    section_title = ""
    for i, m in enumerate(markers):
        title = m.group(1).replace("\\'", "'")
        kind = m.group(2)
        if kind == "icon":
            section_title = title
            continue
        # item: content spans until the next marker (or end of file)
        start = m.end()
        end = markers[i + 1].start() if i + 1 < len(markers) else len(src)
        strings = _clean_tsx_strings(src[start:end])
        if strings:
            items.append({
                "title": f"{section_title} > {title}" if section_title else title,
                "text": "\n".join(strings),
            })
    return items


# ── ingest sources ────────────────────────────────────────────
def _load_public_chunks():
    chunks = []
    for item in parse_docs_tsx():
        # admin-only sections are routed to kb_ops instead
        if re.search(r"仅管理员", item["title"]):
            continue
        for c in chunk_text(item["text"]):
            chunks.append({
                "text": c,
                "title": item["title"],
                "source": "docs.tsx (平台文档)",
            })
    return chunks


def _load_docs_ops_chunks():
    """docs.tsx sections explicitly marked admin-only
    (e.g. 运维知识（仅管理员参考）) are indexed into kb_ops."""
    chunks = []
    for item in parse_docs_tsx():
        if not re.search(r"仅管理员", item["title"]):
            continue
        for c in chunk_text(item["text"]):
            chunks.append({
                "text": c,
                "title": item["title"],
                "source": "docs.tsx (平台文档·运维节)",
            })
    return chunks


def _load_ops_chunks():
    chunks = []
    if not os.path.isdir(KB_DIR):
        return chunks
    for fn in sorted(os.listdir(KB_DIR)):
        if not fn.endswith(".md"):
            continue
        path = os.path.join(KB_DIR, fn)
        try:
            with open(path) as f:
                text = f.read()
        except OSError:
            continue
        for c in chunk_markdown(text):
            chunks.append({"text": c, "title": fn, "source": f"kb/{fn}"})
    return chunks


# ── uploaded docs (uploads/ + uploads-public/) ────────────────
_HEADER_RE = re.compile(r"\A<!--(.*?)-->\s*", re.S)
_SLUG_RE = re.compile(r"[^0-9a-zA-Z一-鿿]+")


def slugify(title):
    """Title → filesystem-safe slug (keeps CJK, drops the rest)."""
    slug = _SLUG_RE.sub("-", (title or "").strip()).strip("-")
    return slug[:60] or "doc"


def _doc_source(kb, fn):
    return f"kb/{'uploads' if kb == 'ops' else 'uploads-public'}/{fn}"


def _write_doc_file(kb, title, body, summarized):
    """Persist an uploaded doc as <slug>-<rand>.md with a YAML-ish header.

    Returns (doc_id, path). The header is an HTML comment so it is easy
    to strip before chunking.
    """
    d = UPLOAD_DIRS[kb]
    os.makedirs(d, exist_ok=True)
    doc_id = f"{slugify(title)}-{uuid.uuid4().hex[:6]}"
    ts = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    header = (f"<!--\ntitle: {title}\nkb: {kb}\n"
              f"uploaded_at: {ts}\nsummarized: {str(bool(summarized)).lower()}\n-->\n\n")
    path = os.path.join(d, doc_id + ".md")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(header + body.rstrip() + "\n")
    os.replace(tmp, path)
    return doc_id, path


def _parse_doc_file(path):
    """Read an uploaded doc → (meta dict, body text). Header comment is
    stripped so it is never embedded/chunked."""
    with open(path) as f:
        raw = f.read()
    meta = {"title": os.path.basename(path), "kb": "ops",
            "uploaded_at": "", "summarized": False}
    m = _HEADER_RE.match(raw)
    if m:
        raw = raw[m.end():]
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                k, v = k.strip(), v.strip()
                if k == "summarized":
                    meta[k] = v.lower() == "true"
                elif k in ("title", "kb", "uploaded_at"):
                    meta[k] = v
    return meta, raw


def _doc_chunks(kb, fn, text):
    """Chunks + payload metadata for one uploaded doc."""
    src = _doc_source(kb, fn)
    return [{"text": c, "title": fn, "source": src}
            for c in chunk_markdown(text)]


def upsert_doc_chunks(kb, fn, text):
    """Incrementally upsert one doc's chunks into its collection.

    Point IDs are deterministic (uuid5 of source#index) so re-upserting
    the same doc is idempotent. Returns the number of chunks.
    """
    coll = COLL_OPS if kb == "ops" else COLL_PUBLIC
    chunks = _doc_chunks(kb, fn, text)
    if not chunks:
        return 0
    vectors = embed([c["text"] for c in chunks])
    points = []
    for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
        points.append({
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL,
                                 f"{chunk['source']}#{i}")),
            "vector": vec,
            "payload": {
                "text": chunk["text"],
                "title": chunk["title"],
                "source": chunk["source"],
                "ingested_at": int(time.time()),
            },
        })
    for i in range(0, len(points), 64):
        _qdrant("PUT", f"/collections/{coll}/points?wait=true",
                {"points": points[i:i + 64]})
    return len(points)


def delete_doc_chunks(kb, fn):
    """Remove one doc's chunks from its collection (filter on source)."""
    coll = COLL_OPS if kb == "ops" else COLL_PUBLIC
    _qdrant("POST", f"/collections/{coll}/points/delete?wait=true",
            {"filter": {"must": [{"key": "source",
                                  "match": {"value": _doc_source(kb, fn)}}]}})


def summarize_content(content, user=None):
    """LLM-summarize doc content into structured markdown.

    Keeps key commands/paths/values, drops chatter. Falls back to the
    original text if the LLM call fails.
    """
    sys_prompt = ("你是运维知识库编辑。把输入的原始内容提炼成结构化 markdown 文档："
                  "保留所有关键命令、配置、文件路径、端口号、数值和结论，去掉寒暄和无关过程描述。"
                  "使用清晰的标题层级和列表。直接输出 markdown 正文，不要任何前言。")
    try:
        import ai_service
        out = ai_service.quick_chat(
            "请把以下内容总结成结构化 markdown 知识文档：\n\n" + content,
            system=sys_prompt, max_tokens=2048, caller="kb_summarize",
            user=user.get("username") if isinstance(user, dict) else user)
        out = (out or "").strip()
        if len(out) >= 50:
            return out, True
    except Exception:
        pass
    return content, False


def save_doc(title, content, kb="ops", summarize=False, user=None):
    """Store one uploaded doc on disk and index it immediately.

    Returns {id, title, kb, chunks, summarized, path}. Raises
    PermissionError on insufficient perms, ValueError on bad input.
    """
    title = (title or "").strip()
    content = (content or "").strip()
    if not title or not content:
        raise ValueError("title and content are required")
    if kb not in ("ops", "public"):
        raise ValueError("kb must be 'ops' or 'public'")
    _check_doc_perms(user, kb)
    if summarize:
        content, summarized = summarize_content(content, user=user)
    else:
        summarized = False
    doc_id, path = _write_doc_file(kb, title, content, summarized)
    chunks = upsert_doc_chunks(kb, doc_id + ".md", content)
    return {"id": doc_id, "title": title, "kb": kb, "chunks": chunks,
            "summarized": summarized, "path": path}


def _check_doc_perms(user, kb):
    """Upload/delete permission: ops → infra.host/ops.audit non-guest;
    public → admin.users or super (higher bar)."""
    if isinstance(user, dict) and user.get("role") == "guest":
        raise PermissionError("guest role cannot manage KB docs")
    perms = _expand_perms(user)
    if "*" in perms:
        return
    if kb == "public":
        if "admin.users" not in perms:
            raise PermissionError("kb=public requires admin.users or super")
        return
    if not any(p.startswith(("infra.", "ops.")) for p in perms):
        raise PermissionError("kb=ops requires infra.* or ops.* permission")


def list_docs():
    """List uploaded docs: [{id, title, kb, ts, chunks, summarized}]."""
    out = []
    for kb, d in UPLOAD_DIRS.items():
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".md"):
                continue
            path = os.path.join(d, fn)
            try:
                meta, body = _parse_doc_file(path)
            except OSError:
                continue
            n_chunks = len(chunk_markdown(body))
            out.append({
                "id": fn[:-3],
                "title": meta["title"],
                "kb": kb,
                "ts": meta["uploaded_at"],
                "chunks": n_chunks,
                "summarized": meta["summarized"],
            })
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def get_doc(doc_id):
    """Locate an uploaded doc by id → (kb, filename, path) or None."""
    if not re.fullmatch(r"[0-9a-zA-Z一-鿿\-_]+", doc_id or ""):
        return None
    for kb, d in UPLOAD_DIRS.items():
        path = os.path.join(d, doc_id + ".md")
        if os.path.isfile(path):
            return kb, doc_id + ".md", path
    return None


def delete_doc(doc_id, user=None):
    """Delete an uploaded doc file and remove its chunks. Returns meta."""
    loc = get_doc(doc_id)
    if loc is None:
        return None
    kb, fn, path = loc
    _check_doc_perms(user, kb)
    meta, _ = _parse_doc_file(path)
    os.remove(path)
    delete_doc_chunks(kb, fn)
    return {"id": doc_id, "title": meta["title"], "kb": kb}


def _load_upload_chunks(d, kb):
    """Chunks for all docs in one uploads dir (full-ingest path)."""
    chunks = []
    if not os.path.isdir(d):
        return chunks
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".md"):
            continue
        try:
            _, body = _parse_doc_file(os.path.join(d, fn))
        except OSError:
            continue
        chunks.extend(_doc_chunks(kb, fn, body))
    return chunks


def _rebuild_collection(name, chunks):
    """Delete + recreate a collection and upsert chunks. Idempotent."""
    try:
        _qdrant("DELETE", f"/collections/{name}")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    _qdrant("PUT", f"/collections/{name}",
            {"vectors": {"size": EMBED_DIM, "distance": "Cosine"}})
    if not chunks:
        return 0
    vectors = embed([c["text"] for c in chunks])
    points = []
    for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
        points.append({
            "id": i + 1,
            "vector": vec,
            "payload": {
                "text": chunk["text"],
                "title": chunk["title"],
                "source": chunk["source"],
                "ingested_at": int(time.time()),
            },
        })
    # upsert in batches to keep request bodies small
    for i in range(0, len(points), 64):
        _qdrant("PUT", f"/collections/{name}/points?wait=true",
                {"points": points[i:i + 64]})
    return len(points)


def _save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def _load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def ingest_all():
    """Rescan docs.tsx + kb/*.md + uploads dirs and rebuild both collections.

    Uploads route by directory: kb/uploads/ → kb_ops,
    kb/uploads-public/ → kb_public (same routing as incremental upsert).
    """
    public = (_load_public_chunks()
              + _load_upload_chunks(UPLOADS_PUBLIC_DIR, "public"))
    ops = (_load_ops_chunks() + _load_docs_ops_chunks()
           + _load_upload_chunks(UPLOADS_OPS_DIR, "ops"))
    result = {
        "public_chunks": _rebuild_collection(COLL_PUBLIC, public),
        "ops_chunks": _rebuild_collection(COLL_OPS, ops),
        "ts": int(time.time()),
    }
    state = _load_state()
    state["last_ingest"] = result
    _save_state(state)
    return result


def status():
    """Per-collection point counts + last ingest time."""
    out = {"collections": {}, "last_ingest": _load_state().get("last_ingest")}
    for name in (COLL_PUBLIC, COLL_OPS):
        try:
            info = _qdrant("GET", f"/collections/{name}")
            res = info.get("result", {})
            out["collections"][name] = {
                "points": res.get("points_count", 0),
                "status": res.get("status", "?"),
                "vectors": res.get("vectors", {}).get("size", EMBED_DIM),
            }
        except urllib.error.HTTPError as e:
            out["collections"][name] = {"error": f"HTTP {e.code}"}
        except Exception as e:
            out["collections"][name] = {"error": str(e)[:200]}
    return out


# ── retrieval ─────────────────────────────────────────────────
def retrieve(query, user, k=DEFAULT_K, min_score=DEFAULT_THRESHOLD):
    """Permission-routed retrieval. Returns [{text, title, source, score}].

    kb_public is always searched; kb_ops only for users with infra.*/ops.*
    permissions. Results are merged and sorted by score.
    """
    query = (query or "").strip()
    if not query:
        return []
    vec = embed([query])[0]
    hits = []
    for coll in collections_for(user):
        try:
            out = _qdrant("POST", f"/collections/{coll}/points/query",
                          {"query": vec, "limit": k, "with_payload": True})
        except Exception:
            continue
        for p in out.get("result", {}).get("points", []):
            score = p.get("score", 0.0)
            if score < min_score:
                continue
            pl = p.get("payload", {}) or {}
            hits.append({
                "text": pl.get("text", ""),
                "title": pl.get("title", ""),
                "source": pl.get("source", coll),
                "collection": coll,
                "score": round(float(score), 4),
            })
    hits.sort(key=lambda h: h["score"], reverse=True)
    return hits[:k]
