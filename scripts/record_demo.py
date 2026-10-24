"""
record_demo.py -- runs the demo's hero scenarios in LIVE mode once, so every
LLM call gets cached to fixtures/. After this, set DEMO_MODE=replay in .env
and the entire demo runs identically with the network cable pulled.

IMPORTANT: run this from a clean memory/ state (it resets memory itself,
both before and after) so DEMO_MODE=replay later starts from the same state
these fixtures were recorded against.
"""
import sys
import os
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
os.environ["DEMO_MODE"] = "live"  # this script must always hit the network to record

import reset_memory  # noqa: E402
from world import world  # noqa: E402
import negotiate  # noqa: E402


def run_and_report(label, gen):
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}")
    n_events = 0
    for ev in gen:
        n_events += 1
        t = ev["event"]
        if t == "agent_turn":
            print(f"  [{ev['round']}] {ev['agent_name']} ({ev['agent_role']}) -> "
                  f"{ev['action']} @ Rs.{ev['price_inr_per_t']}/t")
        elif t == "deal_closed":
            print(f"  >> CLOSED @ Rs.{ev['price_inr_per_t']}/t x {ev['tonnes']}t "
                  f"| saving Rs.{ev['total_saving_inr']}/mo | CO2 {ev['co2_avoided_t']}t")
        elif t == "loop_closed":
            print(f"  *** LOOP CLOSED *** saving Rs.{ev['total_saving_inr']}/mo | "
                  f"CO2 {ev['total_co2_avoided_t']}t")
        elif t in ("compliance_veto", "loop_collapsed", "llm_error", "broker_decision"):
            print(f"  [{t}] {ev}")
    print(f"  ({n_events} events)")


def main():
    reset_memory.main()

    # Scenario 1: the money cascade opener -- a clean pairwise deal.
    run_and_report(
        "SCENARIO 1: Steel Slag Pair (Jamshedpur)",
        negotiate.run_negotiation(world, "jsr_steel_works", "jsr_ggbs_cement", "steel_slag"),
    )

    # Scenario 2: the ghost match -- zero LLM calls, but exercise the path anyway.
    run_and_report(
        "SCENARIO 2: Ghost Match Veto (Bellary -> Hosur, fly ash, 368km)",
        negotiate.run_negotiation(world, "bellary_thermal_power", "hosur_aac_cement", "fly_ash"),
    )

    print("\n  (pausing 8s between scenarios to stay under free-tier tokens/minute limits...)")
    time.sleep(8)

    # Scenario 3: THE hero -- the closed loop.
    run_and_report(
        "SCENARIO 3: Closed Loop (Brewery -> Dairy -> Biogas -> Brewery)",
        negotiate.run_loop(
            world,
            ["bengaluru_craft_brewery", "namma_dairy_feed", "greencycle_biogas"],
            ["spent_brewery_grain", "dairy_manure_whey", "biogas"],
            "recorded_loop_1",
        ),
    )

    print("\n  (pausing 8s between scenarios to stay under free-tier tokens/minute limits...)")
    time.sleep(8)

    # Scenario 4: the cascade -- Jamshedpur steel -> cement -> road construction.
    run_and_report(
        "SCENARIO 4: Cascade (Steel -> GGBS Cement -> Road Construction)",
        negotiate.run_negotiation(world, "jsr_ggbs_cement", "jsr_road_construction", "cement_kiln_dust"),
    )

    reset_memory.main()
    print("\nAll fixtures recorded. Set DEMO_MODE=replay in .env for offline playback.")
    print("Memory has been reset again to match the state fixtures were recorded against.")


if __name__ == "__main__":
    main()
