"""Publish the sharded OSM object index to Cloudflare R2.

Decided 2026-09-11 (docs/plan.md): a separate `workflow_dispatch` GitHub
Action, not a stage bolted onto the daily GFSC snapshot publisher. The two
artifacts have different lifecycles - the object index changes only when the
OSM extracts refresh, the snapshot changes daily - so they get their own
workflow and, here, their own module. This one still stays boto3-only: it
reuses `publish._required_env` and `publish._delete_keys` rather than
re-implementing credential handling or deletion, and imports nothing from the
native raster stack.

The published artifact lives under :data:`OBJECT_INDEX_PREFIX` in the *same*
bucket as the GFSC snapshot (`R2_BUCKET`), so it must not collide with that
snapshot's `runs/`, `latest.json`, `dates.json` or `asof-*.json` keys at the
bucket root. `object-index/` does not collide with any of those, and it
matches the local dev fixture's own layout under `app/public/object-index/`
(see `app/src/map/config.ts`), so pointing `VITE_OBJECT_INDEX_URL` at the
publication only needs a new host, not a new path shape:

    <R2_PUBLIC_BASE_URL>/object-index/object-index.json
    <R2_PUBLIC_BASE_URL>/object-index/objects/<TILE>.json

`object-index.json` is this artifact's `latest.json`: the entry point a
client resolves every shard path against (`app/src/objects/objectIndexSchema.ts`
requires every shard to stay on that URL's own origin and directory), so it is
uploaded last, after every shard it names is already in place - the same
upload-before-pointer ordering `publish.publish_to_r2` uses for the snapshot.
Stale shards a footprint shrink left behind are deleted only after the new
index is live and only among keys the new index no longer names, so a client
already holding the old index can never observe a shard promised but missing.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from math import isfinite
import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, get_args

import boto3

from .object_index import INDEX_FILENAME, ObjectKind, SHARD_DIRECTORY
from .publish import _delete_keys, _required_env

# Distinct from the snapshot's bucket-root keys (`runs/`, `latest.json`,
# `dates.json`, `asof-*.json`) - see module docstring for the exact shape.
OBJECT_INDEX_PREFIX = "object-index"

# A listing this long means something is very wrong with the bucket layout;
# refuse to reason about it rather than plan deletions over it. Mirrors
# publish.MAX_LISTED_KEYS.
MAX_LISTED_KEYS = 20_000

# Generous relative to the measured artifact (54 files, 28.6 MB total, largest
# shard ~1.4 MB): several times over so ordinary growth of the OSM extracts or
# the footprint does not fail a real publish, while a malformed or hostile
# artifact still cannot exhaust the runner. Mirrors the frontend's own
# ceilings in `app/src/objects/objectIndexSchema.ts`.
MAX_SHARDS = 500
MAX_OBJECTS_PER_SHARD = 100_000
MAX_TOTAL_OBJECTS = 5_000_000
MAX_SHARD_BYTES = 16 * 1024 * 1024
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MIN_ELEVATION_METERS = -500
MAX_ELEVATION_METERS = 9000

_TILE_PATTERN = re.compile(r"^[0-9]{1,2}[A-Z]{3}$")
_OBJECT_ID_PATTERN = re.compile(r"^(node|way|relation)/[1-9]\d{0,18}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_KNOWN_KINDS = frozenset(get_args(ObjectKind))


def _fail(message: str) -> None:
    raise ValueError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _shard_path(tile: str) -> str:
    return f"{SHARD_DIRECTORY}/{tile}.json"


def _validate_shard_payload(payload: bytes, expected_tile: str, expected_count: int) -> None:
    """Check one shard file's own structure - light, not a re-run of the pipeline.

    Bytes and the sha256 digest are already checked against the index's own
    claims by the caller; this only checks that the shard is shaped the way
    `app/src/objects/objectIndexSchema.ts` expects, record by record, since a
    truncated or hand-edited shard can still hash-match nothing but itself.
    """
    document = json.loads(payload.decode("utf-8"))
    _require(isinstance(document, dict), f"shard {expected_tile} must be a JSON object")
    _require(document.get("schemaVersion") == 1, f"shard {expected_tile} has an unsupported schemaVersion")
    _require(document.get("tile") == expected_tile, f"shard {expected_tile} tile field does not match its path")
    objects = document.get("objects")
    _require(isinstance(objects, list), f"shard {expected_tile}.objects must be an array")
    _require(
        len(objects) == expected_count,
        f"shard {expected_tile} holds {len(objects)} objects, index promised {expected_count}",
    )
    seen_ids: set[str] = set()
    for entry in objects:
        _require(isinstance(entry, dict), f"shard {expected_tile} object must be a JSON object")
        object_id = entry.get("id")
        _require(
            isinstance(object_id, str) and _OBJECT_ID_PATTERN.match(object_id) is not None,
            f"shard {expected_tile} object id is not an <osmType>/<osmId> identity: {object_id!r}",
        )
        _require(object_id not in seen_ids, f"duplicate object id {object_id} in shard {expected_tile}")
        seen_ids.add(object_id)
        _require(entry.get("kind") in _KNOWN_KINDS, f"shard {expected_tile} object {object_id} has an unknown kind")
        name = entry.get("name")
        _require(isinstance(name, str) and name != "", f"shard {expected_tile} object {object_id} has no name")
        for field in ("longitude", "latitude"):
            value = entry.get(field)
            _require(isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value),
                      f"shard {expected_tile} object {object_id} has an invalid {field}")
        longitude, latitude = entry["longitude"], entry["latitude"]
        _require(-180 <= longitude <= 180 and -90 <= latitude <= 90,
                  f"shard {expected_tile} object {object_id} is outside the world")
        elevation = entry.get("elevationMeters")
        if elevation is not None:
            _require(
                isinstance(elevation, (int, float)) and not isinstance(elevation, bool) and isfinite(elevation)
                and MIN_ELEVATION_METERS <= elevation <= MAX_ELEVATION_METERS,
                f"shard {expected_tile} object {object_id} has an invalid elevationMeters",
            )


def validate_object_index_dir(source_dir: Path) -> dict[str, bytes]:
    """Validate a locally built sharded index and return its files as bytes.

    Rejects the whole artifact rather than skipping a bad shard - a partially
    accepted artifact would silently drop selectable objects from the
    published index, the same reasoning `objectIndexSchema.ts` uses on the
    read side. Returns every file keyed by its path relative to
    ``source_dir`` (``object-index.json`` and ``objects/<TILE>.json``), ready
    to be uploaded under :data:`OBJECT_INDEX_PREFIX`.
    """
    source_dir = Path(source_dir)
    _require(source_dir.is_dir() and not source_dir.is_symlink(), "object index source must be a directory")

    index_path = source_dir / INDEX_FILENAME
    _require(index_path.is_file(), f"missing {INDEX_FILENAME} in {source_dir}")
    index_bytes = index_path.read_bytes()
    _require(0 < len(index_bytes) <= MAX_INDEX_BYTES, f"{INDEX_FILENAME} size outside limits")
    index = json.loads(index_bytes.decode("utf-8"))
    _require(isinstance(index, dict), f"{INDEX_FILENAME} must be a JSON object")
    _require(index.get("schemaVersion") == 1, f"{INDEX_FILENAME} has an unsupported schemaVersion")

    object_count = index.get("objectCount")
    _require(isinstance(object_count, int) and not isinstance(object_count, bool)
              and 0 <= object_count <= MAX_TOTAL_OBJECTS, f"{INDEX_FILENAME} objectCount is invalid")

    shards = index.get("shards")
    _require(isinstance(shards, list) and len(shards) <= MAX_SHARDS, f"{INDEX_FILENAME} shards is invalid")

    shard_dir = source_dir / SHARD_DIRECTORY
    on_disk = {p.name for p in shard_dir.glob("*.json")} if shard_dir.is_dir() else set()

    files: dict[str, bytes] = {INDEX_FILENAME: index_bytes}
    named_files: set[str] = set()
    seen_tiles: set[str] = set()
    total_bytes = len(index_bytes)
    listed_objects = 0

    for entry in shards:
        _require(isinstance(entry, dict), "shard entry must be a JSON object")
        tile = entry.get("tile")
        _require(isinstance(tile, str) and _TILE_PATTERN.match(tile) is not None,
                  f"shard tile is not an MGRS square: {tile!r}")
        _require(tile not in seen_tiles, f"duplicate shard tile {tile}")
        seen_tiles.add(tile)
        _require(entry.get("path") == _shard_path(tile), f"shard {tile} path does not match its tile")

        shard_object_count = entry.get("objectCount")
        _require(isinstance(shard_object_count, int) and not isinstance(shard_object_count, bool)
                  and 0 <= shard_object_count <= MAX_OBJECTS_PER_SHARD,
                  f"shard {tile} objectCount is invalid")
        listed_objects += shard_object_count

        bounds = entry.get("bounds")
        _require(isinstance(bounds, list) and len(bounds) == 4
                  and all(isinstance(v, (int, float)) and not isinstance(v, bool) and isfinite(v) for v in bounds),
                  f"shard {tile} bounds must be four finite numbers")
        west, south, east, north = bounds
        _require(-180 <= west < east <= 180, f"shard {tile} bounds longitudes are not an ordered pair")
        _require(-90 <= south < north <= 90, f"shard {tile} bounds latitudes are not an ordered pair")

        declared_bytes = entry.get("bytes")
        declared_sha256 = entry.get("sha256")
        _require(isinstance(declared_sha256, str) and _SHA256_PATTERN.match(declared_sha256) is not None,
                  f"shard {tile} sha256 is not a lowercase hex digest")

        shard_relative = _shard_path(tile)
        shard_path = source_dir / shard_relative
        _require(shard_path.is_file() and not shard_path.is_symlink(),
                  f"index names shard {tile} but {shard_relative} is missing")
        payload = shard_path.read_bytes()
        _require(len(payload) <= MAX_SHARD_BYTES, f"shard {tile} exceeds the size limit")
        _require(declared_bytes == len(payload),
                  f"shard {tile} is {len(payload)} bytes, index says {declared_bytes}")
        digest = hashlib.sha256(payload).hexdigest()
        _require(digest == declared_sha256, f"shard {tile} content does not match its published sha256")

        _validate_shard_payload(payload, tile, shard_object_count)

        files[shard_relative] = payload
        named_files.add(f"{tile}.json")
        total_bytes += len(payload)
        _require(total_bytes <= MAX_TOTAL_BYTES, "object index artifact exceeds the total size limit")

    _require(listed_objects == object_count,
              f"shards list {listed_objects} objects but objectCount is {object_count}")
    _require(on_disk == named_files,
              "objects/ directory holds files the index does not name, or is missing files it does")

    return files


def _existing_keys(client: Any, bucket: str, prefix: str) -> set[str]:
    keys: set[str] = set()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{prefix}/"):
        keys.update(item["Key"] for item in page.get("Contents", ()))
        if len(keys) > MAX_LISTED_KEYS:
            raise RuntimeError("bucket lists more object-index keys than this publisher will reason about")
    return keys


def publish_object_index_to_r2(
    source_dir: Path,
    *,
    prefix: str = OBJECT_INDEX_PREFIX,
    upload_workers: int = 16,
) -> dict[str, Any]:
    """Validate a local sharded index and publish it atomically under ``prefix``.

    Shard files upload first, the entry point (``object-index.json``) last, so
    a client can never fetch an index naming a shard that is not yet there.
    Only after that pointer is live are stale keys under ``prefix`` - shards a
    footprint shrink left behind - deleted, and only the ones the new index no
    longer names.
    """
    files = validate_object_index_dir(source_dir)

    account_id = _required_env("R2_ACCOUNT_ID")
    bucket = _required_env("R2_BUCKET")
    public_base_url = _required_env("R2_PUBLIC_BASE_URL").rstrip("/")
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=_required_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_required_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
    )

    existing_keys = _existing_keys(client, bucket, prefix)

    def upload(relative_path: str) -> None:
        client.put_object(
            Bucket=bucket,
            Key=f"{prefix}/{relative_path}",
            Body=files[relative_path],
            ContentType="application/json",
            # Overwritten in place on a rebuild, not addressed by content
            # hash, so a stale cached copy must not outlive a republish -
            # same reasoning as `latest.json` and `dates.json`.
            CacheControl="no-cache, max-age=0",
        )

    shard_paths = [path for path in files if path != INDEX_FILENAME]
    with ThreadPoolExecutor(max_workers=upload_workers) as executor:
        for _ in executor.map(upload, shard_paths):
            pass
    upload(INDEX_FILENAME)

    new_keys = {f"{prefix}/{path}" for path in files}
    stale_keys = sorted(existing_keys - new_keys)
    if stale_keys:
        _delete_keys(client, bucket, stale_keys)

    index = json.loads(files[INDEX_FILENAME].decode("utf-8"))
    return {
        "prefix": prefix,
        "indexUrl": f"{public_base_url}/{prefix}/{INDEX_FILENAME}",
        "objectCount": index["objectCount"],
        "shardCount": len(index["shards"]),
        "deletedStaleKeys": stale_keys,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate or publish a locally built sharded OSM object index; never build it here."
    )
    parser.add_argument("--source-dir", type=Path, required=True,
                        help=f"directory holding {INDEX_FILENAME} and {SHARD_DIRECTORY}/<TILE>.json")
    parser.add_argument("--prefix", default=OBJECT_INDEX_PREFIX,
                         help=f"bucket key prefix (default: {OBJECT_INDEX_PREFIX})")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()

    files = validate_object_index_dir(args.source_dir)
    index = json.loads(files[INDEX_FILENAME].decode("utf-8"))
    if args.check_only:
        print(f"Validated object index: {index['objectCount']} objects across {len(index['shards'])} shards")
        return

    result = publish_object_index_to_r2(args.source_dir, prefix=args.prefix)
    if args.receipt:
        args.receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Published object index: {result['objectCount']} objects across "
        f"{result['shardCount']} shards to {result['indexUrl']}"
    )


if __name__ == "__main__":
    main()
