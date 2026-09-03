from pathlib import Path
from unittest import TestCase

from PIL import Image, ImageDraw

from backend.app import _draw_water_geometry
from backend.data_service import DataRepository


class DataRepositoryTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repository = DataRepository(Path(__file__).resolve().parents[2] / "copernicus_data")

    def test_catalog_exposes_all_five_layers(self):
        catalog = self.repository.catalog()
        self.assertEqual(5, len(catalog["layers"]))
        self.assertTrue(all(layer["available"] for layer in catalog["layers"]))
        self.assertEqual(20.0, catalog["region"]["minimum_longitude"])
        self.assertEqual(120.0, catalog["region"]["maximum_longitude"])

    def test_every_layer_returns_a_surface_grid(self):
        for layer_id in ("waves", "currents", "temperature", "sea_level", "chlorophyll"):
            with self.subTest(layer=layer_id):
                field = self.repository.field(layer_id)
                self.assertEqual(len(field["latitudes"]), len(field["values"]))
                self.assertEqual(len(field["longitudes"]), len(field["values"][0]))
                self.assertTrue(any(value is not None for row in field["values"] for value in row))

    def test_vector_layers_include_components(self):
        for layer_id in ("waves", "currents"):
            field = self.repository.field(layer_id)
            self.assertIn("u", field)
            self.assertIn("v", field)

    def test_point_values_use_native_grid(self):
        point = self.repository.point("waves", latitude=0.0, longitude=80.0)
        self.assertEqual(0.0, point["lat"])
        self.assertEqual(80.0, point["lng"])
        self.assertGreaterEqual(point["value"], 0.0)
        self.assertIn("period", point)
        self.assertIn("direction", point)

    def test_vector_water_geometry_preserves_land_holes(self):
        mask = Image.new("L", (32, 32))
        geometry = {
            "type": "Polygon",
            "coordinates": [
                [[0, 0], [32, 0], [32, 32], [0, 32], [0, 0]],
                [[10, 10], [22, 10], [22, 22], [10, 22], [10, 10]],
            ],
        }
        _draw_water_geometry(ImageDraw.Draw(mask), geometry, extent=32, scale=32)
        self.assertEqual(255, mask.getpixel((4, 4)))
        self.assertEqual(0, mask.getpixel((16, 16)))
