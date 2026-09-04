from io import BytesIO
import json
from unittest import TestCase

import numpy as np

from backend.cloud_repository import CloudDataRepository


class _Body:
    def __init__(self, value: bytes):
        self.value = value

    def read(self) -> bytes:
        return self.value


class _ObjectClient:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects

    def get_object(self, Bucket: str, Key: str):
        del Bucket
        return {"Body": _Body(self.objects[Key])}


class CloudDataRepositoryTests(TestCase):
    def setUp(self):
        archive = BytesIO()
        np.savez_compressed(
            archive,
            latitudes=np.array([10.0, 11.0], dtype=np.float32),
            longitudes=np.array([80.0, 81.0], dtype=np.float32),
            native_latitudes=np.array([10.0, 10.5, 11.0], dtype=np.float32),
            native_longitudes=np.array([80.0, 80.5, 81.0], dtype=np.float32),
            values=np.array([[0.4, 0.5], [0.6, 0.7]], dtype=np.float32),
            u=np.ones((2, 2), dtype=np.float32),
            v=np.zeros((2, 2), dtype=np.float32),
            period=np.full((2, 2), 8.0, dtype=np.float32),
            direction=np.full((2, 2), 90.0, dtype=np.float32),
            native_VHM0=np.arange(9, dtype=np.float32).reshape(3, 3),
            native_VMDR=np.full((3, 3), 90.0, dtype=np.float32),
            native_VTM10=np.full((3, 3), 8.0, dtype=np.float32),
        )
        manifest = {
            "version": 1,
            "run_id": "2026-09-04",
            "layers": [{
                "id": "waves",
                "updated_at": "2026-09-04T00:00:00Z",
                "frames": [{
                    "time": "2026-09-04T00:00:00Z",
                    "key": "test/runs/2026-09-04/waves/frame.npz",
                    "source_file": "waves_2026-09-04.nc",
                }],
            }],
        }
        objects = {
            "test/manifest.json": json.dumps(manifest).encode(),
            "test/runs/2026-09-04/waves/frame.npz": archive.getvalue(),
        }
        self.repository = CloudDataRepository(_ObjectClient(objects), bucket="bucket", prefix="test")

    def test_catalog_marks_published_layer_available(self):
        catalog = self.repository.catalog()
        waves = next(layer for layer in catalog["layers"] if layer["id"] == "waves")
        currents = next(layer for layer in catalog["layers"] if layer["id"] == "currents")
        self.assertTrue(waves["available"])
        self.assertFalse(currents["available"])

    def test_field_reads_display_arrays(self):
        field = self.repository.field("waves", "2026-09-04T00:00:00Z")
        self.assertEqual(0.4, field["values"][0][0])
        self.assertEqual(8.0, field["extras"]["period"][0][0])
        self.assertIn("u", field)

    def test_point_reads_native_grid(self):
        point = self.repository.point("waves", latitude=10.5, longitude=80.5)
        self.assertEqual(4.0, point["value"])
        self.assertEqual(8.0, point["period"])

    def test_missing_cloud_manifest_returns_unavailable_catalog(self):
        repository = CloudDataRepository(_ObjectClient({}), bucket="bucket", prefix="missing")
        self.assertFalse(any(layer["available"] for layer in repository.catalog()["layers"]))
