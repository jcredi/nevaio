from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from affine import Affine

from nevaio_pipeline.asof import DailyProduct
from nevaio_pipeline.footprint import unproject_utm
from nevaio_pipeline.object_index import INDEX_FILENAME, ObjectIndexEntry, SHARD_DIRECTORY, build_shard_index_document
from nevaio_pipeline.object_series import array_from_buffer, decode_cell, SeriesMarkState
from nevaio_pipeline.object_slots import SLOT_DIRECTORY, load_slot_map
from nevaio_pipeline.raster_io import LoadedTile, RasterGrid
from nevaio_pipeline.render import _update_object_series, build_preview

TILE = "32TPS"
ZONE = 32
WIDTH = HEIGHT = 6
TRANSFORM = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)


def at_epoch(day: date, hour: int = 10) -> int:
    return int(datetime(day.year, day.month, day.day, hour, tzinfo=UTC).timestamp())


def lonlat_at(col: int, row: int) -> tuple[float, float]:
    """Lon/lat of the CENTER of pixel (row, col) - never an exact grid line.

    A point placed exactly on a pixel boundary can, after a UTM
    project/unproject round trip through the Krueger series, land a
    floating-point hair on either side of it - flooring that to a pixel index
    would then be one column or row off by pure numerical noise. The center
    of a 60 m pixel has 30 m of margin either way, which swamps that noise.
    """
    easting, northing = TRANSFORM @ (col + 0.5, row + 0.5)
    return unproject_utm(easting, northing, ZONE)


def write_shard(object_index_dir: Path, tile: str, entries: list[ObjectIndexEntry]) -> None:
    """Write a minimal local shard + index, the shape `render.py` reads back."""

    shard_document = {
        "schemaVersion": 1,
        "tile": tile,
        "objects": [entry.to_document() for entry in entries],
    }
    shard_dir = object_index_dir / SHARD_DIRECTORY
    shard_dir.mkdir(parents=True, exist_ok=True)
    (shard_dir / f"{tile}.json").write_text(json.dumps(shard_document))


def entry(id_: str, col: float, row: float) -> ObjectIndexEntry:
    longitude, latitude = lonlat_at(col, row)
    return ObjectIndexEntry(id=id_, kind="peak", name=id_, longitude=longitude, latitude=latitude, elevation_meters=None)


def loaded_tile(products: list[DailyProduct]) -> LoadedTile:
    grid = RasterGrid(crs=f"EPSG:{32600 + ZONE}", transform=TRANSFORM, width=WIDTH, height=HEIGHT)
    return LoadedTile(tile=TILE, grid=grid, products=tuple(products))


def product(day: date, marks: dict[tuple[int, int], tuple[int, int, int]]) -> DailyProduct:
    """A DailyProduct where `marks[(row, col)] = (gf, qa, at_epoch)`, else no-data pixels."""

    gf = np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)
    qa = np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)
    at = np.zeros((HEIGHT, WIDTH), dtype=np.uint32)
    for (row, col), (gf_value, qa_value, at_value) in marks.items():
        gf[row, col] = gf_value
        qa[row, col] = qa_value
        at[row, col] = at_value
    return DailyProduct(day, gf, qa, at)


class UpdateObjectSeriesTests(unittest.TestCase):
    def test_skips_a_tile_with_no_published_shard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _update_object_series(TILE, loaded_tile([]), root / "index", root / "series")
            self.assertFalse((root / "series").exists())

    def test_first_run_creates_slot_map_and_month_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "index"
            series_dir = root / "series"
            e = entry("node/1", col=2.0, row=3.0)
            write_shard(index_dir, TILE, [e])

            day = date(2026, 3, 5)
            p = product(day, {(3, 2): (40, 1, at_epoch(date(2026, 3, 4)))})
            _update_object_series(TILE, loaded_tile([p]), index_dir, series_dir)

            slot_map = load_slot_map(index_dir / SLOT_DIRECTORY / f"{TILE}.json")
            self.assertIsNotNone(slot_map)
            self.assertEqual(slot_map.slot_for("node/1"), 0)

            month_path = series_dir / TILE / "2026-03.bin"
            self.assertTrue(month_path.is_file())
            array = array_from_buffer(month_path.read_bytes(), slot_count=1, days=31)
            decoded = decode_cell(bytes(array[0, day.day - 1]))
            self.assertEqual(decoded.state, SeriesMarkState.VALID)
            self.assertEqual(decoded.gf, 40)
            self.assertEqual(decoded.age_days, 1)

    def test_uses_the_tiles_own_transform_not_a_footprint_derived_index(self) -> None:
        """A regression guard for the plan's measured, load-bearing claim.

        The object's pixel is resolved from `loaded.grid.transform`
        (`TRANSFORM` here, deliberately not aligned to the MGRS square's own
        corner) - if `_update_object_series` ever started deriving the pixel
        from `footprint.parse_mgrs_tile` instead, this object would land on
        the wrong column and this test would sample a no-data pixel instead
        of the value written at (row=1, col=4).
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "index"
            series_dir = root / "series"
            e = entry("node/2", col=4.0, row=1.0)
            write_shard(index_dir, TILE, [e])

            day = date(2026, 3, 10)
            p = product(day, {(1, 4): (77, 0, at_epoch(date(2026, 3, 9)))})
            _update_object_series(TILE, loaded_tile([p]), index_dir, series_dir)

            array = array_from_buffer((series_dir / TILE / "2026-03.bin").read_bytes(), 1, 31)
            decoded = decode_cell(bytes(array[0, day.day - 1]))
            self.assertEqual(decoded.gf, 77)

    def test_a_missing_day_in_the_window_stays_a_gap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "index"
            series_dir = root / "series"
            e = entry("node/1", col=0.0, row=0.0)
            write_shard(index_dir, TILE, [e])

            p1 = product(date(2026, 3, 1), {(0, 0): (10, 0, at_epoch(date(2026, 3, 1)))})
            # 2026-03-2 has no product at all in this window.
            p3 = product(date(2026, 3, 3), {(0, 0): (12, 0, at_epoch(date(2026, 3, 3)))})
            _update_object_series(TILE, loaded_tile([p1, p3]), index_dir, series_dir)

            array = array_from_buffer((series_dir / TILE / "2026-03.bin").read_bytes(), 1, 31)
            self.assertEqual(decode_cell(bytes(array[0, 0])).state, SeriesMarkState.VALID)
            self.assertEqual(decode_cell(bytes(array[0, 1])).state, SeriesMarkState.NO_DATA)
            self.assertEqual(decode_cell(bytes(array[0, 2])).state, SeriesMarkState.VALID)

    def test_a_window_spanning_a_month_boundary_writes_two_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "index"
            series_dir = root / "series"
            e = entry("node/1", col=0.0, row=0.0)
            write_shard(index_dir, TILE, [e])

            feb = product(date(2026, 2, 28), {(0, 0): (5, 0, at_epoch(date(2026, 2, 28)))})
            mar = product(date(2026, 3, 1), {(0, 0): (6, 0, at_epoch(date(2026, 3, 1)))})
            _update_object_series(TILE, loaded_tile([feb, mar]), index_dir, series_dir)

            feb_array = array_from_buffer((series_dir / TILE / "2026-02.bin").read_bytes(), 1, 28)
            mar_array = array_from_buffer((series_dir / TILE / "2026-03.bin").read_bytes(), 1, 31)
            self.assertEqual(decode_cell(bytes(feb_array[0, 27])).gf, 5)
            self.assertEqual(decode_cell(bytes(mar_array[0, 0])).gf, 6)

    def test_a_new_object_after_a_refresh_grows_the_month_file_without_disturbing_the_hole(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "index"
            series_dir = root / "series"

            first_entry = entry("node/1", col=0.0, row=0.0)
            write_shard(index_dir, TILE, [first_entry])
            day = date(2026, 3, 5)
            p1 = product(day, {(0, 0): (40, 1, at_epoch(date(2026, 3, 4)))})
            _update_object_series(TILE, loaded_tile([p1]), index_dir, series_dir)

            before = (series_dir / TILE / "2026-03.bin").read_bytes()

            # OSM refresh: node/1 disappears, node/2 is new.
            second_entry = entry("node/2", col=1.0, row=1.0)
            write_shard(index_dir, TILE, [second_entry])
            p2 = product(date(2026, 3, 6), {(1, 1): (50, 2, at_epoch(date(2026, 3, 5)))})
            _update_object_series(TILE, loaded_tile([p2]), index_dir, series_dir)

            slot_map = load_slot_map(index_dir / SLOT_DIRECTORY / f"{TILE}.json")
            self.assertEqual(slot_map.slot_for("node/1"), 0)
            self.assertEqual(slot_map.slot_for("node/2"), 1)

            after = (series_dir / TILE / "2026-03.bin").read_bytes()
            array = array_from_buffer(after, slot_count=2, days=31)
            # node/1's previously written day is untouched, byte for byte.
            self.assertEqual(bytes(array[0, day.day - 1]), bytes(array_from_buffer(before, 1, 31)[0, day.day - 1]))
            # node/2's new slot got its own day written.
            self.assertEqual(decode_cell(bytes(array[1, 5])).gf, 50)
            # node/1's slot got no further writes this run (it's absent from
            # the current shard) - day 6 in its own row is still no-data.
            self.assertEqual(decode_cell(bytes(array[0, 5])).state, SeriesMarkState.NO_DATA)


class BuildPreviewWiringTests(unittest.TestCase):
    """`object_index_dir` is optional and additive; omitting it changes nothing."""

    def _run_build_preview(self, tmp: Path, **extra) -> dict:
        first = ()
        grid = RasterGrid(f"EPSG:{32600+ZONE}", TRANSFORM, WIDTH, HEIGHT)
        with (
            patch(
                "nevaio_pipeline.render._local_window",
                return_value={TILE: (SimpleNamespace(product_date=date(2026, 3, 1)),)},
            ),
            patch(
                "nevaio_pipeline.render.load_tile_products",
                return_value=LoadedTile(tile=TILE, grid=grid, products=(product(date(2026, 3, 1), {}),)),
            ),
            patch("nevaio_pipeline.render.compose_as_of", return_value=object()),
            patch("nevaio_pipeline.render.save_snapshot"),
            patch("nevaio_pipeline.render.render_snapshots", return_value=[Path("one.png")]),
            patch("nevaio_pipeline.render._bounds_wgs84", return_value=[5.0, 40.0, 16.0, 48.0]),
        ):
            return build_preview(
                as_of_date=date(2026, 3, 1),
                tiles=[TILE],
                raw_dir=tmp / "raw",
                work_dir=tmp / "work",
                output_dir=tmp / "output",
                fetch=False,
                **extra,
            )

    def test_omitting_object_index_dir_touches_no_series_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._run_build_preview(root)
            self.assertFalse((root / "output" / "series").exists())

    def test_passing_object_index_dir_with_no_shard_is_a_harmless_no_op(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._run_build_preview(root, object_index_dir=root / "index")
            # No shard was ever written for TILE, so nothing is produced, but
            # the render itself still completes.
            self.assertFalse((root / "output" / "series" / TILE).exists())

    def test_series_output_dir_defaults_under_output_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_shard(root / "index", TILE, [entry("node/1", col=0.0, row=0.0)])
            self._run_build_preview(root, object_index_dir=root / "index")
            # product(date(2026,3,1), {}) has no marks, but the tile has an
            # object, so a (fully no-data) month file is still written under
            # the default series directory.
            self.assertTrue((root / "output" / "series" / TILE / "2026-03.bin").is_file())


if __name__ == "__main__":
    unittest.main()
