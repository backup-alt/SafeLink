import os
from datetime import datetime, timedelta, timezone

import copernicusmarine
MIN_LONGITUDE = 76.0
MAX_LONGITUDE = 83.0
MIN_LATITUDE = 7.0
MAX_LATITUDE = 15.0
DAYS_BACK = 8

OUTPUT_DIR = "copernicus_data"

os.makedirs(OUTPUT_DIR, exist_ok=True)

now = datetime.now(timezone.utc)
end_date = now.replace(
    hour=0,
    minute=0,
    second=0,
    microsecond=0
)

start_date = end_date - timedelta(days=DAYS_BACK)

START_DATETIME = start_date.strftime("%Y-%m-%dT00:00:00")
END_DATETIME = end_date.strftime("%Y-%m-%dT00:00:00")


print("=" * 70)
print("ORCA - COPERNICUS MARINE DOWNLOADER")
print("=" * 70)

print(
    f"""
Region:
Longitude : {MIN_LONGITUDE} -> {MAX_LONGITUDE}
Latitude  : {MIN_LATITUDE} -> {MAX_LATITUDE}

Time:
{START_DATETIME}
to
{END_DATETIME}

Output:
{os.path.abspath(OUTPUT_DIR)}
"""
)


# ============================================================
# DOWNLOAD HELPER
# ============================================================

def download_dataset(
    name,
    dataset_id,
    variables,
    output_filename,
    minimum_depth=None,
    maximum_depth=None
):

    print("\n" + "=" * 70)
    print(f"Downloading: {name}")
    print(f"Dataset: {dataset_id}")
    print(f"Variables: {variables}")
    print("=" * 70)

    try:

        kwargs = {
            "dataset_id": dataset_id,
            "variables": variables,

            "minimum_longitude": MIN_LONGITUDE,
            "maximum_longitude": MAX_LONGITUDE,

            "minimum_latitude": MIN_LATITUDE,
            "maximum_latitude": MAX_LATITUDE,

            "start_datetime": START_DATETIME,
            "end_datetime": END_DATETIME,

            "output_directory": OUTPUT_DIR,
            "output_filename": output_filename,

            "overwrite": True
        }

        # Only include depth when the dataset supports depth.
        if minimum_depth is not None:
            kwargs["minimum_depth"] = minimum_depth

        if maximum_depth is not None:
            kwargs["maximum_depth"] = maximum_depth

        result = copernicusmarine.subset(**kwargs)

        print(f"\n✓ {name} downloaded successfully")
        print(f"✓ File: {output_filename}")

        return result

    except Exception as e:

        print(f"\n✗ Failed to download {name}")
        print(f"Error: {e}")

        return None

download_dataset(

    name="Sea Surface Temperature",

    dataset_id=
    "cmems_mod_glo_phy_anfc_0.083deg_P1D-m",

    variables=[
        "thetao"
    ],

    minimum_depth=0,
    maximum_depth=1,

    output_filename=
    "sea_temperature.nc"
)


download_dataset(

    name="Surface Ocean Currents",

    dataset_id=
    "cmems_mod_glo_phy_anfc_0.083deg_P1D-m",

    variables=[
        "uo",
        "vo"
    ],

    minimum_depth=0,
    maximum_depth=1,

    output_filename=
    "currents.nc"
)

download_dataset(

    name="Ocean Waves",

    dataset_id=
    "cmems_mod_glo_wav_anfc_0.083deg_PT3H-i",

    variables=[
        "VHM0",
        "VMDR",
        "VTPK"
    ],

    output_filename=
    "waves.nc"
)


download_dataset(

    name="Chlorophyll",

    dataset_id=
    "cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m",

    variables=[
        "chl"
    ],

    minimum_depth=0,
    maximum_depth=1,

    output_filename=
    "chlorophyll.nc"
)


download_dataset(

    name="Sea Surface Height",

    dataset_id=
    "cmems_mod_glo_phy_anfc_0.083deg_P1D-m",

    variables=[
        "zos"
    ],

    output_filename=
    "sea_level.nc"
)

print("\n")
print("=" * 70)
print("DOWNLOAD PROCESS FINISHED")
print("=" * 70)

print(
    f"""
Expected files:

{OUTPUT_DIR}/
    sea_temperature.nc
    currents.nc
    waves.nc
    chlorophyll.nc
    sea_level.nc
"""
)