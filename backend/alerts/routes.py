from __future__ import annotations

from fastapi import APIRouter, Query
from .geofence_service import get_geofences_geojson, check_point
from .weather_service import get_geojson as get_weather_geojson, get_hazards, fused_guardrail_check

router = APIRouter(prefix="/api", tags=["alerts"])

# Import repository lazily to avoid circular
def _repo():
    from backend.app import repository
    return repository

@router.get("/geofences")
def geofences():
    return get_geofences_geojson()

@router.get("/geofence/check")
def geofence_check(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    heading: float | None = Query(default=None, ge=0, le=360),
    speed_knots: float | None = Query(default=None, ge=0, le=50),
):
    return check_point(longitude, latitude, heading, speed_knots)

@router.get("/alerts/weather")
def weather_alerts():
    return get_weather_geojson()

@router.get("/alerts/hazards")
def hazards():
    return get_hazards()

@router.get("/alerts/guardrail")
def guardrail(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
):
    return fused_guardrail_check(latitude, longitude, _repo())
