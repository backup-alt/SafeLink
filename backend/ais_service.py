"""AIS vessel data proxy with caching. Uses urllib.request (stdlib)."""
from __future__ import annotations

import json
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

CACHE_TTL = 30  # seconds
_cache: dict[str, tuple[float, list[dict]]] = {}


def get_vessels(west: float, south: float, east: float, north: float) -> list[dict]:
    """Fetch real AIS vessels from Open Waters. Returns parsed vessel list."""
    bbox_key = f"{west},{south},{east},{north}"
    cached = _cache.get(bbox_key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]

    url = f"https://ais.openwaters.io/v1/vessels?bbox={south},{west},{north},{east}"
    request = Request(url, headers={"User-Agent": "SafeLink/0.1 (marine navigation hackathon)"})
    with urlopen(request, timeout=15) as response:
        geojson = json.loads(response.read())

    vessels = []
    for feature in geojson.get("features", []):
        props = feature.get("properties", {})
        coords = feature.get("geometry", {}).get("coordinates", [0, 0])
        vessels.append({
            "mmsi": str(props.get("mmsi", "")),
            "name": props.get("name", "") or "",
            "type": str(props.get("type", "")) if props.get("type") is not None else "",
            "latitude": coords[1],
            "longitude": coords[0],
            "speed": float(props.get("sog", 0) or 0),
            "course": float(props.get("cog", 0) or 0),
            "heading": float(props.get("heading", 0) or props.get("cog", 0) or 0),
            "destination": "",
            "eta": "",
            "lastUpdate": props.get("seen", "") or "",
            "navStatus": str(props.get("nav_status", "")),
            "source": props.get("source", "") or "",
        })
    _cache[bbox_key] = (time.time(), vessels)
    return vessels
