from dataclasses import dataclass


REGION = {
    # Indian Ocean basin, including the Arabian Sea and Bay of Bengal.
    "minimum_longitude": 20.0,
    "maximum_longitude": 120.0,
    "minimum_latitude": -60.0,
    "maximum_latitude": 30.0,
}


@dataclass(frozen=True)
class LayerConfig:
    id: str
    label: str
    prefix: str
    variables: tuple[str, ...]
    unit: str
    palette: tuple[str, ...]
    domain: tuple[float, float]
    vector: bool = False
    logarithmic: bool = False


LAYERS = {
    "waves": LayerConfig(
        "waves", "Waves", "waves_", ("VHM0", "VMDR", "VTM10"), "m",
        ("#155a94", "#36c5c9", "#43b982", "#7558d7", "#e548b7", "#ff665a"),
        (0.0, 5.0), True,
    ),
    "currents": LayerConfig(
        "currents", "Currents", "currents_", ("uo", "vo"), "kn",
        ("#153657", "#086e98", "#08bec4", "#6bd56d", "#f2d95c", "#f06a4e"),
        (0.0, 2.0), True,
    ),
    "temperature": LayerConfig(
        "temperature", "Sea temperature", "sea_temperature_", ("thetao",), "°C",
        ("#283593", "#1976d2", "#00acc1", "#66bb6a", "#fdd835", "#ef5350"),
        (20.0, 34.0),
    ),
    "sea_level": LayerConfig(
        "sea_level", "Sea level", "sea_level_", ("total_sea_level",), "m",
        ("#263b80", "#1976d2", "#13c7c7", "#f4e75b", "#f06a4e", "#ba2c66"),
        (-1.0, 1.0),
    ),
    "chlorophyll": LayerConfig(
        "chlorophyll", "Chlorophyll", "chlorophyll_", ("CHL",), "mg/m³",
        ("#33155f", "#214ec2", "#008dc4", "#00aa7d", "#9bd93c", "#f4de3d"),
        (0.05, 10.0), False, True,
    ),
}
