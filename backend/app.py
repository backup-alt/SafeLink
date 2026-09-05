from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from functools import lru_cache
from io import BytesIO
import json
import logging
import math
import os
from pathlib import Path
from urllib.parse import urlencode
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
import mapbox_vector_tile
from PIL import Image, ImageDraw, ImageOps
from shapely.geometry import LineString, Point, shape
from shapely.ops import unary_union

from . import environment  # Load local .env before constructing any services.
from .data_service import DataRepository
from .pfz_service import PFZService, PFZUnavailable
from .pfz_nearest import nearest_pfz
from .cloud_repository import CloudDataRepository, HuggingFaceDataRepository
from .huggingface_ingest import publish as publish_huggingface
from .refresh import STATE, refresh_loop
from .ai.routes import create_router
from .ai.openai_client import health as ai_health

ROOT = Path(__file__).resolve().parents[1]
pfz_service = PFZService()
DATA_DIR = Path(os.getenv("SAFELINK_DATA_DIR", ROOT / "copernicus_data"))
HF_MODE = bool(os.getenv("HF_DATASET_REPO"))
ORACLE_MODE = bool(os.getenv("SAFELINK_OBJECT_STORAGE_BUCKET"))
CLOUD_MODE = HF_MODE or ORACLE_MODE
repository = (
    HuggingFaceDataRepository()
    if HF_MODE
    else CloudDataRepository()
    if ORACLE_MODE
    else DataRepository(DATA_DIR)
)


async def _huggingface_refresh_loop() -> None:
    await asyncio.sleep(5)
    while True:
        if os.getenv("SAFELINK_AUTO_REFRESH", "false").lower() in {"1", "true", "yes"}:
            try:
                await asyncio.to_thread(publish_huggingface)
            except Exception:
                pass
        await asyncio.sleep(6 * 60 * 60)


@lru_cache(maxsize=1024)
def _basemap_tile(z: int, x: int, y: int) -> bytes:
    request = Request(
        f"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        headers={"User-Agent": "SafeLink/0.1 (local marine conditions map)"},
    )
    with urlopen(request, timeout=10) as response:
        return response.read()


@lru_cache(maxsize=1)
def _vector_tile_template() -> str:
    with urlopen(Request("https://tiles.openfreemap.org/planet", headers={"User-Agent": "SafeLink/0.1"}), timeout=10) as response:
        return json.loads(response.read())["tiles"][0]


@lru_cache(maxsize=1024)
def _vector_tile(z: int, x: int, y: int) -> bytes:
    url = _vector_tile_template().replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
    with urlopen(Request(url, headers={"User-Agent": "SafeLink/0.1"}), timeout=10) as response:
        return response.read()


def _draw_water_geometry(draw: ImageDraw.ImageDraw, geometry: dict, extent: int, scale: int) -> None:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates", [])
    polygons = [coordinates] if geometry_type == "Polygon" else coordinates if geometry_type == "MultiPolygon" else []
    factor = scale / extent
    for polygon in polygons:
        if not polygon:
            continue
        exterior = [(round(x * factor), round(y * factor)) for x, y in polygon[0]]
        draw.polygon(exterior, fill=255)
        for hole in polygon[1:]:
            draw.polygon([(round(x * factor), round(y * factor)) for x, y in hole], fill=0)


@lru_cache(maxsize=1024)
def _land_overlay_tile(z: int, x: int, y: int) -> bytes:
    image = Image.open(BytesIO(_basemap_tile(z, x, y))).convert("RGBA")
    decoded = mapbox_vector_tile.decode(
        _vector_tile(z, x, y),
        default_options={"y_coord_down": True},
    )
    water_layer = decoded.get("water", {"extent": 4096, "features": []})
    mask_size = 1024
    water = Image.new("L", (mask_size, mask_size))
    draw = ImageDraw.Draw(water)
    for feature in water_layer["features"]:
        _draw_water_geometry(draw, feature["geometry"], water_layer["extent"], mask_size)
    water = water.resize(image.size, Image.Resampling.LANCZOS)
    land_alpha = ImageOps.invert(water)
    image.putalpha(land_alpha)
    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def _validate_tile(z: int, x: int, y: int) -> None:
    limit = 1 << z if 0 <= z <= 19 else 0
    if not limit or not (0 <= x < limit and 0 <= y < limit):
        raise HTTPException(status_code=404, detail="Unknown map tile")


@lru_cache(maxsize=512)
def _json_get(url: str, user_agent_note: str = "marine navigation hackathon") -> dict | list:
    request = Request(url, headers={"User-Agent": f"SafeLink/0.1 ({user_agent_note})"})
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read())


@lru_cache(maxsize=512)
def _gebco_depth(latitude: float, longitude: float) -> dict[str, object]:
    params = urlencode({
        "locations": f"{latitude:.6f},{longitude:.6f}",
        "interpolation": "bilinear",
    })
    data = _json_get(f"https://api.opentopodata.org/v1/gebco2020?{params}", "GEBCO depth lookup")
    if not isinstance(data, dict) or data.get("status") != "OK" or not data.get("results"):
        return {"value": None, "unit": "m", "source": "GEBCO 2020", "status": "unavailable"}
    elevation = data["results"][0].get("elevation")
    if elevation is None:
        return {"value": None, "unit": "m", "source": "GEBCO 2020", "status": "unavailable"}
    depth = max(0.0, -float(elevation))
    return {"value": round(depth, 1), "unit": "m", "source": "GEBCO 2020", "status": "estimated"}


@lru_cache(maxsize=512)
def _marine_forecast(latitude: float, longitude: float) -> dict[str, object]:
    params = urlencode({
        "latitude": f"{latitude:.6f}",
        "longitude": f"{longitude:.6f}",
        "current": "wave_height,wave_direction,wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction",
        "wind_speed_unit": "kn",
        "timezone": "auto",
        "cell_selection": "sea",
    })
    data = _json_get(f"https://marine-api.open-meteo.com/v1/marine?{params}", "Open-Meteo marine forecast")
    if not isinstance(data, dict):
        return {}
    current = data.get("current") if isinstance(data.get("current"), dict) else {}
    units = data.get("current_units") if isinstance(data.get("current_units"), dict) else {}
    return {
        "time": current.get("time"),
        "wave_height": {"value": current.get("wave_height"), "unit": units.get("wave_height", "m"), "source": "Open-Meteo Marine"},
        "wave_direction": {"value": current.get("wave_direction"), "unit": units.get("wave_direction", "°"), "source": "Open-Meteo Marine"},
        "wave_period": {"value": current.get("wave_period"), "unit": units.get("wave_period", "s"), "source": "Open-Meteo Marine"},
        "temperature": {"value": current.get("sea_surface_temperature"), "unit": units.get("sea_surface_temperature", "°C"), "source": "Open-Meteo Marine"},
        "current_speed": {"value": current.get("ocean_current_velocity"), "unit": units.get("ocean_current_velocity", "kn"), "source": "Open-Meteo Marine"},
        "current_direction": {"value": current.get("ocean_current_direction"), "unit": units.get("ocean_current_direction", "°"), "source": "Open-Meteo Marine"},
    }


def _condition_or_none(layer_id: str, latitude: float, longitude: float) -> dict[str, object] | None:
    try:
        sample = repository.point(layer_id, latitude, longitude)
        return {
            "value": sample.get("value"),
            "unit": sample.get("unit"),
            "time": sample.get("time"),
            "source": "Copernicus Marine",
        }
    except (KeyError, FileNotFoundError, ValueError):
        return None


@lru_cache(maxsize=1)
def _land_geometry():
    with (ROOT / "public" / "indian-ocean-land.geojson").open("r", encoding="utf-8") as file:
        collection = json.load(file)
    geometries = [
        shape(feature["geometry"])
        for feature in collection.get("features", [])
        if feature.get("geometry")
    ]
    return unary_union(geometries)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not ai_health()['configured']:
        logging.getLogger(__name__).warning('SafeLink chat unavailable: check server AI configuration. Map services remain enabled.')
    task = (
        asyncio.create_task(_huggingface_refresh_loop())
        if HF_MODE
        else None
        if ORACLE_MODE
        else asyncio.create_task(refresh_loop(DATA_DIR))
    )
    yield
    if task is not None:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="SafeLink Ocean API", version="0.2.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

chat_router = create_router(repository, pfz_service)
app.include_router(chat_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/catalog")
def catalog():
    return repository.catalog()


@app.get("/api/pfz")
def pfz():
    try:
        return pfz_service.get()
    except PFZUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/pfz/nearest")
def nearest(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
):
    try:
        snapshot = pfz_service.get()
    except PFZUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    result = nearest_pfz(snapshot["data"], longitude, latitude)
    if result is None:
        raise HTTPException(status_code=404, detail="No PFZ features in the current advisory")
    return {**result, "metadata": snapshot["metadata"]}


@app.get("/api/field/{layer_id}")
def field(layer_id: str, time: str | None = Query(default=None)):
    try:
        return repository.field(layer_id, time)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Unknown layer") from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/value/{layer_id}")
def value(
    layer_id: str,
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    time: str | None = Query(default=None),
):
    try:
        return repository.point(layer_id, latitude, longitude, time)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Unknown layer") from error
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/refresh/status")
def refresh_status():
    return {
        "running": STATE.running,
        "last_started": STATE.last_started,
        "last_completed": STATE.last_completed,
        "last_error": STATE.last_error,
    }


@app.post("/api/admin/refresh", status_code=202)
def trigger_cloud_refresh(
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    if not HF_MODE:
        raise HTTPException(status_code=409, detail="Hugging Face cloud mode is not configured")
    expected = os.getenv("SAFELINK_REFRESH_TOKEN")
    if not expected or authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    if STATE.running:
        return {"accepted": False, "detail": "A refresh is already running"}
    background_tasks.add_task(publish_huggingface)
    return {"accepted": True}


@app.get("/api/map-tile/{z}/{x}/{y}.png")
def map_tile(z: int, x: int, y: int):
    _validate_tile(z, x, y)
    try:
        return Response(_basemap_tile(z, x, y), media_type="image/png")
    except (OSError, URLError) as error:
        raise HTTPException(status_code=502, detail="Basemap tile unavailable") from error


@app.get("/api/land-tile/{z}/{x}/{y}.png")
def land_tile(z: int, x: int, y: int):
    _validate_tile(z, x, y)
    try:
        return Response(_land_overlay_tile(z, x, y), media_type="image/png")
    except (OSError, URLError) as error:
        raise HTTPException(status_code=502, detail="Land overlay tile unavailable") from error


@app.get("/api/vessels")
def vessels(
    west: float = Query(ge=-180, le=180),
    south: float = Query(ge=-90, le=90),
    east: float = Query(ge=-180, le=180),
    north: float = Query(ge=-90, le=90),
):
    """Real AIS vessel positions from Open Waters aggregator."""
    try:
        from . import ais_service
        return ais_service.get_vessels(west, south, east, north)
    except (OSError, URLError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail=f"AIS data unavailable: {error}") from error


@app.post("/api/route")
def calculate_route(body: dict):
    """Advisory Demo Route — Not Certified for Navigation. Great circle interpolation."""
    origin = body.get("origin", [0, 0])
    destination = body.get("destination", [0, 0])
    waypoints = body.get("waypoints", [])
    speed_knots = max(1.0, min(50.0, float(body.get("speed_knots", 10))))

    all_points = [origin] + [list(w) for w in waypoints] + [destination]

    def haversine_km(lon1, lat1, lon2, lat2):
        rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
        rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
        dlat, dlon = rlat2 - rlat1, rlon2 - rlon1
        a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
        return 6371.0088 * 2 * math.asin(math.sqrt(a))

    def bearing_deg(lon1, lat1, lon2, lat2):
        rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
        rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
        y = math.sin(rlon2 - rlon1) * math.cos(rlat2)
        x = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(rlon2 - rlon1)
        return math.degrees(math.atan2(y, x)) % 360

    def great_circle_interpolate(lon1, lat1, lon2, lat2, t):
        rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
        rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
        d = 2 * math.asin(math.sqrt(
            math.sin((rlat2 - rlat1) / 2) ** 2 +
            math.cos(rlat1) * math.cos(rlat2) * math.sin((rlon2 - rlon1) / 2) ** 2
        ))
        if d < 1e-12:
            return lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t
        a = math.sin((1 - t) * d) / math.sin(d)
        b = math.sin(t * d) / math.sin(d)
        x = a * math.cos(rlat1) * math.cos(rlon1) + b * math.cos(rlat2) * math.cos(rlon2)
        y = a * math.cos(rlat1) * math.sin(rlon1) + b * math.cos(rlat2) * math.sin(rlon2)
        z = a * math.sin(rlat1) + b * math.sin(rlat2)
        lat_out = math.degrees(math.atan2(z, math.sqrt(x ** 2 + y ** 2)))
        lon_out = math.degrees(math.atan2(y, x))
        return lon_out, lat_out

    def water_point(point):
        try:
            return not _land_geometry().covers(Point(point[0], point[1]))
        except Exception:
            return True

    def water_segment(p1, p2):
        try:
            land = _land_geometry()
            line = LineString([p1, p2])
            if not line.intersects(land):
                return True
            # Ports and clicked coastline points can sit exactly on land in coarse
            # polygons, so ignore tiny endpoint contact and test the travelled leg.
            samples = max(18, min(72, int(haversine_km(p1[0], p1[1], p2[0], p2[1]) / 8)))
            for index in range(1, samples):
                t = index / samples
                if t < 0.035 or t > 0.965:
                    continue
                lon, lat = great_circle_interpolate(p1[0], p1[1], p2[0], p2[1], t)
                if land.covers(Point(lon, lat)):
                    return False
            return True
        except Exception:
            return True

    def path_distance(points):
        return sum(haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(points, points[1:]))

    def detour_candidates(p1, p2):
        try:
            intersection = LineString([p1, p2]).intersection(_land_geometry())
            minx, miny, maxx, maxy = intersection.bounds if not intersection.is_empty else LineString([p1, p2]).bounds
        except Exception:
            minx, miny, maxx, maxy = LineString([p1, p2]).bounds

        candidates = []
        for margin in (0.18, 0.35, 0.6, 1.0, 1.6, 2.4, 3.4, 5.0):
            west, east = minx - margin, maxx + margin
            south, north = miny - margin, maxy + margin
            raw = [
                [west, south], [west, north], [east, south], [east, north],
                [(west + east) / 2, south], [(west + east) / 2, north],
                [west, (south + north) / 2], [east, (south + north) / 2],
            ]
            for point in raw:
                if -180 <= point[0] <= 180 and -90 <= point[1] <= 90 and water_point(point):
                    rounded = [round(point[0], 5), round(point[1], 5)]
                    if rounded not in candidates:
                        candidates.append(rounded)
        return candidates

    def plan_water_leg(p1, p2):
        if water_segment(p1, p2):
            return [p1, p2], False

        candidates = detour_candidates(p1, p2)
        best = None
        for candidate in candidates:
            path = [p1, candidate, p2]
            if all(water_segment(a, b) for a, b in zip(path, path[1:])):
                if best is None or path_distance(path) < path_distance(best):
                    best = path
        for first in candidates:
            for second in candidates:
                if first == second:
                    continue
                path = [p1, first, second, p2]
                if all(water_segment(a, b) for a, b in zip(path, path[1:])):
                    if best is None or path_distance(path) < path_distance(best):
                        best = path
        return (best, True) if best else ([p1, p2], False)

    planned_points = [all_points[0]]
    inserted_detours = 0
    unresolved_land_crossings = 0
    for p1, p2 in zip(all_points, all_points[1:]):
        leg_path, detoured = plan_water_leg(p1, p2)
        if detoured:
            inserted_detours += max(0, len(leg_path) - 2)
        elif not water_segment(p1, p2):
            unresolved_land_crossings += 1
        planned_points.extend(leg_path[1:])
    all_points = planned_points

    legs = []
    total_distance = 0.0
    all_route_coords = []
    distance_labels = []

    for i in range(len(all_points) - 1):
        p1, p2 = all_points[i], all_points[i + 1]
        leg_dist = haversine_km(p1[0], p1[1], p2[0], p2[1])
        leg_heading = bearing_deg(p1[0], p1[1], p2[0], p2[1])
        steps = max(10, min(40, int(leg_dist / 30)))
        leg_coords = []
        for s in range(steps + 1):
            t = s / steps
            lng, lat = great_circle_interpolate(p1[0], p1[1], p2[0], p2[1], t)
            coord = [round(lng, 5), round(lat, 5)]
            leg_coords.append(coord)
            if s > 0 or i == 0:
                all_route_coords.append(coord)
        label_interval = max(1, steps // 4)
        for s in range(0, steps + 1, label_interval):
            if s == 0 and i > 0:
                continue
            frac = s / steps
            km_at = total_distance + leg_dist * frac
            distance_labels.append({
                "position": leg_coords[s],
                "distance_km": round(km_at, 1),
            })
        total_distance += leg_dist
        legs.append({
            "from": p1,
            "to": p2,
            "distance_km": round(leg_dist, 1),
            "heading": round(leg_heading, 1),
            "steps": steps,
        })

    if distance_labels:
        distance_labels.append({
            "position": all_route_coords[-1],
            "distance_km": round(total_distance, 1),
        })

    eta_hours = total_distance / (speed_knots * 1.852)
    initial_heading = bearing_deg(all_points[0][0], all_points[0][1], all_points[1][0], all_points[1][1]) if len(all_points) > 1 else 0

    warnings = []
    if inserted_detours:
        warnings.append({
            "type": "info",
            "message": f"Automatic route inserted {inserted_detours} sea waypoint{'s' if inserted_detours != 1 else ''} to avoid land.",
            "location": all_route_coords[min(len(all_route_coords) - 1, max(0, len(all_route_coords) // 2))],
            "severity": "info",
        })
    if unresolved_land_crossings:
        warnings.append({
            "type": "restricted",
            "message": "Some land crossings may remain. Add a manual waypoint farther offshore and recalculate.",
            "location": all_route_coords[min(len(all_route_coords) - 1, max(0, len(all_route_coords) // 2))],
            "severity": "warning",
        })
    if total_distance > 200:
        mid = all_route_coords[len(all_route_coords) // 2]
        warnings.append({
            "type": "info",
            "message": f"Long route: {total_distance:.0f} km. Check weather and vessel range.",
            "location": mid,
            "severity": "info",
        })

    try:
        mid_idx = len(all_route_coords) // 2
        mid_coord = all_route_coords[mid_idx]
        wave_data = repository.point("waves", mid_coord[1], mid_coord[0])
        wave_height = wave_data.get("value", 0)
        if wave_height > 4.0:
            warnings.append({
                "type": "hazard",
                "message": f"Very heavy seas at route midpoint: {wave_height:.1f} m wave height.",
                "location": mid_coord,
                "severity": "danger",
            })
        elif wave_height > 2.5:
            warnings.append({
                "type": "hazard",
                "message": f"Moderate seas at route midpoint: {wave_height:.1f} m wave height.",
                "location": mid_coord,
                "severity": "warning",
            })
    except Exception:
        pass

    try:
        mid_coord = all_route_coords[len(all_route_coords) // 3]
        current_data = repository.point("currents", mid_coord[1], mid_coord[0])
        current_speed = current_data.get("value", 0)
        if current_speed > 1.5:
            warnings.append({
                "type": "traffic",
                "message": f"Strong current along route: {current_speed:.1f} kn.",
                "location": mid_coord,
                "severity": "warning",
            })
    except Exception:
        pass

    if speed_knots != 10:
        warnings.append({
            "type": "info",
            "message": f"ETA calculated at {speed_knots:.0f} knots.",
            "location": all_route_coords[0],
            "severity": "info",
        })

    return {
        "coordinates": all_route_coords,
        "distance_km": round(total_distance, 1),
        "eta_hours": round(eta_hours, 1),
        "heading": round(initial_heading, 1),
        "warnings": warnings,
        "legs": legs,
        "distance_labels": distance_labels,
        "speed_knots": speed_knots,
    }


LAYERS_FOR_CLICK = ["waves", "currents", "temperature", "sea_level", "chlorophyll"]


@app.get("/api/nautical/click")
def nautical_click(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
):
    """Get marine conditions at a point — reuses existing Copernicus data service."""
    conditions = {}
    for layer_id in LAYERS_FOR_CLICK:
        try:
            conditions[layer_id] = repository.point(layer_id, latitude, longitude)
        except (KeyError, FileNotFoundError, ValueError):
            conditions[layer_id] = None
    return {
        "coordinates": {"lng": longitude, "lat": latitude},
        "conditions": conditions,
    }


@app.get("/api/nautical/point")
def nautical_point(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
):
    """Combined point advisory data for route planning."""
    forecast: dict[str, object] = {}
    depth: dict[str, object] = {"value": None, "unit": "m", "source": "GEBCO 2020", "status": "unavailable"}
    try:
        forecast = _marine_forecast(latitude, longitude)
    except (OSError, URLError, json.JSONDecodeError, KeyError, ValueError):
        forecast = {}
    try:
        depth = _gebco_depth(latitude, longitude)
    except (OSError, URLError, json.JSONDecodeError, KeyError, ValueError):
        pass

    wave = _condition_or_none("waves", latitude, longitude) or forecast.get("wave_height")
    temperature = _condition_or_none("temperature", latitude, longitude) or forecast.get("temperature")
    current = _condition_or_none("currents", latitude, longitude) or forecast.get("current_speed")
    return {
        "coordinates": {"lng": longitude, "lat": latitude},
        "depth": depth,
        "wave_height": wave,
        "wave_direction": forecast.get("wave_direction"),
        "wave_period": forecast.get("wave_period"),
        "temperature": temperature,
        "current": current,
        "current_direction": forecast.get("current_direction"),
        "fetched_at": forecast.get("time"),
        "note": "Advisory planning data only; not certified for navigation.",
    }


@app.get("/api/geocode")
def geocode(q: str = Query(min_length=2, max_length=120)):
    """Search a place name and return candidate WGS84 coordinates."""
    params = urlencode({
        "q": q,
        "format": "jsonv2",
        "limit": 6,
        "addressdetails": 1,
    })
    try:
        data = _json_get(f"https://nominatim.openstreetmap.org/search?{params}", "route place search")
    except (OSError, URLError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail=f"Place search unavailable: {error}") from error
    if not isinstance(data, list):
        return []
    results = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            lat = float(item["lat"])
            lon = float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        results.append({
            "name": item.get("display_name") or q,
            "latitude": lat,
            "longitude": lon,
            "type": item.get("type"),
            "importance": item.get("importance"),
        })
    return results


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
