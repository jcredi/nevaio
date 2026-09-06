from __future__ import annotations

import unittest
from datetime import date

from affine import Affine
import numpy as np

from pipeline.asof import AsOfComposite, PixelState
from pipeline.mosaic import TileComposite, mosaic_to_grid
from pipeline.raster_io import RasterGrid


def grid(width: int = 3, height: int = 2) -> RasterGrid:
    return RasterGrid("EPSG:3857", Affine.translation(0, height) * Affine.scale(1, -1), width, height)


def composite(
    states: list[list[int]],
    *,
    fsc: list[list[int]] | None = None,
    quality: list[list[int]] | None = None,
    acquisition_time: list[list[int]] | None = None,
) -> AsOfComposite:
    state = np.array(states, dtype=np.uint8)
    shape = state.shape
    valid = state == PixelState.VALID
    return AsOfComposite(
        as_of_date=date(2026, 2, 11),
        fsc=np.array(fsc if fsc is not None else np.where(valid, 50, 255), dtype=np.uint8),
        quality=np.array(quality if quality is not None else np.where(valid, 1, 255), dtype=np.uint8),
        acquisition_time=np.array(
            acquisition_time if acquisition_time is not None else np.where(valid, 1_770_000_000, 0),
            dtype=np.uint64,
        ),
        age_days=np.where(valid, 1, -1).astype(np.int32),
        source_product_day=np.where(valid, 20_489, -1).astype(np.int32),
        state=state,
    )


class MosaicTests(unittest.TestCase):
    def test_applies_water_valid_and_nonvalid_precedence(self) -> None:
        target = grid()
        left = TileComposite(
            "32TQS",
            target,
            composite(
                [
                    [PixelState.VALID, PixelState.VALID, PixelState.STALE],
                    [PixelState.CLOUD, PixelState.NODATA, PixelState.VALID],
                ],
                fsc=[[20, 30, 255], [255, 255, 40]],
                quality=[[2, 1, 255], [255, 255, 1]],
                acquisition_time=[[100, 100, 80], [0, 0, 100]],
            ),
        )
        right = TileComposite(
            "33TUM",
            target,
            composite(
                [
                    [PixelState.WATER, PixelState.VALID, PixelState.CLOUD],
                    [PixelState.STALE, PixelState.CLOUD, PixelState.VALID],
                ],
                fsc=[[255, 90, 255], [255, 255, 80]],
                quality=[[255, 3, 255], [255, 255, 0]],
                acquisition_time=[[0, 120, 0], [90, 0, 100]],
            ),
        )

        result = mosaic_to_grid([right, left], target)

        np.testing.assert_array_equal(
            result.composite.state,
            [
                [PixelState.WATER, PixelState.VALID, PixelState.CLOUD],
                [PixelState.CLOUD, PixelState.CLOUD, PixelState.VALID],
            ],
        )
        np.testing.assert_array_equal(result.composite.fsc, [[255, 90, 255], [255, 255, 80]])
        np.testing.assert_array_equal(result.source_tile, [[1, 1, 1], [0, 1, 1]])

    def test_ties_use_quality_then_lexicographic_tile_name(self) -> None:
        target = grid(width=2, height=1)
        a = TileComposite(
            "32TQS",
            target,
            composite(
                [[PixelState.VALID, PixelState.VALID]],
                fsc=[[10, 20]],
                quality=[[1, 1]],
                acquisition_time=[[100, 100]],
            ),
        )
        b = TileComposite(
            "33TUM",
            target,
            composite(
                [[PixelState.VALID, PixelState.VALID]],
                fsc=[[90, 80]],
                quality=[[0, 1]],
                acquisition_time=[[100, 100]],
            ),
        )

        result = mosaic_to_grid([b, a], target)

        np.testing.assert_array_equal(result.composite.fsc, [[90, 20]])
        np.testing.assert_array_equal(result.source_tile, [[1, 0]])
        self.assertEqual(result.tile_names, ("32TQS", "33TUM"))

    def test_rejects_duplicate_tiles_dates_and_bad_shapes(self) -> None:
        target = grid(width=1, height=1)
        first = TileComposite("32TQS", target, composite([[PixelState.VALID]]))
        duplicate = TileComposite("32TQS", target, composite([[PixelState.VALID]]))
        different_day = AsOfComposite(
            **{**first.composite.__dict__, "as_of_date": date(2026, 2, 12)}
        )

        with self.assertRaisesRegex(ValueError, "unique"):
            mosaic_to_grid([first, duplicate], target)
        with self.assertRaisesRegex(ValueError, "same AS-OF"):
            mosaic_to_grid([first, TileComposite("33TUM", target, different_day)], target)

        bad = TileComposite(
            "33TUM",
            target,
            AsOfComposite(
                **{**first.composite.__dict__, "fsc": np.array([[50, 50]], dtype=np.uint8)}
            ),
        )
        with self.assertRaisesRegex(ValueError, "fsc shape"):
            mosaic_to_grid([first, bad], target)


if __name__ == "__main__":
    unittest.main()
