"""Publish the per-object GFSC time series and its permanent slot maps to R2.

Companion to :mod:`nevaio_pipeline.publish_object_index`, kept as its own
module for the same reason that one is separate from
:mod:`nevaio_pipeline.publish`: a distinct lifecycle, a distinct artifact.
Two things get published here, both produced by ``render.build_preview``'s
optional per-object sampling ("daily increment", ``docs/plan.md``):

    series/<TILE>/<YYYY-MM>.bin           - the sampled time series
    object-index/slots/<TILE>.json        - the permanent per-tile slot map

The slot map is published *beside* the object index (under the
:data:`nevaio_pipeline.publish_object_index.OBJECT_INDEX_PREFIX` prefix), not
under ``series/``: it is conceptually part of "how the index's objects are
ordered", not part of the series data itself - see
:mod:`nevaio_pipeline.object_slots` for why the map must be permanent and
append-only, and why it must live wherever a plain HTTPS GET can reach it with
no credentials (the render job fetches it that way; see
``.github/workflows/publish-latest-preview.yml``). ``series/`` sits at the
bucket root beside ``runs/``, ``latest.json``, ``dates.json`` and
``asof-*.json``, per ``docs/plan.md``'s own artifact description, and does not
collide with them or with ``object-index/``.

Unlike the object index's own artifact, nothing here is ever deleted: a slot
map only ever grows (:mod:`nevaio_pipeline.object_slots`) and a month's
``.bin`` file is only ever extended or overwritten with more/newer data under
the same key, so there is no stale-key cleanup to do.

Either input directory may legitimately not exist at all - that is the normal
shape of a run where the daily sampling increment did not fire (no published
object index reachable yet, or nothing changed), not a broken artifact; see
:func:`validate_object_series_dirs`.

boto3-only, no native raster stack import, matching every other publisher in
this package.
"""

from __future__ import annotations

from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor
import argparse
import json
import re
from pathlib import Path
from typing import Any

import boto3

from .object_slots import SLOT_DIRECTORY, slot_map_from_document
from .publish import _required_env
from .publish_object_index import OBJECT_INDEX_PREFIX

# Bucket root, distinct from runs/, latest.json, dates.json, asof-*.json and
# object-index/ - see module docstring.
SERIES_PREFIX = "series"
SLOTS_PREFIX = f"{OBJECT_INDEX_PREFIX}/{SLOT_DIRECTORY}"

# Mirrors nevaio_pipeline.object_series.CELL_SIZE/days_in_month exactly, but
# is not imported from there: that module imports numpy for its vectorized
# encode/decode path, and this one must stay importable with nothing beyond
# boto3 in the publish job (see module docstring and
# docs/agent-guide.md on requirements-publish.txt carrying no raster stack).
# Only the byte-layout arithmetic is needed here, so it is duplicated rather
# than pulling in a dependency this job must never have.
CELL_SIZE = 2


def _days_in_month(year: int, month: int) -> int:
    return monthrange(year, month)[1]


_TILE_PATTERN = re.compile(r"^[0-9]{1,2}[A-Z]{3}$")
_MONTH_FILENAME_PATTERN = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])\.bin$")

# Generous relative to a real tile: the object index publisher's own
# MAX_OBJECTS_PER_SHARD (100,000) at a 31-day month is
# 31 * CELL_SIZE * 100_000 =~ 6.1 MB. Mirrors publish_object_index.py's
# MAX_SHARD_BYTES for the same reasoning - refuse to reason about an
# implausible artifact rather than upload it.
MAX_MONTH_FILE_BYTES = 16 * 1024 * 1024
MAX_SLOT_FILE_BYTES = 4 * 1024 * 1024
# At most a couple of months per tile times the MVP tile count, with generous
# headroom - see MAX_SHARDS in publish_object_index.py for the same reasoning.
MAX_MONTH_FILES = 2_000
MAX_SLOT_FILES = 500
MAX_TOTAL_BYTES = 256 * 1024 * 1024


def _fail(message: str) -> None:
    raise ValueError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _validate_month_file(payload: bytes, relative: str, year: int, month: int) -> None:
    days = _days_in_month(year, month)
    cell_bytes_per_day = days * CELL_SIZE
    _require(
        len(payload) > 0 and len(payload) % cell_bytes_per_day == 0,
        f"{relative} is not a whole number of object slots for a {days}-day month",
    )


def validate_object_series_dirs(
    series_dir: Path, slots_dir: Path
) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """Validate the local output of the daily per-object sampling increment.

    Neither directory needs to exist - see the module docstring - in which
    case its half of the return value is simply empty. Returns
    ``(series_files, slot_files)``, each keyed by the path relative to its own
    directory (``<TILE>/<YYYY-MM>.bin`` and ``<TILE>.json`` respectively),
    ready to upload under :data:`SERIES_PREFIX` / :data:`SLOTS_PREFIX`.

    Rejects the whole batch rather than skipping a bad file - a partially
    accepted batch would silently drop time-series data the same way a
    partially accepted object index would silently drop objects
    (``publish_object_index.validate_object_index_dir`` uses the same
    reasoning).
    """

    total_bytes = 0

    series_files: dict[str, bytes] = {}
    series_dir = Path(series_dir)
    if series_dir.is_dir():
        month_paths = sorted(series_dir.glob("*/*.bin"))
        _require(len(month_paths) <= MAX_MONTH_FILES, "too many series month files to publish at once")
        for path in month_paths:
            tile = path.parent.name
            _require(_TILE_PATTERN.match(tile) is not None, f"series directory {tile} is not an MGRS tile")
            match = _MONTH_FILENAME_PATTERN.match(path.name)
            _require(match is not None, f"series file {path} is not a <YYYY-MM>.bin name")
            year, month = int(match.group(1)), int(match.group(2))
            _require(not path.is_symlink(), f"series file {path} must not be a symlink")
            relative = f"{tile}/{path.name}"
            payload = path.read_bytes()
            _require(len(payload) <= MAX_MONTH_FILE_BYTES, f"series file {relative} exceeds the size limit")
            _validate_month_file(payload, relative, year, month)
            total_bytes += len(payload)
            _require(total_bytes <= MAX_TOTAL_BYTES, "series artifact exceeds the total size limit")
            series_files[relative] = payload

    slot_files: dict[str, bytes] = {}
    slots_dir = Path(slots_dir)
    if slots_dir.is_dir():
        slot_paths = sorted(slots_dir.glob("*.json"))
        _require(len(slot_paths) <= MAX_SLOT_FILES, "too many slot maps to publish at once")
        for path in slot_paths:
            _require(not path.is_symlink(), f"slot map {path} must not be a symlink")
            payload = path.read_bytes()
            _require(len(payload) <= MAX_SLOT_FILE_BYTES, f"slot map {path} exceeds the size limit")
            slot_map = slot_map_from_document(json.loads(payload.decode("utf-8")))
            expected_tile = path.stem
            _require(
                slot_map.tile == expected_tile,
                f"slot map {path.name} tile field {slot_map.tile!r} does not match its filename",
            )
            total_bytes += len(payload)
            _require(total_bytes <= MAX_TOTAL_BYTES, "series artifact exceeds the total size limit")
            slot_files[f"{expected_tile}.json"] = payload

    # Cross-check, belt-and-braces: a month file must never claim more object
    # slots than its own tile's slot map declares - see object_slots.py on why
    # the map, not the shard, is the ordering authority.
    for relative, payload in series_files.items():
        tile, filename = relative.split("/", 1)
        slot_payload = slot_files.get(f"{tile}.json")
        if slot_payload is None:
            continue
        slot_map = slot_map_from_document(json.loads(slot_payload.decode("utf-8")))
        match = _MONTH_FILENAME_PATTERN.match(filename)
        year, month = int(match.group(1)), int(match.group(2))
        implied_slots = len(payload) // (_days_in_month(year, month) * CELL_SIZE)
        _require(
            implied_slots <= slot_map.slot_count,
            f"{relative} implies more object slots ({implied_slots}) than tile "
            f"{tile}'s published slot map has ({slot_map.slot_count})",
        )

    return series_files, slot_files


def publish_object_series_to_r2(
    series_dir: Path,
    slots_dir: Path,
    *,
    upload_workers: int = 16,
) -> dict[str, Any]:
    """Validate and publish the local per-object series/slot output to R2.

    Series month files upload before slot maps - the same "data before
    pointer" ordering :func:`nevaio_pipeline.publish.publish_to_r2` and
    :func:`nevaio_pipeline.publish_object_index.publish_object_index_to_r2`
    use - though here it is belt-and-braces rather than load-bearing: a slot
    map growing before its month file's bytes catch up just means a client's
    range read for the newest slot falls past the old file's end, which
    ``object_series.object_month_range``'s own docstring says must already be
    read as a gap, not an error. Nothing here is ever deleted (module
    docstring).

    Returns a receipt with zero counts, and never touches the network, when
    both directories are absent or empty - the normal shape of a run where
    the sampling increment did not fire.
    """

    series_files, slot_files = validate_object_series_dirs(series_dir, slots_dir)
    if not series_files and not slot_files:
        return {"seriesFilesPublished": 0, "slotFilesPublished": 0, "tiles": []}

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

    def upload_series(relative: str) -> None:
        client.put_object(
            Bucket=bucket,
            Key=f"{SERIES_PREFIX}/{relative}",
            Body=series_files[relative],
            ContentType="application/octet-stream",
            # Overwritten in place as the month fills in, never addressed by
            # content hash - same reasoning as latest.json/dates.json.
            CacheControl="no-cache, max-age=0",
        )

    with ThreadPoolExecutor(max_workers=upload_workers) as executor:
        for _ in executor.map(upload_series, series_files):
            pass

    def upload_slot(relative: str) -> None:
        client.put_object(
            Bucket=bucket,
            Key=f"{SLOTS_PREFIX}/{relative}",
            Body=slot_files[relative],
            ContentType="application/json",
            CacheControl="no-cache, max-age=0",
        )

    with ThreadPoolExecutor(max_workers=upload_workers) as executor:
        for _ in executor.map(upload_slot, slot_files):
            pass

    tiles = sorted(
        {relative.split("/", 1)[0] for relative in series_files}
        | {relative.removesuffix(".json") for relative in slot_files}
    )
    return {
        "seriesFilesPublished": len(series_files),
        "slotFilesPublished": len(slot_files),
        "tiles": tiles,
        "seriesBaseUrl": f"{public_base_url}/{SERIES_PREFIX}",
        "slotsBaseUrl": f"{public_base_url}/{SLOTS_PREFIX}",
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate or publish the local per-object series/slot-map output; never sample here."
    )
    parser.add_argument(
        "--series-dir", type=Path, required=True,
        help="directory holding <TILE>/<YYYY-MM>.bin (render.build_preview's --series-output-dir)",
    )
    parser.add_argument(
        "--slots-dir", type=Path, required=True,
        help="directory holding <TILE>.json slot maps (render.build_preview's --object-index-dir, slots/ subdirectory)",
    )
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()

    series_files, slot_files = validate_object_series_dirs(args.series_dir, args.slots_dir)
    if args.check_only:
        print(f"Validated object series: {len(series_files)} month file(s), {len(slot_files)} slot map(s)")
        return

    result = publish_object_series_to_r2(args.series_dir, args.slots_dir)
    if args.receipt:
        args.receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Published object series: {result['seriesFilesPublished']} month file(s), "
        f"{result['slotFilesPublished']} slot map(s) across {len(result['tiles'])} tile(s)"
    )


if __name__ == "__main__":
    main()
