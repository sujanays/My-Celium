"""
compliance.py -- rule checks are pure code (fast, deterministic, always correct).
An LLM call is used only afterward to phrase the human-readable citation nicely
(agents.py handles that). This module never calls an LLM.
"""


def check_pair(seller: dict, buyer: dict, material: dict, material_id: str, distance_km: float,
               rules: dict) -> dict:
    """Returns {'verdict': 'OK'|'WARNING'|'REJECTED', 'violations': [...]}"""
    violations = []

    fly_rule = rules.get("fly_ash_300km_radius")
    if fly_rule and material_id == fly_rule["material"] and distance_km > fly_rule["limit_km"]:
        violations.append({
            "rule": "fly_ash_300km_radius",
            "severity": fly_rule["verdict_on_violation"],
            "citation": fly_rule["citation"],
            "detail": f"Distance {distance_km:.0f} km exceeds the {fly_rule['limit_km']} km mandatory-use radius.",
        })

    haz_rule = rules.get("hazardous_waste_license_required")
    if haz_rule and material.get("hazard_class") == haz_rule["hazard_class"]:
        if not buyer.get(haz_rule["required_flag"], False):
            violations.append({
                "rule": "hazardous_waste_license_required",
                "severity": haz_rule["verdict_on_violation"],
                "citation": haz_rule["citation"],
                "detail": f"{buyer['name']} does not hold a hazardous-waste handling license required to receive {material['name']}.",
            })

    perish_rule = rules.get("perishable_storage_window")
    if perish_rule and material_id in perish_rule.get("applies_to_materials", []):
        violations.append({
            "rule": "perishable_storage_window",
            "severity": perish_rule["verdict_on_violation"],
            "citation": perish_rule["citation"],
            "detail": f"{material['name']} must move within {perish_rule['limit_days']} days of generation.",
        })

    verdict = "OK"
    for v in violations:
        if v["severity"] == "REJECTED":
            verdict = "REJECTED"
            break
        if v["severity"] == "WARNING" and verdict != "REJECTED":
            verdict = "WARNING"

    return {"verdict": verdict, "violations": violations}
