"""Compact on-disk tile composites and memory-bounded full-area rendering."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
from affine import Affine
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds

from .asof import AsOfComposite
from .mosaic import TileComposite, mosaic_to_grid
from .raster_io import RasterGrid
from .tiles import ORIGIN_SHIFT, TILE_SIZE, write_xyz_tiles


@dataclass(frozen=True)
class SnapshotInfo:
    path: Path
    tile: str
    grid: RasterGrid
    bounds_3857: tuple[float, float, float, float]


def save_snapshot(path: Path, tile: TileComposite) -> None:
    """Persist one composite compactly so the full AOI need not fit in RAM."""

    path.parent.mkdir(parents=True, exist_ok=True)
    c = tile.composite
    np.savez_compressed(
        path,
        tile=np.array(tile.tile),
        as_of_date=np.array(c.as_of_date.isoformat()),
        crs=np.array(tile.grid.crs),
        transform=np.array(tuple(tile.grid.transform)[:6], dtype=np.float64),
        width=np.array(tile.grid.width, dtype=np.int32),
        height=np.array(tile.grid.height, dtype=np.int32),
        fsc=c.fsc,
        quality=c.quality,
        acquisition_time=c.acquisition_time.astype(np.uint32),
        age_days=c.age_days.astype(np.int16),
        source_product_day=c.source_product_day,
        state=c.state,
    )


def _grid(data: np.lib.npyio.NpzFile) -> RasterGrid:
    return RasterGrid(
        crs=str(data["crs"]),
        transform=Affine(*data["transform"].tolist()),
        width=int(data["width"]),
        height=int(data["height"]),
    )


def snapshot_info(path: Path) -> SnapshotInfo:
    with np.load(path) as data:
        grid = _grid(data)
        tile = str(data["tile"])
    west, south, east, north = array_bounds(grid.height, grid.width, grid.transform)
    bounds = transform_bounds(grid.crs, "EPSG:3857", west, south, east, north)
    return SnapshotInfo(path, tile, grid, bounds)


def load_snapshot(path: Path) -> TileComposite:
    from datetime import date

    with np.load(path) as data:
        grid = _grid(data)
        age_days = data["age_days"].astype(np.int32)
        state = data["state"].astype(np.uint8)
        composite = AsOfComposite(
            as_of_date=date.fromisoformat(str(data["as_of_date"])),
            fsc=data["fsc"].astype(np.uint8),
            quality=data["quality"].astype(np.uint8),
            acquisition_time=data["acquisition_time"].astype(np.uint64),
            age_days=age_days,
            source_product_day=data["source_product_day"].astype(np.int32),
            state=state,
        )
        return TileComposite(str(data["tile"]), grid, composite)


def _xyz_range(
    bounds: tuple[float, float, float, float], zoom: int
) -> tuple[range, range]:
    west, south, east, north = bounds
    count = 2**zoom
    span = 2 * ORIGIN_SHIFT / count
    epsilon = span * 1e-9
    x0 = max(0, int(np.floor((west + ORIGIN_SHIFT) / span)))
    x1 = min(count - 1, int(np.floor((east + ORIGIN_SHIFT - epsilon) / span)))
    y0 = max(0, int(np.floor((ORIGIN_SHIFT - north) / span)))
    y1 = min(count - 1, int(np.floor((ORIGIN_SHIFT - south - epsilon) / span)))
    return range(x0, x1 + 1), range(y0, y1 + 1)


def _metatile_grid(base_zoom: int, max_zoom: int, x: int, y: int) -> RasterGrid:
    scale = 2 ** (max_zoom - base_zoom)
    size = TILE_SIZE * scale
    span = 2 * ORIGIN_SHIFT / (2**base_zoom)
    west = -ORIGIN_SHIFT + x * span
    north = ORIGIN_SHIFT - y * span
    resolution = span / size
    return RasterGrid(
        "EPSG:3857",
        Affine(resolution, 0.0, west, 0.0, -resolution, north),
        size,
        size,
    )


def render_snapshots(
    paths: Sequence[Path], out_dir: Path, min_zoom: int = 8, max_zoom: int = 11
) -> list[Path]:
    """Merge source overlaps one z8 metatile at a time and write XYZ tiles."""

    if max_zoom < min_zoom:
        raise ValueError("max_zoom must be greater than or equal to min_zoom")
    infos = [snapshot_info(path) for path in paths]
    metatiles: dict[tuple[int, int], list[SnapshotInfo]] = {}
    for info in infos:
        xs, ys = _xyz_range(info.bounds_3857, min_zoom)
        for x in xs:
            for y in ys:
                metatiles.setdefault((x, y), []).append(info)

    written: list[Path] = []
    for (x, y), sources in sorted(metatiles.items()):
        target = _metatile_grid(min_zoom, max_zoom, x, y)
        mosaic = mosaic_to_grid(
            [load_snapshot(source.path) for source in sources], target
        )
        written.extend(
            write_xyz_tiles(
                mosaic.composite,
                target,
                range(min_zoom, max_zoom + 1),
                out_dir,
            )
        )
    return sorted(set(written))

