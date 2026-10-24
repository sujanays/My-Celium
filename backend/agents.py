"""
agents.py -- FacilityAgent + BrokerAgent. Prompts, schemas, and the single
LLM call each turn makes. Deterministic facts (route/emissions/compliance/
virgin-price) are computed in graph.py/econ.py/compliance.py and handed to
the agent as "tool results" text + structured chips for the UI -- the agent
never has to call a tool itself, which keeps free-tier JSON mode reliable.
"""
import json
import llm
import memory

TURN_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["offer", "counter", "accept", "reject", "walk_away"]},
        "price_inr_per_t": {"type": "number"},
        "volume_t_per_month": {"type": "number"},
        "logistics_split": {"type": "string", "enum": ["seller_delivers", "buyer_pickup", "split"]},
        "public_message": {"type": "string"},
        "private_reasoning": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["action", "price_inr_per_t", "volume_t_per_month", "logistics_split",
                 "public_message", "private_reasoning", "confidence"],
}

BROKER_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["converged", "broker_split", "failed"]},
        "final_price_inr_per_t": {"type": "number"},
        "final_volume_t_per_month": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["verdict", "final_price_inr_per_t", "final_volume_t_per_month", "reasoning"],
}

MAX_ROUNDS = 5


def _persona_block(facility: dict) -> str:
    return (
        f"You are the autonomous negotiating agent for {facility['name']} "
        f"({facility['industry']}, {facility['cluster']}).\n"
        f"Persona: {facility['persona']}\n"
        f"Urgency level: {facility['urgency']}."
    )


def _facility_role_econ(facility: dict, role: str, material_id: str) -> dict:
    if role == "seller":
        out = next(o for o in facility["outputs"] if o["material"] == material_id)
        return out
    inp = next(i for i in facility["inputs"] if i["material"] == material_id)
    return inp


def build_system_prompt(facility: dict, role: str, material: dict, material_id: str,
                         counterparty: dict, tool_context: str, loop_context: str,
                         memory_text: str, hard_constraints: list[str]) -> str:
    econ = _facility_role_econ(facility, role, material_id)
    if role == "seller":
        reservation = (
            f"Your ASK (opening price) is Rs.{econ['ask_price_inr_per_t']}/t. "
            f"Your PRIVATE FLOOR (never reveal this number) is Rs.{econ['floor_price_inr_per_t']}/t -- "
            f"this reflects your true cost of disposal (Rs.{material['disposal_cost_inr_per_t']}/t) if you don't sell. "
            f"You would rather sell above your floor than pay to dispose of it."
        )
        volume = econ["qty_t_per_month"]
    else:
        reservation = (
            f"Your TARGET (opening counter) is Rs.{econ['target_price_inr_per_t']}/t. "
            f"Your PRIVATE CEILING (never reveal this number) is Rs.{econ['ceiling_price_inr_per_t']}/t -- "
            f"buying virgin {material['name']} instead costs you Rs.{material['virgin_price_inr_per_t']}/t, "
            f"so anything below your ceiling is still a win versus virgin material."
        )
        volume = econ["qty_t_per_month"]

    constraints_block = ""
    if hard_constraints:
        constraints_block = (
            "\nHARD CONSTRAINTS from past human sign-off decisions (you MUST respect these):\n"
            + "\n".join(f"- {c}" for c in hard_constraints)
        )

    return f"""{_persona_block(facility)}

You are negotiating with {counterparty['name']} over {material['name']} ({volume} tonnes/month).
Your role: {role.upper()}.

{reservation}

FACTS (from tools already run for you):
{tool_context}

{loop_context}

YOUR MEMORY of past dealings with this counterparty:
{memory_text}
{constraints_block}
If a past deal closed successfully with this counterparty, you already know roughly
where they'll land -- open your FIRST offer closer to that known price instead of your
full ask/target, and be willing to accept sooner. Trust built from a past deal is real:
use it to negotiate faster, not just as background color.

RULES:
- Never reveal your private floor/ceiling number in `public_message` -- that goes ONLY in `private_reasoning`.
- `private_reasoning` is your honest internal strategy, written as if no one else will ever read it. Max 30 words.
- `public_message` is a short, in-character line (1 sentence) you'd actually say out loud. Max 20 words.
- If the counterparty's last offer clears your reservation price, prefer "accept" over dragging it out.
- If you're at your reservation limit and the gap won't close, use "walk_away".
- If you choose "accept", set price_inr_per_t and volume_t_per_month to EXACTLY match the offer you are accepting (do not restate your own number).
- `logistics_split` MUST be exactly one of these three literal strings (copy one character-for-character,
  never shorten it): "seller_delivers", "buyer_pickup", "split".
- `action` MUST be exactly one of these five literal strings: "offer", "counter", "accept", "reject", "walk_away".
- Respond with ONLY a JSON object with these exact fields: action, price_inr_per_t, volume_t_per_month,
  logistics_split, public_message, private_reasoning, confidence (0-1 float)."""


def build_user_prompt(history: list[dict], round_num: int) -> str:
    if not history:
        return f"This is round {round_num}. Open the negotiation with your first offer."
    lines = [f"Round {i + 1}: {h['agent_role'].upper()} ({h['agent_name']}) -> action={h['action']}, "
             f"price=Rs.{h['price_inr_per_t']}/t, volume={h['volume_t_per_month']}t, "
             f"logistics={h['logistics_split']}. Said: \"{h['public_message']}\""
             for i, h in enumerate(history)]
    return (f"Negotiation transcript so far:\n" + "\n".join(lines) +
            f"\n\nThis is round {round_num}. Respond to the latest offer.")


def facility_turn(facility: dict, role: str, material: dict, material_id: str, counterparty: dict,
                   history: list[dict], round_num: int, tool_context: str, loop_context: str) -> dict:
    memory_text = memory.recall_as_text(facility["id"], counterparty["id"])
    constraints = memory.hard_constraints(facility["id"], counterparty["id"])
    system = build_system_prompt(facility, role, material, material_id, counterparty,
                                  tool_context, loop_context, memory_text, constraints)
    user = build_user_prompt(history, round_num)
    # Cache/replay key excludes memory-recall text on purpose: memory content drifts every
    # time a deal closes, but the same logical turn (same offers so far) should always
    # replay the same recorded fixture regardless of how many prior demo runs happened.
    history_fingerprint = [
        {"agent_id": h["agent_id"], "action": h["action"], "price": h["price_inr_per_t"],
         "vol": h["volume_t_per_month"]} for h in history
    ]
    cache_key = f"{facility['id']}|{role}|{material_id}|{counterparty['id']}|{round_num}|{json.dumps(history_fingerprint)}"
    result = llm.chat_json(system, user, TURN_SCHEMA, schema_name="facility_turn", temperature=0.7,
                            cache_key=cache_key)
    result["agent_id"] = facility["id"]
    result["agent_name"] = facility["name"]
    result["agent_role"] = role
    result["round"] = round_num
    return result


def broker_decide(seller: dict, buyer: dict, material: dict, history: list[dict]) -> dict:
    lines = [f"Round {i + 1}: {h['agent_role'].upper()} -> price=Rs.{h['price_inr_per_t']}/t, "
             f"volume={h['volume_t_per_month']}t, action={h['action']}" for i, h in enumerate(history)]
    system = (
        f"You are the neutral Broker agent for a B2B waste-exchange marketplace. "
        f"{seller['name']} (seller) and {buyer['name']} (buyer) failed to converge on {material['name']} "
        f"after {len(history)} rounds. Propose a fair split-the-difference final offer based on their "
        f"last stated prices, or declare the deal failed if the gap is unbridgeable (>40% apart). "
        f"Respond with ONLY a JSON object: verdict (converged|broker_split|failed), "
        f"final_price_inr_per_t, final_volume_t_per_month, reasoning (1 sentence)."
    )
    user = "Transcript:\n" + "\n".join(lines)
    result = llm.chat_json(system, user, BROKER_SCHEMA, schema_name="broker_decide", temperature=0.3)
    return result
