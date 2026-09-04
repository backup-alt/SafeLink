from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
from typing import Any

import numpy as np
import xarray as xr

from .cloud_repository import object_storage_client
from .config import LAYERS, REGION, LayerConfig
from .data_service import DataRepository
from .refresh import refresh_once


def _iso(value: Any) -> str:
    timestamp = np.datetime64(value, "s").astype("datetime64[s]").astype(str)
    return f"{timestamp}Z"


def _safe_time(value: str) -> str:
    return value.replace("-", "").replace(":", "").replace("Z", "Z")


def _surface(variable: xr.DataArray, time_index: int) -> np.ndarray:
    selection = variable.isel(time=time_index)
    if "depth" in selection.dims:
        selection = selection.isel(depth=0)
    return np.asarray(selection.transpose("latitude", "longitude").values, dtype=np.float32)


def _display_arrays(dataset: xr.Dataset, config: LayerConfig, layer_id: str, time_index: int) -> dict[str, np.ndarray]:
    # A browser cannot usefully render the native million-cell basin grid. Keep a
    # dense, uniform display/inspection grid and avoid embedding a duplicate native
    # copy in every timestamp (which made each HF upload several megabytes larger).
    sample_limit = 360 if config.vector else (600 if layer_id == "chlorophyll" else 420)
    latitude_step = max(1, int(np.ceil(dataset.sizes["latitude"] / sample_limit)))
    longitude_step = max(1, int(np.ceil(dataset.sizes["longitude"] / sample_limit)))
    raw = {name: _surface(dataset[name], time_index) for name in config.variables}
    sampled = {
        name: values[::latitude_step, ::longitude_step]
        for name, values in raw.items()
    }
    if layer_id == "waves":
        values = sampled["VHM0"]
        toward = np.deg2rad(sampled["VMDR"] + 180.0)
        display = {
            "values": values,
            "u": np.sin(toward) * values,
            "v": np.cos(toward) * values,
            "period": sampled["VTM10"],
            "direction": sampled["VMDR"],
        }
    elif layer_id == "currents":
        display = {
            "values": np.hypot(sampled["uo"], sampled["vo"]) * 1.943844,
            "u": sampled["uo"],
            "v": sampled["vo"],
        }
    else:
        display = {"values": next(iter(sampled.values()))}
    return {
        "latitudes": np.asarray(dataset.latitude.values[::latitude_step], dtype=np.float32),
        "longitudes": np.asarray(dataset.longitude.values[::longitude_step], dtype=np.float32),
        "native_latitudes": np.asarray(dataset.latitude.values[::latitude_step], dtype=np.float32),
        "native_longitudes": np.asarray(dataset.longitude.values[::longitude_step], dtype=np.float32),
        **{key: np.asarray(value, dtype=np.float32) for key, value in display.items()},
        **{f"native_{key}": value[::latitude_step, ::longitude_step] for key, value in raw.items()},
    }


def _existing_run(client, bucket: str, manifest_key: str) -> str | None:
    try:
        body = client.get_object(Bucket=bucket, Key=manifest_key)["Body"].read()
        return json.loads(body).get("run_id")
    except Exception:
        return None


def _remove_expired_runs(client, bucket: str, prefix: str, keep_days: int = 7) -> None:
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=keep_days - 1)).isoformat()
    paginator = client.get_paginator("list_objects_v2")
    expired: list[dict[str, str]] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{prefix}/runs/"):
        for item in page.get("Contents", []):
            parts = item["Key"].split("/")
            if len(parts) >= 3 and parts[-3] < cutoff:
                expired.append({"Key": item["Key"]})
    for offset in range(0, len(expired), 1000):
        client.delete_objects(Bucket=bucket, Delete={"Objects": expired[offset:offset + 1000], "Quiet": True})


def publish() -> None:
    bucket = os.environ["SAFELINK_OBJECT_STORAGE_BUCKET"]
    prefix = os.getenv("SAFELINK_OBJECT_STORAGE_PREFIX", "safelink").strip("/")
    run_id = datetime.now(timezone.utc).date().isoformat()
    client = object_storage_client()
    manifest_key = f"{prefix}/manifest.json" if prefix else "manifest.json"
    if os.getenv("SAFELINK_FORCE_INGEST", "false").lower() not in {"1", "true", "yes"}:
        if _existing_run(client, bucket, manifest_key) == run_id:
            print(f"Cloud data run {run_id} already exists; nothing to publish.")
            return

    with tempfile.TemporaryDirectory(prefix="safelink-ingest-") as temporary:
        data_dir = Path(temporary)
        refresh_once(data_dir)
        repository = DataRepository(data_dir)
        layers = []
        for layer_id, config in LAYERS.items():
            path = repository._latest_file(config)
            frames = []
            with xr.open_dataset(path, engine="h5netcdf") as dataset:
                for time_index, time_value in enumerate(dataset.time.values):
                    time = _iso(time_value)
                    key = f"{prefix}/runs/{run_id}/{layer_id}/{_safe_time(time)}.npz" if prefix else f"runs/{run_id}/{layer_id}/{_safe_time(time)}.npz"
                    archive = BytesIO()
                    np.savez_compressed(archive, **_display_arrays(dataset, config, layer_id, time_index))
                    client.put_object(
                        Bucket=bucket,
                        Key=key,
                        Body=archive.getvalue(),
                        ContentType="application/octet-stream",
                    )
                    frames.append({"time": time, "key": key, "source_file": path.name})
            layers.append({
                "id": layer_id,
                "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "frames": frames,
            })

        manifest = {
            "version": 1,
            "run_id": run_id,
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "region": REGION,
            "layers": layers,
        }
        client.put_object(
            Bucket=bucket,
            Key=manifest_key,
            Body=json.dumps(manifest, separators=(",", ":")).encode(),
            ContentType="application/json",
        )
        _remove_expired_runs(client, bucket, prefix)
        print(f"Published SafeLink cloud data run {run_id} with {sum(len(layer['frames']) for layer in layers)} frames.")


if __name__ == "__main__":
    publish()
