from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
from unittest import TestCase
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from fastapi.testclient import TestClient

from backend.app import app
from backend.pfz_service import PFZService, PFZUnavailable, advisory_date, validate_collection


def collection():
    return {"type": "FeatureCollection", "features": [{
        "type": "Feature", "id": "official.1",
        "geometry": {"type": "MultiLineString", "coordinates": [
            [[80.2, 12.1], [80.3, 12.2]], [[81.0, 11.0], [81.1, 11.2]],
        ]},
        "properties": {"Year": 2024, "Julian_day": "060", "Sno": "001", "Length": 12.75},
    }]}


class PFZTests(TestCase):
    def test_valid_collection_and_multiline_preserved(self):
        source = collection()
        result = validate_collection(source)
        self.assertEqual(source["features"][0]["geometry"], result["features"][0]["geometry"])
        self.assertEqual("2024-02-29", result["features"][0]["properties"]["advisory_date"])
        self.assertNotIn("advisory_date", source["features"][0]["properties"])

    def test_dates_validate_leap_year_and_day_bounds(self):
        for year, day, expected in [(2024, 366, "2024-12-31"), (2023, 366, None),
                                     (2024, 0, None), (2024, 367, None), ("bad", 1, None)]:
            with self.subTest(year=year, day=day):
                self.assertEqual(expected, advisory_date({"Year": year, "Julian_day": day}))

    def test_invalid_upstream_structure(self):
        for payload in [None, [], {"type": "Polygon"}, {"type": "FeatureCollection", "features": {}},
                        {"type": "FeatureCollection", "features": [None]}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                validate_collection(payload)

    def test_reject_invalid_coordinates_geometry_and_properties(self):
        for coordinates in [[], [[[80, 10]]], [[[181, 10], [80, 10]]],
                            [[[80, float('nan')], [80, 10]]], [[[True, 10], [80, 10]]]]:
            data = collection()
            data["features"][0]["geometry"]["coordinates"] = coordinates
            with self.subTest(coordinates=coordinates), self.assertRaises(ValueError):
                validate_collection(data)
        for key, value in [("Sno", {}), ("Length", float('inf'))]:
            data = collection()
            data["features"][0]["properties"][key] = value
            with self.assertRaises(ValueError):
                validate_collection(data)
        data = collection()
        data["crs"] = {"properties": None}
        with self.assertRaises(ValueError):
            validate_collection(data)

    def test_cache_metadata_and_no_repeated_requests(self):
        service = PFZService()
        with patch.object(service, "_fetch", return_value=collection()) as fetch:
            first = service.get()
            second = service.get()
        fetch.assert_called_once()
        self.assertEqual(first, second)
        self.assertEqual(1, first["metadata"]["feature_count"])
        self.assertEqual("INCOIS", first["metadata"]["source"])
        self.assertFalse(first["metadata"]["stale"])
        self.assertTrue(first["metadata"]["fetched_at"].endswith("Z"))
        second["data"]["features"].clear()
        self.assertEqual(1, service.get()["metadata"]["feature_count"])

    def test_network_and_http_failure_without_cache(self):
        for error in [URLError("offline"), TimeoutError("timeout"), HTTPError("test", 502, "bad gateway", {}, None)]:
            service = PFZService()
            with patch.object(service, "_fetch", side_effect=error) as fetch, self.assertLogs("backend.pfz_service", "WARNING"):
                with self.assertRaises(PFZUnavailable):
                    service.get()
                with self.assertRaises(PFZUnavailable):
                    service.get()
                fetch.assert_called_once()  # Failure cooldown also protects INCOIS.

    def test_parallel_requests_share_one_refresh(self):
        service = PFZService()
        with patch.object(service, "_fetch", return_value=collection()) as fetch:
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda _: service.get(), range(6)))
        fetch.assert_called_once()
        self.assertTrue(all(result == results[0] for result in results))

    def test_invalid_first_response_becomes_unavailable(self):
        service = PFZService()
        with patch.object(service, "_fetch", return_value={"error": "service exception"}), self.assertLogs("backend.pfz_service", "WARNING"):
            with self.assertRaises(PFZUnavailable):
                service.get()

    def test_stale_fallback_and_recovery(self):
        service = PFZService(ttl_seconds=0, retry_seconds=0)
        with patch.object(service, "_fetch", side_effect=[collection(), URLError("offline"), collection()]):
            first = service.get()
            with self.assertLogs("backend.pfz_service", "WARNING"):
                stale = service.get()
            recovered = service.get()
        self.assertEqual(first["data"], stale["data"])
        self.assertEqual(first["metadata"]["fetched_at"], stale["metadata"]["fetched_at"])
        self.assertTrue(stale["metadata"]["stale"])
        self.assertFalse(recovered["metadata"]["stale"])

    def test_invalid_refresh_uses_cached_fallback(self):
        service = PFZService(ttl_seconds=0)
        with patch.object(service, "_fetch", side_effect=[collection(), {"error": "bad response"}]):
            first = service.get()
            with self.assertLogs("backend.pfz_service", "WARNING"):
                self.assertEqual(first["data"], service.get()["data"])

    def test_empty_collection_is_valid_and_mixed_dates_are_reported(self):
        service = PFZService(ttl_seconds=0)
        data = collection()
        other = deepcopy(data["features"][0])
        other["properties"]["Julian_day"] = "061"
        data["features"].append(other)
        with patch.object(service, "_fetch", return_value=data):
            meta = service.get()["metadata"]
        self.assertEqual(["2024-02-29", "2024-03-01"], meta["advisory_dates"])
        self.assertEqual("2024-03-01", meta["advisory_date"])
        with patch.object(service, "_fetch", return_value={"type": "FeatureCollection", "features": []}):
            self.assertEqual(0, service.get()["metadata"]["feature_count"])

    @patch("backend.pfz_service.urlopen")
    def test_http_timeout_user_agent_and_json_validation(self, opener):
        response = Mock()
        response.read.return_value = json.dumps(collection()).encode()
        opener.return_value.__enter__.return_value = response
        self.assertEqual("FeatureCollection", PFZService()._fetch()["type"])
        self.assertEqual(12, opener.call_args.kwargs["timeout"])
        self.assertIn("SafeLink", opener.call_args.args[0].get_header("User-agent"))
        response.read.return_value = b'<ServiceException>Unavailable</ServiceException>'
        with self.assertRaises(ValueError):
            PFZService()._fetch()

    def test_api_response_and_unavailable_error(self):
        service = PFZService()
        client = TestClient(app)  # No lifespan: no Copernicus background refresh.
        with patch("backend.app.pfz_service", service), patch.object(service, "_fetch", return_value=collection()):
            response = client.get("/api/pfz")
        self.assertEqual(200, response.status_code)
        self.assertEqual("MultiLineString", response.json()["data"]["features"][0]["geometry"]["type"])
        with patch("backend.app.pfz_service.get", side_effect=PFZUnavailable("offline")):
            self.assertEqual(503, client.get("/api/pfz").status_code)
