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
import hashlib
import json
from math import cos, hypot, isfinite, radians
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


# --- Hut/shelter de-duplication -------------------------------------------
#
# A staffed refuge is routinely mapped twice: once as `tourism=alpine_hut` for
# the institution and once as `amenity=shelter` for the building, a few metres
# apart. `Rifugio Quinto Alpini` is the case that surfaced it - two OSM objects,
# 10 m apart, one real place. Both were selectable, both would get their own
# identical snow history, and the tap rule in `app/src/objects/selection.ts`
# would refuse the tap as ambiguous rather than answer it: the panel's worst
# outcome, produced by an artefact of mapping practice.
#
# The hut wins. It is the object a user is looking for, it carries the useful
# type, and `classify_object` already prefers it when one object holds both
# tags; this extends the same precedence across the pair. The rule requires
# both an identical name and physical proximity, so two genuinely different
# places - a bivouac near a refuge of another name, or two `Rifugio` shelters
# in different valleys - are untouched. It never drops a hut, so no object
# disappears from the index without an equivalent, better-typed one remaining.

SHELTER_DEDUPE_METRES = 250.0
_EARTH_RADIUS_METRES = 6_371_008.8


def _match_name(name: str) -> str:
    """Fold a name for matching only; the published name keeps its own form."""

    return " ".join(name.split()).casefold()


def _metres_apart(
    longitude_a: float,
    latitude_a: float,
    longitude_b: float,
    latitude_b: float,
) -> float:
    """Approximate ground distance, good to well under a metre at these ranges.

    A local flat-Earth step is deliberate: this module answers a "same building
    or not" question over tens of metres, and reaching for the footprint's UTM
    machinery would tie a naming rule to a projection it does not need.
    """

    mean_latitude = radians((latitude_a + latitude_b) / 2)
    east = radians(longitude_b - longitude_a) * cos(mean_latitude) * _EARTH_RADIUS_METRES
    north = radians(latitude_b - latitude_a) * _EARTH_RADIUS_METRES
    return hypot(east, north)


def drop_shadowed_shelters(
    entries: Sequence[ObjectIndexEntry],
    within_metres: float = SHELTER_DEDUPE_METRES,
) -> tuple[ObjectIndexEntry, ...]:
    """Drop each shelter that duplicates a same-named hut close beside it."""

    huts_by_name: dict[str, list[ObjectIndexEntry]] = {}
    for entry in entries:
        if entry.kind == "hut":
            huts_by_name.setdefault(_match_name(entry.name), []).append(entry)
    if not huts_by_name:
        return tuple(entries)

    return tuple(
        entry
        for entry in entries
        if not (
            entry.kind == "shelter"
            and any(
                _metres_apart(entry.longitude, entry.latitude, hut.longitude, hut.latitude)
                <= within_metres
                for hut in huts_by_name.get(_match_name(entry.name), ())
            )
        )
    )


def build_object_index(
    features: Sequence[Mapping[str, object]],
    footprint: Footprint | None = None,
) -> tuple[ObjectIndexEntry, ...]:
    """Return a deterministic index from normalized OSM GeoJSON features.

    Input is deliberately small and explicit: each Feature needs ``geometry``
    plus ``properties.osmType``, ``properties.osmId``, and ``properties.tags``.
    Unapproved tags are ignored, while malformed approved records fail instead
    of being published as a target that cannot later be matched to history.

    A shelter that merely duplicates a same-named hut beside it is dropped -
    see :func:`drop_shadowed_shelters` - so one real place is one selectable
    target.

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

    return tuple(sorted(drop_shadowed_shelters(entries), key=lambda entry: entry.id))


INDEX_FILENAME = "object-index.json"


def _features(feature_collection: Mapping[str, object]) -> Sequence[Mapping[str, object]]:
    if feature_collection.get("type") != "FeatureCollection":
        raise ValueError("OSM input must be a GeoJSON FeatureCollection")
    features = feature_collection.get("features")
    if not isinstance(features, Sequence) or isinstance(features, (str, bytes)):
        raise ValueError("GeoJSON FeatureCollection.features must be an array")
    if not all(isinstance(feature, Mapping) for feature in features):
        raise ValueError("GeoJSON FeatureCollection.features must contain objects")
    return features


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

    index = build_object_index(_features(feature_collection), footprint)
    return {
        "schemaVersion": 1,
        "objects": [entry.to_document() for entry in index],
    }


def _read_source(input_path: Path) -> Mapping[str, object]:
    try:
        source = json.loads(input_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"could not read OSM input: {input_path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"OSM input is not valid JSON: {input_path}") from error
    if not isinstance(source, Mapping):
        raise ValueError("OSM input must be a JSON object")
    return source


def write_index_document(
    input_path: Path,
    output_path: Path,
    footprint: Footprint | None = None,
) -> int:
    """Convert a normalized local GeoJSON file to a deterministic index file."""

    document = build_index_document(_read_source(input_path), footprint)
    output_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return len(document["objects"])




# --- Sharding -------------------------------------------------------------
#
# 211,865 records is 39 MB of JSON. That is not a startup download for the
# mobile-first app in docs/spec.md section 10, so the shippable artifact is a
# small index of shards plus one payload per MGRS tile: the biggest shard is
# ~1.4 MB (~280 KB over the wire) and a viewport touches a handful of them.
#
# The split key is the tile the object sits in, because the footprint already
# speaks in tiles and inventing a second grid would mean two spatial
# vocabularies for one dataset. Granules overlap by 9.8 km, so an object can be
# in several; it is filed under the first in sorted order, which keeps every
# object in exactly one shard and needs no client-side de-duplication.
#
# Each shard entry therefore carries the bounds of the objects it actually
# holds, not its granule's bounds. A client intersects the viewport with those
# and fetches what overlaps - no MGRS arithmetic in the browser, and no second
# definition of the footprint to drift from this one.

SHARD_DIRECTORY = "objects"


@dataclass(frozen=True)
class IndexShard:
    """One tile's slice of the index, with the bounds of what it holds."""

    tile: str
    entries: tuple[ObjectIndexEntry, ...]

    @property
    def path(self) -> str:
        return f"{SHARD_DIRECTORY}/{self.tile}.json"

    def bounds(self) -> list[float]:
        """Return [west, south, east, north] around this shard's objects."""

        longitudes = [entry.longitude for entry in self.entries]
        latitudes = [entry.latitude for entry in self.entries]
        return [min(longitudes), min(latitudes), max(longitudes), max(latitudes)]

    def to_document(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "tile": self.tile,
            "objects": [entry.to_document() for entry in self.entries],
        }


def shard_object_index(
    entries: Sequence[ObjectIndexEntry],
    footprint: Footprint,
) -> tuple[IndexShard, ...]:
    """Split an index into per-tile shards, sorted by tile.

    Tiles with no eligible object get no shard at all: an empty payload is a
    request that can only ever return nothing.
    """

    grouped: dict[str, list[ObjectIndexEntry]] = {}
    for entry in entries:
        tiles = footprint.containing_tiles(entry.longitude, entry.latitude)
        if not tiles:
            raise ValueError(f"object outside the footprint cannot be sharded: {entry.id}")
        grouped.setdefault(tiles[0], []).append(entry)
    return tuple(
        IndexShard(tile=tile, entries=tuple(grouped[tile])) for tile in sorted(grouped)
    )


def _serialize(document: Mapping[str, object]) -> bytes:
    """Serialize a published artifact compactly and reproducibly.

    Published payloads carry no indentation: it is a third of the bytes on a
    phone connection and buys nothing a formatter cannot. The single-file
    local build keeps its readable form; this is the one that ships.
    """

    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return (text + "\n").encode("utf-8")


def build_shard_index_document(
    shards: Sequence[IndexShard],
    payloads: Mapping[str, bytes],
) -> dict[str, object]:
    """Describe the shard set: where each one is, what it covers, and its hash.

    The digests are of the shard bytes themselves, so this stays a pure
    function of the input - no timestamp, no provider metadata - while giving
    a consumer something to validate a fetched payload against.
    """

    return {
        "schemaVersion": 1,
        "objectCount": sum(len(shard.entries) for shard in shards),
        "shards": [
            {
                "tile": shard.tile,
                "path": shard.path,
                "objectCount": len(shard.entries),
                "bounds": shard.bounds(),
                "bytes": len(payloads[shard.tile]),
                "sha256": hashlib.sha256(payloads[shard.tile]).hexdigest(),
            }
            for shard in shards
        ],
    }


def build_sharded_index(
    feature_collection: Mapping[str, object],
    footprint: Footprint,
) -> dict[str, bytes]:
    """Return the complete publishable artifact set, keyed by relative path."""

    entries = build_object_index(_features(feature_collection), footprint)
    shards = shard_object_index(entries, footprint)
    payloads = {shard.tile: _serialize(shard.to_document()) for shard in shards}
    files = {shard.path: payloads[shard.tile] for shard in shards}
    files[INDEX_FILENAME] = _serialize(build_shard_index_document(shards, payloads))
    return files


def write_sharded_index(
    input_path: Path,
    output_dir: Path,
    footprint: Footprint | None = None,
) -> tuple[int, int]:
    """Write the shard index and its payloads under ``output_dir``.

    Returns (object count, shard count). Existing files are overwritten; stale
    shards from a previous, wider footprint are not removed here, because
    deciding what may be deleted from a published location belongs to the
    publisher, not to a local format conversion.
    """

    source = _read_source(input_path)
    files = build_sharded_index(source, footprint or mvp_footprint())
    for relative_path, payload in sorted(files.items()):
        destination = output_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
    index = json.loads(files[INDEX_FILENAME])
    return int(index["objectCount"]), len(index["shards"])


def main(argv: Sequence[str] | None = None) -> None:
    """Build a local object index; downloading and publication are separate."""

    parser = argparse.ArgumentParser(description="Build Nevaio's static OSM object index")
    parser.add_argument("--input", type=Path, required=True, help="normalized OSM GeoJSON input")
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output", type=Path, help="one readable index JSON, for local inspection")
    destination.add_argument(
        "--output-dir",
        type=Path,
        help=f"publishable shard set: {INDEX_FILENAME} plus {SHARD_DIRECTORY}/<TILE>.json",
    )
    args = parser.parse_args(argv)
    footprint = mvp_footprint()
    if args.output is not None:
        count = write_index_document(args.input, args.output, footprint)
        print(f"wrote {count} approved OSM object(s) inside the snow footprint to {args.output}")
        return
    count, shards = write_sharded_index(args.input, args.output_dir, footprint)
    print(
        f"wrote {count} approved OSM object(s) inside the snow footprint "
        f"across {shards} shard(s) in {args.output_dir}"
    )


if __name__ == "__main__":
    main()
