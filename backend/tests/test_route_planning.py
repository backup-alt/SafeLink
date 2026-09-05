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
        self.assertGreater(len(data["legs"]), 1)
        self.assertTrue(any("avoid land" in warning["message"] for warning in data["warnings"]))
