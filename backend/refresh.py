from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

import copernicusmarine

from .config import REGION

LOGGER = logging.getLogger("safelink.refresh")
REFRESH_LOCK = Lock()

DATASETS = (
    ("waves", "cmems_mod_glo_wav_anfc_0.083deg_PT3H-i", ["VHM0", "VMDR", "VTM10"], False),
    ("currents", "cmems_mod_glo_phy_anfc_merged-uv_PT1H-i", ["uo", "vo"], False),
    ("sea_temperature", "cmems_mod_glo_phy-thetao_anfc_0.083deg_PT6H-i", ["thetao"], True),
    ("sea_level", "cmems_mod_glo_phy_anfc_merged-sl_PT1H-i", ["total_sea_level"], False),
    ("chlorophyll", "cmems_obs-oc_glo_bgc-plankton_nrt_l4-gapfree-multi-4km_P1D", ["CHL"], False),
)


class RefreshState:
    running = False
    last_started: str | None = None
    last_completed: str | None = None
    last_error: str | None = None


STATE = RefreshState()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _prune(data_dir: Path, keep_days: int = 7) -> None:
    cutoff = _utc_now() - timedelta(days=keep_days)
    for path in data_dir.glob("*.nc"):
        modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        if modified < cutoff:
            path.unlink(missing_ok=True)


def _needs_refresh(data_dir: Path) -> bool:
    freshness_limit = _utc_now() - timedelta(hours=5, minutes=45)
    for prefix, *_ in DATASETS:
        files = list(data_dir.glob(f"{prefix}_*.nc"))
        if not files:
            return True
        newest = max(datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) for path in files)
        if newest < freshness_limit:
            return True
    return False


def download_dataset(
    data_dir: Path,
    prefix: str,
    dataset_id: str,
    variables: list[str],
    has_depth: bool,
) -> Path:
    """Download one product and return its completed NetCDF path."""
    today = _utc_now().date()
    forecast_end = today + timedelta(days=9)
    is_observation = prefix == "chlorophyll"
    start_date = today - timedelta(days=10) if is_observation else today
    end_date = today - timedelta(days=2) if is_observation else forecast_end
    filename_date = end_date if is_observation else today
    return download_dataset_window(
        data_dir, prefix, dataset_id, variables, has_depth, start_date, end_date,
        filename=f"{prefix}_{filename_date.isoformat()}.nc",
    )


def download_dataset_window(
    data_dir: Path,
    prefix: str,
    dataset_id: str,
    variables: list[str],
    has_depth: bool,
    start_date,
    end_date,
    *,
    filename: str | None = None,
) -> Path:
    """Download a bounded product window to limit peak disk and memory usage."""
    data_dir.mkdir(parents=True, exist_ok=True)
    filename = filename or f"{prefix}_{start_date.isoformat()}_{end_date.isoformat()}.nc"
    final_path = data_dir / filename
    temporary_path = data_dir / f".{filename}.part.nc"
    request = {
        "dataset_id": dataset_id,
        "variables": variables,
        **REGION,
        "start_datetime": f"{start_date.isoformat()}T00:00:00",
        "end_datetime": f"{end_date.isoformat()}T23:59:59",
        "output_directory": str(data_dir),
        "output_filename": temporary_path.name,
        "file_format": "netcdf",
        "coordinates_selection_method": "inside",
        # Compression makes xarray materialize the complete subset before writing,
        # which exceeds small Railway containers. The publisher compresses each
        # web frame immediately afterwards, so raw NetCDF compression is wasteful.
        "netcdf_compression_level": 0,
        "disable_progress_bar": True,
        "overwrite": True,
    }
    if has_depth:
        request.update({"minimum_depth": 0.0, "maximum_depth": 1.0})
    try:
        copernicusmarine.subset(**request)
        if not temporary_path.exists():
            raise RuntimeError(f"Copernicus did not produce {temporary_path.name}")
        temporary_path.replace(final_path)
        return final_path
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def refresh_once(data_dir: Path) -> None:
    if not REFRESH_LOCK.acquire(blocking=False):
        return
    STATE.running = True
    STATE.last_started = _utc_now().isoformat()
    STATE.last_error = None
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        for prefix, dataset_id, variables, has_depth in DATASETS:
            try:
                download_dataset(data_dir, prefix, dataset_id, variables, has_depth)
            except Exception as error:  # Continue so one unavailable product does not block the others.
                LOGGER.exception("Could not refresh %s", prefix)
                STATE.last_error = f"{prefix}: {error}"
        _prune(data_dir)
        STATE.last_completed = _utc_now().isoformat()
    finally:
        STATE.running = False
        REFRESH_LOCK.release()


async def refresh_loop(data_dir: Path) -> None:
    await asyncio.sleep(5)
    while True:
        if (
            os.getenv("SAFELINK_AUTO_REFRESH", "true").lower() in {"1", "true", "yes"}
            and _needs_refresh(data_dir)
        ):
            await asyncio.to_thread(refresh_once, data_dir)
        await asyncio.sleep(6 * 60 * 60)
