"""conversations.py -- per-chat Telegram transcripts (data/conversations/<chat_id>.json),
shared by the ingest bot (writes every in/out message) and the dashboard API (reads + sends quotes)."""
import json
from datetime import datetime, timezone
from pathlib import Path

CONVERSATIONS_DIR = Path(__file__).resolve().parent.parent / "data" / "conversations"


def _path(chat_id) -> Path:
    return CONVERSATIONS_DIR / f"{chat_id}.json"


def load(chat_id) -> list:
    p = _path(chat_id)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def append(chat_id, sender: str, text: str, kind: str = "text", extra: dict | None = None) -> dict:
    """sender: 'user' | 'bot' | 'dashboard'."""
    if chat_id is None or not text:
        return {}
    CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "from": sender, "kind": kind, "text": text}
    if extra:
        entry.update(extra)
    log = load(chat_id)
    log.append(entry)
    _path(chat_id).write_text(json.dumps(log, indent=2, ensure_ascii=False), encoding="utf-8")
    return entry
