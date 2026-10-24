"""world.py -- loads all data files once and holds mutable world state
(currently just the diesel multiplier the shock console mutates)."""
import json
import os

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def _load(name: str):
    with open(os.path.join(DATA_DIR, name), "r", encoding="utf-8") as f:
        return json.load(f)


class World:
    def __init__(self):
        self.facilities: list[dict] = _load("facilities.json")
        self.materials: dict = _load("materials.json")
        self.rules: dict = _load("rules.json")
        self.routes_cache: dict = _load("routes_cache.json")
        self.diesel_mult: float = 1.0
        self.landfill_tax_inr_per_t: float = 0.0
        self._by_id = {f["id"]: f for f in self.facilities}

    def facility(self, fid: str) -> dict | None:
        return self._by_id.get(fid)

    def reload(self):
        self.__init__()


world = World()
