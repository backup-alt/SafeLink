"""Weather poller + store for interrupt flags + fusion with chl/waves/ships."""
from __future__ import annotations

import json
import time
import math
from datetime import datetime, timezone, timedelta
from threading import Lock

# In-memory store for hazards
_store_lock = Lock()
_hazards: list[dict] = []
_last_fetch = 0
_cache_ttl = 120  # 2 min

# Mock cyclone & lightning for demo (when OWM key absent, we serve this)
MOCK_HAZARDS = [
    {
        "id": "cyclone_bob_2026",
        "type": "cyclone",
        "severity": "danger",
        "name": "Cyclone Bob (Mock) - Bay of Bengal",
        "polygon": [[[83.0, 13.0], [84.5, 13.0], [84.5, 15.0], [83.0, 15.0], [83.0, 13.0]]],
        "center": [83.7, 14.0],
        "radius_km": 150,
        "source": "IMD Mock / NASA LANCE planned",
        "updated_at": "2026-09-04T00:00:00Z",
    },
    {
        "id": "lightning_cluster_arabia",
        "type": "lightning",
        "severity": "warning",
        "name": "High Lightning Density - Arabian Sea",
        "polygon": [[[65.0, 12.0], [67.0, 12.0], [67.0, 14.0], [65.0, 14.0], [65.0, 12.0]]],
        "center": [66.0, 13.0],
        "strikes_per_15min": 45,
        "source": "Blitzortung Mock / OpenWeather OneCall planned",
        "updated_at": "2026-09-04T00:00:00Z",
    },
]

def _fetch_open_meteo_hazards():
    """Try to fetch real wave-based hazards silently; fallback to mocks."""
    # For hackathon, we return mocks + dynamic wave hazard if available
    return MOCK_HAZARDS

def get_hazards() -> dict:
    global _hazards, _last_fetch
    with _store_lock:
        if time.time() - _last_fetch < _cache_ttl and _hazards:
            return {"hazards": _hazards, "cached": True, "fetched_at": datetime.now(timezone.utc).isoformat()}
        fetched = _fetch_open_meteo_hazards()
        _hazards = fetched
        _last_fetch = time.time()
        return {"hazards": _hazards, "cached": False, "fetched_at": datetime.now(timezone.utc).isoformat()}

def get_geojson() -> dict:
    data = get_hazards()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": h["id"],
                "geometry": {"type": "Polygon", "coordinates": h["polygon"]},
                "properties": {k: v for k, v in h.items() if k not in ("polygon",)},
            }
            for h in data["hazards"]
        ],
        "metadata": {
            "fetched_at": data["fetched_at"],
            "count": len(data["hazards"]),
            "source": "Mock + Open-Meteo Marine (poll every 2min, WS planned)",
        },
    }

def fused_guardrail_check(latitude: float, longitude: float, repository=None) -> dict:
    """Fuse geofence + wave + chl<48h + ship density."""
    from .geofence_service import check_point
    geofence = check_point(longitude, latitude)
    hazards = get_hazards()["hazards"]
    # Check inside any weather polygon
    inside_weather = []
    from shapely.geometry import Point, Polygon
    pt = Point(longitude, latitude)
    for h in hazards:
        poly = Polygon(h["polygon"][0])
        if poly.contains(pt):
            inside_weather.append(h["id"])
    # Sample chlorophyll & waves if repository available
    wave_val = None
    wave_unit = "m"
    chl_val = None
    chl_age_hours = None
    try:
        if repository:
            try:
                w = repository.point("waves", latitude, longitude)
                wave_val = w.get("value")
                wave_unit = w.get("unit", "m")
            except Exception:
                pass
            try:
                c = repository.point("chlorophyll", latitude, longitude)
                chl_val = c.get("value")
                # try catalog for age
                chl_age_hours = c.get("age_hours")
                # fallback: use layer observation_age_hours via repository.catalog
                cat = repository.catalog()
                chl_layer = next((l for l in cat.get("layers",[]) if l["id"]=="chlorophyll"), None)
                if chl_layer:
                    chl_age_hours = chl_layer.get("observation_age_hours")
            except Exception:
                pass
    except Exception:
        pass
    # Ship density via ais_service
    ship_count = 0
    try:
        from backend import ais_service
        vessels = ais_service.get_vessels(longitude-0.5, latitude-0.5, longitude+0.5, latitude+0.5)
        from shapely.geometry import LineString
        # count within 0.5 deg
        ship_count = len([v for v in vessels if abs(v["longitude"]-longitude)<0.5 and abs(v["latitude"]-latitude)<0.5])
    except Exception:
        ship_count = 0

    alerts = []
    level = "safe"
    # Rules
    if geofence["inside"]:
        alerts.append({"type": "geofence", "severity": "danger", "message": f"Inside restricted zone: {geofence['inside_zones'][0]}"})
        level = "danger"
    elif geofence["predicted_inside"]:
        alerts.append({"type": "geofence_predicted", "severity": "warning", "message": f"Predicted to enter {geofence['predicted_zone']} in {geofence.get('time_to_enter_s', 0)}s", "time_to_enter_s": geofence.get("time_to_enter_s")})
        if level != "danger":
            level = "warning"
    if inside_weather:
        alerts.append({"type": "weather", "severity": "danger", "message": f"Inside active {inside_weather[0]} zone"})
        level = "danger"
    if wave_val is not None and wave_val > 2.5:
        alerts.append({"type": "wave", "severity": "danger" if wave_val>4 else "warning", "message": f"High waves {wave_val:.1f} {wave_unit}", "value": wave_val})
        if wave_val > 2.5 and level == "safe":
            level = "warning"
        if wave_val > 4:
            level = "danger"
    if chl_val is not None and chl_age_hours is not None and chl_age_hours < 48 and chl_val < 0.1:
        alerts.append({"type": "chlorophyll", "severity": "info", "message": f"Low productivity {chl_val:.2f} mg/m³ (age {chl_age_hours:.0f}h) - avoid", "value": chl_val, "age_hours": chl_age_hours})
        # not danger, just advisory
    if wave_val and wave_val > 2.0 and ship_count > 5:
        alerts.append({"type": "traffic_wave", "severity": "warning", "message": f"High traffic ({ship_count} vessels) + {wave_val:.1f}m waves = collision risk"})
        if level == "safe":
            level = "warning"
    elif ship_count > 15:
        alerts.append({"type": "traffic", "severity": "warning", "message": f"High vessel density: {ship_count} vessels nearby"})

    return {
        "coordinates": {"lng": longitude, "lat": latitude},
        "level": level,
        "alerts": alerts,
        "geofence": geofence,
        "weather_inside": inside_weather,
        "samples": {
            "wave": {"value": wave_val, "unit": wave_unit},
            "chlorophyll": {"value": chl_val, "age_hours": chl_age_hours, "unit": "mg/m³"},
            "ship_count": ship_count,
        },
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
