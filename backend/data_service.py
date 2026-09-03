from __future__ import annotations

from datetime import datetime, timezone
from math import ceil
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr

from .config import LAYERS, REGION, LayerConfig


class DataRepository:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self._field_cache: dict[tuple[str, str | None, int], dict[str, Any]] = {}

    def _latest_file(self, config: LayerConfig) -> Path:
        matches = sorted(
            self.data_dir.glob(f"{config.prefix}*.nc"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if not matches:
            raise FileNotFoundError(f"No data file found for {config.label}")
        return matches[0]

    @staticmethod
    def _iso(value: Any) -> str:
        timestamp = np.datetime64(value, "s").astype("datetime64[s]").astype(str)
        return f"{timestamp}Z"

    def catalog(self) -> dict[str, Any]:
        result = []
        now = datetime.now(timezone.utc)
        for layer in LAYERS.values():
            try:
                path = self._latest_file(layer)
                with xr.open_dataset(path, engine="h5netcdf") as dataset:
                    times = [self._iso(value) for value in dataset.time.values]
                modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                latest_time = datetime.fromisoformat(times[-1].replace("Z", "+00:00"))
                age_hours = max(0.0, (now - latest_time).total_seconds() / 3600)
                result.append({
                    "id": layer.id,
                    "label": layer.label,
                    "unit": layer.unit,
                    "times": times,
                    "available": True,
                    "updated_at": modified.isoformat().replace("+00:00", "Z"),
                    "observation_age_hours": round(age_hours, 1),
                    "palette": layer.palette,
                    "domain": layer.domain,
                    "logarithmic": layer.logarithmic,
                    "vector": layer.vector,
                })
            except (FileNotFoundError, OSError, KeyError):
                result.append({
                    "id": layer.id,
                    "label": layer.label,
                    "unit": layer.unit,
                    "times": [],
                    "available": False,
                    "palette": layer.palette,
                    "domain": layer.domain,
                    "logarithmic": layer.logarithmic,
                    "vector": layer.vector,
                })
        return {"region": REGION, "layers": result}

    @staticmethod
    def _clean(values: np.ndarray) -> list[list[float | None]]:
        array = np.asarray(values, dtype=float)
        array[~np.isfinite(array) | (np.abs(array) > 1e10)] = np.nan
        return [[None if np.isnan(v) else round(float(v), 4) for v in row] for row in array]

    @staticmethod
    def _surface_at(
        variable: xr.DataArray,
        time_index: int,
        latitude_step: int,
        longitude_step: int,
    ) -> np.ndarray:
        selection = variable.isel(time=time_index)
        if "depth" in selection.dims:
            selection = selection.isel(depth=0)
        selection = selection.isel(
            latitude=slice(None, None, latitude_step),
            longitude=slice(None, None, longitude_step),
        )
        return selection.transpose("latitude", "longitude").values

    def field(self, layer_id: str, requested_time: str | None = None) -> dict[str, Any]:
        if layer_id not in LAYERS:
            raise KeyError(layer_id)
        config = LAYERS[layer_id]
        path = self._latest_file(config)
        cache_key = (layer_id, requested_time, path.stat().st_mtime_ns)
        cached = self._field_cache.get(cache_key)
        if cached is not None:
            return cached
        with xr.open_dataset(path, engine="h5netcdf") as dataset:
            times = np.asarray(dataset.time.values)
            # Scalar layers can carry more coastline detail without the multiple
            # component arrays required by animated vector layers.
            sample_limit = 600 if config.vector else (900 if layer_id == "chlorophyll" else 560)
            latitude_step = max(1, ceil(dataset.sizes["latitude"] / sample_limit))
            longitude_step = max(1, ceil(dataset.sizes["longitude"] / sample_limit))
            if requested_time:
                target = np.datetime64(requested_time.replace("Z", ""))
                time_index = int(np.argmin(np.abs(times - target)))
            else:
                now = np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None))
                time_index = int(np.argmin(np.abs(times - now)))

            raw = {
                name: self._surface_at(dataset[name], time_index, latitude_step, longitude_step)
                for name in config.variables
            }
            if layer_id == "waves":
                values = raw["VHM0"]
                toward = np.deg2rad(raw["VMDR"] + 180.0)
                u = np.sin(toward) * values
                v = np.cos(toward) * values
                extras = {"period": self._clean(raw["VTM10"]), "direction": self._clean(raw["VMDR"])}
            elif layer_id == "currents":
                u, v = raw["uo"], raw["vo"]
                values = np.hypot(u, v) * 1.943844
                extras = {}
            else:
                values = next(iter(raw.values()))
                u = v = None
                extras = {}

            payload: dict[str, Any] = {
                "layer": layer_id,
                "time": self._iso(times[time_index]),
                "latitudes": [
                    round(float(value), 6)
                    for value in dataset.latitude.values[::latitude_step]
                ],
                "longitudes": [
                    round(float(value), 6)
                    for value in dataset.longitude.values[::longitude_step]
                ],
                "values": self._clean(values),
                "unit": config.unit,
                "source_file": path.name,
                "extras": extras,
            }
            if u is not None and v is not None:
                payload["u"] = self._clean(u)
                payload["v"] = self._clean(v)
            self._field_cache[cache_key] = payload
            while len(self._field_cache) > 24:
                self._field_cache.pop(next(iter(self._field_cache)))
            return payload

    def point(
        self,
        layer_id: str,
        latitude: float,
        longitude: float,
        requested_time: str | None = None,
    ) -> dict[str, Any]:
        """Read a clicked value from the native grid without display downsampling."""
        if layer_id not in LAYERS:
            raise KeyError(layer_id)
        config = LAYERS[layer_id]
        path = self._latest_file(config)
        with xr.open_dataset(path, engine="h5netcdf") as dataset:
            times = np.asarray(dataset.time.values)
            if requested_time:
                target = np.datetime64(requested_time.replace("Z", ""))
                time_index = int(np.argmin(np.abs(times - target)))
            else:
                now = np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None))
                time_index = int(np.argmin(np.abs(times - now)))

            def native_value(name: str) -> float:
                selection = dataset[name].isel(time=time_index)
                if "depth" in selection.dims:
                    selection = selection.isel(depth=0)
                value = float(selection.sel(
                    latitude=latitude,
                    longitude=longitude,
                    method="nearest",
                ).values)
                if not np.isfinite(value) or abs(value) > 1e10:
                    raise ValueError("No ocean value at this location")
                return value

            raw = {name: native_value(name) for name in config.variables}
            if layer_id == "waves":
                value = raw["VHM0"]
                extras = {"period": raw["VTM10"], "direction": raw["VMDR"]}
            elif layer_id == "currents":
                value = float(np.hypot(raw["uo"], raw["vo"]) * 1.943844)
                extras = {}
            else:
                value = next(iter(raw.values()))
                extras = {}
            return {
                "lng": longitude,
                "lat": latitude,
                "value": round(value, 4),
                **{key: round(number, 4) for key, number in extras.items()},
            }
