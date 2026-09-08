from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import app


_mock_forecast = {
    "time": "2026-01-01T00:00",
    "wave_height": {"value": 0.5, "unit": "m", "source": "mock"},
    "wave_direction": {"value": 90, "unit": "deg", "source": "mock"},
    "wave_period": {"value": 4, "unit": "s", "source": "mock"},
    "temperature": {"value": 28, "unit": "C", "source": "mock"},
    "current_speed": {"value": 0.2, "unit": "kn", "source": "mock"},
    "current_direction": {"value": 45, "unit": "deg", "source": "mock"},
}


def _patched_route(client, payload):
    with patch("backend.app._marine_forecast", return_value=_mock_forecast), \
         patch("backend.app._traffic_score_along_route", return_value=("low", 0)), \
         patch("backend.app._pfz_proximity_score", return_value=(0.5, "No active PFZ zones")):
        return client.post("/api/route", json=payload)


class RoutePlanningTests(TestCase):
    def test_route_inserts_detours_for_land_crossing(self):
        client = TestClient(app)
        response = _patched_route(client, {
            "origin": [76.27213, 9.96482],
            "destination": [76.9, 8.5],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        self.assertIn("safest", data)
        self.assertIn("direct", data)
        shortest = data["direct"]["route"]
        self.assertGreater(len(shortest["legs"]), 1)
        self.assertTrue(any("avoid land" in w["message"] for w in shortest["warnings"]))

    def test_two_route_groups_are_distinct(self):
        client = TestClient(app)
        response = _patched_route(client, {
            "origin": [76.27213, 9.96482],
            "destination": [76.9, 8.5],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        safest_dist = data["safest"]["route"]["distance_km"]
        direct_dist = data["direct"]["route"]["distance_km"]
        self.assertGreater(safest_dist, 0)
        self.assertGreater(direct_dist, 0)

    def test_no_land_crossings_in_any_route(self):
        client = TestClient(app)
        response = _patched_route(client, {
            "origin": [76.27213, 9.96482],
            "destination": [76.9, 8.5],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        for key in ("safest", "direct"):
            route = data[key]["route"]
            unresolved = [w for w in route["warnings"] if w["type"] == "restricted"]
            self.assertEqual(len(unresolved), 0, f"{key} has unresolved land crossings: {unresolved}")

    def test_all_routes_have_positive_distance(self):
        client = TestClient(app)
        response = _patched_route(client, {
            "origin": [72.8, 8.5],
            "destination": [77.5, 8.0],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        for key in ("safest", "direct"):
            route = data[key]["route"]
            self.assertGreater(route["distance_km"], 0, f"{key} has zero distance")
            self.assertGreater(len(route["coordinates"]), 2, f"{key} has too few coordinates")

    def test_route_groups_have_weather_metadata(self):
        client = TestClient(app)
        response = _patched_route(client, {
            "origin": [72.8, 8.5],
            "destination": [77.5, 8.0],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        for key in ("safest", "direct"):
            group = data[key]
            self.assertIn("weather_summary", group)
            self.assertIn("traffic_level", group)
            self.assertIn("weather_score", group)
            self.assertIn("pfz_summary", group)
