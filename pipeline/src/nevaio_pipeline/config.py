"""Fixed geographic and rendering configuration for the MVP snow pipeline."""

from __future__ import annotations

# MGRS tiles intersecting a 60 km corridor around the Alpine arc and the
# Italian Apennine spine. The set was resolved once against Copernicus's own
# MGRS_tiles.gpkg so production discovery does not depend on a 16 MB reference
# file or on a spatial-library stack.
#
# The geometric corridor also selected four squares that HR-WSI does not
# publish at all - 33SVD, 33SXB, 33TTF and 33TUE - and they are deliberately
# excluded here. They are not a transient catalogue gap: on 2026-08-27 a direct
# listing found zero objects under GFSC/<tile>/ for every year 2016-2026, and
# likewise under FSC/, SWS/ and WDS/, while HR-WSI's own GFSC grid enumerated
# 983 tiles containing none of them. They are valid Sentinel-2 tiles - all four
# are in Copernicus's MGRS_tiles.gpkg - but they are open-sea squares
# (Tyrrhenian and Ionian), off the coast rather than on the Apennine spine, so
# HR-WSI does not produce them and no snow-relevant land is lost by dropping
# them. The same is true of every other square missing from HR-WSI's grid
# nearby (33TXG, 33TYG, 33SUA, 33SXA - all sea). Because of this, a tile
# reported missing by a run is now a real anomaly worth failing on rather than
# expected noise.
MVP_MGRS_TILES: tuple[str, ...] = (
    "31TFK", "31TFL", "31TGK", "31TGL", "31TGM",
    "32TLP", "32TLQ", "32TLR", "32TLS", "32TMP", "32TMQ", "32TMR",
    "32TMS", "32TNN", "32TNP", "32TNQ", "32TNR", "32TNS", "32TNT",
    "32TPM", "32TPN", "32TPP", "32TPQ", "32TPR", "32TPS", "32TPT",
    "32TQM", "32TQN", "32TQP", "32TQR", "32TQS", "32TQT",
    "33SWB", "33SWC", "33SWD", "33SXC", "33SXD",
    "33TTG", "33TUF", "33TUG", "33TUH", "33TUL",
    "33TUM", "33TUN", "33TVE", "33TVF", "33TVG", "33TVL", "33TVM",
    "33TVN", "33TWE", "33TWF", "33TWL", "33TWM", "33TWN", "33TXE",
    "33TXL", "33TXM",
)

# Spec section 9.2 accepts an observation whose acquisition time (AT) is at most
# 30 calendar days before the AS-OF date (raised from 14 on 2026-09-06 - see
# docs/worklog.md for the real-data measurement behind the change). A GFSC
# product's per-pixel AT is never later than its own product date, so products
# dated D-30 through D are exactly the set that can contribute a valid pixel
# for AS-OF date D - a 31-day window.
ASOF_WINDOW_DAYS = 31

PREVIEW_MIN_ZOOM = 8
PREVIEW_MAX_ZOOM = 11


# --- Input boundaries (security audit F2) ---------------------------------
#
# The renderer parses bytes chosen by an upstream catalogue, so every input
# needs a stated shape and a ceiling. These values describe GFSC as actually
# published: measured across 2320 real layer files in the 2026 reconnaissance
# archive (since deleted - see docs/worklog.md 2026-09-09), every GF,
# GF-QA and AT raster is a 1830x1830 GTiff at 60 m in a northern UTM zone, and
# the largest is 1.4 MB. The limits below are deliberately several times
# larger than observed so ordinary upstream variation does not fail a run,
# while a malformed or hostile product still cannot exhaust the runner.

# A 60 m GFSC layer covers a 109.8 km MGRS square: 1830 x 1830 pixels.
GFSC_TILE_PIXELS = 1830
GFSC_PIXEL_METRES = 60.0

# Per-object ceiling, checked against catalogue metadata before downloading and
# against the file before parsing (~12x the largest observed layer).
MAX_LAYER_BYTES = 16 * 1024 * 1024

# Whole-run download ceiling. A full window is ~58 tiles x 31 dates x 3 layers
# at under a megabyte each, so a few gigabytes is normal and this is ~3x that.
MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024 * 1024

# One product per date is kept per tile, so the window length is also the
# per-tile product ceiling.
MAX_PRODUCTS_PER_TILE = ASOF_WINDOW_DAYS
