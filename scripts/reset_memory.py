"""reset_memory.py -- clears all facility memory files. Run this before recording
demo fixtures AND before a replay-mode demo run, so both start from the same
clean state (memory-recall text is excluded from the cache key, but resetting
keeps the on-screen "memory" narrative beat consistent too)."""
import sys
from pathlib import Path

MEMORY_DIR = Path(__file__).resolve().parent.parent / "memory"

def main():
    if not MEMORY_DIR.exists():
        print("No memory directory found -- nothing to reset.")
        return
    count = 0
    for f in MEMORY_DIR.glob("*.jsonl"):
        f.unlink()
        count += 1
    print(f"Cleared {count} facility memory file(s).")

if __name__ == "__main__":
    main()
