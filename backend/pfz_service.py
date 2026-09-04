"""Independent, process-local cache for official INCOIS PFZ vector advisories."""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
import logging
import math
from threading import Lock
from time import monotonic
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)
PFZ_URL = (
    "https://incois.gov.in/geoserver/PFZ_Automation/ows?service=WFS&version=1.0.0"
    "&request=GetFeature&typeName=PFZ_Automation:pfzlines&outputFormat=application/json"
)
MAX_RESPONSE_BYTES = 10 * 1024 * 1024


class PFZUnavailable(Exception):
    """No successful upstream data is available."""


def advisory_date(properties: dict) -> str | None:
    try:
        year = int(str(properties.get("Year", "")))
        day = int(str(properties.get("Julian_day", "")))
        if not 1 <= day <= 366:
            return None
        result = date(year, 1, 1) + timedelta(days=day - 1)
        return result.isoformat() if result.year == year else None
    except (ValueError, TypeError, OverflowError):
        return None


def validate_collection(payload: object) -> dict:
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise ValueError("INCOIS did not return a GeoJSON FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("INCOIS features must be a list")
    crs = payload.get("crs")
    if crs is not None:
        crs_properties = crs.get("properties") if isinstance(crs, dict) else None
        name = crs_properties.get("name", "") if isinstance(crs_properties, dict) else ""
        if name not in {"EPSG:4326", "urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:OGC:1.3:CRS84"}:
            raise ValueError("Unsupported INCOIS coordinate reference system")
    result = []
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError(f"Malformed PFZ feature {index}")
        geometry = feature.get("geometry")
        properties = feature.get("properties")
        if not isinstance(geometry, dict) or geometry.get("type") != "MultiLineString" or not isinstance(properties, dict):
            raise ValueError(f"Malformed PFZ geometry/properties at {index}")
        if properties.get("Sno") is not None and (isinstance(properties["Sno"], bool) or not isinstance(properties["Sno"], (str, int))):
            raise ValueError(f"Invalid PFZ number at {index}")
        length = properties.get("Length")
        if length is not None and (isinstance(length, bool) or not isinstance(length, (int, float)) or not math.isfinite(length) or length < 0):
            raise ValueError(f"Invalid PFZ length at {index}")
        lines = geometry.get("coordinates")
        if not isinstance(lines, list) or not lines:
            raise ValueError(f"Empty PFZ geometry at {index}")
        for line in lines:
            if not isinstance(line, list) or len(line) < 2:
                raise ValueError(f"Invalid PFZ line at {index}")
            for point in line:
                if (not isinstance(point, list) or len(point) not in (2, 3)
                    or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point)
                    or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90):
                    raise ValueError(f"Invalid PFZ coordinate at {index}")
        # Keep upstream properties and geometry, adding only a derived date and
        # a unique render ID (upstream identifiers remain in properties).
        result.append({"type": "Feature", "id": index, "geometry": deepcopy(geometry),
                       "properties": {**properties, "advisory_date": advisory_date(properties)}})
    return {"type": "FeatureCollection", "features": result}


class PFZService:
    def __init__(self, ttl_seconds: float = 20 * 60, retry_seconds: float = 60):
        self.ttl_seconds = ttl_seconds
        self.retry_seconds = retry_seconds
        self._lock = Lock()
        self._cached: dict | None = None
        self._next_attempt = 0.0
        self._stale = False

    def _fetch(self) -> object:
        request = Request(PFZ_URL, headers={
            "User-Agent": "SafeLink/0.1 (INCOIS PFZ advisory viewer; https://github.com/backup-alt/SafeLink)",
            "Accept": "application/json",
        })
        with urlopen(request, timeout=12) as response:
            content = response.read(MAX_RESPONSE_BYTES + 1)
        if len(content) > MAX_RESPONSE_BYTES:
            raise ValueError("INCOIS response exceeds the size limit")
        def reject_constant(value: str):
            raise ValueError(f"Non-finite JSON number: {value}")
        return json.loads(content, parse_constant=reject_constant)

    def get(self) -> dict:
        # Serialize refreshes so simultaneous browsers do not stampede INCOIS.
        with self._lock:
            if monotonic() >= self._next_attempt:
                try:
                    data = validate_collection(self._fetch())
                    dates = sorted({f["properties"]["advisory_date"] for f in data["features"]
                                    if f["properties"]["advisory_date"]})
                    self._cached = {"data": data, "metadata": {
                        "source": "INCOIS",
                        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "advisory_date": dates[-1] if dates else None,
                        "advisory_dates": dates,
                        "feature_count": len(data["features"]),
                        "stale": False,
                    }}
                    self._stale = False
                    self._next_attempt = monotonic() + self.ttl_seconds
                except (OSError, ValueError, TypeError) as error:
                    LOGGER.warning("INCOIS PFZ refresh failed: %s", error, exc_info=True)
                    self._stale = True
                    self._next_attempt = monotonic() + self.retry_seconds
            if self._cached is None:
                raise PFZUnavailable("INCOIS PFZ advisories are temporarily unavailable")
            result = deepcopy(self._cached)
            result["metadata"]["stale"] = self._stale
            return result
