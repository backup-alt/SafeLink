from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timezone
from io import BytesIO
import json
import os
from threading import Lock
from time import monotonic
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

import boto3
import numpy as np

from .config import LAYERS, REGION, LayerConfig


def object_storage_client():
    endpoint = os.environ["SAFELINK_OBJECT_STORAGE_ENDPOINT"]
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.getenv("SAFELINK_OBJECT_STORAGE_REGION", "us-ashburn-1"),
        aws_access_key_id=os.environ["SAFELINK_OBJECT_STORAGE_ACCESS_KEY"],
        aws_secret_access_key=os.environ["SAFELINK_OBJECT_STORAGE_SECRET_KEY"],
    )


class CloudDataRepository:
    """Read web-ready scientific frames from S3-compatible object storage."""

    def __init__(self, client=None, bucket: str | None = None, prefix: str | None = None):
        self.client = client or object_storage_client()
        self.bucket = bucket if bucket is not None else os.environ["SAFELINK_OBJECT_STORAGE_BUCKET"]
        configured_prefix = prefix if prefix is not None else os.getenv("SAFELINK_OBJECT_STORAGE_PREFIX", "safelink")
        self.prefix = configured_prefix.strip("/")
        self._manifest_value: dict[str, Any] | None = None
        self._manifest_loaded_at = 0.0
        self._frames: OrderedDict[str, dict[str, np.ndarray]] = OrderedDict()
        self._lock = Lock()

    def _key(self, name: str) -> str:
        return f"{self.prefix}/{name}" if self.prefix else name

    def _get_bytes(self, key: str) -> bytes:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except Exception as error:
            raise FileNotFoundError(f"Cloud data object is unavailable: {key}") from error

    def _manifest(self) -> dict[str, Any]:
        with self._lock:
            if self._manifest_value is not None and monotonic() - self._manifest_loaded_at < 300:
                return self._manifest_value
        try:
            value = json.loads(self._get_bytes(self._key("manifest.json")))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise FileNotFoundError("Cloud data manifest is invalid") from error
        with self._lock:
            self._manifest_value = value
            self._manifest_loaded_at = monotonic()
        return value

    def _layer(self, layer_id: str) -> tuple[LayerConfig, dict[str, Any]]:
        if layer_id not in LAYERS:
            raise KeyError(layer_id)
        manifest = self._manifest()
        layer = next((item for item in manifest.get("layers", []) if item.get("id") == layer_id), None)
        if not layer or not layer.get("frames"):
            raise FileNotFoundError(f"No cloud data found for {LAYERS[layer_id].label}")
        return LAYERS[layer_id], layer

    @staticmethod
    def _frame_for_time(layer: dict[str, Any], requested_time: str | None) -> dict[str, Any]:
        frames = layer["frames"]
        if not requested_time:
            now = np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None))
            return min(frames, key=lambda frame: abs(np.datetime64(frame["time"].replace("Z", "")) - now))
        target = np.datetime64(requested_time.replace("Z", ""))
        return min(frames, key=lambda frame: abs(np.datetime64(frame["time"].replace("Z", "")) - target))

    def _frame(self, key: str) -> dict[str, np.ndarray]:
        with self._lock:
            cached = self._frames.get(key)
            if cached is not None:
                self._frames.move_to_end(key)
                return cached
        with np.load(BytesIO(self._get_bytes(key)), allow_pickle=False) as archive:
            frame = {name: archive[name].copy() for name in archive.files}
        with self._lock:
            self._frames[key] = frame
            self._frames.move_to_end(key)
            while len(self._frames) > 3:
                self._frames.popitem(last=False)
        return frame

    @staticmethod
    def _clean(values: np.ndarray) -> list[list[float | None]]:
        array = np.asarray(values, dtype=float)
        array[~np.isfinite(array) | (np.abs(array) > 1e10)] = np.nan
        return [[None if np.isnan(value) else round(float(value), 4) for value in row] for row in array]

    def catalog(self) -> dict[str, Any]:
        try:
            manifest = self._manifest()
            remote_layers = {layer["id"]: layer for layer in manifest.get("layers", [])}
        except FileNotFoundError:
            remote_layers = {}
        result = []
        now = datetime.now(timezone.utc)
        for config in LAYERS.values():
            remote = remote_layers.get(config.id)
            frames = remote.get("frames", []) if remote else []
            times = [frame["time"] for frame in frames]
            item: dict[str, Any] = {
                "id": config.id,
                "label": config.label,
                "unit": config.unit,
                "times": times,
                "available": bool(times),
                "palette": config.palette,
                "domain": config.domain,
                "logarithmic": config.logarithmic,
                "vector": config.vector,
            }
            if times:
                latest = datetime.fromisoformat(times[-1].replace("Z", "+00:00"))
                item["updated_at"] = remote.get("updated_at")
                item["observation_age_hours"] = round(max(0.0, (now - latest).total_seconds() / 3600), 1)
            result.append(item)
        return {"region": REGION, "layers": result}

    def field(self, layer_id: str, requested_time: str | None = None) -> dict[str, Any]:
        _, layer = self._layer(layer_id)
        descriptor = self._frame_for_time(layer, requested_time)
        frame = self._frame(descriptor["key"])
        payload: dict[str, Any] = {
            "layer": layer_id,
            "time": descriptor["time"],
            "latitudes": [round(float(value), 6) for value in frame["latitudes"]],
            "longitudes": [round(float(value), 6) for value in frame["longitudes"]],
            "values": self._clean(frame["values"]),
            "unit": LAYERS[layer_id].unit,
            "source_file": descriptor.get("source_file", descriptor["key"].rsplit("/", 1)[-1]),
            "extras": {},
        }
        for name in ("period", "direction"):
            if name in frame:
                payload["extras"][name] = self._clean(frame[name])
        for name in ("u", "v"):
            if name in frame:
                payload[name] = self._clean(frame[name])
        return payload

    def point(
        self,
        layer_id: str,
        latitude: float,
        longitude: float,
        requested_time: str | None = None,
    ) -> dict[str, Any]:
        config, layer = self._layer(layer_id)
        descriptor = self._frame_for_time(layer, requested_time)
        frame = self._frame(descriptor["key"])
        y = int(np.argmin(np.abs(frame["native_latitudes"] - latitude)))
        x = int(np.argmin(np.abs(frame["native_longitudes"] - longitude)))

        def native(name: str) -> float:
            value = float(frame[f"native_{name}"][y, x])
            if not np.isfinite(value) or abs(value) > 1e10:
                raise ValueError("No ocean value at this location")
            return value

        raw = {name: native(name) for name in config.variables}
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


class HuggingFaceDataRepository(CloudDataRepository):
    """Read public or token-protected frames from a Hugging Face dataset."""

    def __init__(self, repo_id: str | None = None, revision: str | None = None, prefix: str | None = None):
        super().__init__(client=object(), bucket="", prefix=prefix)
        self.repo_id = repo_id or os.environ["HF_DATASET_REPO"]
        self.revision = revision or os.getenv("HF_DATASET_REVISION", "main")
        self.token = os.getenv("HF_TOKEN")

    def _get_bytes(self, key: str) -> bytes:
        repo = quote(self.repo_id, safe="/")
        revision = quote(self.revision, safe="")
        path = quote(key, safe="/")
        headers = {"User-Agent": "SafeLink/0.1"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            with urlopen(
                Request(f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{path}", headers=headers),
                timeout=60,
            ) as response:
                return response.read()
        except Exception as error:
            raise FileNotFoundError(f"Hugging Face data object is unavailable: {key}") from error
