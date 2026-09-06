"""Build and optionally publish a full-area GFSC snapshot for one AS-OF date.

Composition follows spec section 9.2 in full: every complete product in the
31-day AS-OF window is loaded per MGRS tile and ``pipeline.asof`` picks, per
pixel, the newest valid acquisition. Because a product's per-pixel acquisition
time is never later than its own product date, the newest product still wins
wherever it holds a valid pixel - the older window members only fill what it
left as cloud or no-data, which is exactly what makes the backward search
additive rather than a re-interpretation of fresh data.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
import json
from pathlib import Path
from typing import Sequence

from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds

from .asof import compose_as_of
from .config import (
    ASOF_WINDOW_DAYS,
    MVP_MGRS_TILES,
    PREVIEW_MAX_ZOOM,
    PREVIEW_MIN_ZOOM,
)
from .fetch import CatalogProduct, discover_window_products, download_products
from .mosaic import TileComposite
from .publish import publish_to_r2
from .raster_io import ProductTriplet, discover_product_triplets, load_tile_products
from .snapshots import render_snapshots, save_snapshot, snapshot_info


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from error


def _local_window(
    raw_dir: Path, tiles: Sequence[str], as_of_date: date, window_days: int
) -> dict[str, tuple[ProductTriplet, ...]]:
    """Collect each tile's local AS-OF window, newest version per product date."""

    earliest = as_of_date - timedelta(days=window_days - 1)
    grouped: dict[str, dict[date, ProductTriplet]] = defaultdict(dict)
    for triplet in discover_product_triplets(raw_dir):
        if triplet.tile not in tiles or not earliest <= triplet.product_date <= as_of_date:
            continue
        incumbent = grouped[triplet.tile].get(triplet.product_date)
        if incumbent is None or triplet.version > incumbent.version:
            grouped[triplet.tile][triplet.product_date] = triplet
    missing = sorted(set(tiles) - grouped.keys())
    if missing:
        raise ValueError(f"no local product found for: {', '.join(missing)}")
    return {
        tile: tuple(by_date[day] for day in sorted(by_date))
        for tile, by_date in grouped.items()
    }


def _downloaded_triplets(
    raw_dir: Path,
    selected: dict[str, tuple[CatalogProduct, ...]],
) -> dict[str, tuple[ProductTriplet, ...]]:
    by_product = {triplet.product: triplet for triplet in discover_product_triplets(raw_dir)}
    missing = [
        product.product
        for window in selected.values()
        for product in window
        if product.product not in by_product
    ]
    if missing:
        raise ValueError(f"downloaded product discovery failed for: {', '.join(missing)}")
    return {
        tile: tuple(by_product[product.product] for product in window)
        for tile, window in selected.items()
    }


def _bounds_wgs84(snapshot_paths: Sequence[Path]) -> list[float]:
    transformed: list[tuple[float, float, float, float]] = []
    for path in snapshot_paths:
        grid = snapshot_info(path).grid
        west, south, east, north = array_bounds(grid.height, grid.width, grid.transform)
        transformed.append(
            transform_bounds(grid.crs, "EPSG:4326", west, south, east, north)
        )
    return [
        min(item[0] for item in transformed),
        min(item[1] for item in transformed),
        max(item[2] for item in transformed),
        max(item[3] for item in transformed),
    ]


def build_preview(
    *,
    as_of_date: date,
    tiles: Sequence[str],
    raw_dir: Path,
    work_dir: Path,
    output_dir: Path,
    window_days: int = ASOF_WINDOW_DAYS,
    max_missing_tiles: int = 0,
    fetch: bool = True,
    publish: bool = False,
    keep_runs: int | None = None,
) -> dict[str, object]:
    """Run AS-OF window discovery through render and optional R2 publish."""

    normalized_tiles = tuple(sorted({tile.upper() for tile in tiles}))
    if fetch:
        catalog = discover_window_products(
            normalized_tiles,
            as_of_date,
            window_days,
            require_all=False,
        )
        if not catalog:
            raise ValueError("no recent complete GFSC products found for the requested area")
        download_products(
            [product for window in catalog.values() for product in window], raw_dir
        )
        triplets = _downloaded_triplets(raw_dir, catalog)
    else:
        triplets = _local_window(raw_dir, normalized_tiles, as_of_date, window_days)

    active_tiles = tuple(sorted(triplets))
    missing_tiles = sorted(set(normalized_tiles) - triplets.keys())
    if len(missing_tiles) > max_missing_tiles:
        # Every tile in the MVP set is one HR-WSI genuinely publishes daily, so
        # a tile with nothing at all across a 31-day window is an anomaly, not
        # ordinary catalogue lag. Failing before publishing leaves latest.json
        # pointing at the previous good run rather than silently shipping a
        # partial map; raise --max-missing-tiles to publish anyway.
        raise ValueError(
            f"{len(missing_tiles)} requested tiles have no complete GFSC product "
            f"in the {window_days}-day window ending {as_of_date.isoformat()} "
            f"(limit {max_missing_tiles}): {', '.join(missing_tiles)}"
        )

    generated_at = datetime.now(UTC)
    run_id = generated_at.strftime("%Y%m%dT%H%M%SZ")
    snapshot_dir = work_dir / "snapshots" / run_id
    snapshot_paths: list[Path] = []
    product_dates: dict[str, str] = {}
    window_sizes: dict[str, int] = {}
    for tile in active_tiles:
        window = triplets[tile]
        loaded = load_tile_products(window)
        composite = compose_as_of(loaded.products, as_of_date)
        snapshot_path = snapshot_dir / f"{tile}.npz"
        save_snapshot(
            snapshot_path,
            TileComposite(tile=tile, grid=loaded.grid, composite=composite),
        )
        snapshot_paths.append(snapshot_path)
        product_dates[tile] = max(item.product_date for item in window).isoformat()
        window_sizes[tile] = len(window)

    run_dir = output_dir / "runs" / run_id
    tile_paths = render_snapshots(
        snapshot_paths,
        run_dir / "tiles",
        PREVIEW_MIN_ZOOM,
        PREVIEW_MAX_ZOOM,
    )
    metadata: dict[str, object] = {
        "schemaVersion": 1,
        "runId": run_id,
        "mode": "asof-window",
        "asOfDate": as_of_date.isoformat(),
        "asOfWindowDays": window_days,
        "generatedAt": generated_at.isoformat(),
        "minzoom": PREVIEW_MIN_ZOOM,
        "maxzoom": PREVIEW_MAX_ZOOM,
        "bounds": _bounds_wgs84(snapshot_paths),
        "tileCount": len(tile_paths),
        "requestedSourceTileCount": len(normalized_tiles),
        "sourceTileCount": len(active_tiles),
        "sourceTiles": list(active_tiles),
        "missingSourceTiles": missing_tiles,
        "productDates": product_dates,
        "sourceProductCounts": window_sizes,
        "sourceProductTotal": sum(window_sizes.values()),
        "notice": (
            "Each pixel shows the newest valid GFSC observation on or before "
            f"{as_of_date.isoformat()}, searching back up to 30 days per spec "
            "section 9.2. Color shows how old that observation is (sky blue = most "
            "recent, indigo = up to 30 days old); a transparent area means no "
            "valid observation was found there in that window (cloud, water, "
            "or no data)."
        ),
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=2) + "\n")

    local_latest = dict(metadata)
    local_latest["tiles"] = [f"runs/{run_id}/tiles/{{z}}/{{x}}/{{y}}.png"]
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "latest.json").write_text(json.dumps(local_latest, indent=2) + "\n")
    if publish:
        publish_to_r2(run_dir, metadata, keep_runs=keep_runs)
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", type=_parse_date, default=date.today())
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--window-days",
        type=int,
        default=ASOF_WINDOW_DAYS,
        help=(
            "Product dates to consider, ending at --as-of. The default "
            f"({ASOF_WINDOW_DAYS}) is what spec section 9.2's 30-day "
            "acquisition-age ceiling implies; 1 reproduces the old "
            "newest-product-only preview."
        ),
    )
    parser.add_argument(
        "--max-missing-tiles",
        type=int,
        default=0,
        help=(
            "Publish even if this many requested tiles have no product in the "
            "window. Defaults to 0: a missing tile fails the run and leaves the "
            "previously published latest.json in place."
        ),
    )
    parser.add_argument("--tiles", nargs="+", default=MVP_MGRS_TILES)
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Use the matching products already below --raw-dir.",
    )
    parser.add_argument(
        "--publish-r2",
        action="store_true",
        help="Publish the completed immutable run and latest.json pointer to R2.",
    )
    parser.add_argument(
        "--keep-runs",
        type=int,
        default=None,
        help=(
            "After the pointer moves, delete all but this many newest runs. "
            "Omit to keep every run forever (the default; a daily schedule "
            "should set it)."
        ),
    )
    args = parser.parse_args()
    metadata = build_preview(
        as_of_date=args.as_of,
        tiles=args.tiles,
        raw_dir=args.raw_dir,
        work_dir=args.work_dir,
        output_dir=args.output_dir,
        window_days=args.window_days,
        max_missing_tiles=args.max_missing_tiles,
        fetch=not args.skip_fetch,
        publish=args.publish_r2,
        keep_runs=args.keep_runs,
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
