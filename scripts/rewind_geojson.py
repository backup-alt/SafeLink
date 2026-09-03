"""Normalize coastline polygon winding for MapLibre fill rendering."""

import json
import sys
from pathlib import Path


def signed_area(ring):
    return sum(
        ring[index][0] * ring[index + 1][1]
        - ring[index + 1][0] * ring[index][1]
        for index in range(len(ring) - 1)
    ) / 2


def rewind_polygon(polygon):
    for index, ring in enumerate(polygon):
        # MapLibre's polygon tessellator expects clockwise exterior rings and
        # counter-clockwise holes for stable fills at the antimeridian.
        should_be_positive = index != 0
        if (signed_area(ring) > 0) != should_be_positive:
            ring.reverse()


def main():
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    split_features = []
    for feature in data["features"]:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "Polygon":
            rewind_polygon(geometry["coordinates"])
            split_features.append(feature)
        elif geometry.get("type") == "MultiPolygon":
            for polygon in geometry["coordinates"]:
                rewind_polygon(polygon)
                # Antarctica crosses the antimeridian and is outside SafeLink's
                # data extent. Omitting it prevents world-wrap fill artifacts.
                if max(point[1] for ring in polygon for point in ring) < -60:
                    continue
                split_features.append({
                    "type": "Feature",
                    "properties": feature.get("properties", {}),
                    "geometry": {"type": "Polygon", "coordinates": polygon},
                })
    data["features"] = split_features
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
