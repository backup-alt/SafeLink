"""Nearest point on minor great-circle PFZ segments (mean-radius sphere)."""
import math

RADIUS_KM = 6371.0088


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def unit(v):
    length = math.sqrt(dot(v, v))
    return tuple(x / length for x in v) if length > 1e-14 else None


def vector(point):
    lng, lat = map(math.radians, point[:2])
    return (math.cos(lat)*math.cos(lng), math.cos(lat)*math.sin(lng), math.sin(lat))


def angle(a, b):
    return math.atan2(math.sqrt(dot(cross(a, b), cross(a, b))), dot(a, b))


def nearest_pfz(collection, longitude, latitude):
    if not (math.isfinite(longitude) and math.isfinite(latitude)
            and -180 <= longitude <= 180 and -90 <= latitude <= 90):
        raise ValueError("Invalid origin coordinates")
    origin = vector((longitude, latitude))
    best = None
    for feature in collection['features']:
        for line_index, line in enumerate(feature['geometry']['coordinates']):
            for segment_index, (start, end) in enumerate(zip(line, line[1:])):
                a, b = vector(start), vector(end)
                candidates = [a, b]
                normal = unit(cross(a, b))
                if normal is not None:
                    projected = unit(tuple(p - dot(origin, normal)*n for p, n in zip(origin, normal)))
                    if projected is not None:
                        for q in (projected, tuple(-x for x in projected)):
                            if abs(angle(a, q) + angle(q, b) - angle(a, b)) < 1e-9:
                                candidates.append(q)
                for q in candidates:
                    distance = angle(origin, q)
                    if best is None or distance < best[0]:
                        best = (distance, q, feature, line_index, segment_index)
    if best is None:
        return None
    distance, q, feature, line_index, segment_index = best
    lng = math.degrees(math.atan2(q[1], q[0]))
    lat = math.degrees(math.atan2(q[2], math.hypot(q[0], q[1])))
    p1, p2, delta = map(math.radians, (latitude, lat, lng-longitude))
    bearing = (math.degrees(math.atan2(math.sin(delta)*math.cos(p2),
               math.cos(p1)*math.sin(p2)-math.sin(p1)*math.cos(p2)*math.cos(delta))) + 360) % 360
    return {'feature': feature, 'point': {'lng': lng, 'lat': lat},
            'origin': {'lng': longitude, 'lat': latitude},
            'distance_km': distance * RADIUS_KM,
            'bearing_degrees': bearing if distance * RADIUS_KM > 0.001 else None,
            'line_index': line_index, 'segment_index': segment_index}
