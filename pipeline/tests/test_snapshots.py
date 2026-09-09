from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from affine import Affine
import numpy as np

from nevaio_pipeline.asof import AsOfComposite, PixelState
from nevaio_pipeline.mosaic import TileComposite
from nevaio_pipeline.raster_io import RasterGrid
from nevaio_pipeline.snapshots import _metatile_grid, _xyz_range, load_snapshot, save_snapshot, snapshot_info
from nevaio_pipeline.tiles import ORIGIN_SHIFT, TILE_SIZE


def tile() -> TileComposite:
    grid = RasterGrid("EPSG:3857", Affine(60, 0, 0, 0, -60, 120), 2, 2)
    state = np.array([[PixelState.VALID, PixelState.CLOUD], [PixelState.WATER, PixelState.STALE]], dtype=np.uint8)
    composite = AsOfComposite(
        as_of_date=date(2026, 2, 10),
        fsc=np.array([[80, 255], [255, 255]], dtype=np.uint8),
        quality=np.array([[1, 255], [255, 255]], dtype=np.uint8),
        acquisition_time=np.array([[1_770_000_000, 0], [0, 1_769_000_000]], dtype=np.uint64),
        age_days=np.array([[1, -1], [-1, 15]], dtype=np.int32),
        source_product_day=np.array([[20_494, -1], [-1, 20_480]], dtype=np.int32),
        state=state,
    )
    return TileComposite("32TPS", grid, composite)


class SnapshotTests(unittest.TestCase):
    def test_snapshot_round_trip_preserves_semantic_fields_and_grid(self) -> None:
        original = tile()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "32TPS.npz"
            save_snapshot(path, original)
            restored = load_snapshot(path)
            info = snapshot_info(path)

        self.assertEqual(restored.tile, original.tile)
        self.assertEqual(restored.grid, original.grid)
        self.assertEqual(info.bounds_3857, (0.0, 0.0, 120.0, 120.0))
        for field in ("fsc", "quality", "acquisition_time", "age_days", "source_product_day", "state"):
            np.testing.assert_array_equal(getattr(restored.composite, field), getattr(original.composite, field))

    def test_xyz_range_honors_exact_tile_edges(self) -> None:
        half = ORIGIN_SHIFT
        xs, ys = _xyz_range((-half, 0, 0, half), 1)
        self.assertEqual(list(xs), [0])
        self.assertEqual(list(ys), [0])

    def test_metatile_grid_has_max_zoom_resolution_and_base_tile_extent(self) -> None:
        grid = _metatile_grid(base_zoom=8, max_zoom=11, x=128, y=128)
        self.assertEqual((grid.width, grid.height), (TILE_SIZE * 8, TILE_SIZE * 8))
        expected_span = 2 * ORIGIN_SHIFT / (2**8)
        self.assertAlmostEqual(grid.transform.a, expected_span / (TILE_SIZE * 8))
        self.assertAlmostEqual(grid.transform.c, 0.0)
        self.assertAlmostEqual(grid.transform.f, 0.0)


if __name__ == "__main__":
    unittest.main()
