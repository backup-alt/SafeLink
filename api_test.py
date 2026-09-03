from datetime import datetime, timedelta, timezone
from pathlib import Path

import copernicusmarine as cm


# =========================================================
# REGION CONFIGURATION
# =========================================================

# Indian Ocean, including the Arabian Sea and Bay of Bengal
MIN_LONGITUDE = 20.0
MAX_LONGITUDE = 120.0
MIN_LATITUDE = -60.0
MAX_LATITUDE = 30.0

OUTPUT_DIRECTORY = Path("copernicus_data")
OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)


# =========================================================
# DATE CONFIGURATION
# =========================================================

today = datetime.now(timezone.utc).date()

# Forecast data: today to five days ahead
forecast_end_date = today + timedelta(days=5)

forecast_start = f"{today.isoformat()}T00:00:00"
forecast_end = f"{forecast_end_date.isoformat()}T00:00:00"

# Chlorophyll is an observation and may be delayed.
# Download from ten days ago until two days ago.
observation_start_date = today - timedelta(days=10)
observation_end_date = today - timedelta(days=2)

observation_start = (
    f"{observation_start_date.isoformat()}T00:00:00"
)

observation_end = (
    f"{observation_end_date.isoformat()}T23:59:59"
)


# =========================================================
# COPERNICUS DATASETS
# =========================================================

datasets = [
    {
        "name": "Waves",
        "dataset_id": (
            "cmems_mod_glo_wav_anfc_0.083deg_PT3H-i"
        ),
        "variables": [
            "VHM0",   # Significant wave height
            "VMDR",   # Mean wave direction
            "VTM10",  # Mean wave period
        ],
        "start_datetime": forecast_start,
        "end_datetime": forecast_end,
        "filename": f"waves_{today.isoformat()}.nc",
    },
    {
        "name": "Surface currents",
        "dataset_id": (
            "cmems_mod_glo_phy_anfc_merged-uv_PT1H-i"
        ),
        "variables": [
            "uo",  # Eastward current
            "vo",  # Northward current
        ],
        "start_datetime": forecast_start,
        "end_datetime": forecast_end,
        "filename": f"currents_{today.isoformat()}.nc",
    },
    {
        "name": "Sea temperature",
        "dataset_id": (
            "cmems_mod_glo_phy-thetao_anfc_"
            "0.083deg_PT6H-i"
        ),
        "variables": [
            "thetao",
        ],
        "minimum_depth": 0.0,
        "maximum_depth": 1.0,
        "start_datetime": forecast_start,
        "end_datetime": forecast_end,
        "filename": (
            f"sea_temperature_{today.isoformat()}.nc"
        ),
    },
    {
        "name": "Sea level",
        "dataset_id": (
            "cmems_mod_glo_phy_anfc_merged-sl_PT1H-i"
        ),
        "variables": [
            "total_sea_level",
        ],
        "start_datetime": forecast_start,
        "end_datetime": forecast_end,
        "filename": f"sea_level_{today.isoformat()}.nc",
    },
    {
        "name": "Chlorophyll",
        "dataset_id": (
            "cmems_obs-oc_glo_bgc-plankton_nrt_"
            "l4-gapfree-multi-4km_P1D"
        ),
        "variables": [
            "CHL",
        ],
        "start_datetime": observation_start,
        "end_datetime": observation_end,
        "filename": (
            f"chlorophyll_"
            f"{observation_end_date.isoformat()}.nc"
        ),
    },
]


# =========================================================
# DOWNLOAD FUNCTION
# =========================================================

def download_dataset(dataset):
    """Download one Copernicus Marine dataset."""

    print("\n" + "=" * 55)
    print(f"Downloading: {dataset['name']}")
    print(f"Dataset: {dataset['dataset_id']}")
    print(f"Variables: {', '.join(dataset['variables'])}")
    print("=" * 55)

    request = {
        "dataset_id": dataset["dataset_id"],
        "variables": dataset["variables"],

        "minimum_longitude": MIN_LONGITUDE,
        "maximum_longitude": MAX_LONGITUDE,
        "minimum_latitude": MIN_LATITUDE,
        "maximum_latitude": MAX_LATITUDE,

        "start_datetime": dataset["start_datetime"],
        "end_datetime": dataset["end_datetime"],

        "output_directory": str(OUTPUT_DIRECTORY),
        "output_filename": dataset["filename"],

        "file_format": "netcdf",
        "coordinates_selection_method": "inside",
        "netcdf_compression_level": 4,
        "overwrite": True,
    }

    # Add depth only to datasets that contain depth levels
    if "minimum_depth" in dataset:
        request["minimum_depth"] = dataset["minimum_depth"]
        request["maximum_depth"] = dataset["maximum_depth"]

    response = cm.subset(**request)

    downloaded_path = getattr(
        response,
        "file_path",
        OUTPUT_DIRECTORY / dataset["filename"],
    )

    print(f"Downloaded successfully: {downloaded_path}")


# =========================================================
# MAIN PROGRAM
# =========================================================

def main():
    print("\nStarting Copernicus Marine downloads")

    print(
        f"Region: "
        f"{MIN_LONGITUDE}°E to {MAX_LONGITUDE}°E, "
        f"{MIN_LATITUDE}°N to {MAX_LATITUDE}°N"
    )

    print(
        f"Forecast period: "
        f"{forecast_start} to {forecast_end}"
    )

    print(
        f"Chlorophyll observation period: "
        f"{observation_start} to {observation_end}"
    )

    successful = []
    failed = []

    for dataset in datasets:
        try:
            download_dataset(dataset)
            successful.append(dataset["name"])

        except Exception as error:
            print(f"\nFailed to download {dataset['name']}")
            print(f"Reason: {error}")
            failed.append(dataset["name"])

    print("\n" + "=" * 55)
    print("DOWNLOAD SUMMARY")
    print("=" * 55)

    print(f"\nSuccessful: {len(successful)}")

    for name in successful:
        print(f"  ✓ {name}")

    if failed:
        print(f"\nFailed: {len(failed)}")

        for name in failed:
            print(f"  ✗ {name}")
    else:
        print("\nAll datasets downloaded successfully.")

    print(
        f"\nFiles are stored in: "
        f"{OUTPUT_DIRECTORY.resolve()}"
    )


if __name__ == "__main__":
    main()
