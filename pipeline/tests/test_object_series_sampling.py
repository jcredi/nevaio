from __future__ import annotations

import unittest
from datetime import date

import numpy as np
from affine import Affine

from nevaio_pipeline.asof import DailyProduct
from nevaio_pipeline.footprint import parse_mgrs_tile, project_utm
from nevaio_pipeline.object_index import ObjectIndexEntry
from nevaio_pipeline.object_series import decode_cell, new_month_array, SeriesMarkState
from nevaio_pipeline.object_series_sampling import (
    index_tile_objects,
    object_pixel_index,
    sample_daily_product,
)
from nevaio_pipeline.object_slots import build_slot_map


def entry(id_: str, longitude: float, latitude: float) -> ObjectIndexEntry:
    return ObjectIndexEntry(
        id=id_, kind="peak", name=id_, longitude=longitude, latitude=latitude, elevation_meters=None
    )


class PixelIndexTests(unittest.TestCase):
    def test_returns_row_col_for_a_point_inside_the_grid(self) -> None:
        zone = 32
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        longitude, latitude = unproject_for_test(transform, zone, col=1.5, row=2.5)
        pixel = object_pixel_index(transform, zone, longitude, latitude, width=4, height=4)
        self.assertEqual(pixel, (2, 1))

    def test_out_of_bounds_point_returns_none(self) -> None:
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        # Project a point far outside the 4x4 grid's 240 m x 240 m extent.
        zone = 32
        longitude, latitude = 12.0, 46.0
        easting, northing = project_utm(longitude, latitude, zone)
        # Force it outside on purpose by using a grid far from that projection.
        far_transform = Affine(60.0, 0, easting + 100_000.0, 0, -60.0, northing)
        self.assertIsNone(
            object_pixel_index(far_transform, zone, longitude, latitude, width=4, height=4)
        )

    def test_pixel_index_uses_the_products_own_transform_not_the_mgrs_square_origin(self) -> None:
        """The load-bearing measured claim: a footprint-derived index is wrong.

        Real GFSC granules sit up to ~40 m off the nominal MGRS 100 km square
        origin. Build a transform deliberately offset from
        `parse_mgrs_tile`'s own square origin by less than one pixel in
        northing but enough to shift the column by one full 60 m pixel in
        easting, and confirm `object_pixel_index` (using the *product's own*
        transform) lands on a different column than naively reusing the
        MGRS square's corner would.
        """
        tile = "32TPS"
        square = parse_mgrs_tile(tile)
        zone = square.zone

        # A point exactly at the MGRS square's nominal top-left corner.
        # (parse_mgrs_tile's min_easting/min_northing describe the granule's
        # own overhung corner - offset an interior point by 1.5 pixels so a
        # 1-pixel origin shift changes which column it falls in.)
        easting = square.min_easting + 90.0  # 1.5 pixels in
        northing = square.max_northing - 90.0
        from nevaio_pipeline.footprint import unproject_utm

        longitude, latitude = unproject_utm(easting, northing, zone)

        # "Naive" footprint-derived transform: pixel (0,0) at the MGRS
        # square's own corner, exactly as `parse_mgrs_tile` reports it.
        naive_transform = Affine(60.0, 0, square.min_easting, 0, -60.0, square.max_northing)
        naive_pixel = object_pixel_index(naive_transform, zone, longitude, latitude, width=1830, height=1830)

        # "Real" product transform: origin shifted by exactly one pixel
        # (60 m) east of the nominal square - within the plan's documented
        # up-to-40m-but-tile-dependent offset order of magnitude, chosen as a
        # clean, exact one-pixel shift so the column difference is unambiguous.
        shifted_transform = Affine(60.0, 0, square.min_easting + 60.0, 0, -60.0, square.max_northing)
        shifted_pixel = object_pixel_index(shifted_transform, zone, longitude, latitude, width=1830, height=1830)

        self.assertIsNotNone(naive_pixel)
        self.assertIsNotNone(shifted_pixel)
        # Same point, two different transforms -> a different column. Using
        # the wrong (naive/footprint-derived) transform for a raster whose
        # real origin is `shifted_transform` would silently sample the wrong
        # pixel by exactly one column - which is the bug this function exists
        # to avoid by always taking the transform the raster itself reports.
        self.assertEqual(naive_pixel[0], shifted_pixel[0])  # same row
        self.assertNotEqual(naive_pixel[1], shifted_pixel[1])  # different column
        self.assertEqual(naive_pixel[1] - shifted_pixel[1], 1)


class IndexTileObjectsTests(unittest.TestCase):
    def test_resolves_slots_and_pixels_for_every_object_inside_the_grid(self) -> None:
        zone = 32
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        longitude, latitude = unproject_for_test(transform, zone, col=1.5, row=2.5)
        entries = [entry("node/1", longitude, latitude)]
        slot_map = build_slot_map("32TPS", ["node/1"])

        pixels = index_tile_objects(entries, slot_map, transform=transform, zone=zone, width=4, height=4)
        self.assertEqual(len(pixels), 1)
        self.assertEqual(pixels.object_ids, ("node/1",))
        self.assertEqual(int(pixels.rows[0]), 2)
        self.assertEqual(int(pixels.cols[0]), 1)
        self.assertEqual(int(pixels.slots[0]), 0)

    def test_drops_objects_outside_the_grid_without_raising(self) -> None:
        zone = 32
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        far_longitude, far_latitude = unproject_for_test(transform, zone, col=1000.0, row=1000.0)
        entries = [entry("node/far", far_longitude, far_latitude)]
        slot_map = build_slot_map("32TPS", ["node/far"])

        pixels = index_tile_objects(entries, slot_map, transform=transform, zone=zone, width=4, height=4)
        self.assertEqual(len(pixels), 0)

    def test_raises_if_an_entry_has_no_slot(self) -> None:
        zone = 32
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        longitude, latitude = unproject_for_test(transform, zone, col=0.5, row=0.5)
        entries = [entry("node/unassigned", longitude, latitude)]
        slot_map = build_slot_map("32TPS", [])  # doesn't know this id

        with self.assertRaisesRegex(ValueError, "node/unassigned"):
            index_tile_objects(entries, slot_map, transform=transform, zone=zone, width=4, height=4)


def unproject_for_test(transform: Affine, zone: int, col: float, row: float) -> tuple[float, float]:
    from nevaio_pipeline.footprint import unproject_utm

    easting, northing = transform @ (col, row)
    return unproject_utm(easting, northing, zone)


class SampleDailyProductTests(unittest.TestCase):
    def test_one_fancy_index_gather_and_scatter_lands_at_the_right_slot_and_day(self) -> None:
        zone = 32
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        longitude, latitude = unproject_for_test(transform, zone, col=2.5, row=1.5)
        entries = [entry("node/1", longitude, latitude)]
        slot_map = build_slot_map("32TPS", ["node/1"])
        pixels = index_tile_objects(entries, slot_map, transform=transform, zone=zone, width=4, height=4)

        gf = np.zeros((4, 4), dtype=np.uint8)
        gf[1, 2] = 33
        quality = np.zeros((4, 4), dtype=np.uint8)
        acquisition_time = np.zeros((4, 4), dtype=np.uint32)
        from datetime import UTC, datetime

        product_date = date(2026, 3, 5)
        acquisition_time[1, 2] = int(datetime(2026, 3, 4, 10, tzinfo=UTC).timestamp())
        product = DailyProduct(product_date, gf, quality, acquisition_time)

        array = new_month_array(slot_map.slot_count, 2026, 3)
        sample_daily_product(array, pixels, product, days_in_month=31)

        decoded = decode_cell(bytes(array[0, product_date.day - 1]))
        self.assertEqual(decoded.state, SeriesMarkState.VALID)
        self.assertEqual(decoded.gf, 33)
        self.assertEqual(decoded.age_days, 1)
        # Every other day in this object's month is untouched (still no-data).
        for day in range(31):
            if day != product_date.day - 1:
                self.assertEqual(decode_cell(bytes(array[0, day])).state, SeriesMarkState.NO_DATA)

    def test_no_objects_is_a_harmless_no_op(self) -> None:
        slot_map = build_slot_map("32TPS", [])
        pixels = index_tile_objects([], slot_map, transform=Affine.identity(), zone=32, width=1, height=1)
        array = new_month_array(0, 2026, 3)
        gf = np.zeros((1, 1), dtype=np.uint8)
        product = DailyProduct(date(2026, 3, 1), gf, gf.copy(), gf.astype(np.uint32))
        sample_daily_product(array, pixels, product, days_in_month=31)  # no raise

    def test_rejects_a_product_date_outside_the_month(self) -> None:
        zone = 32
        transform = Affine(60.0, 0, 500_000.0, 0, -60.0, 5_000_000.0)
        longitude, latitude = unproject_for_test(transform, zone, col=0.5, row=0.5)
        entries = [entry("node/1", longitude, latitude)]
        slot_map = build_slot_map("32TPS", ["node/1"])
        pixels = index_tile_objects(entries, slot_map, transform=transform, zone=zone, width=4, height=4)
        array = new_month_array(1, 2026, 2)  # February, 28 days
        gf = np.zeros((4, 4), dtype=np.uint8)
        # Day 31 doesn't fit a 28-day month's day-index range.
        product = DailyProduct(date(2026, 3, 31), gf, gf.copy(), gf.astype(np.uint32))
        with self.assertRaises(ValueError):
            sample_daily_product(array, pixels, product, days_in_month=28)


if __name__ == "__main__":
    unittest.main()
