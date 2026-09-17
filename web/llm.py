"""OpenAI-compatible streaming client for the ssedgx vllm service.

Reads LLM provider config from llm_conf module (multi-provider, web-manageable).
Falls back to /opt/yatterra/llm.conf (root 600) if llm_conf is unavailable.

`stream_chat(messages, system)` posts to /chat/completions with stream=True
and yields incremental assistant text as it arrives. Non-streaming callers
can use `chat(...)`.

Resilience:
  - concurrency cap: at most LLM_MAX_CONCURRENCY (env, default 2) simultaneous
    LLM calls, so parallel harness nodes / sub-agents don't overload vllm and
    crash EngineCore. Callers block on the semaphore until a slot frees.
  - retry: connection errors and 5xx status are retried with backoff
    (LLM_MAX_RETRIES, default 4) before giving up. Mid-stream resets are not
    retried (would duplicate already-yielded text); they raise immediately.
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
    """Return {base_url, api_key, model, provider_id}. Raises LLMError if missing/invalid.

    Delegates to llm_conf.get_active() for the multi-provider system.
    Falls back to reading llm.conf directly if llm_conf is unavailable.
    api_key prefers env var LLM_API_KEY, fallback to provider config.
    """
    conf = {}
    try:
        import llm_conf
        provider = llm_conf.get_active()
        conf = {
            "base_url": provider["base_url"],
            "api_key": provider["api_key"],
            "model": provider["model"],
            "provider_id": provider.get("id", ""),
        }
    except Exception:
        # Fallback: read old llm.conf directly (backward compat)
        conf = _load_conf_legacy()
    # env override for api_key
    if os.environ.get("LLM_API_KEY"):
        conf["api_key"] = os.environ["LLM_API_KEY"]
    for need in ("base_url", "api_key", "model"):
        if not conf.get(need):
            raise LLMError(f"LLM 配置缺少 {need}")
    return conf


def _backoff(attempt):
    # 1s, 2s, 4s, 8s ...
    time.sleep(min(8, 2 ** attempt))


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
    for attempt in range(MAX_RETRIES):
        if attempt:
            _backoff(attempt - 1)
        try:
            resp = requests.post(url, json=payload, headers=headers, stream=True, timeout=90)
        except requests.RequestException as e:
            last_err = f"连不上 vllm({url}): {e}"
            continue
        if resp.status_code in (500, 502, 503, 504):
            last_err = f"vllm 返回 {resp.status_code}: {resp.text[:200]}"
            try:
                resp.close()
            except Exception:
                pass
            continue
        if resp.status_code != 200:
            raise LLMError(f"vllm 返回 {resp.status_code}: {resp.text[:500]}")
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
        return
    raise LLMError(f"vllm 重试 {MAX_RETRIES} 次仍失败: {last_err}")


def stream_chat(messages, system="", max_tokens=16384, on_usage=None,
                caller=None, user=None):
    """Yield (kind, text) chunks where kind is "reasoning" or "content".

    Raises LLMError. If on_usage is given, it is called with the usage dict
    reported by the server (prompt_tokens/completion_tokens/total_tokens).

    caller: component name for usage tracking (e.g. "agent", "compact").
    user: username for usage tracking."""
    conf = load_conf()
    with _LLM_SEM:
        yield from _post_stream(
            messages, system, conf["model"], conf["base_url"], conf["api_key"],
            max_tokens, on_usage=on_usage,
            _caller=caller, _user=user, _provider_id=conf.get("provider_id"),
        )


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
    with _LLM_SEM:
        yield from _post_stream_with_tools(
            messages, system, conf["model"], conf["base_url"], conf["api_key"],
            max_tokens, tools=tools,
            _caller=caller, _user=user, _provider_id=conf.get("provider_id"),
        )


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

    for attempt in range(MAX_RETRIES):
        if attempt:
            _backoff(attempt - 1)
        try:
            resp = requests.post(url, json=payload, headers=headers, stream=True, timeout=90)
        except requests.RequestException as e:
            last_err = f"连不上 vllm({url}): {e}"
            continue
        if resp.status_code in (500, 502, 503, 504):
            last_err = f"vllm 返回 {resp.status_code}: {resp.text[:200]}"
            try:
                resp.close()
            except Exception:
                pass
            continue
        if resp.status_code != 200:
            raise LLMError(f"vllm 返回 {resp.status_code}: {resp.text[:500]}")

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
        return
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
