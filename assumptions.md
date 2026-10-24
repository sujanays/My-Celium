# MYCELIUM — Assumptions & Constants

Every number on screen traces to one of these. Built in a 10-hour hackathon window — precision is "defensible order-of-magnitude," not audited.

## Transport & emissions
- **Road freight:** ₹6.5/tonne-km (Indian long-haul truck tariff, indicative market rate)
- **Road freight CO2e:** 0.062 kg/tonne-km (GLEC Framework / IPCC road-freight factor)
- **Distance:** haversine × 1.30 (road-distance approximation). We deliberately did NOT call a live routing API at demo time — a hung request on stage is worse than an honest straight-line estimate. Documented, not hidden.
- **Shadow carbon price:** ₹1,500/tonne CO2e, used only to rank matches (India voluntary carbon market indicative range), never shown as a real credit/revenue line.

## Per-material economics (`data/materials.json`)
Each material carries: `virgin_price_inr_per_t` (cost of the virgin input displaced), `virgin_co2_t_per_t` (embodied CO2e of that virgin input, avoided), `disposal_cost_inr_per_t` (what the seller currently pays to landfill/treat it — their BATNA), `hazard_class`. Sources: publicly documented industrial-symbiosis literature (steel slag→GGBS, fly ash→cement/bricks, spent grain→feed, foundry sand→aggregate) cross-checked against typical Indian market price ranges; figures are representative, not facility-audited quotes.

## Deal formulas (`backend/econ.py`)
```
transport_cost   = distance_km × tonnes × 6.5 × diesel_mult
transport_co2    = distance_km × tonnes × 0.062 / 1000
buyer_saving     = (virgin_price − deal_price) × tonnes − buyer_transport_share
seller_saving    = (disposal_cost_avoided + deal_price) × tonnes − seller_transport_share
co2_avoided      = virgin_co2 × tonnes − transport_co2
```
Note: for energy-product sellers with `disposal_cost = 0` (e.g. a biogas plant), `seller_saving` reduces to net sale revenue — legitimate "value captured," not disposal-avoidance. We label this "value created" in the UI where the distinction matters.

## Regulatory rules (`data/rules.json`)
- **Fly ash 300 km rule:** MoEFCC Fly Ash Notification, 2009 (as amended 2016 & 2021) — mandatory utilisation within a 300 km radius of the generating thermal station for construction/ash-based products. Enforced as a hard `REJECTED` verdict.
- **Hazardous waste license:** Hazardous and Other Wastes (Management & Transboundary Movement) Rules, 2016 — a receiving facility must hold an authorised co-processing/TSDF license to accept hazardous process residue (e.g. textile dyeing sludge). Enforced as a hard `REJECTED` verdict.
- **Perishability window:** not a statutory rule — an internal modelling constraint (spent brewery grain, dairy manure/whey spoil within days), surfaced as a `WARNING`.

## Dataset
24 facilities across 6 real Indian industrial clusters (Peenya/Bengaluru, Hosur, Tiruppur, Jamshedpur, Bellary-Hospet, Mundra). Exchange pairs mirror documented real-world symbiosis practice (steel slag→cement is standard Tata/JSW practice; fly ash reuse is mandated by law; foundry sand→construction fill is common in the Peenya/Hosur belt). Prices, quantities and personas are synthesized for the demo, not sourced from real facility filings.

## Honesty note for Q&A
The closed 3-party loop (brewery → dairy/feed → biogas → brewery) is a genuine, real-world-documented symbiosis pattern — we seeded it deliberately rather than relying on random chance to produce one, because true industrial 3-cycles are rare in practice. That rarity is exactly why an automated closed-loop *discovery* engine has value: finding the one viable ring among hundreds of candidate pairs is a combinatorial search problem, which is what `graph.py`'s cycle detection solves.
