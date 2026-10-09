"""OpenAI-compatible streaming client for the ssedgx vllm service.

Reads LLM provider config from llm_conf module (multi-provider, web-manageable).
Falls back to /opt/yatterra/llm.conf (root 600) if llm_conf is unavailable.

`stream_chat(messages, system)` posts to /chat/completions with stream=True
and yields incremental assistant text as it arrives. Non-streaming callers
can use `chat(...)`.

Resilience:
  - concurrency cap: at most LLM_MAX_CONCURRENCY (env, default 4) simultaneous
    LLM calls, so parallel harness nodes / sub-agents don't overload vllm and
    crash EngineCore. Callers block on the semaphore until a slot frees. NOTE:
    this semaphore is process-local — under multiple gunicorn workers each
    process has its own cap, so the effective global limit is workers × this
    value. (Cross-process limiting is out of scope here.)
  - retry: connection errors, 5xx and 429 status are retried with backoff
    (LLM_MAX_RETRIES, default 4) before giving up. Mid-stream resets are not
    retried (would duplicate already-yielded text); they raise immediately.
  - fallback: within a provider, models[] is tried in order; if the whole
    provider fails, the next enabled provider is tried (the active provider
    first). See llm_conf.get_chain().
"""
import json
import os
import socket
import threading
import time

import requests

import siteconf

CONF_FILE = siteconf.path("llm.conf")

MAX_RETRIES = int(os.environ.get("LLM_MAX_RETRIES", "4"))
MAX_CONCURRENCY = int(os.environ.get("LLM_MAX_CONCURRENCY", "4"))
_LLM_SEM = threading.Semaphore(MAX_CONCURRENCY)


class LLMError(Exception):
    pass


def _load_conf_legacy():
    """Read the old key=value llm.conf. Returns {base_url, api_key, model}."""
    try:
        with open(CONF_FILE) as f:
            lines = f.readlines()
    except OSError:
        lines = []
    conf = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        conf[k.strip()] = v.strip()
    return conf


def load_conf():
    """Return {base_url, api_key, model, models, chain, providers, provider_id}.

    `models` is the ordered fallback list; `model` mirrors models[0]. `chain` is
    the ordered provider-level fallback chain (the active provider first, then
    the other enabled providers) — each entry carries its own base_url/api_key/
    models, so when a whole upstream is down the call falls through to the next
    provider. `providers` is a display-only roster of every configured provider
    (api_key stripped) for list-rendering consumers.

    Raises LLMError when the preferred provider is missing base_url/api_key/model.

    Delegates to llm_conf.get_chain() for the multi-provider system.
    Falls back to reading llm.conf directly if llm_conf is unavailable.
    api_key prefers env var LLM_API_KEY, fallback to provider config.
    """
    env_key = os.environ.get("LLM_API_KEY")
    chain = []
    providers = []
    try:
        import llm_conf
        for provider in llm_conf.get_chain():
            models = provider.get("models") or ([provider["model"]] if provider.get("model") else [])
            chain.append({
                "base_url": provider["base_url"],
                "api_key": env_key or provider["api_key"],
                "model": models[0] if models else "",
                "models": models,
                "provider_id": provider.get("id", ""),
                "name": provider.get("name", ""),
            })
        providers = llm_conf.list_providers()
    except Exception:
        # Fallback: read old llm.conf directly (backward compat)
        legacy = _load_conf_legacy()
        chain.append({
            "base_url": legacy.get("base_url", ""),
            "api_key": env_key or legacy.get("api_key", ""),
            "model": legacy.get("model", ""),
            "models": [legacy["model"]] if legacy.get("model") else [],
            "provider_id": "",
            "name": "",
        })
    conf = dict(chain[0])
    conf["chain"] = chain
    # Display-only roster of every configured provider (including disabled ones),
    # for consumers that just render the list — e.g. ai_service's
    # get_llm_providers tool reads conf["providers"]. api_key is stripped; those
    # consumers never need it.
    conf["providers"] = [
        {k: v for k, v in p.items() if k != "api_key"} for p in providers
    ] or [dict(c) for c in chain]
    for need in ("base_url", "api_key", "model"):
        if not conf.get(need):
            raise LLMError(f"LLM 配置缺少 {need}")
    return conf


def _attempts(conf):
    """Flatten a conf into an ordered [(provider_conf, model), ...] attempt list.

    The provider chain gives provider-level fallback; each provider's ordered
    ``models`` gives model-level fallback. A provider whose whole model list is
    dead falls through to the next provider in the chain.
    """
    chain = conf.get("chain") or [conf]
    out = []
    for prov in chain:
        models = prov.get("models") or ([prov["model"]] if prov.get("model") else [])
        for m in models:
            if m:
                out.append((prov, m))
    return out


def _stream_with_fallback(stream_factory, attempts):
    """Run ``stream_factory(provider, model)`` over ``attempts`` in priority order.

    ``attempts`` is an ordered list of (provider_conf, model) spanning the whole
    fallback chain, so both "next model in this provider" and "next provider"
    are handled here.

    Falls back only when the current attempt fails *before* yielding any chunk
    (dead host, non-200 after retries, retries exhausted). Once a chunk has been
    emitted a mid-stream failure is re-raised immediately — retrying would
    duplicate text the client has already seen. Raises the last error if every
    attempt fails.
    """
    attempts = list(attempts)
    if not attempts:
        raise LLMError("LLM 配置缺少 model")
    last_err = None
    for i, (prov, model) in enumerate(attempts):
        yielded = False
        try:
            for chunk in stream_factory(prov, model):
                yielded = True
                yield chunk
            return
        except LLMError as e:
            if yielded:
                raise  # mid-stream failure — cannot safely retry
            last_err = e
            _metric("llm_inc_error", prov.get("provider_id"), model)
            if i + 1 < len(attempts):
                _metric("llm_inc_fallback", prov.get("provider_id"))
                nxt_prov, nxt_model = attempts[i + 1]
                if nxt_prov.get("provider_id") != prov.get("provider_id"):
                    print(f"[llm] provider {prov.get('name') or prov.get('provider_id')} 失败({e})，"
                          f"回退到 provider {nxt_prov.get('name') or nxt_prov.get('provider_id')}")
                else:
                    print(f"[llm] model {model} 失败({e})，回退到 {nxt_model}")
    raise LLMError(f"所有 provider/model 均失败（尝试 {len(attempts)} 项）: {last_err}")


def _backoff(attempt):
    # 1s, 2s, 4s, 8s ...
    time.sleep(min(8, 2 ** attempt))


def _metric(fn, *args):
    """Best-effort emit one observability counter via the metrics module.

    metrics is imported lazily (it starts a background sampler thread on
    import) and every failure is swallowed — observability must never break
    or slow the LLM path. See metrics.llm_inc_request / llm_inc_error /
    llm_inc_fallback / llm_observe_latency.
    """
    try:
        import metrics
        getattr(metrics, fn)(*args)
    except Exception:
        pass


def _post_stream(messages, system, model, base_url, api_key, max_tokens,
                 on_usage=None, _caller=None, _user=None, _provider_id=None):
    url = base_url.rstrip("/") + "/chat/completions"
    # 推理模型(enable_thinking=True)要求所有 assistant 消息含 reasoning_content,
    # 而历史消息存的时候没有保留该字段。遍历补齐避免 vLLM 400 校验拒。
    fixed_messages = []
    for m in messages:
        if m.get("role") == "assistant" and "reasoning_content" not in m:
            m = dict(m, reasoning_content=None)
        fixed_messages.append(m)
    payload = {
        "model": model,
        "messages": ([{"role": "system", "content": system}] if system else []) + fixed_messages,
        "stream": True,
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream_options": {"include_usage": True},
        # qwen3.8-flash-next 是推理模型：思考阶段输出在 delta.reasoning，最终
        # 答案在 delta.content。开思考保质量，reasoning 由上层流给前端单独显示。
        "chat_template_kwargs": {"enable_thinking": True},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    last_err = None
    final_usage = {}
    retried_429 = False
    for attempt in range(MAX_RETRIES):
        if attempt:
            _backoff(attempt - 1)
        t0 = time.monotonic()
        try:
            resp = requests.post(url, json=payload, headers=headers, stream=True, timeout=90)
        except requests.RequestException as e:
            last_err = f"连不上 vllm({url}): {e}"
            _metric("llm_inc_request", _provider_id, model, "error")
            continue
        # 429 = upstream per-model concurrency cap (api.ssemarket limits some
        # models to a couple of concurrent streams). While we hold our slot it
        # stays 429, so burning the full backoff here only delays the
        # multi-model fallback. Retry once briefly, then fall through.
        if resp.status_code == 429:
            last_err = f"vllm 返回 429: {resp.text[:200]}"
            _metric("llm_inc_request", _provider_id, model, "429")
            try:
                resp.close()
            except Exception:
                pass
            if retried_429:
                break
            retried_429 = True
            continue
        # Retry transient upstream failures: 5xx (server hiccup).
        if resp.status_code in (500, 502, 503, 504):
            last_err = f"vllm 返回 {resp.status_code}: {resp.text[:200]}"
            _metric("llm_inc_request", _provider_id, model, "5xx")
            try:
                resp.close()
            except Exception:
                pass
            continue
        if resp.status_code != 200:
            _metric("llm_inc_request", _provider_id, model, f"http{resp.status_code}")
            raise LLMError(f"vllm 返回 {resp.status_code}: {resp.text[:500]}")
        # Some upstreams (e.g. a bare BaseHTTPServer) omit charset on
        # text/event-stream, which makes requests decode UTF-8 as latin-1 and
        # garble Chinese. SSE/JSON is always UTF-8, so force it.
        resp.encoding = "utf-8"
        # Set per-chunk read timeout on underlying socket to avoid hanging forever
        try:
            sock = resp.raw._fp.fp.raw._sock
            if sock is not None:
                sock.settimeout(60)
        except (AttributeError, OSError):
            pass
        # success — stream. Mid-stream errors are not retried (would duplicate).
        try:
            for raw in resp.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                data = raw[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                usage = obj.get("usage")
                if usage:
                    final_usage.update(usage)
                    if on_usage:
                        try:
                            on_usage(usage)
                        except Exception:
                            pass
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                r = delta.get("reasoning")
                if r:
                    yield ("reasoning", r)
                piece = delta.get("content")
                if piece:
                    yield ("content", piece)
        except (requests.RequestException, socket.timeout) as e:
            raise LLMError(f"vllm 流式中断或读取超时({url}): {e}")
        # Record usage after successful stream
        if final_usage and _caller:
            try:
                import llm_usage
                llm_usage.record(
                    user=_user or "system",
                    component=_caller,
                    provider_id=_provider_id or "",
                    model=model,
                    prompt_tokens=final_usage.get("prompt_tokens", 0),
                    completion_tokens=final_usage.get("completion_tokens", 0),
                )
            except Exception:
                pass
        _metric("llm_inc_request", _provider_id, model, "ok")
        _metric("llm_observe_latency", (time.monotonic() - t0) * 1000.0)
        return
    _metric("llm_inc_request", _provider_id, model, "retry_exhausted")
    raise LLMError(f"vllm 重试 {MAX_RETRIES} 次仍失败: {last_err}")


def stream_chat(messages, system="", max_tokens=16384, on_usage=None,
                caller=None, user=None):
    """Yield (kind, text) chunks where kind is "reasoning" or "content".

    Raises LLMError. If on_usage is given, it is called with the usage dict
    reported by the server (prompt_tokens/completion_tokens/total_tokens).

    caller: component name for usage tracking (e.g. "agent", "compact").
    user: username for usage tracking."""
    conf = load_conf()

    def _factory(prov, model):
        return _post_stream(
            messages, system, model, prov["base_url"], prov["api_key"],
            max_tokens, on_usage=on_usage,
            _caller=caller, _user=user, _provider_id=prov.get("provider_id"),
        )

    # Semaphore is held once for the whole (possibly multi-provider) attempt.
    with _LLM_SEM:
        yield from _stream_with_fallback(_factory, _attempts(conf))


def chat(messages, system="", max_tokens=16384, caller=None, user=None):
    """Non-streaming convenience: return full assistant text (content only)."""
    parts = []
    for kind, piece in stream_chat(messages, system, max_tokens, caller=caller, user=user):
        if kind == "content":
            parts.append(piece)
    return "".join(parts)


# ── Tool-use support ──────────────────────────────────────────

def stream_chat_with_tools(messages, system="", max_tokens=16384, tools=None,
                           caller=None, user=None):
    """Stream chat with native tool_use support.

    tools: list of tool definitions in OpenAI format:
      [{"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}]

    Yields (kind, data) chunks where kind is:
      - "reasoning": thinking content
      - "content": text content
      - "tool_calls": partial tool call data (accumulated per index)
      - "tool_call_done": complete tool call {"id", "name", "arguments"}

    The caller is responsible for executing tool calls and feeding results back.
    """
    conf = load_conf()

    def _factory(prov, model):
        return _post_stream_with_tools(
            messages, system, model, prov["base_url"], prov["api_key"],
            max_tokens, tools=tools,
            _caller=caller, _user=user, _provider_id=prov.get("provider_id"),
        )

    with _LLM_SEM:
        yield from _stream_with_fallback(_factory, _attempts(conf))


def _post_stream_with_tools(messages, system, model, base_url, api_key, max_tokens,
                             tools=None, on_usage=None, _caller=None, _user=None,
                             _provider_id=None):
    """Like _post_stream but handles tool_calls in the stream."""
    url = base_url.rstrip("/") + "/chat/completions"
    fixed_messages = []
    for m in messages:
        if m.get("role") == "assistant" and "reasoning_content" not in m:
            m = dict(m, reasoning_content=None)
        fixed_messages.append(m)
    payload = {
        "model": model,
        "messages": ([{"role": "system", "content": system}] if system else []) + fixed_messages,
        "stream": True,
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": True},
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    last_err = None
    final_usage = {}
    retried_429 = False

    for attempt in range(MAX_RETRIES):
        if attempt:
            _backoff(attempt - 1)
        t0 = time.monotonic()
        try:
            resp = requests.post(url, json=payload, headers=headers, stream=True, timeout=90)
        except requests.RequestException as e:
            last_err = f"连不上 vllm({url}): {e}"
            _metric("llm_inc_request", _provider_id, model, "error")
            continue
        # 429 = upstream per-model concurrency cap (see _post_stream): retry once
        # briefly then fall through to the next model instead of burning backoff.
        if resp.status_code == 429:
            last_err = f"vllm 返回 429: {resp.text[:200]}"
            _metric("llm_inc_request", _provider_id, model, "429")
            try:
                resp.close()
            except Exception:
                pass
            if retried_429:
                break
            retried_429 = True
            continue
        # Retry transient upstream failures: 5xx (server hiccup).
        if resp.status_code in (500, 502, 503, 504):
            last_err = f"vllm 返回 {resp.status_code}: {resp.text[:200]}"
            _metric("llm_inc_request", _provider_id, model, "5xx")
            try:
                resp.close()
            except Exception:
                pass
            continue
        if resp.status_code != 200:
            _metric("llm_inc_request", _provider_id, model, f"http{resp.status_code}")
            raise LLMError(f"vllm 返回 {resp.status_code}: {resp.text[:500]}")
        # Force UTF-8 (see note in _post_stream) — upstream may omit charset.
        resp.encoding = "utf-8"

        # Set per-chunk read timeout on underlying socket
        try:
            sock = resp.raw._fp.fp.raw._sock
            if sock is not None:
                sock.settimeout(60)
        except (AttributeError, OSError):
            pass

        # Accumulate tool calls across stream chunks
        # tool_call_accum[index] = {"id": "", "name": "", "arguments": ""}
        tool_call_accum = {}

        try:
            for raw in resp.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data:"):
                    continue
                data = raw[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                usage = obj.get("usage")
                if usage:
                    final_usage.update(usage)
                    if on_usage:
                        try:
                            on_usage(usage)
                        except Exception:
                            pass
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                # Reasoning
                r = delta.get("reasoning")
                if r:
                    yield ("reasoning", r)

                # Content
                piece = delta.get("content")
                if piece:
                    yield ("content", piece)

                # Tool calls
                tc_deltas = delta.get("tool_calls")
                if tc_deltas:
                    for tc in tc_deltas:
                        idx = tc.get("index", 0)
                        if idx not in tool_call_accum:
                            tool_call_accum[idx] = {"id": "", "name": "", "arguments": ""}
                        entry = tool_call_accum[idx]
                        if tc.get("id"):
                            entry["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            entry["name"] += fn["name"]
                        if fn.get("arguments"):
                            entry["arguments"] += fn["arguments"]

                # Check finish_reason for tool calls
                finish_reason = choices[0].get("finish_reason")
                if finish_reason == "tool_calls" and tool_call_accum:
                    for idx in sorted(tool_call_accum.keys()):
                        tc = tool_call_accum[idx]
                        # Try to parse arguments as JSON
                        try:
                            args = json.loads(tc["arguments"])
                        except (json.JSONDecodeError, TypeError):
                            args = tc["arguments"]
                        yield ("tool_call_done", {
                            "id": tc["id"],
                            "name": tc["name"],
                            "arguments": args,
                        })
                    tool_call_accum.clear()

        except (requests.RequestException, socket.timeout) as e:
            raise LLMError(f"vllm 流式中断或读取超时({url}): {e}")

        # Record usage
        if final_usage and _caller:
            try:
                import llm_usage
                llm_usage.record(
                    user=_user or "system",
                    component=_caller,
                    provider_id=_provider_id or "",
                    model=model,
                    prompt_tokens=final_usage.get("prompt_tokens", 0),
                    completion_tokens=final_usage.get("completion_tokens", 0),
                )
            except Exception:
                pass
        _metric("llm_inc_request", _provider_id, model, "ok")
        _metric("llm_observe_latency", (time.monotonic() - t0) * 1000.0)
        return
    _metric("llm_inc_request", _provider_id, model, "retry_exhausted")
    raise LLMError(f"vllm 重试 {MAX_RETRIES} 次仍失败: {last_err}")


def check_model_capabilities():
    """Check if the active model supports tools and vision.

    Returns {"supports_tools": bool, "supports_vision": bool, "model": str}
    """
    try:
        conf = load_conf()
        url = conf["base_url"].rstrip("/") + "/models"
        headers = {"Authorization": f"Bearer {conf['api_key']}"}
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code != 200:
            return {"supports_tools": False, "supports_vision": False, "model": conf["model"]}
        data = resp.json()
        for m in data.get("data", []):
            if m.get("id") == conf["model"]:
                caps = m.get("capabilities", {})
                return {
                    "supports_tools": m.get("supports_tools", False) or caps.get("chat", False),
                    "supports_vision": m.get("supports_vision", False) or caps.get("vision", False),
                    "model": conf["model"],
                    "context_length": m.get("context_length") or m.get("max_model_len", 0),
                }
    except Exception:
        pass
    return {"supports_tools": False, "supports_vision": False, "model": "unknown"}
