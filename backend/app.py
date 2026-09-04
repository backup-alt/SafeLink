from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from functools import lru_cache
from io import BytesIO
import json
import os
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
import mapbox_vector_tile
from PIL import Image, ImageDraw, ImageOps

from .data_service import DataRepository
from .cloud_repository import CloudDataRepository, HuggingFaceDataRepository
from .huggingface_ingest import publish as publish_huggingface
from .refresh import STATE, refresh_loop

ROOT = Path(__file__).resolve().parents[1]
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


@asynccontextmanager
async def lifespan(_: FastAPI):
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


app = FastAPI(title="SafeLink Ocean API", version="0.1.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/catalog")
def catalog():
    return repository.catalog()


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


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
