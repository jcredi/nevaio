from __future__ import annotations

import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from nevaio_pipeline.footprint import Footprint, mvp_footprint, parse_mgrs_tile, unproject_utm
from nevaio_pipeline.object_index import (
    INDEX_FILENAME,
    build_index_document,
    build_object_index,
    build_sharded_index,
    classify_object,
    shard_object_index,
    write_index_document,
    write_sharded_index,
)


def feature(
    osm_type: str,
    osm_id: int,
    tags: dict[str, object],
    coordinates: list[float] = [7.5, 45.5],
) -> dict[str, object]:
    return {
        "type": "Feature",
        "properties": {"osmType": osm_type, "osmId": osm_id, "tags": tags},
        "geometry": {"type": "Point", "coordinates": coordinates},
    }


class ClassifyObjectTests(unittest.TestCase):
    def test_includes_exactly_the_approved_classes(self) -> None:
        cases = [
            ({"natural": "peak"}, "peak"),
            ({"tourism": "alpine_hut"}, "hut"),
            ({"tourism": "wilderness_hut"}, "hut"),
            ({"natural": "saddle"}, "saddle"),
            ({"mountain_pass": "yes"}, "saddle"),
            ({"amenity": "shelter"}, "shelter"),
            ({"amenity": "parking"}, "parking"),
            ({"place": "village"}, "settlement"),
        ]
        for tags, expected in cases:
            with self.subTest(tags=tags):
                self.assertEqual(classify_object(tags), expected)

    def test_huts_beat_broad_shelter_tags_and_linear_features_are_excluded(self) -> None:
        self.assertEqual(
            classify_object({"tourism": "alpine_hut", "amenity": "shelter"}),
            "hut",
        )
        self.assertIsNone(classify_object({"highway": "path", "name": "Via Alta"}))
        self.assertIsNone(classify_object({"highway": "track", "mountain_pass": "no"}))


class FootprintFilterTests(unittest.TestCase):
    """Only objects Nevaio has snow for may reach the published index."""

    def _names(self, features, footprint) -> list[str]:
        return [entry.name for entry in build_object_index(features, footprint)]

    def test_keeps_objects_inside_the_snow_footprint_and_drops_the_rest(self) -> None:
        footprint = mvp_footprint()
        features = [
            feature("node", 1, {"natural": "peak", "name": "Mont Blanc"}, [6.8651, 45.8326]),
            feature("node", 2, {"natural": "peak", "name": "Gran Sasso"}, [13.5594, 42.4700]),
            feature("node", 3, {"place": "city", "name": "Paris"}, [2.3522, 48.8566]),
            feature("node", 4, {"place": "city", "name": "Palermo"}, [13.3614, 38.1157]),
            feature("node", 5, {"place": "city", "name": "Vienna"}, [16.3738, 48.2082]),
        ]
        self.assertEqual(self._names(features, footprint), ["Mont Blanc", "Gran Sasso"])

    def test_no_footprint_keeps_everything_so_the_core_stays_testable(self) -> None:
        features = [feature("node", 3, {"place": "city", "name": "Paris"}, [2.3522, 48.8566])]
        self.assertEqual(self._names(features, None), ["Paris"])

    def test_granule_edges_are_inclusive_and_one_metre_outside_is_excluded(self) -> None:
        square = parse_mgrs_tile("33TUH")
        footprint = Footprint.from_tiles(["33TUH"])
        inside = unproject_utm(square.min_easting + 1.0, square.min_northing + 1.0, square.zone)
        outside = unproject_utm(square.min_easting - 1.0, square.min_northing - 1.0, square.zone)
        features = [
            feature("node", 1, {"natural": "peak", "name": "Just inside"}, list(inside)),
            feature("node", 2, {"natural": "peak", "name": "Just outside"}, list(outside)),
        ]
        self.assertEqual(self._names(features, footprint), ["Just inside"])

    def test_an_object_in_the_gap_between_squares_is_dropped(self) -> None:
        # The MVP set has no 32TQQ; the Po plain there is genuinely uncovered.
        gap = unproject_utm(750_000.0, 4_945_000.0, 32)
        features = [feature("node", 1, {"place": "town", "name": "In the gap"}, list(gap))]
        self.assertEqual(self._names(features, mvp_footprint()), [])

    def test_a_duplicate_identity_still_fails_outside_the_footprint(self) -> None:
        # Filtering must not become a way for a conflicting source snapshot to
        # slip through unnoticed.
        features = [
            feature("node", 1, {"place": "city", "name": "Paris"}, [2.3522, 48.8566]),
            feature("node", 1, {"place": "city", "name": "Paris"}, [2.3522, 48.8566]),
        ]
        with self.assertRaisesRegex(ValueError, "duplicate OSM object"):
            build_object_index(features, mvp_footprint())

    def test_a_malformed_record_fails_rather_than_being_filtered_away(self) -> None:
        broken = feature("node", 1, {"natural": "peak", "name": "Nameless"}, [2.0, 48.0])
        broken["properties"]["tags"]["name"] = "   "
        with self.assertRaisesRegex(ValueError, "name for node/1"):
            build_object_index([broken], mvp_footprint())


class ShardedIndexTests(unittest.TestCase):
    """The publishable artifact: a small index of shards plus one per tile."""

    def _collection(self, features):
        return {"type": "FeatureCollection", "features": features}

    def setUp(self) -> None:
        self.footprint = mvp_footprint()
        # Deliberately in three different tiles, two of them in different UTM
        # zones, so a shard key cannot accidentally be a single-zone accident.
        self.features = [
            feature("node", 1, {"natural": "peak", "name": "Mont Blanc"}, [6.8651, 45.8326]),
            feature("node", 2, {"natural": "peak", "name": "Gran Sasso"}, [13.5594, 42.4700]),
            feature("node", 3, {"tourism": "alpine_hut", "name": "Rifugio"}, [13.6000, 42.4800]),
            feature("node", 4, {"place": "city", "name": "Paris"}, [2.3522, 48.8566]),
        ]

    def test_each_object_lands_in_exactly_one_shard(self) -> None:
        entries = build_object_index(self.features, self.footprint)
        shards = shard_object_index(entries, self.footprint)
        self.assertEqual([shard.tile for shard in shards], ["31TGL", "33TUH"])
        self.assertEqual(sum(len(shard.entries) for shard in shards), len(entries))
        # Mont Blanc is inside both 31TGL and 32TLR; the first sorted covering
        # tile owns it, so no client ever sees it twice.
        self.assertEqual([entry.name for entry in shards[0].entries], ["Mont Blanc"])
        self.assertEqual(
            sorted(entry.name for entry in shards[1].entries), ["Gran Sasso", "Rifugio"]
        )

    def test_a_tile_with_no_objects_gets_no_shard(self) -> None:
        entries = build_object_index(self.features, self.footprint)
        shards = shard_object_index(entries, self.footprint)
        self.assertLess(len(shards), len(self.footprint.squares))

    def test_shard_index_describes_bounds_size_and_digest_of_each_payload(self) -> None:
        files = build_sharded_index(self._collection(self.features), self.footprint)
        index = json.loads(files[INDEX_FILENAME])
        self.assertEqual(index["schemaVersion"], 1)
        self.assertEqual(index["objectCount"], 3)
        self.assertEqual([shard["tile"] for shard in index["shards"]], ["31TGL", "33TUH"])
        for shard in index["shards"]:
            with self.subTest(tile=shard["tile"]):
                payload = files[shard["path"]]
                self.assertEqual(shard["bytes"], len(payload))
                self.assertEqual(shard["sha256"], hashlib.sha256(payload).hexdigest())
                objects = json.loads(payload)["objects"]
                self.assertEqual(shard["objectCount"], len(objects))
                west, south, east, north = shard["bounds"]
                for obj in objects:
                    self.assertTrue(west <= obj["longitude"] <= east)
                    self.assertTrue(south <= obj["latitude"] <= north)

    def test_shard_bounds_track_the_objects_not_the_granule(self) -> None:
        # A viewport test against granule bounds would fetch shards that hold
        # nothing nearby; these bounds are tight around the real objects.
        files = build_sharded_index(self._collection(self.features), self.footprint)
        index = json.loads(files[INDEX_FILENAME])
        bounds = {shard["tile"]: shard["bounds"] for shard in index["shards"]}
        self.assertEqual(bounds["31TGL"], [6.8651, 45.8326, 6.8651, 45.8326])
        self.assertEqual(bounds["33TUH"], [13.5594, 42.47, 13.6, 42.48])

    def test_identical_input_gives_byte_identical_artifacts(self) -> None:
        first = build_sharded_index(self._collection(self.features), self.footprint)
        second = build_sharded_index(self._collection(list(reversed(self.features))), self.footprint)
        self.assertEqual(first, second)
        self.assertNotIn(b"\n  ", first[INDEX_FILENAME])

    def test_writes_the_index_and_its_payloads_under_one_directory(self) -> None:
        with TemporaryDirectory() as directory:
            input_path = Path(directory) / "objects.geojson"
            output_dir = Path(directory) / "out"
            input_path.write_text(json.dumps(self._collection(self.features)), encoding="utf-8")
            self.assertEqual(write_sharded_index(input_path, output_dir), (3, 2))
            index = json.loads((output_dir / INDEX_FILENAME).read_text(encoding="utf-8"))
            for shard in index["shards"]:
                payload = (output_dir / shard["path"]).read_bytes()
                self.assertEqual(hashlib.sha256(payload).hexdigest(), shard["sha256"])
            self.assertEqual(
                sorted(path.name for path in (output_dir / "objects").iterdir()),
                ["31TGL.json", "33TUH.json"],
            )

    def test_refuses_to_shard_an_object_outside_the_footprint(self) -> None:
        entries = build_object_index(self.features)
        with self.assertRaisesRegex(ValueError, "outside the footprint"):
            shard_object_index(entries, self.footprint)


class BuildObjectIndexTests(unittest.TestCase):
    def test_builds_stable_sorted_entries_with_optional_elevation(self) -> None:
        entries = build_object_index(
            [
                feature("node", 20, {"natural": "peak", "name": "Monte Rosa", "ele": "4634"}),
                feature("way", 10, {"amenity": "parking", "name": "Trailhead"}, [7.4, 45.4]),
                feature("node", 30, {"highway": "path", "name": "Ignored"}),
            ]
        )

        self.assertEqual([entry.id for entry in entries], ["node/20", "way/10"])
        self.assertEqual(entries[0].kind, "peak")
        self.assertEqual(entries[0].elevation_meters, 4634.0)
        self.assertIsNone(entries[1].elevation_meters)
        self.assertEqual(
            entries[0].to_document(),
            {
                "id": "node/20",
                "kind": "peak",
                "name": "Monte Rosa",
                "longitude": 7.5,
                "latitude": 45.5,
                "elevationMeters": 4634.0,
            },
        )

    def test_rejects_malformed_eligible_records(self) -> None:
        with self.assertRaisesRegex(ValueError, "name for node/1"):
            build_object_index([feature("node", 1, {"natural": "peak"})])
        with self.assertRaisesRegex(ValueError, "Point geometry"):
            invalid = feature("node", 2, {"natural": "saddle", "name": "Col"})
            invalid["geometry"] = {"type": "LineString", "coordinates": [[7.5, 45.5]]}
            build_object_index([invalid])
        with self.assertRaisesRegex(ValueError, "positive integer"):
            invalid = feature("node", 0, {"amenity": "parking", "name": "Lot"})
            build_object_index([invalid])

    def test_rejects_duplicate_stable_id(self) -> None:
        duplicate = [
            feature("node", 1, {"natural": "peak", "name": "A"}),
            feature("node", 1, {"natural": "saddle", "name": "B"}),
        ]
        with self.assertRaisesRegex(ValueError, "duplicate OSM object: node/1"):
            build_object_index(duplicate)


class IndexDocumentTests(unittest.TestCase):
    def test_document_is_versioned_deterministic_and_writable(self) -> None:
        source = {
            "type": "FeatureCollection",
            "features": [
                feature("node", 2, {"natural": "peak", "name": "B"}),
                feature("node", 1, {"amenity": "parking", "name": "A"}),
            ],
        }
        expected = {
            "schemaVersion": 1,
            "objects": [
                {
                    "id": "node/1",
                    "kind": "parking",
                    "name": "A",
                    "longitude": 7.5,
                    "latitude": 45.5,
                    "elevationMeters": None,
                },
                {
                    "id": "node/2",
                    "kind": "peak",
                    "name": "B",
                    "longitude": 7.5,
                    "latitude": 45.5,
                    "elevationMeters": None,
                },
            ],
        }
        self.assertEqual(build_index_document(source), expected)

        with TemporaryDirectory() as directory:
            input_path = Path(directory) / "objects.geojson"
            output_path = Path(directory) / "index.json"
            input_path.write_text(json.dumps(source), encoding="utf-8")
            self.assertEqual(write_index_document(input_path, output_path), 2)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), expected)

    def test_rejects_non_feature_collection_documents(self) -> None:
        with self.assertRaisesRegex(ValueError, "FeatureCollection"):
            build_index_document({"type": "Feature", "features": []})


if __name__ == "__main__":
    unittest.main()
