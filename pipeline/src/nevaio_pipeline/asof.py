"""Deterministic per-pixel GFSC AS-OF selection.

This module implements docs/spec.md section 9.2 without knowing anything about
GeoTIFFs, MGRS tiles, reprojection, or storage. Callers supply already aligned
GF, GF-QA, and AT arrays for one grid. Keeping the semantic core independent of
raster I/O makes the rules cheap to test before the rest of the pipeline lands.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from enum import IntEnum
from typing import Sequence

import numpy as np
from numpy.typing import NDArray

CLOUD = 205
WATER = 210
NODATA = 255
MAX_AGE_DAYS = 30

NO_VALUE = np.uint8(255)
NO_AGE = np.int32(-1)
NO_PRODUCT_DAY = np.int32(-1)


class PixelState(IntEnum):
    """Semantic state kept separately from the 0-100 FSC value."""

    VALID = 0
    CLOUD = CLOUD
    WATER = WATER
    STALE = 254
    NODATA = NODATA


@dataclass(frozen=True)
class DailyProduct:
    """One aligned GFSC product for a single tile/grid and product date."""

    product_date: date
    gf: NDArray[np.integer]
    quality: NDArray[np.integer]
    acquisition_time: NDArray[np.integer]


@dataclass(frozen=True)
class AsOfComposite:
    """Selected semantic fields for one AS-OF date.

    `fsc` and `quality` use 255 where `state` is not VALID. Acquisition time
    and age remain populated for STALE pixels so the UI can report when the
    last usable acquisition occurred without presenting its FSC as current.
    `source_product_day` is a Unix-day integer, or -1 when no source product
    supplied a value. Rendering derives its freshness color directly from
    `age_days` (see `freshness_tier`); there is no separate stored field for
    it, since age_days is already exactly what that needs.
    """

    as_of_date: date
    fsc: NDArray[np.uint8]
    quality: NDArray[np.uint8]
    acquisition_time: NDArray[np.uint64]
    age_days: NDArray[np.int32]
    source_product_day: NDArray[np.int32]
    state: NDArray[np.uint8]


def _unix_day(value: date) -> int:
    return (value - date(1970, 1, 1)).days


def _next_day_epoch(value: date) -> int:
    next_day = datetime.combine(value + timedelta(days=1), time.min, tzinfo=UTC)
    return int(next_day.timestamp())


def freshness_tier(age_days: NDArray[np.integer] | int) -> NDArray[np.uint8]:
    """Return the exact age-to-freshness-tier mapping from spec section 5.2.

    Tier 0 (0-3 days) through tier 3 (15+ days) select the rendered
    freshness color; they never affect opacity, which is driven by the
    snow-cover percentage alone. Tier 3 has no upper bound - an age past the
    30-day ceiling (which only occurs on STALE pixels) is still "the oldest
    tier", not a wraparound to "freshest". The -1 sentinel for "no
    observation" falls back to tier 0, which is harmless: that only occurs on
    pixels that are never VALID, so `tiles.render_rgba` always renders them
    at alpha 0 regardless of color.
    """

    age = np.asarray(age_days)
    tier = np.zeros(age.shape, dtype=np.uint8)
    tier[(age >= 4) & (age <= 7)] = 1
    tier[(age >= 8) & (age <= 14)] = 2
    tier[age >= 15] = 3
    return tier


def _validate(products: Sequence[DailyProduct]) -> tuple[int, ...]:
    if not products:
        raise ValueError("at least one product is required to establish the grid shape")

    shape = np.asarray(products[0].gf).shape
    if len(shape) != 2:
        raise ValueError(f"GFSC arrays must be two-dimensional, got shape {shape}")

    seen_dates: set[date] = set()
    for product in products:
        if product.product_date in seen_dates:
            raise ValueError(f"duplicate product date: {product.product_date.isoformat()}")
        seen_dates.add(product.product_date)

        arrays = {
            "GF": np.asarray(product.gf),
            "GF-QA": np.asarray(product.quality),
            "AT": np.asarray(product.acquisition_time),
        }
        for name, array in arrays.items():
            if array.shape != shape:
                raise ValueError(
                    f"{name} shape {array.shape} does not match expected grid shape {shape}"
                )
            if not np.issubdtype(array.dtype, np.integer):
                raise TypeError(f"{name} must contain integers, got {array.dtype}")

    return shape


def compose_as_of(products: Sequence[DailyProduct], as_of_date: date) -> AsOfComposite:
    """Apply the frozen AS-OF rule to aligned daily GFSC arrays.

    Candidates must have GF 0-100, GF-QA 0-3, a non-zero AT no later than the
    end of the AS-OF day, and age <=30 days. Selection is newest AT, then better
    quality, then newer product date. The input sequence order never affects the
    result. The newest product's water code is terminal for that pixel.
    """

    shape = _validate(products)
    eligible = [product for product in products if product.product_date <= as_of_date]

    fsc = np.full(shape, NO_VALUE, dtype=np.uint8)
    quality = np.full(shape, NO_VALUE, dtype=np.uint8)
    acquisition_time = np.zeros(shape, dtype=np.uint64)
    age_days = np.full(shape, NO_AGE, dtype=np.int32)
    source_product_day = np.full(shape, NO_PRODUCT_DAY, dtype=np.int32)
    state = np.full(shape, PixelState.NODATA, dtype=np.uint8)

    if not eligible:
        return AsOfComposite(
            as_of_date,
            fsc,
            quality,
            acquisition_time,
            age_days,
            source_product_day,
            state,
        )

    as_of_day = _unix_day(as_of_date)
    next_day_epoch = _next_day_epoch(as_of_date)
    best_at = np.zeros(shape, dtype=np.uint64)
    best_quality = np.full(shape, NO_VALUE, dtype=np.uint8)
    best_product_day = np.full(shape, NO_PRODUCT_DAY, dtype=np.int32)

    for product in eligible:
        gf = np.asarray(product.gf, dtype=np.uint64)
        qa = np.asarray(product.quality, dtype=np.uint64)
        at = np.asarray(product.acquisition_time, dtype=np.uint64)
        product_day = np.int32(_unix_day(product.product_date))

        structurally_valid = (
            (gf <= 100)
            & (qa <= 3)
            & (at > 0)
            & (at < next_day_epoch)
        )
        candidate_age = as_of_day - (at // 86_400).astype(np.int64)
        candidate = structurally_valid & (candidate_age >= 0) & (candidate_age <= MAX_AGE_DAYS)

        better = candidate & (
            (at > best_at)
            | ((at == best_at) & (qa < best_quality))
            | (
                (at == best_at)
                & (qa == best_quality)
                & (product_day > best_product_day)
            )
        )
        fsc[better] = gf[better].astype(np.uint8)
        quality[better] = qa[better].astype(np.uint8)
        best_at[better] = at[better]
        best_quality[better] = qa[better].astype(np.uint8)
        best_product_day[better] = product_day

    selected = best_product_day != NO_PRODUCT_DAY
    acquisition_time[selected] = best_at[selected]
    age_days[selected] = (
        as_of_day - (best_at[selected] // 86_400).astype(np.int64)
    ).astype(np.int32)
    source_product_day[selected] = best_product_day[selected]
    state[selected] = PixelState.VALID

    newest = max(eligible, key=lambda product: product.product_date)
    newest_gf = np.asarray(newest.gf, dtype=np.uint64)
    newest_qa = np.asarray(newest.quality, dtype=np.uint64)
    newest_at = np.asarray(newest.acquisition_time, dtype=np.uint64)
    unresolved = ~selected

    water = unresolved & (newest_gf == WATER) & (newest_qa == WATER)
    state[water] = PixelState.WATER

    cloud = unresolved & (newest_gf == CLOUD) & (newest_qa == CLOUD)
    state[cloud] = PixelState.CLOUD

    newest_value = (
        unresolved
        & (newest_gf <= 100)
        & (newest_qa <= 3)
        & (newest_at > 0)
        & (newest_at < next_day_epoch)
    )
    newest_age = as_of_day - (newest_at // 86_400).astype(np.int64)
    stale = newest_value & (newest_age > MAX_AGE_DAYS)
    state[stale] = PixelState.STALE
    acquisition_time[stale] = newest_at[stale]
    age_days[stale] = newest_age[stale].astype(np.int32)
    source_product_day[stale] = np.int32(_unix_day(newest.product_date))

    # Water is terminal even when an older valid candidate exists. Clear every
    # selected-value field so downstream code cannot accidentally analyze it.
    newest_water = (newest_gf == WATER) & (newest_qa == WATER)
    state[newest_water] = PixelState.WATER
    fsc[newest_water] = NO_VALUE
    quality[newest_water] = NO_VALUE
    acquisition_time[newest_water] = 0
    age_days[newest_water] = NO_AGE
    source_product_day[newest_water] = NO_PRODUCT_DAY

    return AsOfComposite(
        as_of_date,
        fsc,
        quality,
        acquisition_time,
        age_days,
        source_product_day,
        state,
    )
