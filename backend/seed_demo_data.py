"""
Demo data seeder for Play Store reviewers and demo accounts.

GUARDED: Only callable by accounts in REVIEWER_EMAILS or
STRIPE_ADMIN_USER_IDS. Anyone else gets 403.

What it does (idempotent — safe to call repeatedly):
  1. Wipes the caller's stops, route_history, and ML models
  2. Inserts 25 realistic delivery stops around Maroochydore /
     Caloundra (Sunshine Coast, Australia)
  3. Inserts 1 archived route showing all 25 already delivered, with
     realistic completion timestamps + small driveway offsets so the
     ML pipeline has something to learn from
  4. Triggers training of both ML models (service-time + building-side)

After one call, the reviewer sees:
  - 25 stops on the map (pre-optimized order)
  - Telemetry tile: 25 stops, 92% geofence rate, ML-ready
  - Both ML cards: trained, with offset/duration metrics

Hardcoded coordinates so we don't burn Mapbox geocoding quota.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import List

# 25 stops around Maroochydore / Caloundra. Mix of suburbs so the
# building-side corrector has multi-suburb data, and a couple of
# duplicate suburbs so each suburb has ≥3 samples for the corrector
# to publish a per-suburb bucket.
DEMO_STOPS: List[dict] = [
    # Maroochydore (8 stops — primary suburb)
    {"address": "1 Plaza Pde, Maroochydore QLD 4558",   "name": "Sunshine Plaza", "lat": -26.6531, "lng": 153.0907, "suburb": "maroochydore", "service_seconds": 90},
    {"address": "12 First Ave, Maroochydore QLD 4558",  "name": "First Ave Office", "lat": -26.6595, "lng": 153.0931, "suburb": "maroochydore", "service_seconds": 60},
    {"address": "55 Aerodrome Rd, Maroochydore QLD 4558","name": "Aerodrome Apts", "lat": -26.6636, "lng": 153.0956, "suburb": "maroochydore", "service_seconds": 180},
    {"address": "8 Duporth Ave, Maroochydore QLD 4558", "name": "Duporth House", "lat": -26.6562, "lng": 153.0942, "suburb": "maroochydore", "service_seconds": 50},
    {"address": "100 Maroochydore Rd, Maroochydore QLD 4558","name": "Cnr Service Centre", "lat": -26.6601, "lng": 153.0824, "suburb": "maroochydore", "service_seconds": 75},
    {"address": "3 Memorial Ave, Maroochydore QLD 4558","name": "Memorial Lane", "lat": -26.6572, "lng": 153.0951, "suburb": "maroochydore", "service_seconds": 40},
    {"address": "27 Sixth Ave, Maroochydore QLD 4558",  "name": "Sixth Ave House", "lat": -26.6612, "lng": 153.0915, "suburb": "maroochydore", "service_seconds": 45},
    {"address": "9 Beach Rd, Maroochydore QLD 4558",    "name": "Beach Rd Cafe", "lat": -26.6669, "lng": 153.0985, "suburb": "maroochydore", "service_seconds": 60},

    # Buderim (5 stops — hill area, longer service times typical)
    {"address": "1 Burnett St, Buderim QLD 4556",       "name": "Buderim Village", "lat": -26.6822, "lng": 153.0540, "suburb": "buderim", "service_seconds": 120},
    {"address": "55 King St, Buderim QLD 4556",         "name": "King St Office Park", "lat": -26.6841, "lng": 153.0567, "suburb": "buderim", "service_seconds": 150},
    {"address": "12 Lindsay Rd, Buderim QLD 4556",      "name": "Lindsay Rd House", "lat": -26.6867, "lng": 153.0602, "suburb": "buderim", "service_seconds": 65},
    {"address": "30 Main St, Buderim QLD 4556",         "name": "Main St Pharmacy", "lat": -26.6815, "lng": 153.0552, "suburb": "buderim", "service_seconds": 75},
    {"address": "8 Mons Rd, Buderim QLD 4556",          "name": "Mons Rd Apts", "lat": -26.6889, "lng": 153.0624, "suburb": "buderim", "service_seconds": 200},

    # Mooloolaba (4 stops — beachfront, tight stops)
    {"address": "13 Mooloolaba Esplanade, Mooloolaba QLD 4557","name": "Esplanade Tower", "lat": -26.6824, "lng": 153.1212, "suburb": "mooloolaba", "service_seconds": 110},
    {"address": "57 First Ave, Mooloolaba QLD 4557",    "name": "First Ave Mooloolaba", "lat": -26.6797, "lng": 153.1183, "suburb": "mooloolaba", "service_seconds": 70},
    {"address": "2 Brisbane Rd, Mooloolaba QLD 4557",   "name": "Brisbane Rd Cnr", "lat": -26.6788, "lng": 153.1147, "suburb": "mooloolaba", "service_seconds": 80},
    {"address": "44 Walan St, Mooloolaba QLD 4557",     "name": "Walan St House", "lat": -26.6775, "lng": 153.1175, "suburb": "mooloolaba", "service_seconds": 55},

    # Caloundra (4 stops)
    {"address": "5 Bulcock St, Caloundra QLD 4551",     "name": "Bulcock St Plaza", "lat": -26.7997, "lng": 153.1320, "suburb": "caloundra", "service_seconds": 95},
    {"address": "20 Knox Ave, Caloundra QLD 4551",      "name": "Knox Ave Apts", "lat": -26.8015, "lng": 153.1346, "suburb": "caloundra", "service_seconds": 130},
    {"address": "33 Queen St, Caloundra QLD 4551",      "name": "Queen St Pharmacy", "lat": -26.8024, "lng": 153.1305, "suburb": "caloundra", "service_seconds": 65},
    {"address": "8 Maltman St, Caloundra QLD 4551",     "name": "Maltman St House", "lat": -26.7986, "lng": 153.1287, "suburb": "caloundra", "service_seconds": 50},

    # Kawana (4 stops)
    {"address": "1 Sportsmans Pde, Kawana QLD 4575",    "name": "Kawana Sports Centre", "lat": -26.7350, "lng": 153.1245, "suburb": "kawana", "service_seconds": 100},
    {"address": "12 Nicklin Way, Kawana QLD 4575",      "name": "Nicklin Way Office", "lat": -26.7420, "lng": 153.1285, "suburb": "kawana", "service_seconds": 85},
    {"address": "5 Point Cartwright Dr, Kawana QLD 4575","name": "Cartwright Tower", "lat": -26.6961, "lng": 153.1370, "suburb": "kawana", "service_seconds": 175},
    {"address": "30 Birtinya Bvd, Kawana QLD 4575",     "name": "Birtinya Hub", "lat": -26.7503, "lng": 153.1280, "suburb": "kawana", "service_seconds": 70},
]


def is_seeder_authorized(current_user, reviewer_emails: set, admin_user_ids: set) -> bool:
    """Only allow admins / reviewers to seed demo data."""
    if current_user.user_id in admin_user_ids:
        return True
    if (getattr(current_user, "email", None) or "").lower() in reviewer_emails:
        return True
    return False


def build_stop_docs(user_id: str, when: datetime) -> List[dict]:
    """Build the 25 unarchived stop docs (the ones the reviewer sees on
    the map). Returned in optimization-ready order — already roughly
    suburb-clustered for a believable polyline."""
    docs = []
    for i, stop in enumerate(DEMO_STOPS):
        docs.append({
            "id": f"demo-stop-{i+1:02d}",
            "user_id": user_id,
            "address": stop["address"],
            "name": stop["name"],
            "latitude": stop["lat"],
            "longitude": stop["lng"],
            "suburb": stop["suburb"],
            "order": i,
            "original_sequence": i + 1,
            "completed": False,
            "created_at": when,
            "geocode_metadata": {
                "geocoder": "demo-seed",
                "confidence": "rooftop",
            },
        })
    return docs


def build_archived_route(user_id: str, when: datetime) -> dict:
    """Build a single archived route showing all 25 stops as completed
    with realistic geofence telemetry. Drives the Telemetry tile and
    feeds the ML training pool."""
    rng = random.Random(42)
    archived_stops = []
    arrived_at = when - timedelta(hours=8)
    for i, stop in enumerate(DEMO_STOPS):
        # Realistic completion: 23 of 25 hit the geofence (92% rate),
        # 2 are geofence_inferred from being close-but-not-quite.
        method = "geofence" if i not in (5, 18) else "geofence_inferred"
        completion_distance_m = (
            rng.uniform(8.0, 80.0) if method == "geofence" else rng.uniform(110.0, 145.0)
        )
        # Driveway offset (per-suburb consistent so the corrector learns)
        suburb_offsets = {
            "maroochydore": (0.0001, 0.00012),  # ~13m NE
            "buderim":      (-0.00015, 0.00008),  # ~17m SW
            "mooloolaba":   (0.00018, 0.0),     # ~20m N
            "caloundra":    (0.00022, -0.00015),# ~28m NW
            "kawana":       (0.0001, 0.0001),   # ~14m NE
        }
        d_lat, d_lng = suburb_offsets.get(stop["suburb"], (0.0, 0.0))
        completion_lat = stop["lat"] + d_lat + rng.uniform(-0.00002, 0.00002)
        completion_lng = stop["lng"] + d_lng + rng.uniform(-0.00002, 0.00002)

        # Service time = the model's intended time + small jitter (so
        # the ML learner sees a tight distribution per suburb).
        svc = stop["service_seconds"] + rng.randint(-15, 25)
        completed_at = arrived_at + timedelta(seconds=svc)

        archived_stops.append({
            "id": f"demo-archived-{i+1:02d}",
            "address": stop["address"],
            "name": stop["name"],
            "latitude": stop["lat"],
            "longitude": stop["lng"],
            "suburb": stop["suburb"],
            "order": i,
            "completed": True,
            "arrival_method": method,
            "completion_distance_m": round(completion_distance_m, 1),
            "completion_lat": completion_lat,
            "completion_lng": completion_lng,
            "view_mode_at_completion": "navigating",
            "arrived_at": arrived_at.isoformat(),
            "completed_at": completed_at.isoformat(),
        })
        # Drive 4-7 minutes to the next stop
        arrived_at = completed_at + timedelta(seconds=rng.randint(180, 420))

    return {
        "id": f"demo-route-{when.strftime('%Y%m%d')}",
        "user_id": user_id,
        "archived_at": when,
        "stops": archived_stops,
        "summary": {
            "stop_count": len(archived_stops),
            "total_distance_km": 73.4,
            "total_duration_minutes": 412,
            "geofence_rate": 0.92,
        },
    }
