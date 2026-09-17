"""AI API blueprint — /api/ai

AI-native endpoints for chat, analysis, vision, code, web-qa, completion, translation, explanation.
All endpoints support streaming (SSE) for progressive rendering.
"""
import json
import time
from flask import Blueprint, request, jsonify, Response, stream_with_context, g
from middleware.error_handler import ApiError, bad_request

import ai_service
import insight
import kb_service

from api._auth import require_auth, current_username

ai_bp = Blueprint("api_ai", __name__, url_prefix="/api/ai")


def _user():
    return current_username() or "anonymous"


def _rag_context(question, k=3, threshold=0.35):
    """Retrieve KB chunks relevant to the question (permission-routed).

    Returns a system-prompt section string, or "" on no hit / KB failure
    (RAG must never break the chat itself).
    """
    from flask import g
    try:
        hits = kb_service.retrieve(question, g.api_user, k=k,
                                   min_score=threshold)
    except Exception:
        return ""
    if not hits:
        return ""
    parts = ["[知识库检索] 以下是平台文档/运维知识库中与用户问题相关的片段,回答时可参考,引用时注明来源:"]
    for i, h in enumerate(hits, 1):
        parts.append(f"[{i}] 来源: {h['source']} | {h['title']}\n{h['text']}")
    return "\n\n" + "\n\n".join(parts)


def _sse_stream(gen):
    """Wrap a (kind, text) generator into an SSE Response."""
    def stream():
        yield "retry: 3000\n\n"
        for kind, piece in gen:
            ev = {"type": kind, "data": piece}
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
    resp = Response(stream_with_context(stream()), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


# ── Chat ──────────────────────────────────────────────────────
@ai_bp.route("/chat", methods=["POST"])
@require_auth()
def ai_chat():
    """General-purpose chat. Supports streaming.

    Body: {message, system?, context?, stream?, max_tokens?}
    """
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        raise bad_request("message is required")
    system = body.get("system", "")
    context = body.get("context")
    max_tokens = min(16384, max(256, int(body.get("max_tokens", 4096))))
    stream = body.get("stream", False)

    # RAG enhancement: inject permission-routed KB hits into the system prompt
    system = (system or "") + _rag_context(message)

    if stream:
        return _sse_stream(
            ai_service.stream_chat(message, system=system, context=context,
                                   max_tokens=max_tokens, user=_user()))
    result = ai_service.quick_chat(message, system=system, context=context,
                                   max_tokens=max_tokens, user=_user())
    return jsonify({"content": result})


# ── Analyze ───────────────────────────────────────────────────
@ai_bp.route("/analyze", methods=["POST"])
@require_auth()
def ai_analyze():
    """Text analysis: summarize, classify, extract, translate, explain.

    Body: {text, task, categories?, extract_type?, stream?}
    task: summarize | classify | extract | translate | explain
    """
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        raise bad_request("text is required")
    task = body.get("task", "summarize")
    if task not in ("summarize", "classify", "extract", "translate", "explain"):
        raise bad_request(f"Unknown task: {task}")
    categories = body.get("categories")
    extract_type = body.get("extract_type")

    if body.get("stream"):
        def gen():
            # For streaming analyze, we use stream_chat with task-specific system
            sys_map = {
                "summarize": ai_service._SYS_SUMMARIZE,
                "classify": ai_service._SYS_CLASSIFY,
                "extract": ai_service._SYS_EXTRACT,
                "translate": ai_service._SYS_TRANSLATE,
                "explain": ai_service._SYS_EXPLAIN,
            }
            yield from ai_service.stream_chat(
                f"请{task}以下内容：\n\n{text}",
                system=sys_map.get(task, ""), max_tokens=4096, user=_user())
        return _sse_stream(gen())

    result = ai_service.analyze_text(text, task=task, categories=categories,
                                     extract_type=extract_type, user=_user())
    return jsonify({"content": result, "task": task})


# ── Vision ────────────────────────────────────────────────────
@ai_bp.route("/vision", methods=["POST"])
@require_auth()
def ai_vision():
    """Image understanding with Qwen vision model.

    Body: {image, prompt, stream?}
    image: base64-encoded image (without data: prefix)
    """
    body = request.get_json(silent=True) or {}
    image = (body.get("image") or "").strip()
    prompt = (body.get("prompt") or "请描述这张图片的内容").strip()
    if not image:
        raise bad_request("image (base64) is required")

    if body.get("stream"):
        return _sse_stream(
            ai_service.stream_vision(image, prompt, user=_user()))

    result = ai_service.analyze_image(image, prompt, user=_user())
    return jsonify({"content": result})


# ── Code ──────────────────────────────────────────────────────
@ai_bp.route("/code", methods=["POST"])
@require_auth()
def ai_code():
    """Code generation, explanation, or review.

    Body: {prompt, language?, task?, stream?}
    task: generate | explain | review
    """
    body = request.get_json(silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        raise bad_request("prompt is required")
    language = body.get("language", "python")
    task = body.get("task", "generate")

    if body.get("stream"):
        return _sse_stream(
            ai_service.stream_code(prompt, language=language, task=task, user=_user()))

    result = ai_service.generate_code(prompt, language=language, task=task, user=_user())
    return jsonify({"content": result, "language": language, "task": task})


# ── Web QA ────────────────────────────────────────────────────
@ai_bp.route("/web-qa", methods=["POST"])
@require_auth()
def ai_web_qa():
    """Answer question using search results (web-use pattern).

    Body: {question, search_results?, stream?}
    search_results: [{title, url, snippet}, ...]
    """
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    if not question:
        raise bad_request("question is required")
    search_results = body.get("search_results")

    if body.get("stream"):
        return _sse_stream(
            ai_service.stream_web_qa(question, search_results=search_results, user=_user()))

    result = ai_service.web_qa(question, search_results=search_results, user=_user())
    return jsonify({"content": result})


# ── Complete ──────────────────────────────────────────────────
@ai_bp.route("/complete", methods=["POST"])
@require_auth()
def ai_complete():
    """Smart completion for forms, commands, configs.

    Body: {partial, schema?, context?}
    """
    body = request.get_json(silent=True) or {}
    partial = (body.get("partial") or "").strip()
    if not partial:
        raise bad_request("partial is required")
    schema = body.get("schema")
    context = body.get("context", "")

    result = ai_service.smart_complete(partial, schema=schema, context=context, user=_user())
    return jsonify({"completion": result})


# ── Translate ─────────────────────────────────────────────────
@ai_bp.route("/translate", methods=["POST"])
@require_auth()
def ai_translate():
    """Translate text.

    Body: {text, target?, stream?}
    target: zh | en | ja | ko (default: zh)
    """
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        raise bad_request("text is required")
    target = body.get("target", "zh")
    lang_map = {"zh": "中文", "en": "英文", "ja": "日文", "ko": "韩文"}
    target_name = lang_map.get(target, target)

    if body.get("stream"):
        return _sse_stream(
            ai_service.stream_chat(f"翻译为{target_name}：\n\n{text}",
                                   system=ai_service._SYS_TRANSLATE, user=_user()))

    result = ai_service.analyze_text(text, task="translate", target=target, user=_user())
    return jsonify({"content": result, "target": target})


# ── Explain ───────────────────────────────────────────────────
@ai_bp.route("/explain", methods=["POST"])
@require_auth()
def ai_explain():
    """Explain error messages, logs, or code.

    Body: {text, stream?}
    """
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        raise bad_request("text is required")

    if body.get("stream"):
        return _sse_stream(
            ai_service.stream_chat(f"请解释以下内容：\n\n{text}",
                                   system=ai_service._SYS_EXPLAIN, user=_user()))

    result = ai_service.analyze_text(text, task="explain", user=_user())
    return jsonify({"content": result})


# ── Page Context ──────────────────────────────────────────────
@ai_bp.route("/page", methods=["POST"])
@require_auth()
def ai_page():
    """Page-level AI assistant. Context-aware, multi-turn with tool use.

    Body: {page, question, context?, history?, stream?}
    page: dashboard | pod | terminal | audit | llm | users | threat-map | storage | databases | proxy | shared | profile
    history: [{role, content}, ...]  prior conversation turns
    """
    body = request.get_json(silent=True) or {}
    page = body.get("page", "dashboard")
    question = (body.get("question") or body.get("message") or "").strip()
    if not question:
        raise bad_request("question is required")

    # Page-level permission check — a low-privilege user must not be able to
    # request the storage/db/ops assistant system prompts. Uses the same
    # INSIGHT_PAGE_PERMS mapping as the insight endpoints; pages outside the
    # map are denied except the login-only ones below.
    import users
    _PAGE_LOGIN_ONLY = {"terminal": "group.terminal", "profile": None, "docs": None}
    _req_perm = INSIGHT_PAGE_PERMS.get(page, _PAGE_LOGIN_ONLY.get(page, "__deny__"))
    if _req_perm == "__deny__":
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": f"Permission denied: page/{page}"}}), 403
    if _req_perm:
        try:
            _has = users.has_perm(g.api_user, _req_perm)
        except Exception:
            _has = False
        if not _has:
            return jsonify({"error": {"code": "FORBIDDEN",
                                      "message": f"Permission denied: {_req_perm}"}}), 403

    context = body.get("context", "")
    history = body.get("history") or []
    images = body.get("images") or []  # base64 strings

    # Page-specific system prompts
    page_systems = {
        "dashboard": "你是集群运维助手。分析集群状态数据，给出运维建议。关注异常指标、资源瓶颈、安全风险。你可以使用工具查询集群实时状态。",
        "pod": "你是 Pod/容器助手。帮助分析 Pod 状态、日志错误、部署配置、资源使用。你可以使用工具查看 Pod 详情和日志，给出具体修复建议。",
        "terminal": "你是终端助手。解释命令输出、建议修复命令、生成常用命令。你可以使用工具执行安全的只读命令来查看状态。注意安全，不执行危险命令。",
        "audit": "你是安全审计助手。分析审计事件、发现异常模式、生成安全报告。关注权限变更、异常登录、资源操作。你可以使用工具查询集群状态辅助分析。",
        "llm": "你是 LLM 服务助手。帮助测试 prompt、对比模型输出、优化推理参数、分析用量。你可以使用工具查看 GPU 和集群状态。",
        "users": "你是用户管理助手。帮助批量操作建议、权限审计、角色规划。",
        "threat-map": "你是安全防御助手。分析攻击模式、建议防御策略、评估风险等级。你可以使用工具查询集群安全状态。",
        "storage": "你是存储助手。帮助分析桶策略、优化存储配置、管理访问密钥。你可以使用工具查看集群存储状态。",
        "databases": "你是数据库助手。帮助分析连接配置、优化查询、管理凭证。你可以使用工具查看数据库 Pod 状态。",
        "proxy": "你是反向代理助手。帮助检查 Nginx 反代映射冲突、推荐端口分配、分析代理配置问题。你可以使用工具查看集群网络和 Pod 端口状态。",
        "shared": "你是共享文件助手。帮助分析共享目录结构、建议清理策略、查找大文件、优化文件组织。你可以使用工具查看文件系统状态。",
        "profile": "你是个人设置助手。帮助检查安全设置建议、身份绑定状态、账户安全最佳实践。",
        "mcp": "你是 MCP 服务助手。帮助推荐 MCP 工具服务、分析连接问题、生成服务配置。了解 Model Context Protocol 的 stdio/SSE/HTTP 传输方式。",
        "harness": "你是 Agent 编排助手。帮助优化多 Agent 工作流编排、分析运行结果、推荐工作流设计。了解 DAG 编排、并行 fan-out、条件分支等模式。",
        "docs": "你是平台文档助手。帮助解释 API 用法、查找功能文档、生成示例命令。了解 YatTerra 平台的所有功能模块和 REST API 端点。",
        "dev": "你是开发概览助手。帮助分析 Agent 运行状态、检查编排工作流、推荐开发最佳实践。了解 ReAct Agent、DAG 编排、MCP 服务等开发工具。",
        "infra": "你是基础设施概览助手。帮助检查集群健康状态、分析资源瓶颈、给出容量规划建议。关注 CPU、内存、GPU、存储、数据库等基础设施组件。",
        "ops": "你是运维概览助手。帮助分析运维事件摘要、评估安全风险、检测异常模式。关注审计日志、共享文件、安全防御等运维场景。",
        "gpu": "你是 GPU 监控助手。帮助分析 GPU 利用率、显存使用、温度状态，给出 GPU 资源优化和调度建议。了解 NVIDIA GPU、CUDA、显存管理、GPU 调度策略。",
        "host": "你是主机监控助手。帮助检查主机健康状态、分析资源使用（CPU/内存/磁盘/网络）、诊断性能瓶颈。了解 Linux 系统管理、资源监控、性能调优。",
    }
    system = page_systems.get(page, "你是 YatTerra 平台 AI 助手。你可以使用工具查询集群实时状态来辅助回答。")
    # RAG enhancement: permission-routed KB hits injected into the system prompt
    system += _rag_context(question)

    # Build messages array from history + new question
    messages = []
    for h in history:
        role = h.get("role", "")
        content = h.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    # Add context as a system-like user message if present
    if context:
        messages.append({"role": "user", "content": f"[页面数据]\n{context}"})
        messages.append({"role": "assistant", "content": "收到页面数据，已了解当前状态。"})

    # Build user message — with images if provided (vision support)
    if images:
        content_parts = [{"type": "text", "text": question}]
        for img in images[:4]:  # cap at 4 images
            if isinstance(img, str) and img.startswith("data:"):
                content_parts.append({"type": "image_url", "image_url": {"url": img}})
            elif isinstance(img, str):
                content_parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}})
        messages.append({"role": "user", "content": content_parts})
    else:
        messages.append({"role": "user", "content": question})

    if body.get("stream"):
        return _sse_stream(
            ai_service.stream_agent(messages, system=system, max_tokens=4096,
                                    user=_user(), perms=g.api_user))

    # Non-streaming: collect full response
    parts = []
    for kind, data in ai_service.stream_agent(messages, system=system, max_tokens=4096,
                                              user=_user(), perms=g.api_user):
        if kind == "content":
            parts.append(data)
    return jsonify({"content": "".join(parts)})


# ── Pre-computed Insights ──────────────────────────────────────
# Insight page → required permission. Insight generators (insight.py GATHERERS)
# read infra-level data (minio_svc, proxy_map, host_health, db_svc, audit, ...),
# so access must match the permission guarding the underlying module.
# Pages not listed here are denied by default.
INSIGHT_PAGE_PERMS = {
    "dashboard": "infra.host",     # aggregates host/GPU/audit/threat data
    "pod": "group.view",
    "gpu": "infra.host",
    "host": "infra.host",
    "infra": "infra.host",         # aggregates host/storage/db/proxy
    "storage": "infra.storage.read",
    "databases": "infra.db.read",
    "db": "infra.db.read",
    "proxy": "infra.proxy",
    "audit": "ops.audit",
    "ops": "ops.audit",            # aggregates audit + threat feed
    "users": "admin.users",
    "threat-map": "ops.audit",
    "mcp": "dev.mcp",
    "dev": "dev.agent",            # aggregates agents/mcp/llm/usage
    "harness": "dev.harness",
    "llm": "dev.llm",
    "shared": "ops.shared.read",
}


def _check_insight_perm(page):
    """Return None if g.api_user may read this insight page, else a 403 response."""
    import users
    perm = INSIGHT_PAGE_PERMS.get(page)
    if not perm:
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": f"Permission denied: insight/{page}"}}), 403
    try:
        has = users.has_perm(g.api_user, perm)
    except Exception:
        has = False
    if not has:
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": f"Permission denied: {perm}"}}), 403
    return None


@ai_bp.route("/insight/<page>", methods=["GET"])
@require_auth()
def ai_insight_get(page):
    """Read pre-computed AI insight from Redis cache.

    Returns {content, ts, cached: true} on hit, {content: null, cached: false} on miss.
    The frontend falls back to synchronous generate on miss.
    """
    denied = _check_insight_perm(page)
    if denied:
        return denied
    data = insight.get_insight(page)
    if data:
        return jsonify({"content": data.get("content", ""), "ts": data.get("ts", 0), "cached": True})
    return jsonify({"content": None, "cached": False})


@ai_bp.route("/insight/<page>/refresh", methods=["POST"])
@require_auth()
def ai_insight_refresh(page):
    """Force re-compute one page's insight synchronously and return it."""
    denied = _check_insight_perm(page)
    if denied:
        return denied
    data = insight.refresh(page)
    if data:
        return jsonify({"content": data.get("content", ""), "ts": data.get("ts", 0), "cached": True})
    return jsonify({"content": None, "cached": False, "error": "compute failed"}), 500


# ── Knowledge Base management ─────────────────────────────────
# RAG collections are permission-partitioned (kb_public / kb_ops);
# rebuilding the index requires ops/infra-level permission.
def _kb_admin(user):
    import users
    # guest role carries infra.host for viewing; index rebuild needs a
    # real ops/infra account
    if not user or user.get("role") == "guest":
        return False
    try:
        return (users.has_perm(user, "ops.audit")
                or users.has_perm(user, "infra.host"))
    except Exception:
        return False


@ai_bp.route("/kb/ingest", methods=["POST"])
@require_auth()
def kb_ingest():
    """Rescan docs.tsx + /opt/yatterra/kb/*.md and rebuild KB collections.

    Collections are deleted and recreated (idempotent). Requires
    ops.audit or infra.host.
    """
    if not _kb_admin(g.api_user):
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": "Permission denied: kb ingest"}}), 403
    try:
        result = kb_service.ingest_all()
    except Exception as e:
        return jsonify({"error": {"code": "KB_ERROR",
                                  "message": f"ingest failed: {e}"}}), 500
    import audit
    audit.record("ai_kb_ingest",
                 detail=f"public={result['public_chunks']} ops={result['ops_chunks']}",
                 actor=_user())
    return jsonify({"ok": True, **result})


@ai_bp.route("/kb/status", methods=["GET"])
@require_auth()
def kb_status():
    """KB collection point counts + last ingest time."""
    if not _kb_admin(g.api_user):
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": "Permission denied: kb status"}}), 403
    try:
        return jsonify(kb_service.status())
    except Exception as e:
        return jsonify({"error": {"code": "KB_ERROR",
                                  "message": str(e)}}), 500


@ai_bp.route("/kb/docs", methods=["POST"])
@require_auth()
def kb_docs_upload():
    """Upload one knowledge doc into the KB.

    Body: {title, content, kb: "ops"|"public" (default ops),
           summarize: bool (default false)}
    Permissions: ops → infra.host/ops.audit non-guest; public →
    admin.users or super. The doc is persisted under
    /opt/yatterra/kb/uploads[-public]/ and its chunks are upserted into
    the matching collection immediately.
    """
    body = request.get_json(silent=True) or {}
    kb = body.get("kb", "ops")
    try:
        result = kb_service.save_doc(
            title=body.get("title"), content=body.get("content"), kb=kb,
            summarize=bool(body.get("summarize", False)), user=g.api_user)
    except PermissionError as e:
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": str(e)}}), 403
    except ValueError as e:
        return jsonify({"error": {"code": "BAD_REQUEST",
                                  "message": str(e)}}), 400
    except Exception as e:
        return jsonify({"error": {"code": "KB_ERROR",
                                  "message": f"upload failed: {e}"}}), 500
    import audit
    audit.record("ai_kb_doc_upload",
                 detail=f"id={result['id']} kb={result['kb']} "
                        f"chunks={result['chunks']} summarized={result['summarized']}",
                 actor=_user())
    return jsonify(result)


@ai_bp.route("/kb/docs", methods=["GET"])
@require_auth()
def kb_docs_list():
    """List uploaded KB docs: [{id, title, kb, ts, chunks, summarized}]."""
    if not _kb_admin(g.api_user):
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": "Permission denied: kb docs"}}), 403
    try:
        return jsonify({"docs": kb_service.list_docs()})
    except Exception as e:
        return jsonify({"error": {"code": "KB_ERROR",
                                  "message": str(e)}}), 500


@ai_bp.route("/kb/docs/<doc_id>", methods=["DELETE"])
@require_auth()
def kb_docs_delete(doc_id):
    """Delete an uploaded KB doc (file + its chunks). Same perms as POST."""
    try:
        result = kb_service.delete_doc(doc_id, user=g.api_user)
    except PermissionError as e:
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": str(e)}}), 403
    except Exception as e:
        return jsonify({"error": {"code": "KB_ERROR",
                                  "message": f"delete failed: {e}"}}), 500
    if result is None:
        return jsonify({"error": {"code": "NOT_FOUND",
                                  "message": f"doc not found: {doc_id}"}}), 404
    import audit
    audit.record("ai_kb_doc_delete",
                 detail=f"id={result['id']} kb={result['kb']}", actor=_user())
    return jsonify({"ok": True, **result})
