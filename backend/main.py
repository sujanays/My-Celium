"""main.py -- FastAPI app. Phase 1: facilities + discover endpoints only."""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import os

from world import world
import graph as graph_mod

app = FastAPI(title="MYCELIUM")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web")


@app.get("/api/facilities")
def get_facilities():
    return world.facilities


@app.get("/api/materials")
def get_materials():
    return world.materials


@app.get("/api/discover")
def discover():
    return graph_mod.discover(world.facilities, world.materials, world.rules, world.routes_cache,
                               diesel_mult=world.diesel_mult, landfill_tax_inr_per_t=world.landfill_tax_inr_per_t)


@app.get("/api/world")
def get_world_state():
    return {"diesel_mult": world.diesel_mult, "landfill_tax_inr_per_t": world.landfill_tax_inr_per_t}


if os.path.isdir(WEB_DIR):
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    @app.get("/")
    def index():
        index_path = os.path.join(WEB_DIR, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return {"status": "MYCELIUM backend running. Frontend not built yet."}


# ---------------------------------------------------------------------------
# Phase 2: negotiation streaming
# ---------------------------------------------------------------------------
import json
import asyncio
from fastapi.responses import StreamingResponse
from fastapi import Query
import negotiate


def _sse_format(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


@app.get("/api/negotiate/pair")
def negotiate_pair_stream(seller_id: str = Query(...), buyer_id: str = Query(...),
                           material: str = Query(...), loop_id: str | None = Query(None)):
    def gen():
        for event in negotiate.run_negotiation(world, seller_id, buyer_id, material, loop_id=loop_id):
            yield _sse_format(event)
        yield _sse_format({"event": "stream_end"})
    return StreamingResponse(gen(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/negotiate/loop")
def negotiate_loop_stream(nodes: str = Query(..., description="comma-separated facility ids"),
                           materials: str = Query(..., description="comma-separated material ids, one per leg"),
                           loop_id: str = Query(...)):
    node_ids = nodes.split(",")
    edge_materials = materials.split(",")

    def gen():
        for event in negotiate.run_loop(world, node_ids, edge_materials, loop_id):
            yield _sse_format(event)
        yield _sse_format({"event": "stream_end"})
    return StreamingResponse(gen(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/shock")
def apply_shock(diesel_mult: float | None = None, landfill_tax_inr_per_t: float | None = None):
    if diesel_mult is not None:
        world.diesel_mult = diesel_mult
    if landfill_tax_inr_per_t is not None:
        world.landfill_tax_inr_per_t = landfill_tax_inr_per_t
    return {"diesel_mult": world.diesel_mult, "landfill_tax_inr_per_t": world.landfill_tax_inr_per_t}


@app.post("/api/shock/reset")
def reset_shock():
    world.diesel_mult = 1.0
    world.landfill_tax_inr_per_t = 0.0
    return {"diesel_mult": world.diesel_mult, "landfill_tax_inr_per_t": world.landfill_tax_inr_per_t}


@app.post("/api/signoff")
def human_signoff(facility_id: str, counterparty_id: str, counterparty_name: str, material: str,
                   approve: bool, note: str | None = None):
    import memory
    outcome = "human_approved" if approve else "human_rejected"
    memory.record(facility_id, counterparty_id, counterparty_name, material, outcome,
                  final_price=None, rounds=0, human_note=note)
    return {"status": "recorded", "outcome": outcome}
