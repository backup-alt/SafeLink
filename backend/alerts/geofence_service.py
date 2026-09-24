"""Dynamic Geofencing service - hardcoded boundaries for demo."""
from __future__ import annotations

import json
import math
from pathlib import Path
from functools import lru_cache

from shapely.geometry import Point, Polygon, shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]

# Hardcoded restricted zones for internal hackathon demo
# Real source: MarineRegions.org EEZ + WDPA + military blocks (fetch later)
GEOFENCES = [
    {
        "id": "india_eez_boundary",
        "name": "India-Sri Lanka Maritime Boundary (Palk Bay)",
        "type": "international_boundary",
        "severity": "danger",
        "description": "Approaching international maritime boundary. IMBL crossing requires authorization.",
        "polygon": [
            [79.0, 9.0], [79.5, 9.5], [80.0, 10.0], [80.5, 9.8],
            [81.0, 9.2], [80.5, 8.8], [80.0, 8.5], [79.5, 8.6], [79.0, 9.0]
        ],
    },
    {
        "id": "gulf_of_mannar_sanctuary",
        "name": "Gulf of Mannar Marine Sanctuary",
        "type": "marine_sanctuary",
        "severity": "warning",
        "description": "Marine protected area - fishing restricted.",
        "polygon": [
            [78.5, 8.5], [79.2, 8.5], [79.2, 9.2], [78.5, 9.2], [78.5, 8.5]
        ],
    },
    {
        "id": "military_testing_block",
        "name": "Military Testing Block (Bay of Bengal)",
        "type": "military",
        "severity": "danger",
        "description": "Active military testing zone - entry prohibited.",
        "polygon": [
            [82.0, 12.0], [83.5, 12.0], [83.5, 13.5], [82.0, 13.5], [82.0, 12.0]
        ],
    },
]

_prepared = None
_polygons = None

def _init():
    global _prepared, _polygons
    if _prepared is not None:
        return
    _polygons = []
    _prepared = []
    for g in GEOFENCES:
        poly = Polygon(g["polygon"])
        _polygons.append(poly)
        _prepared.append(prep(poly))

def get_geofences_geojson() -> dict:
    _init()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": g["id"],
                "geometry": {"type": "Polygon", "coordinates": [g["polygon"]]},
                "properties": {
                    "name": g["name"],
                    "type": g["type"],
                    "severity": g["severity"],
                    "description": g["description"],
                },
            }
            for g in GEOFENCES
        ],
        "metadata": {
            "source": "MarineRegions.org EEZ + WDPA (hardcoded demo, 3 zones)",
            "count": len(GEOFENCES),
            "note": "Dynamic fetch from MarineRegions API planned for production",
        },
    }

def _haversine_km(lon1, lat1, lon2, lat2):
    rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
    rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
    dlat, dlon = rlat2 - rlat1, rlon2 - rlon1
    a = math.sin(dlat/2)**2 + math.cos(rlat1)*math.cos(rlat2)*math.sin(dlon/2)**2
    return 6371.0088 * 2 * math.asin(math.sqrt(a))

def _bearing_deg(lon1, lat1, lon2, lat2):
    rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
    rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
    y = math.sin(rlon2-rlon1)*math.cos(rlat2)
    x = math.cos(rlat1)*math.sin(rlat2)-math.sin(rlat1)*math.cos(rlat2)*math.cos(rlon2-rlon1)
    return math.degrees(math.atan2(y,x))%360

def _destination(lon, lat, distance_km, bearing_deg):
    rlat, rlon = math.radians(lat), math.radians(lon)
    br = math.radians(bearing_deg)
    d = distance_km/6371.0088
    lat2 = math.asin(math.sin(rlat)*math.cos(d)+math.cos(rlat)*math.sin(d)*math.cos(br))
    lon2 = rlon + math.atan2(math.sin(br)*math.sin(d)*math.cos(rlat), math.cos(d)-math.sin(rlat)*math.sin(lat2))
    return math.degrees(lon2), math.degrees(lat2)

def check_point(longitude: float, latitude: float, heading: float | None = None, speed_knots: float | None = None, predict_minutes: float = 5.0) -> dict:
    _init()
    point = Point(longitude, latitude)
    result = {
        "inside": False,
        "inside_zones": [],
        "distance_to_boundary_km": None,
        "nearest_zone": None,
        "predicted_position": None,
        "predicted_inside": False,
        "predicted_zone": None,
        "time_to_enter_s": None,
        "bearing_to_boundary": None,
    }
    # Check inside
    for idx, poly in enumerate(_polygons):
        if poly.contains(point) or poly.touches(point):
            result["inside"] = True
            result["inside_zones"].append(GEOFENCES[idx]["id"])

    # Distance to nearest boundary
    min_dist = float("inf")
    nearest_id = None
    nearest_point = None
    for idx, poly in enumerate(_polygons):
        dist = poly.distance(point) * 111.0  # approx deg to km
        # More accurate via nearest point
        # Use shapely nearest point approx
        if dist < min_dist:
            min_dist = dist
            nearest_id = GEOFENCES[idx]["id"]
            # find centroid bearing
            centroid = poly.centroid
            nearest_point = (centroid.x, centroid.y)
    if nearest_id:
        # refine with haversine to centroid
        result["distance_to_boundary_km"] = round(_haversine_km(longitude, latitude, nearest_point[0], nearest_point[1]), 2) if nearest_point else round(min_dist,2)
        result["nearest_zone"] = nearest_id
        if nearest_point:
            result["bearing_to_boundary"] = round(_bearing_deg(longitude, latitude, nearest_point[0], nearest_point[1]), 1)

    # Predicted position
    if heading is not None and speed_knots is not None and speed_knots > 0.5:
        dist_km = speed_knots * 1.852 * (predict_minutes / 60.0)
        pred_lon, pred_lat = _destination(longitude, latitude, dist_km, heading)
        result["predicted_position"] = {"lng": round(pred_lon,5), "lat": round(pred_lat,5), "distance_km": round(dist_km,2)}
        pred_point = Point(pred_lon, pred_lat)
        for idx, poly in enumerate(_polygons):
            if poly.contains(pred_point):
                result["predicted_inside"] = True
                result["predicted_zone"] = GEOFENCES[idx]["id"]
                # Estimate time to enter by stepping
                for t in range(1, 10):
                    frac = t/10.0
                    step_lon, step_lat = _destination(longitude, latitude, dist_km*frac, heading)
                    if poly.contains(Point(step_lon, step_lat)):
                        result["time_to_enter_s"] = int(frac * predict_minutes * 60)
                        break
                break
    return result
