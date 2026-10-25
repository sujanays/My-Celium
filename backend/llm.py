"""
llm.py -- the ONE entry point every agent call goes through. Handles:
  - .env loading (no extra dependency)
  - provider fail-over chain (Groq -> Gemini -> Ollama -> xAI Grok), all OpenAI-wire-compatible
  - strict JSON-schema output with one repair retry
  - a client-side rate limiter (free tiers throttle hard)
  - fixture recording (DEMO_MODE=live) / replay (DEMO_MODE=replay) for offline-proof demos
"""
import os
import json
import time
import hashlib
import threading
from pathlib import Path

import jsonschema
from openai import OpenAI, APIError, RateLimitError

BASE_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = BASE_DIR / "fixtures"
FIXTURES_DIR.mkdir(exist_ok=True)


def _load_env():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if k and v and k not in os.environ:
            os.environ[k] = v


_load_env()

DEMO_MODE = os.environ.get("DEMO_MODE", "live").lower()  # "live" | "replay"

PROVIDER_CHAIN = [
    {"name": "groq", "base_url": "https://api.groq.com/openai/v1",
     "api_key_env": "GROQ_API_KEY", "model": "openai/gpt-oss-120b"},
    {"name": "gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
     "api_key_env": "GEMINI_API_KEY", "model": "gemini-2.5-flash"},
    {"name": "ollama", "base_url": "http://localhost:11434/v1",
     "api_key_env": None, "model": "llama3.1:8b"},
    {"name": "xai", "base_url": "https://api.x.ai/v1",
     "api_key_env": "XAI_API_KEY", "model": "grok-4-fast"},
]

_last_call_ts: dict[str, float] = {}
_lock = threading.Lock()
_MIN_INTERVAL_S = 0.15  # spacing per provider to avoid free-tier 429s
_sem = threading.Semaphore(6)  # cap concurrent in-flight calls


def _hash_key(system: str, user: str, schema_name: str) -> str:
    h = hashlib.sha256(f"{schema_name}|{system}|{user}".encode("utf-8")).hexdigest()[:24]
    return h


def _hash_raw(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:24]


def _coerce_enums(data: dict, schema: dict) -> dict:
    """Free-tier models occasionally emit a plausible abbreviation of an enum value
    ("seller" instead of "seller_delivers") that fails strict validation but is an
    unambiguous match. Snap it to the real value BEFORE validating -- this is free
    (no extra API call) and fixes the single most common schema-validation failure
    mode observed in testing, without weakening validation for genuinely wrong output."""
    props = schema.get("properties", {})
    for field, spec in props.items():
        enum = spec.get("enum")
        if not enum or field not in data or not isinstance(data[field], str):
            continue
        val = data[field]
        if val in enum:
            continue
        val_l = val.lower()
        matches = [opt for opt in enum if opt.lower().startswith(val_l) or val_l.startswith(opt.lower())]
        if len(matches) == 1:
            data[field] = matches[0]
    return data


def _fixture_path(key: str) -> Path:
    return FIXTURES_DIR / f"{key}.json"


def _load_fixture(key: str):
    p = _fixture_path(key)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return None


def _save_fixture(key: str, result: dict):
    try:
        _fixture_path(key).write_text(json.dumps(result, indent=2), encoding="utf-8")
    except Exception:
        pass  # never let fixture recording break a live demo


def _client_for(provider: dict) -> OpenAI | None:
    if provider["api_key_env"]:
        api_key = os.environ.get(provider["api_key_env"], "").strip()
        if not api_key:
            return None
    else:
        api_key = "not-needed"
    # Short timeout + zero SDK-internal retries: a missing local Ollama server (or any dead
    # provider) must fail FAST so the chain moves on, not stall a live demo for 10+ seconds.
    timeout = 4.0 if provider["name"] == "ollama" else 20.0
    return OpenAI(base_url=provider["base_url"], api_key=api_key, timeout=timeout, max_retries=0)


def _throttle(provider_name: str):
    with _lock:
        last = _last_call_ts.get(provider_name, 0)
        wait = _MIN_INTERVAL_S - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        _last_call_ts[provider_name] = time.time()


def _call_provider(provider: dict, system: str, user: str, temperature: float) -> str:
    client = _client_for(provider)
    if client is None:
        raise RuntimeError(f"{provider['name']}: no API key set")
    _throttle(provider["name"])
    resp = client.chat.completions.create(
        model=provider["model"],
        temperature=temperature,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_object"},
    )
    return resp.choices[0].message.content


def chat_json(system: str, user: str, schema: dict, schema_name: str = "generic",
              temperature: float = 0.6, cache_key: str | None = None) -> dict:
    """The single entry point. Returns a dict validated against `schema`.
    Raises RuntimeError only if every provider AND every retry is exhausted.

    `cache_key`: pass a stable identifier (facility ids + round + history, NOT raw prompt
    text) when the prompt embeds volatile context (e.g. memory-recall text that changes
    as deals close) but you still want deterministic replay for the same logical turn.
    Without it, the fixture key is derived from the exact prompt text."""
    key = _hash_raw(f"{schema_name}|{cache_key}") if cache_key else _hash_key(system, user, schema_name)

    if DEMO_MODE == "replay":
        cached = _load_fixture(key)
        if cached is not None:
            cached = dict(cached)
            cached["_meta"] = {"provider": "fixture", "model": None, "elapsed_ms": 0, "cache_hit": True}
            return cached
        raise RuntimeError(f"REPLAY MODE: no fixture recorded for key {key} ({schema_name}). "
                           f"Run scripts/record_demo.py in live mode first.")

    last_err = None
    errors_by_provider: dict[str, str] = {}
    with _sem:
        for provider in PROVIDER_CHAIN:
            # Rate limits are transient and our fallback chain may have no other live
            # provider configured -- retry the SAME provider with backoff before giving up on it.
            # Groq's free-tier TPM limit is a ~5-6s sliding window (confirmed via
            # x-ratelimit-reset-tokens) -- one wait of that length clears it; short
            # exponential backoff under that just burns wall-clock without recovering.
            rate_limit_retries = 3
            raw = None
            t_call_start = time.time()
            for attempt in range(rate_limit_retries + 1):
                try:
                    raw = _call_provider(provider, system, user, temperature)
                    break
                except RateLimitError as e:
                    last_err = e
                    errors_by_provider[provider["name"]] = f"RateLimitError (attempt {attempt + 1}): {e}"
                    if attempt < rate_limit_retries:
                        time.sleep(6.0)
                    continue
                except Exception as e:
                    last_err = e
                    errors_by_provider[provider["name"]] = f"{type(e).__name__}: {e}"
                    raw = None
                    break
            if raw is None:
                continue
            try:
                data = json.loads(raw)
                data = _coerce_enums(data, schema)
                jsonschema.validate(data, schema)
                _save_fixture(key, data)
                data["_meta"] = {"provider": provider["name"], "model": provider["model"],
                                 "elapsed_ms": round((time.time() - t_call_start) * 1000), "cache_hit": False}
                return data
            except (json.JSONDecodeError, jsonschema.ValidationError) as e:
                errors_by_provider[provider["name"]] = f"{type(e).__name__} on first reply: {e}. Raw: {raw[:200]!r}"
                # one repair retry on the SAME provider before moving to the next
                try:
                    repair_user = (
                        f"{user}\n\n---\nYour previous reply failed validation: {e}\n"
                        f"Reply again with ONLY valid JSON matching the required schema."
                    )
                    raw2 = _call_provider(provider, system, repair_user, temperature)
                    data2 = json.loads(raw2)
                    data2 = _coerce_enums(data2, schema)
                    jsonschema.validate(data2, schema)
                    _save_fixture(key, data2)
                    data2["_meta"] = {"provider": provider["name"], "model": provider["model"],
                                      "elapsed_ms": round((time.time() - t_call_start) * 1000),
                                      "cache_hit": False, "repaired": True}
                    return data2
                except Exception as e2:
                    last_err = e2
                    errors_by_provider[provider["name"]] += f" | repair retry also failed: {type(e2).__name__}: {e2}"
                    continue
            except Exception as e:
                last_err = e
                errors_by_provider[provider["name"]] = f"{type(e).__name__} (post-call): {e}"
                continue

    # Total failure: fall back to a cached fixture from a prior run, if one exists
    cached = _load_fixture(key)
    if cached is not None:
        cached = dict(cached)
        cached["_meta"] = {"provider": "fixture-fallback", "model": None, "elapsed_ms": 0, "cache_hit": True}
        return cached
    detail = " || ".join(f"{name}: {err}" for name, err in errors_by_provider.items())
    raise RuntimeError(f"All providers failed for {schema_name}: {detail or last_err}")