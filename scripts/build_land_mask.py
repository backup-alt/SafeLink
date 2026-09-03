"""Rasterize Natural Earth land polygons in SafeLink's Web Mercator extent."""

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

WIDTH = 4096
HEIGHT = 4096
WEST, SOUTH, EAST, NORTH = 20.0, -60.0, 120.0, 30.0


def mercator_y(latitude: float) -> float:
    radians = math.radians(max(-85.0, min(85.0, latitude)))
    return 0.5 - math.log((1 + math.sin(radians)) / (1 - math.sin(radians))) / (4 * math.pi)


TOP = mercator_y(NORTH)
BOTTOM = mercator_y(SOUTH)


def pixel(point):
    longitude, latitude = point[:2]
    return (
        round((longitude - WEST) / (EAST - WEST) * WIDTH),
        round((mercator_y(latitude) - TOP) / (BOTTOM - TOP) * HEIGHT),
    )


def main():
    root = Path(__file__).resolve().parents[1]
    source = root / "public" / "ne_10m_land.geojson"
    target = root / "public" / "indian-ocean-land-mask.png"
    data = json.loads(source.read_text(encoding="utf-8"))
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for feature in data["features"]:
        geometry = feature.get("geometry") or {}
        polygons = [geometry["coordinates"]] if geometry.get("type") == "Polygon" else geometry.get("coordinates", [])
        for polygon in polygons:
            draw.polygon([pixel(point) for point in polygon[0]], fill=(12, 12, 12, 255))
            for hole in polygon[1:]:
                draw.polygon([pixel(point) for point in hole], fill=(0, 0, 0, 0))
    image.save(target, optimize=True)
    print(f"Wrote {target} ({target.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
