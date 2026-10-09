"""LLM provider configuration manager.

Manages multiple LLM upstream providers stored in /opt/yatterra/llm_providers.json.
Auto-migrates from the legacy /opt/yatterra/llm.conf on first use.

Provider schema:
  id        — unique hex ID (auto-generated)
  name      — display name (e.g. "ModelArts GLM-5.1")
  type      — provider kind: openai | anthropic | ollama | vllm
  base_url  — OpenAI-compatible API base URL
  api_key   — API key
  model     — default model name
  enabled   — bool, whether this provider can be selected
  is_default — bool, cosmetic flag for the active provider
  created   — ISO timestamp

State file: /opt/yatterra/llm_providers.json (root 600, atomic write).
"""
import json
import os
import secrets
import threading

import siteconf

STATE_FILE = siteconf.path("llm_providers.json")
LEGACY_CONF = siteconf.path("llm.conf")

_lock = threading.Lock()


def _now():
    from datetime import datetime
    return datetime.utcnow().isoformat()


def _atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _normalize_models(spec):
    """Return a clean, ordered, de-duplicated model list from a provider spec.

    Prefers ``spec["models"]`` (ordered list == fallback priority); falls back
    to a single ``spec["model"]``. Non-string / blank entries are dropped and
    duplicates removed keeping first occurrence, so ``models[]`` and ``model``
    can never contradict each other.
    """
    out = []
    seen = set()
    raw = spec.get("models")
    if isinstance(raw, (list, tuple)):
        for m in raw:
            if not isinstance(m, str):
                continue
            m = m.strip()
            if m and m not in seen:
                seen.add(m)
                out.append(m)
    if not out:
        m = spec.get("model")
        if isinstance(m, str) and m.strip():
            out = [m.strip()]
    return out


def _read_legacy_conf():
    """Read the old key=value llm.conf. Returns dict or empty."""
    conf = {}
    try:
        with open(LEGACY_CONF) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                conf[k.strip()] = v.strip()
    except OSError:
        pass
    return conf


def _migrate_from_conf():
    """One-time migration: read llm.conf → create single provider entry."""
    conf = _read_legacy_conf()
    if not conf.get("base_url") or not conf.get("api_key") or not conf.get("model"):
        return  # nothing to migrate
    state = {
        "providers": [{
            "id": "migrated-default",
            "name": "Migrated (llm.conf)",
            "base_url": conf["base_url"],
            "api_key": conf["api_key"],
            "model": conf["model"],
            "models": [conf["model"]],
            "enabled": True,
            "is_default": True,
            "created": _now(),
        }],
        "active_id": "migrated-default",
        "_migrated_from_conf": True,
    }
    _atomic_write(STATE_FILE, state)
    try:
        import audit
        audit.record("llm_conf_migrated", detail="migrated from llm.conf", actor="system")
    except Exception:
        pass


def load():
    """Load provider state from JSON. Auto-migrate from llm.conf on first call.

    Providers are normalised *in memory only* (never written back here, to avoid
    rewriting the root-600 state file on every read). This is also the migration
    for legacy single-model records: ``{model: "x"}`` becomes ``models: ["x"]``.
    """
    with _lock:
        if not os.path.exists(STATE_FILE):
            _migrate_from_conf()
        if not os.path.exists(STATE_FILE):
            return {"providers": [], "active_id": None}
        try:
            with open(STATE_FILE) as f:
                state = json.load(f)
        except (json.JSONDecodeError, OSError):
            return {"providers": [], "active_id": None}
    for p in state.get("providers", []):
        models = _normalize_models(p)
        p["models"] = models
        if models:
            p["model"] = models[0]
    return state


def save(state):
    """Atomic save to JSON."""
    with _lock:
        _atomic_write(STATE_FILE, state)


def list_providers():
    """Return all providers."""
    return load().get("providers", [])


def get_provider(provider_id):
    """Get one provider by ID. Returns dict or None."""
    for p in load().get("providers", []):
        if p["id"] == provider_id:
            return p
    return None


def add_provider(spec):
    """Add a new provider. Returns the new provider dict."""
    state = load()
    providers = state.setdefault("providers", [])
    pid = spec.get("id") or secrets.token_hex(8)
    models = _normalize_models(spec)
    provider = {
        "id": pid,
        "name": spec.get("name", ""),
        "type": spec.get("type", "openai"),
        "base_url": spec.get("base_url", ""),
        "api_key": spec.get("api_key", ""),
        # models is the ordered fallback list; model mirrors models[0] so legacy
        # readers that only know `model` keep working.
        "models": models,
        "model": models[0] if models else spec.get("model", ""),
        "max_context": spec.get("max_context", None),
        "enabled": spec.get("enabled", True),
        "is_default": spec.get("is_default", False),
        "created": _now(),
    }
    providers.append(provider)
    # If first provider or marked default, set as active
    if not state.get("active_id") or provider["is_default"]:
        state["active_id"] = pid
        # Clear other defaults
        for p in providers:
            p["is_default"] = (p["id"] == pid)
    save(state)
    return provider


def update_provider(provider_id, updates):
    """Update a provider's fields. Returns updated dict or None."""
    state = load()
    for p in state.get("providers", []):
        if p["id"] == provider_id:
            for k in ("name", "type", "base_url", "api_key", "model", "models", "max_context", "enabled", "is_default"):
                if k in updates:
                    p[k] = updates[k]
            # Re-normalise so models[] and model never contradict each other.
            # An explicit `models` wins; a bare legacy `model` becomes [model].
            if "models" in updates or "model" in updates:
                models = _normalize_models(
                    {"models": updates.get("models"), "model": updates.get("model")})
                p["models"] = models
                p["model"] = models[0] if models else ""
            if updates.get("is_default"):
                state["active_id"] = provider_id
                for q in state["providers"]:
                    q["is_default"] = (q["id"] == provider_id)
            save(state)
            return p
    return None


def delete_provider(provider_id):
    """Delete a provider. Returns True if deleted."""
    state = load()
    providers = state.get("providers", [])
    new_providers = [p for p in providers if p["id"] != provider_id]
    if len(new_providers) == len(providers):
        return False
    state["providers"] = new_providers
    if state.get("active_id") == provider_id:
        # Switch to first enabled provider
        state["active_id"] = None
        for p in new_providers:
            if p.get("enabled"):
                state["active_id"] = p["id"]
                p["is_default"] = True
                break
    save(state)
    return True


def set_default(provider_id):
    """Set a provider as the active default. Returns provider dict or None."""
    state = load()
    found = None
    for p in state.get("providers", []):
        if p["id"] == provider_id and p.get("enabled"):
            found = p
            p["is_default"] = True
        else:
            p["is_default"] = False
    if found:
        state["active_id"] = provider_id
        save(state)
        return found
    return None


def _active_view(p):
    """Shape a provider record for get_active() consumers.

    `models` is the ordered fallback list; `model` mirrors models[0] (== "" when
    there are no models) so legacy single-model callers are unaffected.
    """
    models = p.get("models") or ([p["model"]] if p.get("model") else [])
    return {
        "base_url": p["base_url"],
        "api_key": p["api_key"],
        "model": models[0] if models else "",
        "models": models,
        "id": p["id"],
        "name": p.get("name", ""),
    }


def get_chain():
    """Return every enabled provider as an ordered fallback chain.

    The active provider (``active_id``) comes first — it is the preferred
    upstream — followed by the remaining enabled providers in their stored
    order. ``llm.load_conf`` walks this list provider-by-provider, so a whole
    provider going down falls through to the next one. Each element has the
    same shape as ``get_active()`` ({base_url, api_key, model, models, id}).

    Raises an Exception if no enabled provider exists.
    """
    state = load()
    active_id = state.get("active_id")
    providers = [p for p in state.get("providers", []) if p.get("enabled")]
    if not providers:
        raise Exception("LLM: 没有可用的 provider（请到 开发→LLM 配置添加）")
    # Stable sort: the active provider first, everyone else keeps stored order.
    providers.sort(key=lambda p: 0 if p["id"] == active_id else 1)
    return [_active_view(p) for p in providers]


def get_active():
    """Return the preferred (first) provider in the fallback chain.

    Kept for callers that only want a single provider; new code should use
    ``get_chain()`` so provider-level fallback is available."""
    return get_chain()[0]
