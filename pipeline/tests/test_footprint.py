"""Tests for the single definition of Nevaio's snow footprint."""

from __future__ import annotations

import unittest

from nevaio_pipeline.config import MVP_MGRS_TILES
from nevaio_pipeline.footprint import (
    Footprint,
    GRANULE_METRES,
    mvp_footprint,
    parse_mgrs_tile,
    project_utm,
    unproject_utm,
    utm_epsg,
)

# Reference eastings/northings produced by PROJ (EPSG:326xx) for the same
# points, pinned here so the pure-Python Krüger series cannot silently drift
# away from the projection the rasters are actually published in. The pipeline
# tests must not need a projection library to check this.
_PROJ_REFERENCE = (
    (6.8651, 45.8326, 32, 334193.003697, 5077664.798035),
    (13.5594, 42.4700, 33, 381573.777238, 4702967.291977),
    (4.8357, 45.7640, 31, 642744.984926, 5069465.455942),
    # Zone 60/zone 1 either side of the antimeridian: nothing Nevaio ships is
    # there, but the longitude wrap must be arithmetic, not a special case.
    (179.5, 60.0, 60, 639422.088460, 6654046.023776),
    (-179.5, 60.0, 1, 360577.911540, 6654046.023776),
)


class ProjectionTest(unittest.TestCase):
    def test_matches_proj_reference_values(self) -> None:
        for longitude, latitude, zone, easting, northing in _PROJ_REFERENCE:
            with self.subTest(zone=zone, longitude=longitude):
                projected = project_utm(longitude, latitude, zone)
                self.assertAlmostEqual(projected[0], easting, places=3)
                self.assertAlmostEqual(projected[1], northing, places=3)

    def test_round_trips_within_a_micrometre(self) -> None:
        for longitude, latitude, zone, _, _ in _PROJ_REFERENCE:
            with self.subTest(zone=zone, longitude=longitude):
                back = unproject_utm(*project_utm(longitude, latitude, zone), zone)
                self.assertAlmostEqual(back[0], longitude, places=9)
                self.assertAlmostEqual(back[1], latitude, places=9)

    def test_projects_across_a_zone_seam_into_the_neighbouring_zone(self) -> None:
        # 12E is the 32/33 seam; both zones must accept the point, because a
        # granule from either side can overhang it.
        in_32 = project_utm(12.0, 45.0, 32)
        in_33 = project_utm(12.0, 45.0, 33)
        self.assertGreater(in_32[0], 700_000.0)
        self.assertLess(in_33[0], 300_000.0)
        self.assertAlmostEqual(in_32[1], in_33[1], delta=200.0)

    def test_rejects_a_longitude_far_outside_the_zone(self) -> None:
        with self.assertRaisesRegex(ValueError, "too far from UTM zone"):
            project_utm(-10.0, 45.0, 33)


class MgrsTileTest(unittest.TestCase):
    def test_decodes_an_odd_zone_tile(self) -> None:
        square = parse_mgrs_tile("31TFK")
        self.assertEqual((square.zone, square.epsg), (31, 32631))
        self.assertEqual(square.min_easting, 600_000.0)
        # Row K in an odd zone is the 100 km square based at 4 900 000; the
        # granule hangs 9.8 km south of it.
        self.assertEqual(square.min_northing, 4_890_200.0)
        self.assertEqual(square.max_easting, 600_000.0 + GRANULE_METRES)

    def test_decodes_an_even_zone_tile_with_the_five_letter_row_shift(self) -> None:
        square = parse_mgrs_tile("32TPS")
        self.assertEqual(square.zone, 32)
        self.assertEqual(square.min_easting, 600_000.0)
        self.assertEqual(square.min_northing, 5_090_200.0)

    def test_resolves_the_row_cycle_using_the_latitude_band(self) -> None:
        # Same zone and row letter, different band: the 2000 km row cycle must
        # be resolved by the band rather than assumed.
        self.assertEqual(parse_mgrs_tile("33TWE").min_northing, 4_390_200.0)
        self.assertEqual(parse_mgrs_tile("33SWD").min_northing, 4_290_200.0)

    def test_every_mvp_tile_decodes_inside_its_own_latitude_band(self) -> None:
        for tile in MVP_MGRS_TILES:
            with self.subTest(tile=tile):
                square = parse_mgrs_tile(tile)
                self.assertEqual(utm_epsg(tile), 32600 + square.zone)
                latitudes = [corner[1] for corner in square.corners_wgs84()]
                band_min = -80.0 + 8.0 * "CDEFGHJKLMNPQRSTUVWX".index(tile[2])
                self.assertGreater(min(latitudes), band_min - 1.0)
                self.assertLess(max(latitudes), band_min + 9.0)

    def test_rejects_malformed_tile_ids(self) -> None:
        for tile in ("32TP", "32tps", "99TPS", "32IPS", "32TIS", "32TPI", "32TAS"):
            with self.subTest(tile=tile):
                with self.assertRaises(ValueError):
                    parse_mgrs_tile(tile)


class FootprintTest(unittest.TestCase):
    def setUp(self) -> None:
        self.footprint = mvp_footprint()

    def test_covers_the_alpine_arc_and_apennine_spine(self) -> None:
        for name, longitude, latitude in (
            ("Mont Blanc", 6.8651, 45.8326),
            ("Matterhorn", 7.6586, 45.9763),
            ("Zugspitze", 10.9863, 47.4211),
            ("Gran Sasso", 13.5594, 42.4700),
            ("Aspromonte", 15.9167, 38.1667),
        ):
            with self.subTest(name=name):
                self.assertTrue(self.footprint.contains(longitude, latitude))

    def test_excludes_places_the_app_never_shows_snow_for(self) -> None:
        for name, longitude, latitude in (
            ("Paris", 2.3522, 48.8566),
            ("Munich", 11.5820, 48.1351),
            ("Vienna", 16.3738, 48.2082),
            ("Marseille", 5.3698, 43.2965),
            ("Cagliari", 9.1217, 39.2238),
            ("Palermo", 13.3614, 38.1157),
            ("Bari", 16.8719, 41.1171),
        ):
            with self.subTest(name=name):
                self.assertFalse(self.footprint.contains(longitude, latitude))

    def test_a_point_just_inside_a_granule_edge_is_covered(self) -> None:
        square = parse_mgrs_tile("33TUH")
        for easting, northing in (
            (square.min_easting + 1.0, square.min_northing + 1.0),
            (square.max_easting - 1.0, square.max_northing - 1.0),
        ):
            with self.subTest(easting=easting, northing=northing):
                longitude, latitude = unproject_utm(easting, northing, square.zone)
                self.assertIn("33TUH", self.footprint.containing_tiles(longitude, latitude))

    def test_a_point_just_outside_an_isolated_granule_edge_is_not_covered(self) -> None:
        # Tested against a one-granule footprint: in the MVP set a neighbour's
        # 9.8 km overhang would cover these points, which would hide a wrong
        # edge rather than exercise it.
        single = Footprint.from_tiles(["33TUH"])
        square = parse_mgrs_tile("33TUH")
        for easting, northing in (
            (square.min_easting - 1.0, square.min_northing + 1.0),
            (square.min_easting + 1.0, square.max_northing + 1.0),
        ):
            with self.subTest(easting=easting, northing=northing):
                longitude, latitude = unproject_utm(easting, northing, square.zone)
                self.assertFalse(single.contains(longitude, latitude))

    def test_the_gap_between_non_adjacent_squares_is_not_covered(self) -> None:
        # The MVP set has no 32TQQ, so the Po plain between the Alpine and
        # Apennine corridors is a real hole - overhang from 32TQP and 32TQR
        # must not close it.
        for northing in (4_910_000.0, 4_945_000.0, 4_980_000.0):
            for easting in (710_000.0, 750_000.0, 790_000.0):
                with self.subTest(easting=easting, northing=northing):
                    longitude, latitude = unproject_utm(easting, northing, 32)
                    self.assertEqual(self.footprint.containing_tiles(longitude, latitude), ())

    def test_granules_overlap_across_the_utm_zone_seams(self) -> None:
        # Mont Blanc sits in both a zone 31 and a zone 32 granule; Rome in both
        # a zone 32 and a zone 33 one. Containment must be answered in each
        # granule's own zone rather than in one shared projection.
        self.assertEqual(self.footprint.containing_tiles(6.8651, 45.8326), ("31TGL", "32TLR"))
        self.assertEqual(self.footprint.containing_tiles(12.4964, 41.9028), ("32TQM", "33TTG"))

    def test_bounding_box_encloses_every_granule_corner(self) -> None:
        west, south, east, north = self.footprint.bounding_box()
        self.assertLess(west, east)
        self.assertLess(south, north)
        for square in self.footprint.squares:
            for longitude, latitude in square.corners_wgs84():
                self.assertTrue(west <= longitude <= east)
                self.assertTrue(south <= latitude <= north)

    def test_rejects_an_empty_or_duplicated_tile_set(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least one MGRS tile"):
            Footprint.from_tiles([])
        with self.assertRaisesRegex(ValueError, "must be unique"):
            Footprint.from_tiles(["32TPS", "32TPS"])


if __name__ == "__main__":
    unittest.main()
