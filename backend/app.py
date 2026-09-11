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
from shapely.prepared import prep

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


_land_cache = None
_prepared_land_cache = None

def _land_geometry():
    global _land_cache
    if _land_cache is not None:
        return _land_cache
    with (ROOT / "public" / "indian-ocean-land.geojson").open("r", encoding="utf-8") as file:
        collection = json.load(file)
    geometries = [
        shape(feature["geometry"])
        for feature in collection.get("features", [])
        if feature.get("geometry")
    ]
    _land_cache = unary_union(geometries)
    return _land_cache


def _prepared_land():
    global _prepared_land_cache
    if _prepared_land_cache is not None:
        return _prepared_land_cache
    land = _land_geometry()
    _prepared_land_cache = prep(land.buffer(0.0005))
    return _prepared_land_cache


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


def _haversine_km(lon1, lat1, lon2, lat2):
    rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
    rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
    dlat, dlon = rlat2 - rlat1, rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(a))


def _bearing_deg(lon1, lat1, lon2, lat2):
    rlon1, rlat1 = math.radians(lon1), math.radians(lat1)
    rlon2, rlat2 = math.radians(lon2), math.radians(lat2)
    y = math.sin(rlon2 - rlon1) * math.cos(rlat2)
    x = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(rlon2 - rlon1)
    return math.degrees(math.atan2(y, x)) % 360


def _great_circle_interpolate(lon1, lat1, lon2, lat2, t):
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


def _water_point(point):
    try:
        return not _prepared_land().contains(Point(point[0], point[1]))
    except Exception:
        return False


_water_segment_cache = {}
_land_bbox = None

def _water_segment(p1, p2):
    key = (p1[0], p1[1], p2[0], p2[1])
    cached = _water_segment_cache.get(key)
    if cached is not None:
        return cached
    try:
        pland = _prepared_land()
        global _land_bbox
        if _land_bbox is None:
            _land_bbox = _land_geometry().bounds
        lb = _land_bbox
        seg_min_lon = min(p1[0], p2[0])
        seg_max_lon = max(p1[0], p2[0])
        seg_min_lat = min(p1[1], p2[1])
        seg_max_lat = max(p1[1], p2[1])
        if seg_max_lon < lb[0] or seg_min_lon > lb[2] or seg_max_lat < lb[1] or seg_min_lat > lb[3]:
            _water_segment_cache[key] = True
            return True
        line = LineString([p1, p2])
        if not pland.intersects(line):
            _water_segment_cache[key] = True
            return True
        dist = _haversine_km(p1[0], p1[1], p2[0], p2[1])
        samples = max(20, min(60, int(dist / 5)))
        for index in range(1, samples):
            t = index / samples
            if t < 0.005 or t > 0.995:
                continue
            lon, lat = _great_circle_interpolate(p1[0], p1[1], p2[0], p2[1], t)
            if pland.contains(Point(lon, lat)):
                _water_segment_cache[key] = False
                return False
        _water_segment_cache[key] = True
        return True
    except Exception:
        return False


def _sample_weather_along_route(coordinates, sample_count=6):
    """Sample weather at multiple points along a route and return scores."""
    if len(coordinates) < 2:
        return 1.0, "Insufficient route data", []
    samples = []
    n = len(coordinates)
    for i in range(sample_count):
        t = i / max(1, sample_count - 1)
        idx = min(int(t * (n - 1)), n - 2)
        frac = t * (n - 1) - idx
        lon = coordinates[idx][0] + frac * (coordinates[idx + 1][0] - coordinates[idx][0])
        lat = coordinates[idx][1] + frac * (coordinates[idx + 1][1] - coordinates[idx][1])
        try:
            forecast = _marine_forecast(lat, lon)
            wave_val = forecast.get("wave_height", {}).get("value")
            curr_val = forecast.get("current_speed", {}).get("value")
            wave = float(wave_val) if wave_val is not None else 0.0
            curr = float(curr_val) if curr_val is not None else 0.0
            samples.append({"lon": lon, "lat": lat, "wave_height": wave, "current_speed": curr})
        except Exception:
            samples.append({"lon": lon, "lat": lat, "wave_height": 0.0, "current_speed": 0.0})
    max_wave = max((s["wave_height"] for s in samples), default=0.0)
    max_curr = max((s["current_speed"] for s in samples), default=0.0)
    avg_wave = sum(s["wave_height"] for s in samples) / max(1, len(samples))
    wave_penalty = 0.0
    if max_wave > 4.0:
        wave_penalty = 0.5
    elif max_wave > 2.5:
        wave_penalty = 0.3
    elif max_wave > 1.5:
        wave_penalty = 0.15
    curr_penalty = 0.0
    if max_curr > 2.0:
        curr_penalty = 0.2
    elif max_curr > 1.5:
        curr_penalty = 0.1
    score = max(0.0, min(1.0, 1.0 - wave_penalty - curr_penalty))
    parts = []
    if max_wave > 0.5:
        parts.append(f"{max_wave:.1f}m waves")
    if max_curr > 0.3:
        parts.append(f"{max_curr:.1f}kn currents")
    summary = ", ".join(parts) if parts else "Calm seas"
    return score, summary, samples


def _traffic_score_along_route(coordinates):
    """Estimate traffic density along route using AIS data."""
    if len(coordinates) < 2:
        return "low", 0
    lons = [c[0] for c in coordinates]
    lats = [c[1] for c in coordinates]
    bbox = {"west": min(lons) - 0.5, "south": min(lats) - 0.5, "east": max(lons) + 0.5, "north": max(lats) + 0.5}
    try:
        from . import ais_service
        vessels = ais_service.get_vessels(bbox["west"], bbox["south"], bbox["east"], bbox["north"])
    except Exception:
        return "low", 0
    if not vessels:
        return "low", 0
    route_line = LineString(coordinates)
    buffered = route_line.buffer(0.5)
    nearby = 0
    for v in vessels:
        try:
            vlon = float(v.get("longitude", 0))
            vlat = float(v.get("latitude", 0))
            if buffered.contains(Point(vlon, vlat)):
                nearby += 1
        except (ValueError, TypeError):
            continue
    if nearby > 15:
        return "high", nearby
    elif nearby > 5:
        return "medium", nearby
    return "low", nearby


def _pfz_proximity_score(coordinates):
    """Check if route passes near Potential Fishing Zones."""
    if len(coordinates) < 2:
        return 0.0, "No PFZ data"
    try:
        snapshot = pfz_service.get()
        features = snapshot.get("data", {}).get("features", [])
    except Exception:
        return 0.0, "PFZ data unavailable"
    if not features:
        return 0.0, "No active PFZ zones"
    route_line = LineString(coordinates)
    min_dist = float("inf")
    for feat in features:
        try:
            geom = shape(feat["geometry"])
            dist = route_line.distance(geom) * 111.0
            min_dist = min(min_dist, dist)
        except Exception:
            continue
    if min_dist < 20:
        return 1.0, "Near active fishing zone"
    elif min_dist < 50:
        return 0.7, "Close to fishing zone"
    elif min_dist < 100:
        return 0.4, "Moderate distance to fishing zone"
    return 0.1, "Far from fishing zones"


def _perpendicular_offset(lon1, lat1, lon2, lat2, distance_km, direction):
    mid_lon = (lon1 + lon2) / 2
    mid_lat = (lat1 + lat2) / 2
    heading = math.radians(_bearing_deg(lon1, lat1, lon2, lat2))
    if direction == 'right':
        perp = heading - math.pi / 2
    else:
        perp = heading + math.pi / 2
    delta_lat = distance_km * math.cos(perp) / 111.32
    delta_lon = distance_km * math.sin(perp) / (111.32 * max(0.01, math.cos(math.radians(mid_lat))))
    return [round(mid_lon + delta_lon, 5), round(mid_lat + delta_lat, 5)]


def _plan_single_route(all_points, prefer_direction=None, reference_path=None, exclude_paths=None):
    pland = _prepared_land()

    def path_distance(points):
        return sum(_haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(points, points[1:]))

    def find_land_crossings(p1, p2):
        dist = _haversine_km(p1[0], p1[1], p2[0], p2[1])
        samples = max(36, min(180, int(dist / 2)))
        crossings = []
        prev_on_land = False
        pland = _prepared_land()
        for i in range(samples + 1):
            t = i / samples
            lon, lat = _great_circle_interpolate(p1[0], p1[1], p2[0], p2[1], t)
            on_land = pland.contains(Point(lon, lat))
            if on_land and not prev_on_land:
                crossings.append(t)
            prev_on_land = on_land
        return crossings

    def detour_candidates(p1, p2, offset_distances=None):
        crossings = find_land_crossings(p1, p2)
        if offset_distances is None:
            offset_distances = [25, 50, 100]
        candidates = []
        land_mid_lon = None
        land_bounds = None
        if crossings:
            try:
                route_len = _haversine_km(p1[0], p1[1], p2[0], p2[1])
                corridor = LineString([p1, p2]).buffer(max(2.0, route_len / 120))
                nearby_land = _land_geometry().intersection(corridor)
                if not nearby_land.is_empty:
                    land_bounds = nearby_land.bounds
                    land_mid_lon = (land_bounds[0] + land_bounds[2]) / 2
            except Exception:
                pass
            for t in crossings:
                cross_lon, cross_lat = _great_circle_interpolate(p1[0], p1[1], p2[0], p2[1], t)
                for d in offset_distances:
                    left = _perpendicular_offset(p1[0], p1[1], p2[0], p2[1], d, 'left')
                    right = _perpendicular_offset(p1[0], p1[1], p2[0], p2[1], d, 'right')
                    for c in [left, right]:
                        if _water_point(c) and c not in candidates:
                            candidates.append(c)
                for d in [50, 100, 200]:
                    for angle in [0, 90, 180, 270]:
                        rad = math.radians(angle)
                        dlat = d * math.cos(rad) / 111.32
                        dlon = d * math.sin(rad) / (111.32 * max(0.01, math.cos(math.radians(cross_lat))))
                        cand = [round(cross_lon + dlon, 5), round(cross_lat + dlat, 5)]
                        if -180 <= cand[0] <= 180 and -90 <= cand[1] <= 90:
                            if _water_point(cand) and cand not in candidates:
                                candidates.append(cand)
            try:
                ib = LineString([p1, p2]).intersection(_land_geometry()).bounds
                for step in range(6):
                    t = step / 5
                    bx = ib[0] + t * (ib[2] - ib[0])
                    by = ib[1] + t * (ib[3] - ib[1])
                    for offset_km in offset_distances:
                        for angle_offset in [-0.3, 0, 0.3]:
                            heading = _bearing_deg(p1[0], p1[1], p2[0], p2[1])
                            perp_heading = math.radians(heading + 90 + math.degrees(angle_offset))
                            dlat = offset_km * math.cos(perp_heading) / 111.32
                            dlon = offset_km * math.sin(perp_heading) / (111.32 * max(0.01, math.cos(math.radians(by))))
                            cand = [round(bx + dlon, 5), round(by + dlat, 5)]
                            if _water_point(cand) and cand not in candidates:
                                candidates.append(cand)
            except Exception:
                pass
            if land_bounds is not None:
                edge_lats = [(land_bounds[1] + land_bounds[3]) / 2]
                if crossings:
                    edge_lats.append(cross_lat)
                for extra in [0.5, 1.0, 2.0]:
                    for edge_lat in edge_lats:
                        for edge_lon in [land_bounds[0] - extra, land_bounds[2] + extra]:
                            cand = [round(edge_lon, 5), round(edge_lat, 5)]
                            if -180 <= cand[0] <= 180 and -90 <= cand[1] <= 90:
                                if _water_point(cand) and cand not in candidates:
                                    candidates.append(cand)
        else:
            for margin in (0.5, 1.0, 2.0):
                try:
                    bounds = LineString([p1, p2]).bounds
                except Exception:
                    continue
                west, east = bounds[0] - margin, bounds[2] + margin
                south, north = bounds[1] - margin, bounds[3] + margin
                for point in [
                    [west, south], [west, north], [east, south], [east, north],
                    [(west + east) / 2, south], [(west + east) / 2, north],
                    [west, (south + north) / 2], [east, (south + north) / 2],
                ]:
                    if -180 <= point[0] <= 180 and -90 <= point[1] <= 90 and _water_point(point):
                        rounded = [round(point[0], 5), round(point[1], 5)]
                        if rounded not in candidates:
                            candidates.append(rounded)
        if len(candidates) > 20:
            candidates = candidates[:20]
        return candidates, land_bounds

    def filter_by_longitude(candidates, land_bounds, side):
        if land_bounds is None:
            return candidates
        if side == 'west':
            return [c for c in candidates if c[0] < land_bounds[0]]
        else:
            return [c for c in candidates if c[0] > land_bounds[2]]

    def _exclude_reference(candidates, ref_path, min_dist_km=50):
        paths = [ref_path] if ref_path else []
        if exclude_paths:
            paths.extend(exclude_paths)
        if not paths:
            return candidates
        ref_mids = []
        for p in paths:
            if p and len(p) >= 3:
                ref_mids.extend(p[1:-1])
        if not ref_mids:
            return candidates
        return [c for c in candidates
                if all(_haversine_km(c[0], c[1], rm[0], rm[1]) > min_dist_km
                       for rm in ref_mids)]

    def find_best_path(p1, p2, candidates, max_pairs=300):
        best = None
        best_dist = float('inf')
        for candidate in candidates:
            path = [p1, candidate, p2]
            d = path_distance(path)
            if d >= best_dist:
                continue
            if all(_water_segment(a, b) for a, b in zip(path, path[1:])):
                best = path
                best_dist = d
        pair_count = 0
        for first in candidates:
            for second in candidates:
                if first == second:
                    continue
                pair_count += 1
                if pair_count > max_pairs:
                    return best
                path = [p1, first, second, p2]
                d = path_distance(path)
                if d >= best_dist:
                    continue
                if all(_water_segment(a, b) for a, b in zip(path, path[1:])):
                    best = path
                    best_dist = d
        return best

    def plan_water_leg(p1, p2):
        if _water_segment(p1, p2):
            return [p1, p2], False

        candidates, land_bounds = detour_candidates(p1, p2)

        if prefer_direction in ('west', 'east'):
            filtered = filter_by_longitude(candidates, land_bounds, prefer_direction)
            if filtered and reference_path is not None:
                filtered = _exclude_reference(filtered, reference_path)
            if filtered:
                best = find_best_path(p1, p2, filtered)
                if best:
                    return best, True
            if land_bounds is not None:
                forced_lon = land_bounds[0] - 2.0 if prefer_direction == 'west' else land_bounds[2] + 2.0
                for lat_offset in [-1.0, 0.0, 1.0]:
                    forced_wp = [round(forced_lon, 5), round((p1[1] + p2[1]) / 2 + lat_offset, 5)]
                    if _water_point(forced_wp):
                        if _water_segment(p1, forced_wp) and _water_segment(forced_wp, p2):
                            return [p1, forced_wp, p2], True
            if prefer_direction == 'west':
                fallback_lons = []
                if land_bounds:
                    fallback_lons = [land_bounds[0] - d for d in [1.0, 2.0, 3.0]]
                else:
                    fallback_lons = [p1[0] - d for d in [2.0, 3.0]]
                for fallback_lon in fallback_lons:
                    for lat_offset in [-1.0, 0.0, 1.0]:
                        cand = [round(fallback_lon, 5), round((p1[1] + p2[1]) / 2 + lat_offset, 5)]
                        if _water_point(cand):
                            best = find_best_path(p1, p2, [cand])
                            if best:
                                return best, True
            else:
                fallback_lons = []
                if land_bounds:
                    fallback_lons = [land_bounds[2] + d for d in [1.0, 2.0, 3.0]]
                else:
                    fallback_lons = [p1[0] + d for d in [2.0, 3.0]]
                for fallback_lon in fallback_lons:
                    for lat_offset in [-1.0, 0.0, 1.0]:
                        cand = [round(fallback_lon, 5), round((p1[1] + p2[1]) / 2 + lat_offset, 5)]
                        if _water_point(cand):
                            best = find_best_path(p1, p2, [cand])
                            if best:
                                return best, True
            if reference_path is not None:
                remaining = _exclude_reference(candidates, reference_path, min_dist_km=30)
                if remaining:
                    best = find_best_path(p1, p2, remaining)
                    if best:
                        return best, True
            best = find_best_path(p1, p2, candidates)
            if best:
                return best, True

        best = find_best_path(p1, p2, candidates)
        if best:
            return best, True

        large_offsets = [400, 800]
        large_candidates, _ = detour_candidates(p1, p2, offset_distances=large_offsets)
        if prefer_direction in ('west', 'east') and reference_path is not None:
            large_filtered = _exclude_reference(large_candidates, reference_path, min_dist_km=50)
            if large_filtered:
                best = find_best_path(p1, p2, large_filtered)
                if best:
                    return best, True
        best = find_best_path(p1, p2, large_candidates)
        if best:
            return best, True

        arc_candidates = []
        min_lat = min(p1[1], p2[1])
        for lat_deg in range(3, max(3, int(min_lat) - 1), 3):
            for lon_deg in range(max(65, int(min(p1[0], p2[0])) - 3),
                                min(95, int(max(p1[0], p2[0])) + 3), 3):
                cand = [float(lon_deg), float(lat_deg)]
                if _water_point(cand):
                    arc_candidates.append(cand)
        if arc_candidates:
            if prefer_direction in ('west', 'east') and reference_path is not None:
                arc_filtered = _exclude_reference(arc_candidates, reference_path, min_dist_km=50)
                if arc_filtered:
                    best = find_best_path(p1, p2, arc_filtered)
                    if best:
                        return best, True
            best = find_best_path(p1, p2, arc_candidates)
            if best:
                return best, True

        return [p1, p2], True

    planned_points = [all_points[0]]
    inserted_detours = 0
    unresolved_land_crossings = 0
    for p1, p2 in zip(all_points, all_points[1:]):
        leg_path, detoured = plan_water_leg(p1, p2)
        if detoured:
            inserted_detours += max(0, len(leg_path) - 2)
        planned_points.extend(leg_path[1:])
    return planned_points, inserted_detours, unresolved_land_crossings


def _build_route_response(all_points, speed_knots, inserted_detours, unresolved_land_crossings, label=""):
    legs = []
    total_distance = 0.0
    all_route_coords = []
    distance_labels = []

    for i in range(len(all_points) - 1):
        p1, p2 = all_points[i], all_points[i + 1]
        leg_dist = _haversine_km(p1[0], p1[1], p2[0], p2[1])
        leg_heading = _bearing_deg(p1[0], p1[1], p2[0], p2[1])
        steps = max(10, min(40, int(leg_dist / 30)))
        leg_coords = []
        for s in range(steps + 1):
            t = s / steps
            lng, lat = _great_circle_interpolate(p1[0], p1[1], p2[0], p2[1], t)
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
    initial_heading = _bearing_deg(all_points[0][0], all_points[0][1], all_points[1][0], all_points[1][1]) if len(all_points) > 1 else 0

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
        mid_coord = all_route_coords[len(all_route_coords) // 2]
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
        "label": label,
        "coordinates": all_route_coords,
        "distance_km": round(total_distance, 1),
        "eta_hours": round(eta_hours, 1),
        "heading": round(initial_heading, 1),
        "warnings": warnings,
        "legs": legs,
        "distance_labels": distance_labels,
        "speed_knots": speed_knots,
    }


@app.post("/api/route")
def calculate_route(body: dict):
    """Advisory Demo Route — Not Certified for Navigation. Returns safest and direct route groups."""
    origin = body.get("origin", [0, 0])
    destination = body.get("destination", [0, 0])
    waypoints = body.get("waypoints", [])
    speed_knots = max(1.0, min(50.0, float(body.get("speed_knots", 10))))

    all_points = [origin] + [list(w) for w in waypoints] + [destination]

    shortest_planned, shortest_inserted, shortest_unresolved = _plan_single_route(
        list(all_points), prefer_direction=None
    )
    shortest_route = _build_route_response(
        shortest_planned, speed_knots, shortest_inserted, shortest_unresolved, label="Direct Route"
    )

    western_planned, western_inserted, western_unresolved = _plan_single_route(
        list(all_points), prefer_direction="west", reference_path=shortest_planned
    )
    western_route = _build_route_response(
        western_planned, speed_knots, western_inserted, western_unresolved, label="Safest Route"
    )

    eastern_planned, eastern_inserted, eastern_unresolved = _plan_single_route(
        list(all_points), prefer_direction="east", reference_path=shortest_planned,
        exclude_paths=[western_planned]
    )
    eastern_route = _build_route_response(
        eastern_planned, speed_knots, eastern_inserted, eastern_unresolved, label="Scenic Route"
    )

    candidates = [
        ("western", western_route, western_planned),
        ("shortest", shortest_route, shortest_planned),
        ("eastern", eastern_route, eastern_planned),
    ]

    scored = []
    for name, route_data, planned_coords in candidates:
        coords = route_data.get("coordinates", [])
        weather_score, weather_summary, _ = _sample_weather_along_route(coords)
        traffic_level, traffic_count = _traffic_score_along_route(coords)
        pfz_score, pfz_summary = _pfz_proximity_score(coords)
        combined_score = weather_score * 0.5 + pfz_score * 0.3 + (1.0 if traffic_level == "low" else 0.5 if traffic_level == "medium" else 0.2) * 0.2
        route_data["weather_score"] = round(combined_score, 2)
        route_data["weather_summary"] = weather_summary
        route_data["traffic_level"] = traffic_level
        route_data["pfz_summary"] = pfz_summary
        scored.append((combined_score, name, route_data))

    scored.sort(key=lambda x: x[0], reverse=True)
    safest_data = scored[0][2]
    safest_data["label"] = "Safest Route"
    direct_data = scored[-1][2]
    direct_data["label"] = "Direct Route"

    return {
        "safest": {
            "route": safest_data,
            "weather_summary": safest_data.get("weather_summary", ""),
            "traffic_level": safest_data.get("traffic_level", "low"),
            "weather_score": safest_data.get("weather_score", 0),
            "pfz_summary": safest_data.get("pfz_summary", ""),
        },
        "direct": {
            "route": direct_data,
            "weather_summary": direct_data.get("weather_summary", ""),
            "traffic_level": direct_data.get("traffic_level", "low"),
            "weather_score": direct_data.get("weather_score", 0),
            "pfz_summary": direct_data.get("pfz_summary", ""),
        },
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


from .hf_routes import store as route_store


@app.get("/api/saved-routes")
def list_saved_routes(user_id: str = Query(default="default")):
    if not route_store.configured:
        return []
    return route_store.get_routes(user_id)


@app.post("/api/saved-routes")
def create_saved_route(body: dict, user_id: str = Query(default="default")):
    if not route_store.configured:
        raise HTTPException(status_code=503, detail="Hugging Face storage not configured. Set HF_TOKEN and HF_CHAT_DATASET_REPO.")
    saved = route_store.save_route(user_id, body)
    if saved is None:
        raise HTTPException(status_code=500, detail="Failed to save route")
    return saved


@app.delete("/api/saved-routes/{route_id}")
def remove_saved_route(route_id: str, user_id: str = Query(default="default")):
    if not route_store.configured:
        raise HTTPException(status_code=503, detail="Hugging Face storage not configured.")
    deleted = route_store.delete_route(user_id, route_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Route not found")
    return {"deleted": True}


from .hf_emergency import emergency_store

EMERGENCY_TYPES = {"fire", "medical", "engine_failure", "collision", "sinking", "person_overboard", "other"}


@app.post("/api/emergency/help", status_code=201)
def emergency_help(body: dict):
    emergency_type = (body.get("emergency_type") or "").strip().lower()
    if emergency_type not in EMERGENCY_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid emergency_type. Must be one of: {', '.join(sorted(EMERGENCY_TYPES))}")
    vessel_name = (body.get("vessel_name") or "").strip()
    vessel_mmsi = (body.get("vessel_mmsi") or "").strip()
    if not vessel_name or not vessel_mmsi:
        raise HTTPException(status_code=400, detail="vessel_name and vessel_mmsi are required")
    for field in ("vessel_lat", "vessel_lon", "user_lat", "user_lon"):
        val = body.get(field)
        if val is None or not isinstance(val, (int, float)):
            raise HTTPException(status_code=400, detail=f"{field} is required and must be a number")
    record = emergency_store.create_request({
        "emergency_type": emergency_type,
        "vessel_name": vessel_name,
        "vessel_mmsi": vessel_mmsi,
        "vessel_lat": body["vessel_lat"],
        "vessel_lon": body["vessel_lon"],
        "user_lat": body["user_lat"],
        "user_lon": body["user_lon"],
        "message": (body.get("message") or "").strip()[:500],
    })
    if record is None:
        raise HTTPException(status_code=500, detail="Failed to create emergency request. Storage may be unavailable.")
    return {
        "success": True,
        "request_id": record["id"],
        "status": record["status"],
        "message": "Emergency request created and logged in SafeLink backend. This has NOT been delivered to the target vessel via maritime radio.",
    }


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
