"""Encode an AS-OF composite as a lossless *data* tile pyramid.

This is the second tile pyramid, published beside the visual one that
``tiles.py`` writes, and it exists because the visual one deliberately cannot
answer the question a route profile asks. From docs/spec.md section 5.4:

    A valid 0% pixel is *not* distinguishable from these on the map raster
    (both are fully transparent ...) - only point/object details and the
    historical chart tell them apart.

For the map that is the right call. For "is there snow along this route", the
difference between *no snow* and *no observation* is the entire question, and
the QA tier spec section 15 item 11 requires is not in the visual encoding at
all. So this module encodes values rather than appearance. The reasoning, the
alternatives, and the measured storage cost are in
``docs/research/snow-along-route.md``.

**The wire format** - one RGBA PNG per tile, mirrored by the frontend decoder
in ``app/src/features/route/snowDataTile.ts``. Both sides must change together:

===== ====================================================================
R      GF value 0-100, or ``NO_VALUE`` (255) where the state is not VALID
G      observation age in days 0-``MAX_AGE_DAYS``, or ``AGE_NOT_APPLICABLE``
B      bits 0-1: QA tier 0-3.  bits 2-4: state (see ``DataState``)
A      always ``ALPHA_OPAQUE`` (255) - never a data channel, see below
===== ====================================================================

**Alpha is a constant 255 and must stay one.** A browser reads these pixels
with canvas ``getImageData``, which returns colour channels that have been
premultiplied by alpha and then un-premultiplied. Any alpha below 255 therefore
corrupts the other three channels by rounding - silently, with no error, and
worst at low alpha. Using alpha as a fourth data field would produce snow
values that are quietly wrong. This is the single easiest way to break this
format.

**Why the warp goes through an index raster.** ``tiles.py`` warps its four
colour bands directly, relying on a documented property of the visual encoding:
an all-zero pixel is impossible there, so 0 can double as GDAL's nodata
sentinel. That property does not hold here - ``GF = 0`` means *zero percent
snow*, which is a real, common and important value, and ``state = VALID``,
``QA = 0`` and ``age = 0`` are all legitimate zeros too. Warping these bands
with ``nodata=0`` would either drop genuine 0% pixels or bump them to 1%.
So this module warps a raster of *source pixel indices* instead, where -1 is
genuinely impossible, and then looks the encoded values up. That also makes the
four channels provably consistent with each other, since one nearest-neighbour
decision is made per destination pixel rather than four independent ones.
"""

from __future__ import annotations

from enum import IntEnum
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image
from rasterio.warp import Resampling, reproject

from .asof import AsOfComposite, PixelState
from .raster_io import RasterGrid
from .tiles import TILE_SIZE, _tile_range, _tile_transform

#: Sentinel in the R channel: this pixel carries no snow percentage.
NO_VALUE = 255
#: Sentinel in the G channel: this pixel has no meaningful observation age.
AGE_NOT_APPLICABLE = 255
#: Largest age the AS-OF rule can produce (spec section 9.2 searches 30 days back).
MAX_AGE_DAYS = 30
#: Alpha is never a data channel - see the module docstring.
ALPHA_OPAQUE = 255


class DataState(IntEnum):
    """State codes as packed into bits 2-4 of the B channel.

    Deliberately a small dense enum rather than ``PixelState``'s raw GFSC
    category codes (205, 210, 254, 255): those do not fit in three bits, and the
    wire format is a contract with the frontend rather than a mirror of the
    source product's numbering.
    """

    VALID = 0
    CLOUD = 1
    WATER = 2
    NO_DATA = 3
    STALE = 4


_STATE_FROM_PIXEL = {
    PixelState.VALID: DataState.VALID,
    PixelState.CLOUD: DataState.CLOUD,
    PixelState.WATER: DataState.WATER,
    PixelState.STALE: DataState.STALE,
    PixelState.NODATA: DataState.NO_DATA,
}


def pack_quality_and_state(quality: NDArray[np.uint8], state: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """Pack QA tier (bits 0-1) and :class:`DataState` (bits 2-4) into one byte."""

    # Quality is 255 wherever the state is not VALID (AsOfComposite's own
    # convention); that would overflow two bits, so it is clamped to 0 there.
    # The state byte already says the value is not a reading, so a QA tier
    # would be meaningless rather than merely unknown.
    tier = np.where(quality <= 3, quality, 0).astype(np.uint8)

    packed_state = np.full(state.shape, int(DataState.NO_DATA), dtype=np.uint8)
    for pixel_state, data_state in _STATE_FROM_PIXEL.items():
        packed_state[state == int(pixel_state)] = int(data_state)

    return (tier | (packed_state << 2)).astype(np.uint8)


def encode_data_rgba(composite: AsOfComposite) -> NDArray[np.uint8]:
    """Encode a composite's semantic fields into the RGBA wire format.

    Lossless for everything the route profile needs: the percentage, the state,
    the quality tier and the observation age. Nothing here is thresholded,
    hidden or attenuated - that is the visual encoding's job, not this one's.
    """

    fsc = composite.fsc
    # A percentage only where there is one. Every non-VALID state carries 255 in
    # `fsc` already (AsOfComposite's convention), which is exactly NO_VALUE, but
    # this is asserted rather than assumed: a stale pixel keeps a raw fsc for
    # detail views, and it must not be published here as if it were current.
    red = np.where(composite.fsc <= 100, fsc, NO_VALUE).astype(np.uint8)
    red = np.where(composite.state == int(PixelState.VALID), red, NO_VALUE).astype(np.uint8)

    age = composite.age_days
    green = np.where(
        (age >= 0) & (age <= MAX_AGE_DAYS),
        np.clip(age, 0, MAX_AGE_DAYS),
        AGE_NOT_APPLICABLE,
    ).astype(np.uint8)

    blue = pack_quality_and_state(composite.quality, composite.state)
    alpha = np.full(fsc.shape, ALPHA_OPAQUE, dtype=np.uint8)
    return np.dstack([red, green, blue, alpha])


def no_value_pixel() -> NDArray[np.uint8]:
    """The four bytes meaning "outside the footprint, nothing known here"."""

    return np.array(
        [NO_VALUE, AGE_NOT_APPLICABLE, int(DataState.NO_DATA) << 2, ALPHA_OPAQUE],
        dtype=np.uint8,
    )


def _warp_indices(grid: RasterGrid, z: int, x: int, y: int) -> NDArray[np.int32] | None:
    """Nearest source pixel index for every pixel of one tile, or None if empty.

    -1 means "no source pixel maps here". See the module docstring for why this
    goes through indices rather than warping the encoded bands.
    """

    source = np.arange(grid.height * grid.width, dtype=np.int32).reshape(grid.height, grid.width)
    destination = np.full((TILE_SIZE, TILE_SIZE), -1, dtype=np.int32)
    dst_transform, _ = _tile_transform(z, x, y)
    reproject(
        source=source,
        destination=destination,
        src_transform=grid.transform,
        src_crs=grid.crs,
        # No source pixel is ever -1, so this marks nothing as nodata on the way
        # in; on the way out it keeps untouched destination pixels at -1.
        src_nodata=-1,
        dst_transform=dst_transform,
        dst_crs="EPSG:3857",
        dst_nodata=-1,
        resampling=Resampling.nearest,
    )
    if not (destination >= 0).any():
        return None
    return destination


def write_data_tiles(
    composite: AsOfComposite,
    grid: RasterGrid,
    zoom: int,
    out_dir: Path,
) -> list[Path]:
    """Write one composite as a single-zoom data tile set under ``out_dir``.

    One zoom only, deliberately: ``zoom`` is expected to be the pyramid's max
    (11), which at this footprint's latitude is about 53 m/px against GFSC's
    60 m native pixel - so it already *is* native resolution and a coarser level
    would throw away data while a finer one would invent it. The frontend reads
    the one to four tiles a route crosses; it never renders these.

    Tiles with no source coverage at all are skipped, exactly as the visual
    pyramid skips fully transparent ones.
    """

    encoded = encode_data_rgba(composite).reshape(-1, 4)
    blank = no_value_pixel()
    written: list[Path] = []

    x_range, y_range = _tile_range(grid, zoom)
    for x in x_range:
        for y in y_range:
            indices = _warp_indices(grid, zoom, x, y)
            if indices is None:
                continue
            covered = indices >= 0
            tile = np.empty((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
            tile[...] = blank
            tile[covered] = encoded[indices[covered]]

            path = out_dir / str(zoom) / str(x) / f"{y}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            # optimize=True only changes the deflate effort, never the pixels -
            # this format would be worthless if a lossy save were possible, so
            # the mode is pinned to RGBA and the format to PNG explicitly.
            Image.fromarray(tile, mode="RGBA").save(path, format="PNG", optimize=True)
            written.append(path)
    return written
