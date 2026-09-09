"""Discover and download only the newest GFSC product for each MGRS tile."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
import os
import re
from typing import Iterable, Sequence

import boto3
from botocore.config import Config

from .config import MAX_DOWNLOAD_BYTES, MAX_LAYER_BYTES, MAX_PRODUCTS_PER_TILE

ENDPOINT_URL = "https://s3.WAW3-2.cloudferro.com"
BUCKET = "HRWSI"

# These are the read-only credentials published in Copernicus's official
# HR-WSI client. Environment overrides let us rotate without changing code.
PUBLIC_ACCESS_KEY = "c4ae60af7b144053803c618a8860f7c9"
PUBLIC_SECRET_KEY = "dcb3ba1f6eab45aaaec5802feef5e2e4"

_KEY_PATTERN = re.compile(
    r"^GFSC/(?P<tile>\d{2}[A-Z0-9]{3})/(?P<year>\d{4})/(?P<month>\d{2})/"
    r"(?P<day>\d{2})/(?P<product>CLMS_WSI_GFSC_060m_T(?P=tile)_"
    r"(?P<date>\d{8})P7D_COMB_(?P<version>[^_/]+))/"
    r"(?P=product)_(?P<layer>GF|GF-QA|AT)\.tif$"
)
_REQUIRED_LAYERS = frozenset({"GF", "GF-QA", "AT"})


@dataclass(frozen=True)
class CatalogObject:
    key: str
    size: int


@dataclass(frozen=True)
class CatalogProduct:
    tile: str
    product_date: date
    version: str
    product: str
    layers: dict[str, CatalogObject]


def _month_prefixes(tile: str, start: date, end: date) -> list[str]:
    current = start.replace(day=1)
    prefixes: list[str] = []
    while current <= end:
        prefixes.append(f"GFSC/{tile}/{current.year:04d}/{current.month:02d}/")
        current = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
    return prefixes


def _complete_products(
    objects: Iterable[CatalogObject], start: date, end: date
) -> dict[str, list[CatalogProduct]]:
    """Group catalogue objects into complete products, keyed by MGRS tile.

    Only products carrying all three required layers are returned; a partially
    published product is not a usable observation. Products are returned for
    every tile present in ``objects``, unfiltered and unsorted, so callers can
    apply their own selection policy.
    """

    grouped: dict[tuple[str, date, str, str], dict[str, CatalogObject]] = {}
    oversize: list[CatalogObject] = []
    for item in objects:
        match = _KEY_PATTERN.match(item.key)
        if not match:
            continue
        if item.size > MAX_LAYER_BYTES:
            # Bounding inputs before download (audit F2). Dropping the object
            # makes its product incomplete, so the tile falls back to another
            # date in the window rather than failing the whole run on one
            # anomalous object. A tile left with nothing still raises below.
            oversize.append(item)
            continue
        metadata = match.groupdict()
        product_date = date.fromisoformat(
            f"{metadata['date'][:4]}-{metadata['date'][4:6]}-{metadata['date'][6:]}"
        )
        if not start <= product_date <= end:
            continue
        key = (
            metadata["tile"],
            product_date,
            metadata["version"],
            metadata["product"],
        )
        layers = grouped.setdefault(key, {})
        layer = metadata["layer"]
        if layer in layers:
            raise ValueError(f"duplicate {layer} object for {metadata['product']}")
        layers[layer] = item

    if oversize:
        listed = ", ".join(f"{item.key} ({item.size} bytes)" for item in oversize[:5])
        print(
            f"skipped {len(oversize)} catalogue object(s) over the "
            f"{MAX_LAYER_BYTES}-byte layer limit: {listed}"
        )

    by_tile: dict[str, list[CatalogProduct]] = {}
    for (tile, product_date, version, product), layers in grouped.items():
        if layers.keys() != _REQUIRED_LAYERS:
            continue
        by_tile.setdefault(tile, []).append(
            CatalogProduct(tile, product_date, version, product, layers)
        )
    return by_tile


def select_latest_products(
    objects: Iterable[CatalogObject],
    tiles: Sequence[str],
    start: date,
    end: date,
    *,
    require_all: bool = True,
) -> dict[str, CatalogProduct]:
    """Select one complete, newest product per tile from catalogue objects.

    If Copernicus publishes more than one processing version for the newest
    product date, the lexicographically greatest version wins. This is an
    explicit preview publication policy, never filesystem-order selection.
    """

    by_tile = _complete_products(objects, start, end)
    selected: dict[str, CatalogProduct] = {}
    for tile in (tile.upper() for tile in tiles):
        candidates = by_tile.get(tile, [])
        if not candidates:
            if require_all:
                raise ValueError(
                    f"no complete GFSC product found for {tile} from {start} through {end}"
                )
            continue
        selected[tile] = max(
            candidates, key=lambda product: (product.product_date, product.version)
        )
    return selected


def select_window_products(
    objects: Iterable[CatalogObject],
    tiles: Sequence[str],
    start: date,
    end: date,
    *,
    require_all: bool = False,
) -> dict[str, tuple[CatalogProduct, ...]]:
    """Select every complete product per tile, one per product date.

    This is the input the spec section 9.2 per-pixel backward search needs: the
    whole window, not just its newest member. Exactly one product is kept per
    product date - the lexicographically greatest processing version, matching
    ``select_latest_products`` - because ``pipeline.raster_io`` treats two
    versions of the same tile/date as an unresolved ambiguity and refuses them.
    Results are ordered oldest to newest so downstream ordering is never
    inherited from catalogue listing order.
    """

    by_tile = _complete_products(objects, start, end)
    selected: dict[str, tuple[CatalogProduct, ...]] = {}
    for tile in (tile.upper() for tile in tiles):
        candidates = by_tile.get(tile, [])
        if not candidates:
            if require_all:
                raise ValueError(
                    f"no complete GFSC product found for {tile} from {start} through {end}"
                )
            continue
        by_date: dict[date, CatalogProduct] = {}
        for candidate in candidates:
            incumbent = by_date.get(candidate.product_date)
            if incumbent is None or candidate.version > incumbent.version:
                by_date[candidate.product_date] = candidate
        if len(by_date) > MAX_PRODUCTS_PER_TILE:
            raise ValueError(
                f"{len(by_date)} products for tile {tile} exceeds the "
                f"{MAX_PRODUCTS_PER_TILE}-product window limit"
            )
        selected[tile] = tuple(by_date[day] for day in sorted(by_date))
    return selected


def _client():
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=os.getenv("HRWSI_ACCESS_KEY_ID", PUBLIC_ACCESS_KEY),
        aws_secret_access_key=os.getenv("HRWSI_SECRET_ACCESS_KEY", PUBLIC_SECRET_KEY),
        config=Config(
            retries={"max_attempts": 5, "mode": "standard"},
            response_checksum_validation="when_required",
        ),
    )


def _list_window(
    tiles: Sequence[str], as_of_date: date, lookback_days: int, workers: int
) -> tuple[date, list[CatalogObject]]:
    if lookback_days < 1:
        raise ValueError("lookback_days must be at least 1")
    start = as_of_date - timedelta(days=lookback_days - 1)
    prefixes = [
        prefix
        for tile in tiles
        for prefix in _month_prefixes(tile, start, as_of_date)
    ]

    def list_prefix(prefix: str) -> list[CatalogObject]:
        client = _client()
        paginator = client.get_paginator("list_objects_v2")
        return [
            CatalogObject(item["Key"], int(item["Size"]))
            for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix)
            for item in page.get("Contents", ())
        ]

    with ThreadPoolExecutor(max_workers=workers) as executor:
        pages = executor.map(list_prefix, prefixes)
        objects = [item for page in pages for item in page]
    return start, objects


def discover_latest_products(
    tiles: Sequence[str],
    as_of_date: date,
    lookback_days: int = 21,
    *,
    require_all: bool = True,
    workers: int = 16,
) -> dict[str, CatalogProduct]:
    """List recent catalogue metadata without downloading historical products."""

    start, objects = _list_window(tiles, as_of_date, lookback_days, workers)
    return select_latest_products(
        objects, tiles, start, as_of_date, require_all=require_all
    )


def discover_window_products(
    tiles: Sequence[str],
    as_of_date: date,
    window_days: int,
    *,
    require_all: bool = False,
    workers: int = 16,
) -> dict[str, tuple[CatalogProduct, ...]]:
    """List every complete product per tile across the AS-OF window.

    Unlike ``discover_latest_products`` this keeps the whole window, which is
    what the section 9.2 per-pixel backward search consumes. Catalogue listing
    cost is unchanged - the same month prefixes are enumerated either way - only
    the number of products subsequently downloaded grows.
    """

    start, objects = _list_window(tiles, as_of_date, window_days, workers)
    return select_window_products(
        objects, tiles, start, as_of_date, require_all=require_all
    )


def download_products(
    products: Iterable[CatalogProduct], out_dir: Path, workers: int = 8
) -> list[Path]:
    """Download the required GF/GF-QA/AT layers, skipping exact cached files."""

    out_dir = Path(out_dir)
    downloads: list[tuple[CatalogObject, Path]] = []
    for product in products:
        product_dir = out_dir / product.product
        for layer in sorted(_REQUIRED_LAYERS):
            item = product.layers[layer]
            if item.size > MAX_LAYER_BYTES:
                raise ValueError(
                    f"catalogue object {item.key} is {item.size} bytes, over the "
                    f"{MAX_LAYER_BYTES}-byte layer limit"
                )
            target = product_dir / Path(item.key).name
            if target.is_file() and target.stat().st_size == item.size:
                continue
            downloads.append((item, target))

    planned = sum(item.size for item, _ in downloads)
    if planned > MAX_DOWNLOAD_BYTES:
        raise ValueError(
            f"this run would download {planned} bytes, over the "
            f"{MAX_DOWNLOAD_BYTES}-byte run limit"
        )

    def download(pair: tuple[CatalogObject, Path]) -> Path:
        item, target = pair
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".part")
        _client().download_file(BUCKET, item.key, str(temporary))
        if temporary.stat().st_size != item.size:
            temporary.unlink(missing_ok=True)
            raise IOError(f"downloaded size mismatch for {item.key}")
        temporary.replace(target)
        return target

    with ThreadPoolExecutor(max_workers=workers) as executor:
        written = list(executor.map(download, downloads))
    return written
