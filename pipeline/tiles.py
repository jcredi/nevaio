"""Render a merged AS-OF composite into browser-ready Web Mercator XYZ tiles.

Two independent steps, kept separate so the frozen color ramp stays testable
without any raster I/O: ``render_rgba`` turns a composite's semantic fields
into the fixed visual encoding from docs/spec.md sections 5.2 and 5.4; the
rest of this module slices that RGBA raster into the standard slippy-map tile
grid (https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames), writing
``{z}/{x}/{y}.png`` under an output root. Fully-transparent tiles are not
written - a mosaic's footprint is rarely the whole world.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Sequence

import numpy as np
from numpy.typing import NDArray
from PIL import Image
from affine import Affine
from rasterio.warp import Resampling, reproject, transform_bounds

from .asof import AsOfComposite, freshness_tier
from .raster_io import RasterGrid

TILE_SIZE = 256

# EPSG:3857 half-circumference at the equator - the standard Web Mercator
# world extent, in map units (metres). This is a fixed property of the
# projection, not a derived/tunable value.
ORIGIN_SHIFT = 20_037_508.342789244
_WORLD_SPAN = 2 * ORIGIN_SHIFT

# Frozen visual encoding, docs/spec.md section 5.2 (amended 2026-09-06):
# opacity and color are two independent channels rather than one combined
# alpha, so a pixel's faintness always means one thing (little snow), never
# "little snow, or maybe just old" ambiguity.
#
# alpha = snow-cover percentage: piecewise-linear 0 at 0%, 150 at 50%, 255 at
# 100%. Index 101-255 (categorical GF codes, NO_VALUE, including every
# non-VALID state per AsOfComposite's "fsc/quality use 255 where state is not
# VALID" convention) maps to alpha 0 - cloud, water, stale, and no-data all
# render fully transparent with no separate visual code, and a confirmed 0%
# pixel is indistinguishable from them on the map itself (spec 5.4).
_ALPHA_STOPS = (0.0, 0.5, 1.0)


def _build_alpha_lut() -> NDArray[np.uint8]:
    lut = np.zeros(256, dtype=np.uint8)
    f = np.linspace(0.0, 1.0, 101)
    lut[0:101] = np.round(np.interp(f, _ALPHA_STOPS, [0, 150, 255]))
    return lut


_ALPHA_LUT = _build_alpha_lut()

# color = freshness tier (spec 9.2 age bands, tier indices from
# asof.freshness_tier): Sky to Indigo, selected 2026-09-06 to distinguish
# snow from green topo terrain. Only meaningful where alpha > 0 (state
# VALID); freshness_tier's tier for any other pixel is never rendered.
_FRESHNESS_COLORS = np.array(
    [
        (0x38, 0xBD, 0xF8),  # tier 0, 0-3 days: sky blue
        (0x51, 0x85, 0xED),  # tier 1, 4-7 days
        (0x69, 0x57, 0xCE),  # tier 2, 8-14 days
        (0x71, 0x3A, 0x9C),  # tier 3, 15-30 days: indigo
    ],
    dtype=np.uint8,
)


def render_rgba(composite: AsOfComposite) -> NDArray[np.uint8]:
    """Colorize a composite's fsc/age fields per spec 5.2/5.4/9.2.

    Water, cloud, stale, and no-data all render fully transparent (spec 5.4);
    only their category is distinguished elsewhere (point/history details,
    not this raster).
    """

    alpha = _ALPHA_LUT[composite.fsc]
    rgb = _FRESHNESS_COLORS[freshness_tier(composite.age_days)]
    return np.dstack([rgb, alpha])


def _tile_transform(z: int, x: int, y: int) -> tuple[Affine, tuple[float, float, float, float]]:
    tile_span = _WORLD_SPAN / (2**z)
    west = -ORIGIN_SHIFT + x * tile_span
    north = ORIGIN_SHIFT - y * tile_span
    resolution = tile_span / TILE_SIZE
    transform = Affine(resolution, 0.0, west, 0.0, -resolution, north)
    return transform, (west, north - tile_span, west + tile_span, north)


def _tile_range(grid: RasterGrid, z: int) -> tuple[range, range]:
    corners_x = (grid.transform.c, (grid.transform * (grid.width, grid.height))[0])
    corners_y = (grid.transform.f, (grid.transform * (grid.width, grid.height))[1])
    left, right = min(corners_x), max(corners_x)
    bottom, top = min(corners_y), max(corners_y)
    west, south, east, north = transform_bounds(grid.crs, "EPSG:3857", left, bottom, right, top)

    n = 2**z
    tile_span = _WORLD_SPAN / n
    epsilon = tile_span * 1e-9
    x_min = max(0, math.floor((west + ORIGIN_SHIFT) / tile_span))
    x_max = min(n - 1, math.floor((east + ORIGIN_SHIFT - epsilon) / tile_span))
    y_min = max(0, math.floor((ORIGIN_SHIFT - north) / tile_span))
    y_max = min(n - 1, math.floor((ORIGIN_SHIFT - south - epsilon) / tile_span))
    return range(x_min, x_max + 1), range(y_min, y_max + 1)


def _warp_tile(rgba: NDArray[np.uint8], grid: RasterGrid, z: int, x: int, y: int) -> NDArray[np.uint8] | None:
    dst_transform, _ = _tile_transform(z, x, y)
    dst = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    for band in range(4):
        # 0 never occurs in a legitimately encoded pixel (color channels start
        # at 130/160/190 and alpha at 26; only a fully transparent pixel is
        # all-zero), so 0 doubles safely as the nodata sentinel on both sides.
        # Without src_nodata, GDAL's dst_nodata handling bumps any resampled
        # value that collides with it by 1 to disambiguate from "no data" -
        # turning legitimate (0,0,0,0) transparency into (1,1,1,1).
        reproject(
            source=rgba[..., band],
            destination=dst[..., band],
            src_transform=grid.transform,
            src_crs=grid.crs,
            src_nodata=0,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            dst_nodata=0,
            resampling=Resampling.nearest,
        )
    if not dst[..., 3].any():
        return None
    return dst


def write_xyz_tiles(
    composite: AsOfComposite,
    grid: RasterGrid,
    zooms: Sequence[int],
    out_dir: Path,
) -> list[Path]:
    """Warp and write one composite as an XYZ tile set under ``out_dir``.

    Only tiles with at least one non-transparent pixel are written, so a
    mosaic's footprint (never the whole world) doesn't leave behind an empty
    tile tree. Returns the paths actually written.
    """

    rgba = render_rgba(composite)
    written: list[Path] = []
    for z in zooms:
        x_range, y_range = _tile_range(grid, z)
        for x in x_range:
            for y in y_range:
                tile = _warp_tile(rgba, grid, z, x, y)
                if tile is None:
                    continue
                path = out_dir / str(z) / str(x) / f"{y}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(tile, mode="RGBA").save(path, optimize=True)
                written.append(path)
    return written
