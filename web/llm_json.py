"""Shared helpers for getting *valid* JSON out of an LLM reply.

Historically three call sites each hand-rolled this: podwatch's fence-stripping
+ ``{...}`` substring retry (``podwatch._parse_json``), agent.py's lenient loads
(``_lenient_json_loads``), and llm.py's bare ``json.loads`` on tool arguments.
Centralising it here lets a caller also *validate* against a schema and re-ask
the model with the error, instead of silently trusting whatever came back.

Everything here is pure and dependency-light: if ``jsonschema`` is missing the
validation step degrades to a no-op rather than raising.
"""
import json

try:
    import jsonschema
except Exception:                                    # pragma: no cover
    jsonschema = None


def extract_json(text):
    """Best-effort pull one JSON value out of a model reply.

    Handles a ```` ```json ... ``` ```` fence and, failing a whole-string parse,
    the outermost ``{...}`` / ``[...]`` substring. Returns the parsed value, or
    None when nothing parseable is found.
    """
    if not isinstance(text, str):
        return None
    t = text.strip()
    if t.startswith("```"):
        # drop the opening fence line ("```" or "```json")
        t = t.split("\n", 1)[1] if "\n" in t else t
        t = t.rsplit("```", 1)[0]
    candidates = [t]
    for open_c, close_c in (("{", "}"), ("[", "]")):
        i, j = t.find(open_c), t.rfind(close_c)
        if i != -1 and j > i:
            candidates.append(t[i:j + 1])
    for cand in candidates:
        cand = cand.strip()
        if not cand:
            continue
        try:
            return json.loads(cand)
        except Exception:
            continue
    return None


def validate(data, schema):
    """Return a short error string if *data* violates *schema*, else "".

    A missing schema (or missing jsonschema) means "no constraint" → "".
    """
    if not schema or jsonschema is None:
        return ""
    try:
        jsonschema.validate(data, schema)
        return ""
    except Exception as e:
        # First line only — the full message is a multi-line traceback we do not
        # want to feed back into the prompt (or the log).
        return (str(e).split("\n", 1)[0] or "schema 校验失败")[:300]


def parse_json(text, schema=None):
    """Parse *text* as JSON, optionally validating it.

    Returns ``(data, err)``. On any failure ``data`` is None and ``err`` is a
    human/model-readable reason (``""`` on success).
    """
    data = extract_json(text)
    if data is None:
        return None, "不是合法的 JSON"
    err = validate(data, schema)
    if err:
        return None, err
    return data, ""


def parse_json_retry(call, messages, system="", schema=None, tries=2, **kw):
    """Call the model until it returns schema-valid JSON (bounded retries).

    ``call(messages, system=..., **kw)`` must return the raw model *text*
    (i.e. the signature of ``llm.chat``). On a parse/validation failure the
    reason is fed back and the model is asked once more, up to *tries*
    attempts. Returns ``(data, err)``; ``err`` is "" when a valid object was
    produced.
    """
    msgs = list(messages)
    err = ""
    last = ""
    for _ in range(max(1, int(tries))):
        if err:
            msgs = msgs + [
                {"role": "assistant", "content": last},
                {"role": "user", "content":
                 f"上面这段不是合法的 JSON（{err}）。请严格按要求只输出一个 JSON 对象，不要解释、不要代码块围栏。"},
            ]
        last = call(msgs, system=system, **kw) or ""
        data, err = parse_json(last, schema)
        if data is not None:
            return data, ""
    return None, err or "无法解析"
