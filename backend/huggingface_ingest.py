from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile

from huggingface_hub import (
    CommitOperationAdd,
    CommitOperationDelete,
    HfApi,
    hf_hub_download,
)
import numpy as np
import xarray as xr

from .cloud_ingest import _display_arrays, _iso, _safe_time
from .config import LAYERS
from .refresh import DATASETS, REFRESH_LOCK, STATE, download_dataset_window


def _remote_path(prefix: str, name: str) -> str:
    return f"{prefix}/{name}" if prefix else name


def _existing_manifest(repo_id: str, token: str, manifest_path: str) -> dict | None:
    try:
        local_path = hf_hub_download(
            repo_id=repo_id,
            filename=manifest_path,
            repo_type="dataset",
            token=token,
        )
        return json.loads(Path(local_path).read_text(encoding="utf-8"))
    except Exception:
        return None


def _publish_manifest(
    api: HfApi,
    repo_id: str,
    manifest_path: str,
    run_id: str,
    layers: list[dict],
    *,
    complete: bool,
) -> None:
    manifest = {
        "version": 1,
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "complete": complete,
        "layers": layers,
    }
    api.upload_file(
        repo_id=repo_id,
        repo_type="dataset",
        path_in_repo=manifest_path,
        path_or_fileobj=BytesIO(json.dumps(manifest, separators=(",", ":")).encode()),
        commit_message=(
            f"Complete SafeLink data run {run_id}"
            if complete else f"Checkpoint SafeLink data run {run_id}"
        ),
    )


def _delete_expired_runs(api: HfApi, repo_id: str, prefix: str, run_id: str, keep_days: int = 7) -> None:
    cutoff = (datetime.fromisoformat(run_id).date() - timedelta(days=keep_days - 1)).isoformat()
    runs_prefix = _remote_path(prefix, "runs/")
    expired = []
    for path in api.list_repo_files(repo_id=repo_id, repo_type="dataset"):
        if not path.startswith(runs_prefix):
            continue
        remainder = path[len(runs_prefix):]
        candidate = remainder.split("/", 1)[0]
        if candidate < cutoff:
            expired.append(CommitOperationDelete(path_in_repo=path))
    for offset in range(0, len(expired), 100):
        api.create_commit(
            repo_id=repo_id,
            repo_type="dataset",
            operations=expired[offset:offset + 100],
            commit_message=f"Remove expired SafeLink runs before {cutoff}",
        )


def _upload_layer(
    api: HfApi,
    repo_id: str,
    prefix: str,
    run_id: str,
    layer_id: str,
    path: Path,
    output_dir: Path,
) -> list[dict[str, str]]:
    config = LAYERS[layer_id]
    frames: list[dict[str, str]] = []
    operations: list[CommitOperationAdd] = []
    local_files: list[Path] = []

    def flush() -> None:
        if not operations:
            return
        api.create_commit(
            repo_id=repo_id,
            repo_type="dataset",
            operations=list(operations),
            commit_message=f"Publish {layer_id} frames for {run_id}",
        )
        operations.clear()
        for local_file in local_files:
            local_file.unlink(missing_ok=True)
        local_files.clear()

    with xr.open_dataset(path, engine="h5netcdf") as dataset:
        for time_index, time_value in enumerate(dataset.time.values):
            time = _iso(time_value)
            filename = f"{_safe_time(time)}.npz"
            local_path = output_dir / filename
            archive = BytesIO()
            np.savez_compressed(
                archive,
                **_display_arrays(dataset, config, layer_id, time_index),
            )
            local_path.write_bytes(archive.getvalue())
            key = _remote_path(prefix, f"runs/{run_id}/{layer_id}/{filename}")
            operations.append(CommitOperationAdd(path_in_repo=key, path_or_fileobj=local_path))
            local_files.append(local_path)
            frames.append({"time": time, "key": key, "source_file": path.name})
            if len(operations) >= 24:
                flush()
    flush()
    return frames


def publish() -> bool:
    """Download products sequentially and publish web frames to Hugging Face."""
    if not REFRESH_LOCK.acquire(blocking=False):
        return False
    STATE.running = True
    STATE.last_started = datetime.now(timezone.utc).isoformat()
    STATE.last_error = None
    try:
        repo_id = os.environ["HF_DATASET_REPO"]
        token = os.environ["HF_TOKEN"]
        prefix = os.getenv("SAFELINK_HF_PREFIX", "safelink").strip("/")
        run_id = datetime.now(timezone.utc).date().isoformat()
        manifest_path = _remote_path(prefix, "manifest.json")
        if os.getenv("SAFELINK_FORCE_INGEST", "false").lower() not in {"1", "true", "yes"}:
            existing = _existing_manifest(repo_id, token, manifest_path)
            if existing and existing.get("run_id") == run_id and existing.get("complete") is True:
                STATE.last_completed = datetime.now(timezone.utc).isoformat()
                return False

        api = HfApi(token=token)
        layers = []
        dataset_by_prefix = {prefix_name: values for prefix_name, *values in DATASETS}
        with tempfile.TemporaryDirectory(prefix="safelink-hf-") as temporary:
            working_dir = Path(temporary)
            for layer_id, config in LAYERS.items():
                product_prefix = config.prefix.rstrip("_")
                dataset_id, variables, has_depth = dataset_by_prefix[product_prefix]
                layer_output = working_dir / f"frames-{layer_id}"
                layer_output.mkdir()
                frames = []
                layer_manifest = {
                    "id": layer_id,
                    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "frames": frames,
                }
                layers.append(layer_manifest)
                today = datetime.now(timezone.utc).date()
                if product_prefix == "chlorophyll":
                    first_day, last_day = today - timedelta(days=10), today - timedelta(days=2)
                else:
                    first_day, last_day = today, today + timedelta(days=9)
                day = first_day
                while day <= last_day:
                    path = download_dataset_window(
                        working_dir,
                        product_prefix,
                        dataset_id,
                        variables,
                        has_depth,
                        day,
                        day,
                    )
                    try:
                        frames.extend(
                            _upload_layer(api, repo_id, prefix, run_id, layer_id, path, layer_output)
                        )
                    finally:
                        path.unlink(missing_ok=True)
                    day += timedelta(days=1)
                    frames.sort(key=lambda frame: frame["time"])
                    layer_manifest["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                    _publish_manifest(
                        api, repo_id, manifest_path, run_id, layers, complete=False
                    )
                if not frames:
                    raise RuntimeError(f"No frames were produced for {layer_id}")
                frames.sort(key=lambda frame: frame["time"])

        _publish_manifest(api, repo_id, manifest_path, run_id, layers, complete=True)
        _delete_expired_runs(api, repo_id, prefix, run_id)
        if os.getenv("SAFELINK_HF_SQUASH_HISTORY", "true").lower() in {"1", "true", "yes"}:
            api.super_squash_history(
                repo_id=repo_id,
                repo_type="dataset",
                branch="main",
                commit_message=f"SafeLink data through {run_id}",
            )
        STATE.last_completed = datetime.now(timezone.utc).isoformat()
        return True
    except Exception as error:
        STATE.last_error = str(error)
        raise
    finally:
        STATE.running = False
        REFRESH_LOCK.release()
