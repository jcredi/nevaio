from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from nevaio_pipeline.object_index import (
    build_index_document,
    build_object_index,
    classify_object,
    write_index_document,
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
