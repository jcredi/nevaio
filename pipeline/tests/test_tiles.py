from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from affine import Affine
import numpy as np
from PIL import Image

from nevaio_pipeline.asof import AsOfComposite, NO_AGE, NO_PRODUCT_DAY, NO_VALUE, PixelState
from nevaio_pipeline.raster_io import RasterGrid
from nevaio_pipeline.tiles import ORIGIN_SHIFT, render_rgba, write_xyz_tiles

# The 4 frozen freshness-tier colors from nevaio_pipeline.tiles._FRESHNESS_COLORS,
# spelled out here so a test failure shows which tier broke rather than an
# opaque import of the production constant.
SKY_BLUE = (0x38, 0xBD, 0xF8)  # tier 0, 0-3 days: sky blue
BLUE = (0x51, 0x85, 0xED)  # tier 1, 4-7 days
VIOLET = (0x69, 0x57, 0xCE)  # tier 2, 8-14 days
INDIGO = (0x71, 0x3A, 0x9C)  # tier 3, 15+ days: indigo


def composite(state: int, *, fsc: int = NO_VALUE, age_days: int = NO_AGE, shape=(1, 1)) -> AsOfComposite:
    return AsOfComposite(
        as_of_date=date(2026, 2, 11),
        fsc=np.full(shape, fsc, dtype=np.uint8),
        quality=np.full(shape, 255, dtype=np.uint8),
        acquisition_time=np.zeros(shape, dtype=np.uint64),
        age_days=np.full(shape, age_days, dtype=np.int32),
        source_product_day=np.full(shape, NO_PRODUCT_DAY, dtype=np.int32),
        state=np.full(shape, state, dtype=np.uint8),
    )


class RenderRgbaTests(unittest.TestCase):
    def test_alpha_ramp_at_frozen_stops_is_driven_by_coverage_alone(self) -> None:
        c = composite(PixelState.VALID, fsc=0, age_days=0)
        np.testing.assert_array_equal(render_rgba(c)[0, 0], [*SKY_BLUE, 0])

        c = composite(PixelState.VALID, fsc=50, age_days=0)
        np.testing.assert_array_equal(render_rgba(c)[0, 0], [*SKY_BLUE, 150])

        c = composite(PixelState.VALID, fsc=100, age_days=0)
        np.testing.assert_array_equal(render_rgba(c)[0, 0], [*SKY_BLUE, 255])

    def test_freshness_selects_color_not_alpha(self) -> None:
        # Fixed at full coverage (alpha 255 throughout) so only color varies.
        tier0 = render_rgba(composite(PixelState.VALID, fsc=100, age_days=0))[0, 0]
        tier1 = render_rgba(composite(PixelState.VALID, fsc=100, age_days=5))[0, 0]
        tier2 = render_rgba(composite(PixelState.VALID, fsc=100, age_days=10))[0, 0]
        tier3 = render_rgba(composite(PixelState.VALID, fsc=100, age_days=20))[0, 0]

        np.testing.assert_array_equal(tier0, [*SKY_BLUE, 255])
        np.testing.assert_array_equal(tier1, [*BLUE, 255])
        np.testing.assert_array_equal(tier2, [*VIOLET, 255])
        np.testing.assert_array_equal(tier3, [*INDIGO, 255])

    def test_cloud_water_stale_and_nodata_are_all_transparent(self) -> None:
        for state in (PixelState.CLOUD, PixelState.WATER, PixelState.STALE, PixelState.NODATA):
            rgba = render_rgba(composite(state))[0, 0]
            self.assertEqual(int(rgba[3]), 0)

    def test_confirmed_zero_percent_snow_is_also_fully_transparent(self) -> None:
        # Deliberate: a genuine 0% observation is visually indistinguishable
        # on the map from no-data/cloud/stale/water (spec 5.2/5.4, amended
        # 2026-09-06) - only opacity encodes coverage, and 0% coverage is 0
        # opacity, with no floor tint.
        rgba = render_rgba(composite(PixelState.VALID, fsc=0, age_days=0))[0, 0]
        self.assertEqual(int(rgba[3]), 0)


def _world_grid() -> RasterGrid:
    """A 256x256 grid whose footprint is exactly the z0 tile (the whole world)."""

    resolution = (2 * ORIGIN_SHIFT) / 256
    transform = Affine.translation(-ORIGIN_SHIFT, ORIGIN_SHIFT) * Affine.scale(resolution, -resolution)
    return RasterGrid("EPSG:3857", transform, 256, 256)


class WriteXyzTilesTests(unittest.TestCase):
    def test_full_world_tile_written_at_z0(self) -> None:
        grid = _world_grid()
        c = composite(PixelState.VALID, fsc=100, age_days=0, shape=(256, 256))

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            written = write_xyz_tiles(c, grid, zooms=[0], out_dir=out_dir)

            self.assertEqual(written, [out_dir / "0" / "0" / "0.png"])
            tile = np.array(Image.open(written[0]).convert("RGBA"))
            self.assertEqual(tile.shape, (256, 256, 4))
            self.assertTrue((tile == [*SKY_BLUE, 255]).all())

    def test_full_world_source_covers_all_four_z1_tiles(self) -> None:
        grid = _world_grid()
        # Coverage must be >0% here (unlike the old encoding, 0% is now truly
        # 0 alpha) so every tile in the footprint actually gets written.
        c = composite(PixelState.VALID, fsc=50, age_days=0, shape=(256, 256))

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            written = write_xyz_tiles(c, grid, zooms=[1], out_dir=out_dir)

            expected = {
                out_dir / "1" / str(x) / f"{y}.png" for x in (0, 1) for y in (0, 1)
            }
            self.assertEqual(set(written), expected)

    def test_fully_transparent_composite_writes_nothing(self) -> None:
        grid = _world_grid()
        c = composite(PixelState.NODATA, shape=(256, 256))

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            written = write_xyz_tiles(c, grid, zooms=[0, 1], out_dir=out_dir)

            self.assertEqual(written, [])
            self.assertFalse(any(out_dir.iterdir()))

    def test_partial_footprint_leaves_rest_of_tile_transparent(self) -> None:
        # A small source raster placed in one quadrant of the z1/x0/y0 tile.
        resolution = (2 * ORIGIN_SHIFT) / 256
        transform = Affine.translation(-ORIGIN_SHIFT, ORIGIN_SHIFT) * Affine.scale(resolution, -resolution)
        grid = RasterGrid("EPSG:3857", transform, 64, 64)
        c = composite(PixelState.VALID, fsc=100, age_days=0, shape=(64, 64))

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            written = write_xyz_tiles(c, grid, zooms=[1], out_dir=out_dir)

            self.assertEqual(written, [out_dir / "1" / "0" / "0.png"])
            tile = np.array(Image.open(written[0]).convert("RGBA"))
            self.assertTrue((tile[0:128, 0:128] == [*SKY_BLUE, 255]).all())
            self.assertTrue((tile[128:, :] == 0).all())
            self.assertTrue((tile[:, 128:] == 0).all())


if __name__ == "__main__":
    unittest.main()
