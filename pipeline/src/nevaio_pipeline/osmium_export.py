"""Normalize GeoJSON emitted by ``osmium export`` for Nevaio's object index.

``osmium export`` puts OSM tags directly in GeoJSON feature properties.  With
the checked-in export configuration it also adds ``@type`` and ``@id``
metadata fields. The public index deliberately has a smaller,
source-independent input contract: nested tags, separate type/ID fields, and
one representative Point. This module is the local boundary between those two
formats. It does not download extracts, invoke Osmium, publish anything, or
choose snow values.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable, Mapping, Sequence
import json
from math import isfinite
from pathlib import Path
import re

from nevaio_pipeline.object_index import classify_object

_OSM_ID = re.compile(r"^[1-9][0-9]*$")
_OSM_TYPES = frozenset({"node", "way", "relation"})


def _coordinate(value: object) -> tuple[float, float]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes))
        or len(value) < 2
        or any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value[:2])
    ):
        raise ValueError("geometry coordinates must contain numeric longitude and latitude")
    longitude, latitude = float(value[0]), float(value[1])
    if not isfinite(longitude) or not isfinite(latitude) or not (-180 <= longitude <= 180) or not (-90 <= latitude <= 90):
        raise ValueError("geometry coordinates are outside valid longitude/latitude bounds")
    return longitude, latitude


def _line_midpoint(coordinates: object) -> tuple[float, float]:
    if not isinstance(coordinates, Sequence) or isinstance(coordinates, (str, bytes)) or len(coordinates) < 2:
        raise ValueError("line geometry must have at least two positions")
    points = [_coordinate(position) for position in coordinates]
    lengths = [
        ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** 0.5
        for start, end in zip(points, points[1:])
    ]
    total = sum(lengths)
    if total == 0:
        raise ValueError("line geometry cannot have only identical positions")
    remaining = total / 2
    for start, end, length in zip(points, points[1:], lengths):
        if remaining <= length:
            ratio = remaining / length
            return (
                start[0] + (end[0] - start[0]) * ratio,
                start[1] + (end[1] - start[1]) * ratio,
            )
        remaining -= length
    return points[-1]


def _ring_centroid(coordinates: object) -> tuple[float, float]:
    if not isinstance(coordinates, Sequence) or isinstance(coordinates, (str, bytes)) or len(coordinates) < 4:
        raise ValueError("polygon outer ring must have at least four positions")
    points = [_coordinate(position) for position in coordinates]
    area_twice = 0.0
    longitude_sum = 0.0
    latitude_sum = 0.0
    for start, end in zip(points, points[1:]):
        cross = start[0] * end[1] - end[0] * start[1]
        area_twice += cross
        longitude_sum += (start[0] + end[0]) * cross
        latitude_sum += (start[1] + end[1]) * cross
    if area_twice == 0:
        return _line_midpoint(points)
    return longitude_sum / (3 * area_twice), latitude_sum / (3 * area_twice)


def representative_point(geometry: Mapping[str, object]) -> tuple[float, float]:
    """Return a deterministic point for supported GeoJSON geometry types.

    Point objects retain their location.  Lines use their length midpoint and
    polygons use the outer-ring centroid.  Multi-geometries pick the first
    non-empty component in the source's deterministic order; a future visual
    placement policy can replace that rule without changing object identity.
    """

    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Point":
        return _coordinate(coordinates)
    if geometry_type == "LineString":
        return _line_midpoint(coordinates)
    if geometry_type == "Polygon":
        if not isinstance(coordinates, Sequence) or isinstance(coordinates, (str, bytes)) or not coordinates:
            raise ValueError("polygon geometry must have an outer ring")
        return _ring_centroid(coordinates[0])
    if geometry_type in {"MultiLineString", "MultiPolygon"}:
        if not isinstance(coordinates, Sequence) or isinstance(coordinates, (str, bytes)) or not coordinates:
            raise ValueError(f"{geometry_type} geometry must have at least one component")
        first = coordinates[0]
        if geometry_type == "MultiLineString":
            return _line_midpoint(first)
        if not isinstance(first, Sequence) or isinstance(first, (str, bytes)) or not first:
            raise ValueError("MultiPolygon component must have an outer ring")
        return _ring_centroid(first[0])
    raise ValueError(f"unsupported Osmium GeoJSON geometry type: {geometry_type!r}")


def _osm_identity(properties: Mapping[str, object]) -> tuple[str, int]:
    osm_type = properties.get("@type")
    raw_id = properties.get("@id")
    if not isinstance(osm_type, str) or osm_type not in _OSM_TYPES:
        raise ValueError("Osmium GeoJSON feature requires @type node, way, or relation")
    if isinstance(raw_id, bool) or not isinstance(raw_id, (int, str)) or not _OSM_ID.fullmatch(str(raw_id)):
        raise ValueError("Osmium GeoJSON feature requires a positive numeric @id")
    return osm_type, int(raw_id)


def _tags(properties: Mapping[str, object]) -> dict[str, str]:
    return {
        key: value
        for key, value in properties.items()
        if not key.startswith("@") and isinstance(value, str)
    }


def normalize_feature(feature: Mapping[str, object]) -> dict[str, object] | None:
    """Normalize one named approved object, skipping non-interactive records."""

    properties = feature.get("properties")
    if not isinstance(properties, Mapping):
        raise ValueError("Osmium GeoJSON feature properties must be an object")
    tags = _tags(properties)
    if classify_object(tags) is None:
        return None
    # The public panel contract has a required name. Anonymous parking/shelter
    # geometry is not a useful selection target, and manufacturing a generic
    # label would hide that its OSM metadata is incomplete.
    if not isinstance(tags.get("name"), str) or not tags["name"].strip():
        return None
    osm_type, osm_id = _osm_identity(properties)
    geometry = feature.get("geometry")
    if not isinstance(geometry, Mapping):
        raise ValueError(f"eligible OSM object {osm_type}/{osm_id} has no geometry")
    longitude, latitude = representative_point(geometry)
    return {
        "type": "Feature",
        "properties": {"osmType": osm_type, "osmId": osm_id, "tags": tags},
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
    }


def normalize_feature_collection(features: Iterable[Mapping[str, object]]) -> dict[str, object]:
    """Normalize an iterable of exported features and reject duplicate IDs.

    Regional extracts can overlap.  The same object is allowed only when its
    normalized representation is byte-for-byte equivalent; otherwise a source
    snapshot mismatch must be resolved upstream instead of silently choosing
    a potentially stale version.
    """

    normalized: dict[str, dict[str, object]] = {}
    for feature in features:
        object_feature = normalize_feature(feature)
        if object_feature is None:
            continue
        properties = object_feature["properties"]
        assert isinstance(properties, Mapping)
        object_id = f"{properties['osmType']}/{properties['osmId']}"
        previous = normalized.get(object_id)
        if previous is not None and previous != object_feature:
            raise ValueError(f"conflicting duplicate OSM object across extracts: {object_id}")
        normalized[object_id] = object_feature
    return {"type": "FeatureCollection", "features": [normalized[key] for key in sorted(normalized)]}


def write_normalized_feature_collection(input_paths: Sequence[Path], output_path: Path) -> int:
    """Merge exported GeoJSON files into one normalized, deduplicated document."""

    source_features: list[Mapping[str, object]] = []
    for input_path in input_paths:
        try:
            source = json.loads(input_path.read_text(encoding="utf-8"))
        except OSError as error:
            raise ValueError(f"could not read Osmium GeoJSON input: {input_path}") from error
        except json.JSONDecodeError as error:
            raise ValueError(f"Osmium GeoJSON input is not valid JSON: {input_path}") from error
        if not isinstance(source, Mapping) or source.get("type") != "FeatureCollection":
            raise ValueError(f"Osmium GeoJSON input must be a FeatureCollection: {input_path}")
        features = source.get("features")
        if (
            not isinstance(features, Sequence)
            or isinstance(features, (str, bytes))
            or not all(isinstance(feature, Mapping) for feature in features)
        ):
            raise ValueError(f"Osmium GeoJSON FeatureCollection.features must be an array of objects: {input_path}")
        source_features.extend(features)

    document = normalize_feature_collection(source_features)
    output_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    features = document["features"]
    assert isinstance(features, list)
    return len(features)


def main(argv: Sequence[str] | None = None) -> None:
    """Normalize local output from ``osmium export``; no network access occurs."""

    parser = argparse.ArgumentParser(description="Normalize Osmium GeoJSON for Nevaio's object index")
    parser.add_argument("--input", type=Path, action="append", required=True, help="Osmium GeoJSON FeatureCollection")
    parser.add_argument("--output", type=Path, required=True, help="normalized OSM GeoJSON output")
    args = parser.parse_args(argv)
    count = write_normalized_feature_collection(args.input, args.output)
    print(f"wrote {count} normalized OSM object(s) to {args.output}")


if __name__ == "__main__":
    main()
