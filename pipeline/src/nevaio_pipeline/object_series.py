"""The ``series/<TILE>/<YYYY-MM>.bin`` per-object GFSC time series format.

``docs/plan.md`` decides the shape: object-major, a fixed 2-byte cell per
calendar day, one column per day of the month, so one object's whole month is
a single contiguous byte range - a 62-byte read for a 31-day month - at a
byte offset computed from nothing but the object's permanent slot (see
:mod:`nevaio_pipeline.object_slots`) and the day of month.

**Byte layout, per cell (2 bytes, big-picture first byte, bit-packed second):**

- Byte 0 - ``GF``: the raw GF pixel value from *that calendar day's own GFSC
  product* (not the AS-OF composite - see module docs on
  :mod:`nevaio_pipeline.object_series_sampling` for why). 0-100 is a real
  snow-fraction percentage. 205 is GFSC's own "cloud" code
  (:data:`nevaio_pipeline.asof.CLOUD`) and is stored verbatim. Any other value
  (210 water, 255 no-data, or anything else undocumented) collapses to the one
  "nothing plottable" byte, :data:`_MISSING_GF_BYTE`, which is numerically
  ``NODATA`` (255) so an unwritten cell and an explicit no-data product read
  identically - both are gaps, which is exactly how spec section 7.1 wants
  them treated.
- Byte 1 - packed: bits 0-1 are ``GF-QA`` (0-3, meaningful only when byte 0 is
  a real 0-100 value); bits 2-5 are the AT age code (0-14 real days, or 15 as
  the "not applicable" sentinel); bits 6-7 are reserved and always 0.

**Sentinel/mark rules** (this is the whole of spec section 7.1's eligibility
test, frozen into two bytes so decoding never has to re-derive it from
anything else):

- **VALID mark**: byte 0 in 0-100, QA in 0-3, age code in 0-14. This is
  exactly "GF 0-100, GF-QA 0-3, usable AT no more than 14 days before the
  product's own date" from spec 7.1 - the only case the chart may plot a
  discrete point for.
- **CLOUD**: byte 0 == 205. A gap, labelled "Cloud".
- **NO_DATA**: byte 0 is anything other than 0-100 or 205 - covers GFSC's own
  water/no-data codes, an unrecognized raw value, and a calendar day with no
  product at all (the caller never has pixel values to encode for that day,
  so it writes this sentinel directly). A gap, labelled "No data".
- **STALE**: byte 0 in 0-100 but age code == 15 - either because the real age
  exceeded the 14-day validity ceiling, or because QA or AT itself was not
  usable even though GF was present. The raw GF/QA are kept for detail views,
  but this is a gap, not a mark: the chart must not plot it. Labelled "Stale".

  *Underspecified in the plan, flagged rather than silently resolved*: spec
  7.1 only says a mark needs "GF 0-100, GF-QA 0-3, and a usable AT no more
  than 14 days before the product's own date" - it does not say what to call
  the case where GF is present but QA or AT themselves are unusable (as
  opposed to present-but-old). Folding that into STALE rather than inventing
  a fifth label was a judgment call made here, not something either the plan
  or spec 7.1 states outright.

Keeping the semantic core independent of raster I/O (repo convention): this
module imports only :mod:`numpy` and :mod:`nevaio_pipeline.asof` (itself
raster-I/O-free), so encode/decode/offset arithmetic is fully testable without
the native raster stack.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date
from enum import Enum
from typing import NamedTuple, Sequence

import numpy as np
from numpy.typing import NDArray

from .asof import CLOUD, NODATA

CELL_SIZE = 2  # bytes per object per day: [GF byte, packed GF-QA/AT-age byte]

# Spec section 7.1 caps mark validity at 14 days of AT age; ages 0-14 are 15
# distinct values, which leaves exactly one spare 4-bit code (15) to use as
# the "not applicable" sentinel - real observed ages were 0-6 days
# (docs/plan.md, measured 2026-09-11), so 15 has never collided with a real one.
MAX_VALID_AGE_DAYS = 14
_AGE_NOT_APPLICABLE = 15

# A day with no product at all reads exactly like an explicit GFSC no-data
# pixel: both are gaps, and spec 7.1 wants a gap treated honestly rather than
# specially depending on its cause.
_MISSING_GF_BYTE = int(NODATA)
NO_DATA_CELL = bytes((_MISSING_GF_BYTE, _AGE_NOT_APPLICABLE << 2))


class SeriesMarkState(Enum):
    """What one decoded cell means to the chart (spec section 7.1)."""

    VALID = "valid"
    CLOUD = "cloud"
    NO_DATA = "no_data"
    STALE = "stale"


class SeriesCell(NamedTuple):
    """A decoded cell. Only ``VALID`` (and, for detail views, ``STALE``) carry values."""

    state: SeriesMarkState
    gf: int | None
    quality: int | None
    age_days: int | None


def unix_day(value: date) -> int:
    """Days since the Unix epoch - the same unit AT is compared against."""

    return (value - date(1970, 1, 1)).days


def days_in_month(year: int, month: int) -> int:
    return monthrange(year, month)[1]


# --- Offset arithmetic ------------------------------------------------------


def object_month_range(slot_index: int, days: int) -> tuple[int, int]:
    """Return ``(start, length)`` of one object's whole month, in bytes.

    This is exactly what an HTTP Range request asks for: with a 31-day month,
    ``length`` is 62 bytes, matching the plan's own description. Object-major
    layout is what makes this contiguous - see the module docstring.

    **A range past the end of an older month file is not an error.** The offset
    depends only on this object's own slot, never on the tile's current slot
    count, and slots are append-only, so any slot allocated after a given month
    was written is necessarily beyond that month's length. A read that falls
    off the end therefore means exactly one thing: this object had no slot that
    month, because it was not in the OSM extract yet. That is genuine absence,
    and spec section 7.1 wants it drawn as a gap, not interpolated - so the
    client must read a 416 (or a short read) as no-data rather than as a
    failure, and old month files are deliberately NOT rewritten when the slot
    map grows. Decided 2026-09-12; see docs/worklog.md.
    """

    length = days * CELL_SIZE
    return slot_index * length, length


def cell_offset(slot_index: int, day_index: int, days: int) -> int:
    """Byte offset of one object's one day (``day_index`` is 0-based) within a month buffer."""

    if not 0 <= day_index < days:
        raise ValueError(f"day_index {day_index} is out of range for a {days}-day month")
    if slot_index < 0:
        raise ValueError(f"slot_index must not be negative, got {slot_index}")
    return (slot_index * days + day_index) * CELL_SIZE


def month_buffer_size(slot_count: int, days: int) -> int:
    return slot_count * days * CELL_SIZE


# --- Scalar encode/decode ----------------------------------------------------


def encode_cell(gf: int, quality: int, acquisition_time: int, product_day_epoch: int) -> bytes:
    """Encode one object's one calendar day from *that day's own* product pixel.

    Mirrors spec 7.1's mark-eligibility test exactly, so decoding never has to
    re-derive eligibility from anything but the two returned bytes. Delegates
    to the vectorized form so scalar and array paths can never disagree.
    """

    cell = encode_cells_vectorized(
        np.array([gf], dtype=np.int64),
        np.array([quality], dtype=np.int64),
        np.array([acquisition_time], dtype=np.int64),
        product_day_epoch,
    )[0]
    return bytes((int(cell[0]), int(cell[1])))


def decode_cell(cell: bytes) -> SeriesCell:
    if len(cell) != CELL_SIZE:
        raise ValueError(f"a series cell is exactly {CELL_SIZE} bytes, got {len(cell)}")
    gf_byte, packed = cell[0], cell[1]
    quality = packed & 0b11
    age_code = (packed >> 2) & 0b1111

    if gf_byte == CLOUD:
        return SeriesCell(SeriesMarkState.CLOUD, None, None, None)
    if not (0 <= gf_byte <= 100):
        return SeriesCell(SeriesMarkState.NO_DATA, None, None, None)
    if age_code == _AGE_NOT_APPLICABLE:
        return SeriesCell(SeriesMarkState.STALE, gf_byte, quality, None)
    return SeriesCell(SeriesMarkState.VALID, gf_byte, quality, age_code)


# --- Vectorized encode (the sampling hot path) ------------------------------


def encode_cells_vectorized(
    gf: NDArray[np.integer] | Sequence[int],
    quality: NDArray[np.integer] | Sequence[int],
    acquisition_time: NDArray[np.integer] | Sequence[int],
    product_day_epoch: int,
) -> NDArray[np.uint8]:
    """Vectorized :func:`encode_cell`. Returns an ``(N, 2)`` uint8 array.

    One boolean-mask pass per rule, mirroring ``nevaio_pipeline.asof``'s own
    style - no per-object Python loop, which is what keeps sampling an entire
    tile's worth of objects for one product date a single fancy-index
    operation rather than 7,878 function calls.
    """

    gf_arr = np.asarray(gf, dtype=np.int64)
    quality_arr = np.asarray(quality, dtype=np.int64)
    at_arr = np.asarray(acquisition_time, dtype=np.int64)
    if not (gf_arr.shape == quality_arr.shape == at_arr.shape):
        raise ValueError("gf, quality, and acquisition_time must share one shape")

    gf_byte = np.full(gf_arr.shape, _MISSING_GF_BYTE, dtype=np.uint8)
    age_code = np.full(gf_arr.shape, _AGE_NOT_APPLICABLE, dtype=np.uint8)
    quality_field = np.zeros(gf_arr.shape, dtype=np.uint8)

    cloud = gf_arr == CLOUD
    gf_byte[cloud] = CLOUD

    in_range = (gf_arr >= 0) & (gf_arr <= 100)
    gf_byte[in_range] = gf_arr[in_range].astype(np.uint8)

    certified = in_range & (quality_arr >= 0) & (quality_arr <= 3) & (at_arr > 0)
    quality_field[certified] = quality_arr[certified].astype(np.uint8)

    age = product_day_epoch - (at_arr // 86_400)
    plottable = certified & (age >= 0) & (age <= MAX_VALID_AGE_DAYS)
    age_code[plottable] = age[plottable].astype(np.uint8)

    packed = (age_code << 2) | quality_field
    return np.stack([gf_byte, packed], axis=-1)


# --- Byte-buffer month storage -----------------------------------------------


def new_month_buffer(slot_count: int, year: int, month: int) -> bytearray:
    """A fresh month buffer with every cell starting as :data:`NO_DATA_CELL`.

    All-zero bytes would decode as GF=0 (a real, and wrong, "0% snow cover"
    value); every unwritten cell must instead decode as a gap.
    """

    days = days_in_month(year, month)
    return bytearray(NO_DATA_CELL * (slot_count * days))


def read_cell(buffer: bytes, slot_index: int, day_index: int, days: int) -> SeriesCell:
    offset = cell_offset(slot_index, day_index, days)
    return decode_cell(bytes(buffer[offset : offset + CELL_SIZE]))


def write_cell(buffer: bytearray, slot_index: int, day_index: int, days: int, cell: bytes) -> None:
    if len(cell) != CELL_SIZE:
        raise ValueError(f"a series cell is exactly {CELL_SIZE} bytes, got {len(cell)}")
    offset = cell_offset(slot_index, day_index, days)
    buffer[offset : offset + CELL_SIZE] = cell


# --- Array-shaped month storage (the sampling hot path) ---------------------
#
# Reshaping the flat buffer to (slots, days, CELL_SIZE) in C order is exactly
# the object-major layout the offset formula above describes: slot varies
# slowest, then day, then the two bytes of a cell - so `array.tobytes()` and
# the byte-buffer functions above always agree on where a given cell lives.


def _blank_array(slot_count: int, days: int) -> NDArray[np.uint8]:
    array = np.empty((slot_count, days, CELL_SIZE), dtype=np.uint8)
    array[..., 0] = _MISSING_GF_BYTE
    array[..., 1] = _AGE_NOT_APPLICABLE << 2
    return array


def new_month_array(slot_count: int, year: int, month: int) -> NDArray[np.uint8]:
    return _blank_array(slot_count, days_in_month(year, month))


def array_from_buffer(buffer: bytes, slot_count: int, days: int) -> NDArray[np.uint8]:
    expected = month_buffer_size(slot_count, days)
    if len(buffer) != expected:
        raise ValueError(
            f"buffer is {len(buffer)} bytes, expected {expected} for {slot_count} slot(s) x {days} day(s)"
        )
    return np.frombuffer(buffer, dtype=np.uint8).reshape(slot_count, days, CELL_SIZE).copy()


def buffer_from_array(array: NDArray[np.uint8]) -> bytes:
    return array.tobytes()


def grow_month_array(array: NDArray[np.uint8], new_slot_count: int) -> NDArray[np.uint8]:
    """Append newly assigned slots to the end - never move an existing row.

    Object-major layout means growing the slot count only appends whole
    per-object blocks at the end; no existing object's bytes move, which is
    what makes an append-only slot map (:mod:`nevaio_pipeline.object_slots`)
    actually cheap to honor here.
    """

    old_slot_count, days, _ = array.shape
    if new_slot_count < old_slot_count:
        raise ValueError(f"slot count may only grow: {old_slot_count} -> {new_slot_count}")
    if new_slot_count == old_slot_count:
        return array
    addition = _blank_array(new_slot_count - old_slot_count, days)
    return np.concatenate([array, addition], axis=0)
