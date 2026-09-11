"""Build the stable OSM-object index consumed by the panel and snow history.

The map's provider tiles remain visual context: their rendered properties are
not a durable identity API. A future acquisition adapter supplies a normalized
GeoJSON FeatureCollection (with an OSM type, ID, and tags); this pure module
keeps only the product's approved, named point objects and gives each one a
stable ``node/123``-style identity. It deliberately knows nothing about
downloads, raster sampling, R2, or MapLibre.

An object outside Nevaio's snow footprint is dropped the same way an
unapproved tag is. The panel's whole purpose is a snow history, and there is
none to show where no GFSC product exists; shipping such an object would be a
selectable target that answers every question with "no data". The footprint
itself is not defined here - :mod:`nevaio_pipeline.footprint` owns it.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from math import isfinite
from pathlib import Path
import re
from typing import Literal, Mapping, Sequence

from .footprint import Footprint, mvp_footprint

ObjectKind = Literal["peak", "hut", "saddle", "shelter", "parking", "settlement"]

_OSM_TYPES = frozenset({"node", "way", "relation"})
_SETTLEMENT_TAGS = frozenset({"city", "town", "village", "hamlet"})


@dataclass(frozen=True)
class ObjectIndexEntry:
    """One selectable OSM object and its durable panel/history identity."""

    id: str
    kind: ObjectKind
    name: str
    longitude: float
    latitude: float
    elevation_meters: float | None

    def to_document(self) -> dict[str, object]:
        """Return the compact, JSON-ready public representation."""

        document = asdict(self)
        document["elevationMeters"] = document.pop("elevation_meters")
        return document


def classify_object(tags: Mapping[str, object]) -> ObjectKind | None:
    """Classify exactly the product-approved OSM tags, or return ``None``.

    More-specific hut tags take precedence over the broad ``amenity=shelter``
    class, so a refuge never loses its useful type to its secondary shelter
    tag. A named road/path with ``mountain_pass=yes`` is a pass target, but no
    transport geometry is included merely because it is a road or path.
    """

    tourism = tags.get("tourism")
    if tourism in {"alpine_hut", "wilderness_hut"}:
        return "hut"
    if tags.get("natural") == "peak":
        return "peak"
    if tags.get("natural") == "saddle" or tags.get("mountain_pass") == "yes":
        return "saddle"
    if tags.get("amenity") == "shelter":
        return "shelter"
    if tags.get("amenity") == "parking":
        return "parking"
    if tags.get("place") in _SETTLEMENT_TAGS:
        return "settlement"
    return None


def _required_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not (text := value.strip()):
        raise ValueError(f"{field} must be a non-empty string")
    return text


def _osm_id(properties: Mapping[str, object]) -> str:
    osm_type = _required_string(properties.get("osmType"), "osmType")
    if osm_type not in _OSM_TYPES:
        raise ValueError(f"unsupported osmType: {osm_type!r}")

    raw_id = properties.get("osmId")
    if isinstance(raw_id, bool) or not isinstance(raw_id, (str, int)):
        raise ValueError("osmId must be a positive integer")
    try:
        numeric_id = int(raw_id)
    except ValueError as error:
        raise ValueError("osmId must be a positive integer") from error
    if numeric_id <= 0 or str(numeric_id) != str(raw_id):
        raise ValueError("osmId must be a positive integer")
    return f"{osm_type}/{numeric_id}"


def _point(feature: Mapping[str, object]) -> tuple[float, float]:
    geometry = feature.get("geometry")
    if not isinstance(geometry, Mapping) or geometry.get("type") != "Point":
        raise ValueError("eligible object must have Point geometry")
    coordinates = geometry.get("coordinates")
    if (
        not isinstance(coordinates, Sequence)
        or isinstance(coordinates, (str, bytes))
        or len(coordinates) != 2
        or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in coordinates)
    ):
        raise ValueError("Point geometry must have numeric longitude and latitude")
    longitude, latitude = (float(value) for value in coordinates)
    if not isfinite(longitude) or not isfinite(latitude) or not (-180 <= longitude <= 180) or not (-90 <= latitude <= 90):
        raise ValueError("Point geometry is outside valid longitude/latitude bounds")
    return longitude, latitude


def _elevation(tags: Mapping[str, object]) -> float | None:
    value = tags.get("ele")
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        # OSM tags arrive as strings. Accept only a bare numeric metres value;
        # values with units or other prose need an explicit future policy.
        if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", value.strip()):
            return None
    elif not isinstance(value, (int, float)):
        return None
    elevation = float(value)
    return elevation if isfinite(elevation) else None


def build_object_index(
    features: Sequence[Mapping[str, object]],
    footprint: Footprint | None = None,
) -> tuple[ObjectIndexEntry, ...]:
    """Return a deterministic index from normalized OSM GeoJSON features.

    Input is deliberately small and explicit: each Feature needs ``geometry``
    plus ``properties.osmType``, ``properties.osmId``, and ``properties.tags``.
    Unapproved tags are ignored, while malformed approved records fail instead
    of being published as a target that cannot later be matched to history.

    ``footprint`` restricts the result to objects Nevaio actually has snow for.
    It stays optional so the classification and identity rules can be tested
    without a geography, but every published index is built with one; the
    command below supplies the MVP footprint and offers no way to opt out.
    Filtering is a coordinate test on already-validated records, so a record
    that is malformed still fails rather than being quietly skipped for being
    somewhere else.
    """

    entries: list[ObjectIndexEntry] = []
    seen_ids: set[str] = set()

    for feature in features:
        properties = feature.get("properties")
        if not isinstance(properties, Mapping):
            raise ValueError("Feature properties must be an object")
        tags = properties.get("tags")
        if not isinstance(tags, Mapping):
            raise ValueError("Feature properties.tags must be an object")
        kind = classify_object(tags)
        if kind is None:
            continue

        object_id = _osm_id(properties)
        if object_id in seen_ids:
            raise ValueError(f"duplicate OSM object: {object_id}")
        name = _required_string(tags.get("name"), f"name for {object_id}")
        longitude, latitude = _point(feature)
        if footprint is not None and not footprint.contains(longitude, latitude):
            seen_ids.add(object_id)
            continue
        entries.append(
            ObjectIndexEntry(
                id=object_id,
                kind=kind,
                name=name,
                longitude=longitude,
                latitude=latitude,
                elevation_meters=_elevation(tags),
            )
        )
        seen_ids.add(object_id)

    return tuple(sorted(entries, key=lambda entry: entry.id))


def build_index_document(
    feature_collection: Mapping[str, object],
    footprint: Footprint | None = None,
) -> dict[str, object]:
    """Validate a normalized GeoJSON FeatureCollection and produce public JSON.

    The document contains no timestamp or source-specific metadata, so identical
    input gives byte-for-byte identical serialized output. The acquisition
    adapter owns source provenance separately; it must normalize its input into
    the explicit feature contract described by :func:`build_object_index`.
    """

    if feature_collection.get("type") != "FeatureCollection":
        raise ValueError("OSM input must be a GeoJSON FeatureCollection")
    features = feature_collection.get("features")
    if not isinstance(features, Sequence) or isinstance(features, (str, bytes)):
        raise ValueError("GeoJSON FeatureCollection.features must be an array")
    if not all(isinstance(feature, Mapping) for feature in features):
        raise ValueError("GeoJSON FeatureCollection.features must contain objects")

    index = build_object_index(features, footprint)
    return {
        "schemaVersion": 1,
        "objects": [entry.to_document() for entry in index],
    }


def write_index_document(
    input_path: Path,
    output_path: Path,
    footprint: Footprint | None = None,
) -> int:
    """Convert a normalized local GeoJSON file to a deterministic index file."""

    try:
        source = json.loads(input_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"could not read OSM input: {input_path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"OSM input is not valid JSON: {input_path}") from error
    if not isinstance(source, Mapping):
        raise ValueError("OSM input must be a JSON object")

    document = build_index_document(source, footprint)
    output_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return len(document["objects"])


def main(argv: Sequence[str] | None = None) -> None:
    """Build a local object index; downloading and publication are separate."""

    parser = argparse.ArgumentParser(description="Build Nevaio's static OSM object index")
    parser.add_argument("--input", type=Path, required=True, help="normalized OSM GeoJSON input")
    parser.add_argument("--output", type=Path, required=True, help="public index JSON output")
    args = parser.parse_args(argv)
    footprint = mvp_footprint()
    count = write_index_document(args.input, args.output, footprint)
    print(f"wrote {count} approved OSM object(s) inside the snow footprint to {args.output}")


if __name__ == "__main__":
    main()
