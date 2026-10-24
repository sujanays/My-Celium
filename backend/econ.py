"""
econ.py -- The number engine. Every rupee and every kg of CO2 shown on screen
traces back to one of the four constants below. See ../assumptions.md.
"""
import math

ROAD_FREIGHT_INR_PER_T_KM = 6.5    # Indian long-haul truck tariff (approx, per tonne-km)
ROAD_CO2_KG_PER_T_KM = 0.062       # GLEC/IPCC road-freight emission factor (kg CO2e per tonne-km)
ROAD_FACTOR = 1.30                 # haversine -> road-distance multiplier (fallback only)
EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def road_distance_km(lat1: float, lon1: float, lat2: float, lon2: float, routes_cache: dict | None = None,
                      id1: str | None = None, id2: str | None = None) -> float:
    """Look up a precomputed road distance; fall back to haversine * ROAD_FACTOR."""
    if routes_cache and id1 and id2:
        key_a, key_b = f"{id1}|{id2}", f"{id2}|{id1}"
        if key_a in routes_cache:
            return routes_cache[key_a]["distance_km"]
        if key_b in routes_cache:
            return routes_cache[key_b]["distance_km"]
    return haversine_km(lat1, lon1, lat2, lon2) * ROAD_FACTOR


def transport_cost_inr(distance_km: float, tonnes: float, diesel_mult: float = 1.0) -> float:
    return distance_km * tonnes * ROAD_FREIGHT_INR_PER_T_KM * diesel_mult


def transport_co2_t(distance_km: float, tonnes: float) -> float:
    return distance_km * tonnes * ROAD_CO2_KG_PER_T_KM / 1000.0


def deal_economics(material: dict, distance_km: float, tonnes: float, deal_price_inr_per_t: float,
                    diesel_mult: float = 1.0, buyer_transport_share: float = 0.5,
                    landfill_tax_inr_per_t: float = 0.0) -> dict:
    """Compute the full ₹/CO2 picture for one matched pair at a given price & volume.

    buyer_transport_share: fraction of transport cost the buyer bears (0=seller delivers free,
    1=buyer pays all, 0.5=split). This is what `logistics_split` in the deal maps to.
    landfill_tax_inr_per_t: a shock-console lever -- a new per-tonne tax on the seller's
    counterfactual disposal route, on top of the material's baseline disposal cost. Raising
    it makes finding a buyer strictly more valuable to the seller than landfilling.
    """
    t_cost = transport_cost_inr(distance_km, tonnes, diesel_mult)
    t_co2 = transport_co2_t(distance_km, tonnes)
    buyer_t_cost = t_cost * buyer_transport_share
    seller_t_cost = t_cost * (1 - buyer_transport_share)

    virgin_price = material["virgin_price_inr_per_t"]
    virgin_co2 = material["virgin_co2_t_per_t"]
    disposal_cost = material["disposal_cost_inr_per_t"] + landfill_tax_inr_per_t

    buyer_saving_inr = (virgin_price - deal_price_inr_per_t) * tonnes - buyer_t_cost
    seller_saving_inr = (disposal_cost + deal_price_inr_per_t) * tonnes - seller_t_cost
    co2_avoided_t = virgin_co2 * tonnes - t_co2

    return {
        "distance_km": round(distance_km, 1),
        "tonnes": tonnes,
        "deal_price_inr_per_t": deal_price_inr_per_t,
        "transport_cost_inr": round(t_cost, 0),
        "transport_co2_t": round(t_co2, 3),
        "buyer_saving_inr": round(buyer_saving_inr, 0),
        "seller_saving_inr": round(seller_saving_inr, 0),
        "total_saving_inr": round(buyer_saving_inr + seller_saving_inr, 0),
        "co2_avoided_t": round(co2_avoided_t, 2),
        "diesel_mult": diesel_mult,
        "landfill_tax_inr_per_t": landfill_tax_inr_per_t,
        "effective_disposal_cost_inr_per_t": disposal_cost,
        "viable_for_buyer": buyer_saving_inr > 0,
        "viable_for_seller": seller_saving_inr > 0,
    }
