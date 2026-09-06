"""Merge independently composed MGRS tiles onto one target grid.

GFSC tiles overlap by design and can use different UTM zones. Each tile is
composed in its native grid first; this module warps those semantic fields with
nearest-neighbour resampling and resolves overlap deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np
from numpy.typing import NDArray
from rasterio.warp import Resampling, reproject

from .asof import (
    NODATA,
    NO_AGE,
    NO_PRODUCT_DAY,
    NO_VALUE,
    AsOfComposite,
    PixelState,
)
from .raster_io import RasterGrid


@dataclass(frozen=True)
class TileComposite:
    """One MGRS tile after native-grid AS-OF composition."""

    tile: str
    grid: RasterGrid
    composite: AsOfComposite


@dataclass(frozen=True)
class Mosaic:
    """A target-grid composite plus the source tile selected at each pixel."""

    composite: AsOfComposite
    source_tile: NDArray[np.int16]
    tile_names: tuple[str, ...]


def mosaic_to_grid(tiles: Sequence[TileComposite], target_grid: RasterGrid) -> Mosaic:
    """Warp and merge tile composites onto ``target_grid``.

    Overlap precedence is deliberately data-centric and deterministic:

    1. water (a terminal static mask) wins;
    2. a valid observation wins over all non-water states, ordered by newest
       acquisition time, better quality tier, then lexicographically earlier
       tile name;
    3. with no valid observation, cloud wins over stale, which wins over no-data.

    All fields are warped independently with nearest-neighbour resampling, so
    categorical values and 60 m values are never averaged across an overlap or
    UTM-zone seam.
    """

    if not tiles:
        raise ValueError("at least one tile composite is required")

    tile_names = tuple(sorted(tile.tile for tile in tiles))
    if len(tile_names) != len(set(tile_names)):
        raise ValueError("tile composites must have unique MGRS tile names")
    by_name = {tile.tile: tile for tile in tiles}
    ordered_tiles = [by_name[name] for name in tile_names]
    as_of_dates = {tile.composite.as_of_date for tile in ordered_tiles}
    if len(as_of_dates) != 1:
        raise ValueError("all tile composites must use the same AS-OF date")

    shape = (target_grid.height, target_grid.width)
    fsc = np.full(shape, NO_VALUE, dtype=np.uint8)
    quality = np.full(shape, NO_VALUE, dtype=np.uint8)
    acquisition_time = np.zeros(shape, dtype=np.uint64)
    age_days = np.full(shape, NO_AGE, dtype=np.int32)
    source_product_day = np.full(shape, NO_PRODUCT_DAY, dtype=np.int32)
    state = np.full(shape, PixelState.NODATA, dtype=np.uint8)
    source_tile = np.full(shape, -1, dtype=np.int16)

    for tile_index, tile in enumerate(ordered_tiles):
        _validate_tile(tile)
        incoming = _warp_composite(tile, target_grid)
        incoming_state = incoming.state

        # Water is terminal even when an overlapping source has an apparently
        # valid percentage at the same destination pixel.
        water = (incoming_state == PixelState.WATER) & (
            (state != PixelState.WATER) | (tile_index < source_tile)
        )
        _set_absent(state, fsc, quality, acquisition_time, age_days, source_product_day, source_tile, water, PixelState.WATER, tile_index)

        valid = incoming_state == PixelState.VALID
        better_valid = valid & (state != PixelState.WATER) & (
            (state != PixelState.VALID)
            | (incoming.acquisition_time > acquisition_time)
            | (
                (incoming.acquisition_time == acquisition_time)
                & (incoming.quality < quality)
            )
            | (
                (incoming.acquisition_time == acquisition_time)
                & (incoming.quality == quality)
                & (tile_index < source_tile)
            )
        )
        _copy_value(
            fsc,
            quality,
            acquisition_time,
            age_days,
            source_product_day,
            state,
            source_tile,
            incoming,
            better_valid,
            tile_index,
        )

        # The two no-value states have deliberate precedence: cloud explains a
        # current failure better than stale data, while stale retains a useful
        # last-observation age only when no cloud is available.
        cloud = (
            (incoming_state == PixelState.CLOUD)
            & (state != PixelState.WATER)
            & (state != PixelState.VALID)
            & ((state != PixelState.CLOUD) | (tile_index < source_tile))
        )
        _set_absent(state, fsc, quality, acquisition_time, age_days, source_product_day, source_tile, cloud, PixelState.CLOUD, tile_index)

        stale = (incoming_state == PixelState.STALE) & (state == PixelState.NODATA)
        better_stale = stale & (
            (incoming.acquisition_time > acquisition_time)
            | ((incoming.acquisition_time == acquisition_time) & (tile_index < source_tile))
        )
        _copy_stale(
            quality,
            acquisition_time,
            age_days,
            source_product_day,
            state,
            source_tile,
            incoming,
            better_stale,
            tile_index,
        )

    as_of_date = next(iter(as_of_dates))
    composite = AsOfComposite(
        as_of_date=as_of_date,
        fsc=fsc,
        quality=quality,
        acquisition_time=acquisition_time,
        age_days=age_days,
        source_product_day=source_product_day,
        state=state,
    )
    return Mosaic(composite=composite, source_tile=source_tile, tile_names=tile_names)


def _validate_tile(tile: TileComposite) -> None:
    expected_shape = (tile.grid.height, tile.grid.width)
    arrays = {
        "fsc": tile.composite.fsc,
        "quality": tile.composite.quality,
        "acquisition_time": tile.composite.acquisition_time,
        "age_days": tile.composite.age_days,
        "source_product_day": tile.composite.source_product_day,
        "state": tile.composite.state,
    }
    for name, array in arrays.items():
        if array.shape != expected_shape:
            raise ValueError(
                f"{tile.tile} {name} shape {array.shape} does not match grid {expected_shape}"
            )


def _warp_composite(tile: TileComposite, target_grid: RasterGrid) -> AsOfComposite:
    source = tile.composite
    return AsOfComposite(
        as_of_date=source.as_of_date,
        fsc=_warp(source.fsc, tile.grid, target_grid, NO_VALUE),
        quality=_warp(source.quality, tile.grid, target_grid, NO_VALUE),
        acquisition_time=_warp(source.acquisition_time, tile.grid, target_grid, 0),
        age_days=_warp(source.age_days, tile.grid, target_grid, NO_AGE),
        source_product_day=_warp(source.source_product_day, tile.grid, target_grid, NO_PRODUCT_DAY),
        state=_warp(source.state, tile.grid, target_grid, PixelState.NODATA),
    )


def _warp(
    source: NDArray[np.generic],
    source_grid: RasterGrid,
    target_grid: RasterGrid,
    nodata: int,
) -> NDArray[np.generic]:
    destination = np.full((target_grid.height, target_grid.width), nodata, dtype=source.dtype)
    reproject(
        source=source,
        destination=destination,
        src_transform=source_grid.transform,
        src_crs=source_grid.crs,
        src_nodata=nodata,
        dst_transform=target_grid.transform,
        dst_crs=target_grid.crs,
        dst_nodata=nodata,
        resampling=Resampling.nearest,
    )
    return destination


def _set_absent(
    state: NDArray[np.uint8],
    fsc: NDArray[np.uint8],
    quality: NDArray[np.uint8],
    acquisition_time: NDArray[np.uint64],
    age_days: NDArray[np.int32],
    source_product_day: NDArray[np.int32],
    source_tile: NDArray[np.int16],
    mask: NDArray[np.bool_],
    value: PixelState,
    tile_index: int,
) -> None:
    state[mask] = value
    fsc[mask] = NO_VALUE
    quality[mask] = NO_VALUE
    acquisition_time[mask] = 0
    age_days[mask] = NO_AGE
    source_product_day[mask] = NO_PRODUCT_DAY
    source_tile[mask] = tile_index


def _copy_value(
    fsc: NDArray[np.uint8],
    quality: NDArray[np.uint8],
    acquisition_time: NDArray[np.uint64],
    age_days: NDArray[np.int32],
    source_product_day: NDArray[np.int32],
    state: NDArray[np.uint8],
    source_tile: NDArray[np.int16],
    incoming: AsOfComposite,
    mask: NDArray[np.bool_],
    tile_index: int,
) -> None:
    fsc[mask] = incoming.fsc[mask]
    quality[mask] = incoming.quality[mask]
    acquisition_time[mask] = incoming.acquisition_time[mask]
    age_days[mask] = incoming.age_days[mask]
    source_product_day[mask] = incoming.source_product_day[mask]
    state[mask] = PixelState.VALID
    source_tile[mask] = tile_index


def _copy_stale(
    quality: NDArray[np.uint8],
    acquisition_time: NDArray[np.uint64],
    age_days: NDArray[np.int32],
    source_product_day: NDArray[np.int32],
    state: NDArray[np.uint8],
    source_tile: NDArray[np.int16],
    incoming: AsOfComposite,
    mask: NDArray[np.bool_],
    tile_index: int,
) -> None:
    quality[mask] = incoming.quality[mask]
    acquisition_time[mask] = incoming.acquisition_time[mask]
    age_days[mask] = incoming.age_days[mask]
    source_product_day[mask] = incoming.source_product_day[mask]
    state[mask] = PixelState.STALE
    source_tile[mask] = tile_index
