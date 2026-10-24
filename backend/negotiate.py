"""
negotiate.py -- the orchestrator. Hand-rolled state machine (no LangGraph):
explicit rounds, explicit stop conditions, trivially debuggable under time
pressure. Yields events as they happen so main.py can stream them over SSE.
"""
import time
import compliance as compliance_mod
from econ import road_distance_km, deal_economics
import agents
import llm


def _tool_context(seller: dict, buyer: dict, material: dict, material_id: str, distance_km: float,
                   tonnes: float, comp: dict, diesel_mult: float, landfill_tax: float) -> str:
    econ = deal_economics(material, distance_km, tonnes, material["virgin_price_inr_per_t"] * 0.6,
                           diesel_mult=diesel_mult, landfill_tax_inr_per_t=landfill_tax)
    return (
        f"[get_route_and_emissions] distance={distance_km:.0f}km, "
        f"transport_cost=Rs.{econ['transport_cost_inr']:.0f} for {tonnes}t, "
        f"transport_co2={econ['transport_co2_t']:.2f}t CO2e"
        + (f" (diesel index {diesel_mult:.2f}x normal)" if diesel_mult != 1.0 else "") + "\n"
        f"[get_virgin_price_index] virgin {material['name']} = Rs.{material['virgin_price_inr_per_t']}/t, "
        f"seller's disposal cost if unsold = Rs.{econ['effective_disposal_cost_inr_per_t']:.0f}/t"
        + (f" (includes a new Rs.{landfill_tax:.0f}/t landfill tax -- selling just got more attractive)" if landfill_tax else "")
        + "\n"
        f"[check_regulation] verdict={comp['verdict']}"
        + (f", violations={[v['detail'] for v in comp['violations']]}" if comp["violations"] else ", no issues found")
    )


def run_negotiation(world, seller_id: str, buyer_id: str, material_id: str,
                     loop_context: str = "", diesel_mult: float | None = None,
                     landfill_tax: float | None = None, loop_id: str | None = None):
    seller = world.facility(seller_id)
    buyer = world.facility(buyer_id)
    material = world.materials[material_id]
    diesel_mult = world.diesel_mult if diesel_mult is None else diesel_mult
    landfill_tax = world.landfill_tax_inr_per_t if landfill_tax is None else landfill_tax

    out = next(o for o in seller["outputs"] if o["material"] == material_id)
    inp = next(i for i in buyer["inputs"] if i["material"] == material_id)
    tonnes = min(out["qty_t_per_month"], inp["qty_t_per_month"])
    distance = road_distance_km(seller["lat"], seller["lon"], buyer["lat"], buyer["lon"],
                                 world.routes_cache, seller_id, buyer_id)
    comp = compliance_mod.check_pair(seller, buyer, material, material_id, distance, world.rules)

    yield {"event": "negotiation_start", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
           "material": material_id, "material_name": material["name"], "tonnes": tonnes,
           "distance_km": round(distance, 1), "compliance": comp}

    if comp["verdict"] == "REJECTED":
        yield {"event": "compliance_veto", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
               "material": material_id, "compliance": comp}
        yield {"event": "deal_failed", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
               "reason": "compliance_veto"}
        return

    tool_ctx = _tool_context(seller, buyer, material, material_id, distance, tonnes, comp, diesel_mult, landfill_tax)
    history: list[dict] = []
    final = None

    for round_num in range(1, agents.MAX_ROUNDS + 1):
        is_seller_turn = (round_num % 2 == 1)
        actor, role = (seller, "seller") if is_seller_turn else (buyer, "buyer")
        counterparty = buyer if is_seller_turn else seller

        yield {"event": "llm_call_start", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
               "agent_id": actor["id"], "agent_name": actor["name"], "role": role, "round": round_num}
        try:
            turn = agents.facility_turn(actor, role, material, material_id, counterparty,
                                         history, round_num, tool_ctx, loop_context)
        except Exception as e:
            yield {"event": "llm_error", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
                   "detail": str(e)}
            yield {"event": "deal_failed", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
                   "reason": "llm_error"}
            return
        history.append(turn)
        yield {"event": "agent_turn", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
               "material": material_id, **turn}

        if turn["action"] == "accept":
            final = {"price_inr_per_t": history[-2]["price_inr_per_t"] if len(history) > 1 else turn["price_inr_per_t"],
                     "volume_t_per_month": turn["volume_t_per_month"], "rounds": round_num, "outcome": "accepted"}
            break
        if turn["action"] in ("reject", "walk_away"):
            final = {"outcome": "walked_away", "rounds": round_num}
            break

    if final is None:
        yield {"event": "broker_invoked", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
               "agent_id": "broker", "agent_name": "Broker", "role": "broker"}
        try:
            broker = agents.broker_decide(seller, buyer, material, history)
        except Exception as e:
            yield {"event": "llm_error", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
                   "detail": str(e)}
            yield {"event": "deal_failed", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
                   "reason": "llm_error"}
            return
        yield {"event": "broker_decision", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id, **broker}
        if broker["verdict"] in ("converged", "broker_split"):
            final = {"price_inr_per_t": broker["final_price_inr_per_t"],
                     "volume_t_per_month": broker["final_volume_t_per_month"],
                     "rounds": agents.MAX_ROUNDS, "outcome": "broker_split"}
        else:
            final = {"outcome": "failed", "rounds": agents.MAX_ROUNDS}

    if final["outcome"] in ("accepted", "broker_split"):
        econ = deal_economics(material, distance, final["volume_t_per_month"], final["price_inr_per_t"],
                               diesel_mult=diesel_mult, landfill_tax_inr_per_t=landfill_tax)
        deal = {
            "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
            "seller_name": seller["name"], "buyer_name": buyer["name"],
            "material": material_id, "material_name": material["name"],
            "price_inr_per_t": final["price_inr_per_t"], "tonnes": final["volume_t_per_month"],
            "rounds": final["rounds"], "outcome": final["outcome"], **econ,
        }
        import memory
        memory.record(seller_id, buyer_id, buyer["name"], material_id, "deal_closed",
                      final["price_inr_per_t"], final["rounds"])
        memory.record(buyer_id, seller_id, seller["name"], material_id, "deal_closed",
                      final["price_inr_per_t"], final["rounds"])
        yield {"event": "deal_closed", **deal}
    else:
        yield {"event": "deal_failed", "loop_id": loop_id, "seller_id": seller_id, "buyer_id": buyer_id,
               "reason": "no_convergence"}


def run_loop(world, node_ids: list[str], edge_materials: list[str], loop_id: str):
    """Runs a closed loop (or cascade) as N sequential pairwise negotiations, then applies
    the PACKAGE VIABILITY GATE: every leg must independently close, or the whole ring collapses."""
    n = len(node_ids)
    loop_ctx = (f"IMPORTANT: This exchange is one leg of a {n}-party closed loop "
                f"({' -> '.join(node_ids)} -> back to start). If ANY leg of this loop fails, "
                f"ALL {n} deals collapse and everyone loses the other legs too. This gives you "
                f"real incentive to be flexible on price.")
    deals = []
    for i in range(n):
        if i > 0:
            # Deliberate pacing between legs: free-tier LLM providers cap tokens/minute, and
            # 3 legs back-to-back with zero gap is the single riskiest moment in the whole
            # demo for hitting that ceiling. A short pause here costs nothing narratively
            # (the UI already shows a "closed loop attempt" banner) and buys real headroom.
            yield {"event": "loop_pacing", "loop_id": loop_id, "next_leg": i}
            if llm.DEMO_MODE != "replay":
                time.sleep(3.0)
        seller_id, buyer_id = node_ids[i], node_ids[(i + 1) % n]
        material_id = edge_materials[i]
        leg_events = []
        for event in run_negotiation(world, seller_id, buyer_id, material_id,
                                      loop_context=loop_ctx, loop_id=loop_id):
            leg_events.append(event)
            yield event
        last = leg_events[-1]
        if last["event"] == "deal_closed":
            deals.append(last)
        else:
            yield {"event": "loop_collapsed", "loop_id": loop_id, "failed_leg": i,
                   "reason": "a leg failed to close -- the ring does not clear"}
            return
    total_saving = sum(d["total_saving_inr"] for d in deals)
    total_co2 = sum(d["co2_avoided_t"] for d in deals)
    yield {"event": "loop_closed", "loop_id": loop_id, "nodes": node_ids, "deals": deals,
           "total_saving_inr": round(total_saving, 0), "total_co2_avoided_t": round(total_co2, 2)}
