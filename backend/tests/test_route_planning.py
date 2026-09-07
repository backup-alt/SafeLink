from unittest import TestCase

from fastapi.testclient import TestClient

from backend.app import app


class RoutePlanningTests(TestCase):
    def test_route_inserts_detours_for_land_crossing(self):
        client = TestClient(app)
        response = client.post("/api/route", json={
            "origin": [76.27213, 9.96482],
            "destination": [76.9, 8.5],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        alternatives = data["alternatives"]
        self.assertEqual(len(alternatives), 3)
        shortest = alternatives[0]
        self.assertGreater(len(shortest["legs"]), 1)
        self.assertTrue(any("avoid land" in w["message"] for w in shortest["warnings"]))

    def test_three_alternatives_are_distinct(self):
        client = TestClient(app)
        response = client.post("/api/route", json={
            "origin": [76.27213, 9.96482],
            "destination": [76.9, 8.5],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        alternatives = data["alternatives"]
        self.assertEqual(len(alternatives), 3)
        distances = [a["distance_km"] for a in alternatives]
        self.assertEqual(len(set(distances)), 3, f"Routes have identical distances: {distances}")
        coords = [tuple(tuple(c) for c in a["coordinates"]) for a in alternatives]
        self.assertEqual(len(set(coords)), 3, "All three routes have identical coordinates")

    def test_no_land_crossings_in_any_alternative(self):
        client = TestClient(app)
        response = client.post("/api/route", json={
            "origin": [76.27213, 9.96482],
            "destination": [76.9, 8.5],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        for alt in data["alternatives"]:
            unresolved = [w for w in alt["warnings"] if w["type"] == "restricted"]
            self.assertEqual(len(unresolved), 0, f"{alt['label']} has unresolved land crossings: {unresolved}")

    def test_all_alternatives_have_positive_distance(self):
        client = TestClient(app)
        response = client.post("/api/route", json={
            "origin": [72.8, 8.5],
            "destination": [77.5, 8.0],
            "speed_knots": 10,
        })
        self.assertEqual(200, response.status_code)
        data = response.json()
        for alt in data["alternatives"]:
            self.assertGreater(alt["distance_km"], 0, f"{alt['label']} has zero distance")
            self.assertGreater(len(alt["coordinates"]), 2, f"{alt['label']} has too few coordinates")
