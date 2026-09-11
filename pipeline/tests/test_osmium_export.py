from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from nevaio_pipeline.osmium_export import (
    normalize_feature,
    normalize_feature_collection,
    representative_point,
    write_normalized_feature_collection,
)


def exported_feature(
    osm_id: str,
    tags: dict[str, str],
    geometry: dict[str, object],
) -> dict[str, object]:
    osm_type, numeric_id = osm_id.split("/", maxsplit=1)
    return {
        "type": "Feature",
        "properties": {"@type": osm_type, "@id": int(numeric_id), **tags},
        "geometry": geometry,
    }


class RepresentativePointTests(unittest.TestCase):
    def test_retains_point_and_uses_line_midpoint(self) -> None:
        self.assertEqual(representative_point({"type": "Point", "coordinates": [7.0, 45.0]}), (7.0, 45.0))
        self.assertEqual(
            representative_point({"type": "LineString", "coordinates": [[0, 0], [2, 0], [2, 2]]}),
            (2.0, 0.0),
        )

    def test_uses_polygon_outer_ring_centroid(self) -> None:
        self.assertEqual(
            representative_point(
                {"type": "Polygon", "coordinates": [[[0, 0], [4, 0], [4, 2], [0, 0]]]}
            ),
            (2.6666666666666665, 0.6666666666666666),
        )

    def test_rejects_unsupported_geometry(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported"):
            representative_point({"type": "GeometryCollection", "geometries": []})


class NormalizeFeatureTests(unittest.TestCase):
    def test_normalizes_direct_osmium_properties_and_filters_unapproved_features(self) -> None:
        normalized = normalize_feature(
            exported_feature(
                "way/42",
                {"amenity": "parking", "name": "Colle lot", "ele": "1820", "highway": "service"},
                {"type": "LineString", "coordinates": [[7.0, 45.0], [7.2, 45.0]]},
            )
        )
        self.assertEqual(
            normalized,
            {
                "type": "Feature",
                "properties": {
                    "osmType": "way",
                    "osmId": 42,
                    "tags": {"amenity": "parking", "name": "Colle lot", "ele": "1820", "highway": "service"},
                },
                "geometry": {"type": "Point", "coordinates": [7.1, 45.0]},
            },
        )
        self.assertIsNone(
            normalize_feature(
                exported_feature(
                    "way/99",
                    {"highway": "path", "name": "Not selectable"},
                    {"type": "LineString", "coordinates": [[7.0, 45.0], [7.2, 45.0]]},
                )
            )
        )
        self.assertIsNone(
            normalize_feature(
                exported_feature(
                    "node/100",
                    {"amenity": "parking"},
                    {"type": "Point", "coordinates": [7.0, 45.0]},
                )
            )
        )

    def test_rejects_malformed_eligible_feature_identity(self) -> None:
        invalid = exported_feature(
            "node/42",
            {"natural": "peak", "name": "Peak"},
            {"type": "Point", "coordinates": [7.0, 45.0]},
        )
        invalid["properties"]["@type"] = "area"
        with self.assertRaisesRegex(ValueError, "@type"):
            normalize_feature(invalid)

    def test_deduplicates_identical_overlap_and_rejects_conflicts(self) -> None:
        original = exported_feature(
            "node/42",
            {"natural": "peak", "name": "Peak"},
            {"type": "Point", "coordinates": [7.0, 45.0]},
        )
        document = normalize_feature_collection([original, original])
        self.assertEqual(len(document["features"]), 1)

        changed = exported_feature(
            "node/42",
            {"natural": "peak", "name": "Peak renamed"},
            {"type": "Point", "coordinates": [7.0, 45.0]},
        )
        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            normalize_feature_collection([original, changed])

    def test_writes_merged_feature_collections(self) -> None:
        source = {
            "type": "FeatureCollection",
            "features": [
                exported_feature(
                    "node/42",
                    {"natural": "peak", "name": "Peak"},
                    {"type": "Point", "coordinates": [7.0, 45.0]},
                )
            ],
        }
        with TemporaryDirectory() as directory:
            input_path = Path(directory) / "export.geojson"
            output_path = Path(directory) / "normalized.geojson"
            input_path.write_text(json.dumps(source), encoding="utf-8")
            self.assertEqual(write_normalized_feature_collection([input_path], output_path), 1)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8"))["features"], [
                {
                    "geometry": {"coordinates": [7.0, 45.0], "type": "Point"},
                    "properties": {
                        "osmId": 42,
                        "osmType": "node",
                        "tags": {"name": "Peak", "natural": "peak"},
                    },
                    "type": "Feature",
                }
            ])


if __name__ == "__main__":
    unittest.main()
