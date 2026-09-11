"""Validate rendered data without importing a raster/image parser or artifact code."""
from __future__ import annotations

from datetime import date, datetime
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import zlib

from .catalogue import CATALOGUE_KIND, CATALOGUE_SCHEMA_VERSION, date_manifest_key
from .config import (
    ASOF_CATALOGUE_DATES, ASOF_WINDOW_DAYS, MVP_MGRS_TILES,
    PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM,
)

MAX_FILES = 50_000
MAX_TOTAL_BYTES = 2 * 1024**3
MAX_PNG_BYTES = 1024**2
MAX_METADATA_BYTES = 64 * 1024
# A full window is 31 entries of about 90 bytes; this is several times that,
# and small enough that a corrupted object cannot become a parsing problem.
MAX_CATALOGUE_BYTES = 16 * 1024
CATALOGUE_FIELDS = frozenset(("schemaVersion", "kind", "generatedAt", "maxDates", "dates"))
CATALOGUE_ENTRY_FIELDS = frozenset(("asOfDate", "runId", "manifest"))
RUN_PATTERN = re.compile(r"\d{8}T\d{6}Z")
TILE_PATTERN = re.compile(r"tiles/(\d{1,2})/(\d{1,5})/(\d{1,5})\.png")
FIELDS = frozenset((
    "schemaVersion", "runId", "mode", "asOfDate", "asOfWindowDays", "generatedAt",
    "minzoom", "maxzoom", "bounds", "tileCount", "requestedSourceTileCount",
    "sourceTileCount", "sourceTiles", "missingSourceTiles", "productDates",
    "sourceProductCounts", "sourceProductTotal", "notice",
))


def snapshot_notice(as_of: str) -> str:
    return (
        "Each pixel shows the newest valid GFSC observation on or before "
        f"{as_of}, searching back up to 30 days per spec "
        "section 9.2. Color shows how old that observation is (sky blue = most "
        "recent, indigo = up to 30 days old); a transparent area means no "
        "valid observation was found there in that window (cloud, water, "
        "or no data)."
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _integer(value: object, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _iso_date(value: object) -> date:
    _require(isinstance(value, str), "date must be an ISO string")
    parsed = date.fromisoformat(value)
    _require(parsed.isoformat() == value, "date must use YYYY-MM-DD")
    return parsed


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate metadata key")
        result[key] = value
    return result


def _regular_file(path: Path, maximum: int) -> int:
    info = path.lstat()
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
             "artifact must contain only regular, non-linked files")
    _require(0 < info.st_size <= maximum, "artifact file size outside limits")
    return info.st_size


def _directory(path: Path) -> None:
    _require(stat.S_ISDIR(path.lstat().st_mode), "artifact directory must not be a link")


def _validate_png(path: Path) -> None:
    """Accept only the renderer's 256x256, 8-bit RGBA PNGs, with bounded inflate.

    No ancillary chunks, external references, executable formats, or trailing
    bytes. This validates transport/shape; it cannot authenticate snow pixels.
    """
    data = path.read_bytes()
    _require(data[:8] == b"\x89PNG\r\n\x1a\n", "invalid PNG signature")
    offset, chunks, compressed = 8, [], bytearray()
    while offset < len(data):
        _require(offset + 12 <= len(data), "truncated PNG")
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        _require(end <= len(data), "truncated PNG chunk")
        payload = data[offset + 8:end - 4]
        checksum = struct.unpack_from(">I", data, end - 4)[0]
        _require(zlib.crc32(kind + payload) & 0xffffffff == checksum, "invalid PNG checksum")
        if not chunks:
            _require(kind == b"IHDR" and payload == struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0),
                     "PNG must be 256x256 RGBA, non-interlaced")
        elif kind == b"IDAT":
            _require(chunks[-1] in (b"IHDR", b"IDAT"), "invalid PNG chunk order")
            compressed.extend(payload)
        elif kind == b"IEND":
            _require(length == 0 and chunks[-1] == b"IDAT" and end == len(data),
                     "invalid PNG end or trailing data")
        else:
            raise ValueError("unexpected PNG chunk")
        chunks.append(kind)
        offset = end
    _require(bool(chunks) and chunks[-1] == b"IEND", "missing PNG end")
    expected = 256 * (1 + 256 * 4)
    decoder = zlib.decompressobj()
    pixels = decoder.decompress(bytes(compressed), expected + 1)
    _require(len(pixels) == expected and decoder.eof and not decoder.unused_data
             and not decoder.unconsumed_tail, "invalid or oversized PNG pixels")
    _require(all(pixels[i] <= 4 for i in range(0, expected, 1025)), "invalid PNG filter")


def validate_run(run_dir: Path) -> tuple[dict, list[Path]]:
    """Reject unexpected paths and validate the whole run before any upload."""
    run_dir = Path(run_dir)
    _directory(run_dir)
    files: list[Path] = []
    total = 0
    entries_seen = 0
    for base, dirs, names in os.walk(run_dir, followlinks=False):
        entries_seen += len(dirs) + len(names)
        _require(entries_seen <= MAX_FILES * 4, "too many artifact entries")
        for name in dirs:
            path = Path(base) / name
            _directory(path)
            relative = path.relative_to(run_dir).as_posix()
            _require(re.fullmatch(r"tiles(?:/\d{1,2}(?:/\d{1,5})?)?", relative) is not None,
                     "unexpected artifact directory")
        for name in names:
            path = Path(base) / name
            relative = path.relative_to(run_dir).as_posix()
            match = TILE_PATTERN.fullmatch(relative)
            _require(relative == "run.json" or match is not None, "unexpected artifact file")
            total += _regular_file(path, MAX_METADATA_BYTES if relative == "run.json" else MAX_PNG_BYTES)
            files.append(path)
            _require(len(files) <= MAX_FILES and total <= MAX_TOTAL_BYTES, "artifact exceeds limits")
            if match:
                z, x, y = map(int, match.groups())
                _require(PREVIEW_MIN_ZOOM <= z <= PREVIEW_MAX_ZOOM and x < 2**z and y < 2**z,
                         "tile coordinates outside pyramid")
                _require(relative == f"tiles/{z}/{x}/{y}.png", "noncanonical tile path")
    _require(run_dir / "run.json" in files, "missing run metadata")
    metadata = json.loads((run_dir / "run.json").read_text(), object_pairs_hook=_unique_object)
    _require(type(metadata) is dict and metadata.keys() == FIELDS, "unexpected metadata fields")
    d = metadata
    _require(isinstance(d["runId"], str) and RUN_PATTERN.fullmatch(d["runId"]) is not None,
             "invalid run ID")
    generated = datetime.fromisoformat(d["generatedAt"])
    _require(generated.utcoffset() is not None and generated.utcoffset().total_seconds() == 0
             and generated.strftime("%Y%m%dT%H%M%SZ") == d["runId"], "invalid generation timestamp")
    as_of = _iso_date(d["asOfDate"])
    for key, expected in (("schemaVersion", 1), ("asOfWindowDays", ASOF_WINDOW_DAYS),
                          ("minzoom", PREVIEW_MIN_ZOOM), ("maxzoom", PREVIEW_MAX_ZOOM)):
        _require(type(d[key]) is int and d[key] == expected, f"invalid {key}")
    _require(d["mode"] == "asof-window" and d["notice"] == snapshot_notice(d["asOfDate"]),
             "unexpected snapshot mode or notice")
    bounds = d["bounds"]
    _require(type(bounds) is list and len(bounds) == 4 and all(
        type(v) in (int, float) and math.isfinite(v) for v in bounds), "invalid bounds")
    w, s, e, n = bounds
    _require(-180 <= w < e <= 180 and -85.1 <= s < n <= 85.1, "invalid bounds range")
    for key in ("sourceTiles", "missingSourceTiles"):
        values = d[key]
        _require(type(values) is list and all(type(v) is str and v in MVP_MGRS_TILES for v in values),
                 "invalid source tile list")
        _require(values == sorted(set(values)), "source tile list must be sorted and unique")
    active, missing = set(d["sourceTiles"]), set(d["missingSourceTiles"])
    _require(bool(active) and not active & missing, "invalid source coverage")
    for key, expected in (("sourceTileCount", len(active)),
                          ("requestedSourceTileCount", len(active | missing)),
                          ("tileCount", len(files) - 1)):
        _require(_integer(d[key], 0, MAX_FILES) and d[key] == expected, f"inconsistent {key}")
    for key in ("productDates", "sourceProductCounts"):
        _require(type(d[key]) is dict and set(d[key]) == active, "invalid source product map")
    for value in d["productDates"].values():
        _require(0 <= (as_of - _iso_date(value)).days < ASOF_WINDOW_DAYS, "product outside AS-OF window")
    _require(all(_integer(v, 1, ASOF_WINDOW_DAYS) for v in d["sourceProductCounts"].values()),
             "invalid source product count")
    _require(_integer(d["sourceProductTotal"], 1, len(MVP_MGRS_TILES) * ASOF_WINDOW_DAYS)
             and d["sourceProductTotal"] == sum(d["sourceProductCounts"].values()),
             "inconsistent source product total")
    for path in files:
        if path.suffix == ".png":
            _validate_png(path)
    return metadata, sorted(files)


def validate_artifact(runs_dir: Path, *, tiles: list[str] | None = None,
                      max_missing_tiles: int = 0, as_of: str | None = None) -> tuple[Path, dict]:
    _directory(runs_dir)
    entries = list(runs_dir.iterdir())
    _require(len(entries) == 1, "artifact must contain exactly one run")
    run_dir = entries[0]
    metadata, _ = validate_run(run_dir)
    _require(run_dir.name == metadata["runId"], "run directory does not match metadata")
    requested = {t.upper() for t in tiles} if tiles else set(MVP_MGRS_TILES)
    _require(requested <= set(MVP_MGRS_TILES), "requested tile outside MVP")
    _require(set(metadata["sourceTiles"]) | set(metadata["missingSourceTiles"]) == requested,
             "artifact does not match requested coverage")
    _require(0 <= max_missing_tiles <= len(requested)
             and len(metadata["missingSourceTiles"]) <= max_missing_tiles, "too many missing tiles")
    if as_of:
        _require(metadata["asOfDate"] == _iso_date(as_of).isoformat(), "unexpected AS-OF date")
    return run_dir, metadata


def validate_date_catalogue(document: bytes | str) -> dict:
    """Validate the public AS-OF date catalogue, as the browser will.

    The catalogue is the authority on which historical dates exist (spec
    section 5.3), so it is a public contract in the same sense `latest.json`
    is, and it gets the same treatment: exact field sets, no duplicate keys,
    bounded size, and every derivable value re-derived rather than trusted.
    The publisher runs this over its own bytes before the PUT, so a bug here
    fails the run instead of advertising a date the frontend will reject.
    """
    raw = document.encode() if isinstance(document, str) else document
    _require(isinstance(raw, bytes), "catalogue must be bytes or text")
    _require(0 < len(raw) <= MAX_CATALOGUE_BYTES, "catalogue size outside limits")
    d = json.loads(raw.decode(), object_pairs_hook=_unique_object)
    _require(type(d) is dict and d.keys() == CATALOGUE_FIELDS, "unexpected catalogue fields")
    _require(type(d["schemaVersion"]) is int and d["schemaVersion"] == CATALOGUE_SCHEMA_VERSION,
             "invalid catalogue schemaVersion")
    _require(d["kind"] == CATALOGUE_KIND, "unexpected catalogue kind")
    _require(isinstance(d["generatedAt"], str), "catalogue generatedAt must be a string")
    generated = datetime.fromisoformat(d["generatedAt"])
    _require(generated.utcoffset() is not None and generated.utcoffset().total_seconds() == 0,
             "catalogue generatedAt must be UTC")
    _require(type(d["maxDates"]) is int and d["maxDates"] == ASOF_CATALOGUE_DATES,
             "invalid catalogue maxDates")

    entries = d["dates"]
    _require(type(entries) is list, "catalogue dates must be a list")
    # Empty is legal and meaningful: it says nothing is available, which the
    # frontend must honour rather than fall back to the latest map.
    _require(len(entries) <= d["maxDates"], "catalogue advertises more dates than its window")
    dates: list[date] = []
    run_ids: list[str] = []
    for entry in entries:
        _require(type(entry) is dict and entry.keys() == CATALOGUE_ENTRY_FIELDS,
                 "unexpected catalogue entry fields")
        as_of = _iso_date(entry["asOfDate"])
        run_id = entry["runId"]
        _require(isinstance(run_id, str) and RUN_PATTERN.fullmatch(run_id) is not None,
                 "invalid catalogue run ID")
        _require(entry["manifest"] == date_manifest_key(entry["asOfDate"], run_id),
                 "catalogue manifest key does not match its date and run")
        dates.append(as_of)
        run_ids.append(run_id)
    _require(all(later > earlier for later, earlier in zip(dates, dates[1:])),
             "catalogue dates must be unique and newest first")
    _require(len(set(run_ids)) == len(run_ids), "a run may back only one catalogue date")
    if dates:
        _require((dates[0] - dates[-1]).days < d["maxDates"],
                 "catalogue spans more than its retention window")
    return d
