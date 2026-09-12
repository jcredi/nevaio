"""Sample the per-object GFSC series from arrays ``render.build_preview`` already loads.

``docs/plan.md``, "Do the daily increment first; it is nearly free":
``build_preview`` already holds every window product's GF/GF-QA/AT arrays in
RAM per tile to build the AS-OF composite, so sampling every object's pixel
for every product date is one numpy fancy-index gather, one vectorized encode
(:func:`nevaio_pipeline.object_series.encode_cells_vectorized`), and one
fancy-index scatter into the month buffer - no per-object Python loop.

**Critical, measured, and not to be re-derived**: the pixel index for an
object must come from the product's *own* affine transform
(``RasterGrid.transform``), never from
``nevaio_pipeline.footprint.parse_mgrs_tile``. The real granule origin is
offset by up to 40 m from the nominal 100 km MGRS grid, and the offset differs
per tile; a footprint-derived pixel index was measured to be off by a column
for roughly two thirds of objects. ``footprint`` still owns *which* tile(s)
cover a point (:meth:`nevaio_pipeline.footprint.Footprint.containing_tiles`) -
only the row/column arithmetic comes from here, using the tile's own loaded
grid.

Each daily product is sampled using *that product's own* GF/GF-QA/AT pixel
values, not the AS-OF composite - spec section 7.1's mark-eligibility test is
stated per product date ("that product's own pixel"), independent of what the
map's AS-OF fallback later resolves to.

Pure Python plus ``numpy`` and ``affine`` (no GDAL/rasterio import), so this
stays testable without the native raster stack, per repo convention.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import floor
from typing import Sequence

import numpy as np
from affine import Affine
from numpy.typing import NDArray

from .asof import DailyProduct
from .footprint import project_utm
from .object_index import ObjectIndexEntry
from .object_series import encode_cells_vectorized, unix_day
from .object_slots import SlotMap


@dataclass(frozen=True)
class TileObjectPixels:
    """Resolved (slot, row, col) for every object this tile can actually sample.

    An object is silently dropped here - never raised as an error - when its
    point falls outside this tile's own raster grid. That can legitimately
    happen even for an object the footprint places inside the tile's nominal
    100 km square, because the granule's real pixel grid and that square are
    related but not identical (see the module docstring on the origin
    offset); it is not a sign of a bad object.
    """

    object_ids: tuple[str, ...]
    slots: NDArray[np.intp]
    rows: NDArray[np.intp]
    cols: NDArray[np.intp]

    def __len__(self) -> int:
        return len(self.object_ids)


def object_pixel_index(
    transform: Affine,
    zone: int,
    longitude: float,
    latitude: float,
    width: int,
    height: int,
) -> tuple[int, int] | None:
    """Return ``(row, col)`` of one WGS84 point in one tile's OWN raster grid.

    Returns ``None`` when the point falls outside the raster (see
    :class:`TileObjectPixels`). Deliberately takes the product's own affine
    transform rather than deriving an index from
    ``footprint.parse_mgrs_tile``'s nominal square origin - see the module
    docstring for why that distinction is load-bearing.
    """

    easting, northing = project_utm(longitude, latitude, zone)
    col_f, row_f = ~transform @ (easting, northing)
    col, row = int(floor(col_f)), int(floor(row_f))
    if 0 <= row < height and 0 <= col < width:
        return row, col
    return None


def index_tile_objects(
    entries: Sequence[ObjectIndexEntry],
    slot_map: SlotMap,
    *,
    transform: Affine,
    zone: int,
    width: int,
    height: int,
) -> TileObjectPixels:
    """Resolve every entry's pixel and permanent slot for one tile's grid.

    Every ``entry.id`` must already have a slot in ``slot_map`` - extend the
    slot map (:func:`nevaio_pipeline.object_slots.extend_slot_map`) before
    calling this, rather than have sampling silently invent one.
    """

    object_ids: list[str] = []
    slots: list[int] = []
    rows: list[int] = []
    cols: list[int] = []
    for entry in entries:
        slot = slot_map.slot_for(entry.id)
        if slot is None:
            raise ValueError(
                f"object {entry.id} has no slot in the tile {slot_map.tile} slot map - extend it first"
            )
        pixel = object_pixel_index(transform, zone, entry.longitude, entry.latitude, width, height)
        if pixel is None:
            continue
        row, col = pixel
        object_ids.append(entry.id)
        slots.append(slot)
        rows.append(row)
        cols.append(col)
    return TileObjectPixels(
        object_ids=tuple(object_ids),
        slots=np.asarray(slots, dtype=np.intp),
        rows=np.asarray(rows, dtype=np.intp),
        cols=np.asarray(cols, dtype=np.intp),
    )


def sample_daily_product(
    array: NDArray[np.uint8],
    pixels: TileObjectPixels,
    product: DailyProduct,
    days_in_month: int,
) -> None:
    """Sample one day's own GF/GF-QA/AT arrays into a month array, in place.

    ``array`` is shaped ``(slot_count, days, 2)`` (see
    ``nevaio_pipeline.object_series.new_month_array``/``array_from_buffer``).
    One fancy-index gather (`gf[rows, cols]`, ...), one vectorized encode, and
    one fancy-index scatter (`array[slots, day, :] =`) - no per-object loop.
    """

    if len(pixels) == 0:
        return
    day_index = product.product_date.day - 1
    if not 0 <= day_index < days_in_month:
        raise ValueError(
            f"product date {product.product_date.isoformat()} does not fall in a "
            f"{days_in_month}-day month (day index {day_index})"
        )
    gf = np.asarray(product.gf)[pixels.rows, pixels.cols]
    quality = np.asarray(product.quality)[pixels.rows, pixels.cols]
    acquisition_time = np.asarray(product.acquisition_time)[pixels.rows, pixels.cols]
    cells = encode_cells_vectorized(gf, quality, acquisition_time, unix_day(product.product_date))
    array[pixels.slots, day_index, :] = cells
