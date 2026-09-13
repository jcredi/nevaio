from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from affine import Affine
import numpy as np
from PIL import Image

from nevaio_pipeline.asof import AsOfComposite, NO_AGE, NO_PRODUCT_DAY, NO_VALUE, PixelState
from nevaio_pipeline.data_tiles import (
    AGE_NOT_APPLICABLE,
    ALPHA_OPAQUE,
    DataState,
    MAX_AGE_DAYS,
    encode_data_rgba,
    pack_quality_and_state,
    write_data_tiles,
)
from nevaio_pipeline.data_tiles import NO_VALUE as DATA_NO_VALUE
from nevaio_pipeline.raster_io import RasterGrid
from nevaio_pipeline.tiles import ORIGIN_SHIFT


def composite(
    state: int,
    *,
    fsc: int = NO_VALUE,
    quality: int = 255,
    age_days: int = NO_AGE,
    shape=(1, 1),
) -> AsOfComposite:
    return AsOfComposite(
        as_of_date=date(2026, 2, 11),
        fsc=np.full(shape, fsc, dtype=np.uint8),
        quality=np.full(shape, quality, dtype=np.uint8),
        acquisition_time=np.zeros(shape, dtype=np.uint64),
        age_days=np.full(shape, age_days, dtype=np.int32),
        source_product_day=np.full(shape, NO_PRODUCT_DAY, dtype=np.int32),
        state=np.full(shape, state, dtype=np.uint8),
    )


def decode(pixel) -> dict[str, int]:
    """The frontend's decoding, written out here so the contract is readable."""

    red, green, blue, alpha = (int(v) for v in pixel)
    return {
        "fsc": None if red == DATA_NO_VALUE else red,
        "age": None if green == AGE_NOT_APPLICABLE else green,
        "quality": blue & 0b11,
        "state": (blue >> 2) & 0b111,
        "alpha": alpha,
    }


class EncodeDataRgbaTests(unittest.TestCase):
    def test_zero_percent_snow_is_a_real_value_not_an_absence(self) -> None:
        # The whole reason this format exists: on the visual raster a confirmed
        # 0% pixel is indistinguishable from cloud/water/no-data (spec 5.4).
        # Here it must be a plain 0 with a VALID state.
        got = decode(encode_data_rgba(composite(PixelState.VALID, fsc=0, quality=1, age_days=0))[0, 0])
        self.assertEqual(got["fsc"], 0)
        self.assertEqual(got["state"], int(DataState.VALID))
        self.assertEqual(got["quality"], 1)
        self.assertEqual(got["age"], 0)

    def test_each_missing_state_is_distinguishable_from_the_others(self) -> None:
        cases = {
            PixelState.CLOUD: DataState.CLOUD,
            PixelState.WATER: DataState.WATER,
            PixelState.NODATA: DataState.NO_DATA,
            PixelState.STALE: DataState.STALE,
        }
        seen = set()
        for pixel_state, expected in cases.items():
            got = decode(encode_data_rgba(composite(pixel_state))[0, 0])
            self.assertEqual(got["state"], int(expected), f"{pixel_state!r} encoded wrongly")
            self.assertIsNone(got["fsc"], f"{pixel_state!r} must carry no percentage")
            seen.add(got["state"])
        self.assertEqual(len(seen), len(cases), "states must not collapse into each other")

    def test_a_stale_pixel_never_publishes_its_raw_percentage(self) -> None:
        # STALE keeps a raw fsc for detail views upstream. Publishing it here
        # would present a reading older than the 30-day window as current.
        got = decode(encode_data_rgba(composite(PixelState.STALE, fsc=88, age_days=40))[0, 0])
        self.assertIsNone(got["fsc"])
        self.assertEqual(got["state"], int(DataState.STALE))

    def test_full_percentage_range_round_trips(self) -> None:
        for value in (0, 1, 50, 99, 100):
            got = decode(encode_data_rgba(composite(PixelState.VALID, fsc=value, quality=0, age_days=3))[0, 0])
            self.assertEqual(got["fsc"], value)

    def test_every_quality_tier_round_trips(self) -> None:
        for tier in (0, 1, 2, 3):
            got = decode(
                encode_data_rgba(composite(PixelState.VALID, fsc=10, quality=tier, age_days=0))[0, 0]
            )
            self.assertEqual(got["quality"], tier)
            self.assertEqual(got["state"], int(DataState.VALID))

    def test_age_range_round_trips_and_out_of_range_is_marked_absent(self) -> None:
        for age in (0, 1, 14, MAX_AGE_DAYS):
            got = decode(encode_data_rgba(composite(PixelState.VALID, fsc=10, quality=0, age_days=age))[0, 0])
            self.assertEqual(got["age"], age)
        # NO_AGE and anything past the window carry no age rather than a wrong one.
        self.assertIsNone(decode(encode_data_rgba(composite(PixelState.CLOUD, age_days=NO_AGE))[0, 0])["age"])
        self.assertIsNone(
            decode(encode_data_rgba(composite(PixelState.STALE, age_days=MAX_AGE_DAYS + 5))[0, 0])["age"]
        )

    def test_alpha_is_always_opaque(self) -> None:
        # Load-bearing: a browser reads these with canvas getImageData, which
        # un-premultiplies by alpha. Any alpha below 255 silently corrupts the
        # other three channels by rounding.
        for state in (PixelState.VALID, PixelState.CLOUD, PixelState.WATER, PixelState.NODATA, PixelState.STALE):
            encoded = encode_data_rgba(composite(state, fsc=0, quality=0, age_days=0))
            self.assertTrue((encoded[..., 3] == ALPHA_OPAQUE).all(), f"{state!r} produced a non-opaque pixel")

    def test_quality_sentinel_does_not_overflow_its_two_bits(self) -> None:
        # AsOfComposite carries quality 255 wherever the state is not VALID.
        packed = pack_quality_and_state(
            np.array([[255]], dtype=np.uint8), np.array([[int(PixelState.CLOUD)]], dtype=np.uint8)
        )
        self.assertEqual(int(packed[0, 0]) & 0b11, 0)
        self.assertEqual((int(packed[0, 0]) >> 2) & 0b111, int(DataState.CLOUD))

    def test_shape_is_preserved(self) -> None:
        encoded = encode_data_rgba(composite(PixelState.VALID, fsc=10, quality=0, age_days=0, shape=(7, 5)))
        self.assertEqual(encoded.shape, (7, 5, 4))


class WriteDataTilesTests(unittest.TestCase):
    def _grid(self) -> RasterGrid:
        # A small patch of Web Mercator near the top-left of the world, chosen
        # so a single z1 tile covers it - the arithmetic is the same at z11.
        resolution = 40_000.0
        return RasterGrid(
            transform=Affine(resolution, 0.0, -ORIGIN_SHIFT, 0.0, -resolution, ORIGIN_SHIFT),
            width=64,
            height=64,
            crs="EPSG:3857",
        )

    def test_writes_a_png_that_decodes_back_to_the_input(self) -> None:
        grid = self._grid()
        c = composite(PixelState.VALID, fsc=42, quality=2, age_days=5, shape=(grid.height, grid.width))
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            written = write_data_tiles(c, grid, 1, out)
            self.assertTrue(written, "expected at least one tile")
            for path in written:
                self.assertEqual(path.suffix, ".png")
                with Image.open(path) as image:
                    self.assertEqual(image.mode, "RGBA")
                    pixels = np.array(image)
                # Every covered pixel must survive the PNG round trip exactly -
                # a lossy save here would make the whole format worthless.
                covered = pixels[..., 0] != DATA_NO_VALUE
                self.assertTrue(covered.any(), "expected covered pixels in a tile that was written")
                self.assertTrue((pixels[covered][:, 0] == 42).all())
                self.assertTrue((pixels[covered][:, 1] == 5).all())
                self.assertTrue((pixels[covered][:, 2] == (2 | (int(DataState.VALID) << 2))).all())
                self.assertTrue((pixels[..., 3] == ALPHA_OPAQUE).all())

    def test_zero_percent_survives_the_warp(self) -> None:
        # The regression this module's index-based warp exists to prevent:
        # tiles.py warps colour bands with nodata=0, which would either drop a
        # genuine 0% pixel or bump it to 1%.
        grid = self._grid()
        c = composite(PixelState.VALID, fsc=0, quality=0, age_days=0, shape=(grid.height, grid.width))
        with tempfile.TemporaryDirectory() as tmp:
            written = write_data_tiles(c, grid, 1, Path(tmp))
            self.assertTrue(written)
            with Image.open(written[0]) as image:
                pixels = np.array(image)
            # Where the source covers, the state must read VALID and the
            # percentage must be exactly 0 - not NO_VALUE, and not 1.
            state = (pixels[..., 2] >> 2) & 0b111
            valid = state == int(DataState.VALID)
            self.assertTrue(valid.any(), "the 0% source must produce VALID pixels, not absence")
            self.assertTrue((pixels[valid][:, 0] == 0).all(), "0% snow was altered by the warp")

    def test_uncovered_pixels_read_as_no_data_not_as_zero_snow(self) -> None:
        grid = self._grid()
        c = composite(PixelState.VALID, fsc=70, quality=0, age_days=0, shape=(grid.height, grid.width))
        with tempfile.TemporaryDirectory() as tmp:
            written = write_data_tiles(c, grid, 3, Path(tmp))
            self.assertTrue(written)
            for path in written:
                with Image.open(path) as image:
                    pixels = np.array(image)
                uncovered = pixels[..., 0] == DATA_NO_VALUE
                if not uncovered.any():
                    continue
                state = (pixels[..., 2] >> 2) & 0b111
                self.assertTrue(
                    (state[uncovered] == int(DataState.NO_DATA)).all(),
                    "a pixel outside the footprint must say no-data, never 0% snow",
                )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class RenderSnapshotsWiringTests(unittest.TestCase):
    """The data pyramid must be purely additive to the existing render."""

    def _snapshot(self, tmp: Path) -> Path:
        from nevaio_pipeline.mosaic import TileComposite
        from nevaio_pipeline.snapshots import save_snapshot

        resolution = 300.0
        grid = RasterGrid(
            "EPSG:3857",
            Affine(resolution, 0.0, 860_000.0, 0.0, -resolution, 5_800_000.0),
            128,
            128,
        )
        c = composite(
            PixelState.VALID, fsc=35, quality=1, age_days=2, shape=(grid.height, grid.width)
        )
        path = tmp / "32TLR.npz"
        save_snapshot(path, TileComposite(tile="32TLR", grid=grid, composite=c))
        return path

    def test_visual_tiles_are_identical_with_and_without_data_tiles(self) -> None:
        from nevaio_pipeline.snapshots import render_snapshots

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            snapshot = self._snapshot(tmp)

            plain_dir = tmp / "plain"
            visual_only, none_written = render_snapshots([snapshot], plain_dir, 8, 10)
            self.assertEqual(none_written, [], "no data tiles without an output dir")

            both_dir = tmp / "both"
            data_dir = tmp / "both-data"
            visual_again, data_written = render_snapshots(
                [snapshot], both_dir, 8, 10, data_out_dir=data_dir
            )

            self.assertTrue(visual_only, "expected the fixture to produce visual tiles")
            self.assertTrue(data_written, "expected data tiles when an output dir is given")

            # Same relative paths, and byte-identical content: turning the data
            # pyramid on must not perturb the map by so much as a pixel.
            relative_plain = sorted(p.relative_to(plain_dir).as_posix() for p in visual_only)
            relative_both = sorted(p.relative_to(both_dir).as_posix() for p in visual_again)
            self.assertEqual(relative_plain, relative_both)
            for relative in relative_plain:
                self.assertEqual(
                    (plain_dir / relative).read_bytes(),
                    (both_dir / relative).read_bytes(),
                    f"visual tile {relative} changed when data tiles were enabled",
                )

    def test_data_tiles_are_written_only_at_the_max_zoom(self) -> None:
        from nevaio_pipeline.snapshots import render_snapshots

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            snapshot = self._snapshot(tmp)
            data_dir = tmp / "data"
            _, data_written = render_snapshots([snapshot], tmp / "tiles", 8, 10, data_out_dir=data_dir)
            self.assertTrue(data_written)
            zooms = {int(p.relative_to(data_dir).parts[0]) for p in data_written}
            self.assertEqual(zooms, {10}, "the data pyramid is one zoom level only")
