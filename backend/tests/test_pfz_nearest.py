import math
from unittest import TestCase
from unittest.mock import patch
import numpy as np

from fastapi.testclient import TestClient
from backend.app import app
from backend.pfz_nearest import nearest_pfz, RADIUS_KM
from backend.pfz_service import PFZUnavailable
from backend.cloud_repository import CloudDataRepository
from backend.config import LAYERS


def collection(*lines):
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'id': i, 'properties': {'Sno': str(i)},
         'geometry': {'type': 'MultiLineString', 'coordinates': line}}
        for i, line in enumerate(lines)]}


class NearestPFZTests(TestCase):
    def test_segment_interior_not_vertex(self):
        result = nearest_pfz(collection([[[-10, 0], [10, 0]]]), 0, 1)
        self.assertAlmostEqual(0, result['point']['lng'], places=8)
        self.assertAlmostEqual(0, result['point']['lat'], places=8)
        self.assertAlmostEqual(math.pi / 180 * RADIUS_KM, result['distance_km'], places=6)
        self.assertAlmostEqual(180, result['bearing_degrees'], places=6)

    def test_endpoint_and_east_bearing(self):
        result = nearest_pfz(collection([[[2, 0], [3, 0]]]), 0, 0)
        self.assertAlmostEqual(2, result['point']['lng'])
        self.assertAlmostEqual(90, result['bearing_degrees'])

    def test_all_features_and_multiline_parts(self):
        result = nearest_pfz(collection([[[20, 0], [21, 0]]],
                                       [[[10, 0], [11, 0]], [[-1, 0], [1, 0]]]), 0, 1)
        self.assertEqual(1, result['feature']['id'])
        self.assertEqual(1, result['line_index'])

    def test_antimeridian(self):
        result = nearest_pfz(collection([[[179, 0], [-179, 0]]]), 180, 1)
        self.assertAlmostEqual(180, abs(result['point']['lng']))
        self.assertAlmostEqual(111.19508, result['distance_km'], places=4)

    def test_zero_length_and_on_line(self):
        result = nearest_pfz(collection([[[0, 0], [0, 0], [1, 0]]]), 0, 0)
        self.assertAlmostEqual(0, result['distance_km'])
        self.assertIsNone(result['bearing_degrees'])

    def test_high_latitude_great_circle(self):
        result = nearest_pfz(collection([[[-45, 80], [45, 80]]]), 0, 89)
        self.assertGreater(result['point']['lat'], 80)
        self.assertAlmostEqual(0, result['point']['lng'], places=6)

    def test_empty_and_invalid_origin(self):
        self.assertIsNone(nearest_pfz(collection(), 0, 0))
        for lng, lat in [(181, 0), (0, 91), (float('nan'), 0)]:
            with self.assertRaises(ValueError):
                nearest_pfz(collection(), lng, lat)

    def test_api_metadata_and_errors(self):
        client = TestClient(app)
        data = {'data': collection([[[-1, 0], [1, 0]]]), 'metadata': {'stale': True}}
        with patch('backend.app.pfz_service.get', return_value=data):
            response = client.get('/api/pfz/nearest?latitude=1&longitude=0')
            self.assertEqual(200, response.status_code)
            self.assertTrue(response.json()['metadata']['stale'])
            self.assertEqual(422, client.get('/api/pfz/nearest?latitude=91&longitude=0').status_code)
        with patch('backend.app.pfz_service.get', return_value={'data': collection(), 'metadata': {}}):
            self.assertEqual(404, client.get('/api/pfz/nearest?latitude=0&longitude=0').status_code)
        with patch('backend.app.pfz_service.get', side_effect=PFZUnavailable('offline')):
            self.assertEqual(503, client.get('/api/pfz/nearest?latitude=0&longitude=0').status_code)

    def test_cloud_native_conditions_metadata_bounds_and_missing_data(self):
        repository = object.__new__(CloudDataRepository)
        frame = {'native_latitudes': np.array([10., 11.]),
                 'native_longitudes': np.array([80., 81.]),
                 'native_CHL': np.array([[1.34, np.nan], [2., 3.]])}
        descriptor = {'key': 'fixture', 'time': '2026-09-02T00:00:00Z'}
        with patch.object(repository, '_layer', return_value=(LAYERS['chlorophyll'], {})), \
             patch.object(repository, '_frame_for_time', return_value=descriptor), \
             patch.object(repository, '_frame', return_value=frame):
            result = repository.point('chlorophyll', 10, 80)
            self.assertEqual(1.34, result['value'])
            self.assertEqual(descriptor['time'], result['time'])
            self.assertEqual(LAYERS['chlorophyll'].unit, result['unit'])
            for lat, lng in [(10, 81), (0, 0)]:
                with self.assertRaises(ValueError):
                    repository.point('chlorophyll', lat, lng)
