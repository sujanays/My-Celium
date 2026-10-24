"""memory.py -- one JSONL file per facility. Read by agents.py before a
negotiation starts, appended to after one closes. This is what lets the
SAME pair negotiate faster the second time, and lets a human rejection
become a hard constraint on the next attempt."""
import json
from pathlib import Path

MEMORY_DIR = Path(__file__).resolve().parent.parent / "memory"
MEMORY_DIR.mkdir(exist_ok=True)


def _path(facility_id: str) -> Path:
    return MEMORY_DIR / f"{facility_id}.jsonl"


def recall(facility_id: str, counterparty_id: str | None = None, limit: int = 5) -> list[dict]:
    p = _path(facility_id)
    if not p.exists():
        return []
    records = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    if counterparty_id:
        records = [r for r in records if r.get("counterparty_id") == counterparty_id]
    return records[-limit:]


def recall_as_text(facility_id: str, counterparty_id: str | None = None) -> str:
    records = recall(facility_id, counterparty_id)
    if not records:
        return "No prior history with this counterparty."
    lines = []
    for r in records:
        lines.append(
            f"- Deal with {r['counterparty_name']} on {r['material']}: "
            f"{r['outcome']} at Rs.{r.get('final_price', '?')}/t after {r.get('rounds', '?')} rounds"
            + (f" [HUMAN REJECTED: {r['human_note']}]" if r.get("human_note") else "")
        )
    return "\n".join(lines)


def record(facility_id: str, counterparty_id: str, counterparty_name: str, material: str,
           outcome: str, final_price: float | None, rounds: int, human_note: str | None = None):
    entry = {
        "counterparty_id": counterparty_id, "counterparty_name": counterparty_name,
        "material": material, "outcome": outcome, "final_price": final_price,
        "rounds": rounds, "human_note": human_note,
    }
    with open(_path(facility_id), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def hard_constraints(facility_id: str, counterparty_id: str) -> list[str]:
    """Past human rejections become non-negotiable constraints on future attempts."""
    records = recall(facility_id, counterparty_id, limit=20)
    return [r["human_note"] for r in records if r.get("outcome") == "human_rejected" and r.get("human_note")]
