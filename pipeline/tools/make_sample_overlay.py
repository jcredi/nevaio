"""Turn one GFSC GF.tif into a web-map overlay the app/ MapLibre map can render.

Why this shape (see docs/plan.md "Converge: first real snow tile"):

GFSC ships one GeoTIFF per MGRS tile in native UTM (EPSG:326XX), 1830x1830 at
60 m. MapLibre renders Web Mercator. Reprojecting to EPSG:3857 gives an
axis-aligned rectangle there, which maps *exactly* onto the four-corner quad a
MapLibre `image` source takes - so a single PNG plus four lon/lat corners is
enough. No tiling pipeline needed to answer this milestone's questions.

Outputs two files into app/public/snow/:
  <name>.png   - RGBA, EPSG:3857, ready for a MapLibre image source
  <name>.json  - corner coordinates + provenance + coverage stats

Then verifies itself: samples the original UTM GeoTIFF and the shipped PNG at
the same lon/lat by two independent code paths and checks they agree.

DEVELOPER TOOL, not part of the published pipeline. It generates the archived
sample overlay the frontend falls back to when the live snapshot manifest is
unavailable, and it is the only thing that regenerates that committed asset.
Everything worth carrying into the real pipeline already has: the value
codebook, nearest-neighbour warping to EPSG:3857 at native resolution, the
paletted-PNG encoding and the two-independent-paths alignment check.

Deliberately still GF-only, so it has no AT-based observation-age multiplier -
that difference from the production encoding is intentional and is recorded in
docs/spec.md section 5.2. Do not "fix" it here.

Usage:
    pipeline/.venv/bin/python pipeline/tools/make_sample_overlay.py \
        [--input path/to/..._GF.tif] [--output-dir app/public/snow]
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.warp import Resampling, calculate_default_transform, reproject

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO / "app" / "public" / "snow"

# Ortles-Cevedale, 6 Feb 2026. Picked by scanning all 580 downloaded products:
# 97.2% valid, 0% nodata, 97 distinct percentage values, and ~21% snow-free
# valley floor - the snow/no-snow boundary should trace the valleys on the
# basemap, which is what makes this a usable alignment test.
DEFAULT_GF = (
    REPO
    / "data/research/ortles-cevedale-glaciers/result"
    / "CLMS_WSI_GFSC_060m_T32TPS_20260206P7D_COMB_V102"
    / "CLMS_WSI_GFSC_060m_T32TPS_20260206P7D_COMB_V102_GF.tif"
)

# GF non-percentage codes, from the Product User Manual - see
# docs/research/gfsc-findings.md.
CLOUD, WATER, NODATA = 205, 210, 255

WEB_MERCATOR_R = 6378137.0


def build_lut() -> np.ndarray:
    """256x4 uint8 RGBA lookup table, indexed by raw GF value.

    This is the base coverage ramp frozen in spec.md section 5.2. The real
    pipeline must additionally multiply alpha by the selected observation's
    AT-based freshness factor; this GF-only reconnaissance artifact cannot.
    0% keeps a faint but non-zero alpha so "measured snow-free" stays visually
    distinct from "no data" (spec.md section 5.4).
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    f = np.linspace(0.0, 1.0, 101)
    stops = [0.0, 0.5, 1.0]
    lut[0:101, 0] = np.round(np.interp(f, stops, [130, 200, 255]))  # steel blue
    lut[0:101, 1] = np.round(np.interp(f, stops, [160, 222, 255]))  #   -> white
    lut[0:101, 2] = np.round(np.interp(f, stops, [190, 240, 255]))
    lut[0:101, 3] = np.round(np.interp(f, stops, [26, 150, 224]))  # a 0.10->0.88

    lut[CLOUD] = (168, 85, 247, 115)  # violet, fixed alpha 0.45
    lut[WATER] = (0, 0, 0, 0)  # static mask; basemap already draws water
    lut[NODATA] = (0, 0, 0, 0)  # absence, not zero
    return lut


def lonlat_to_mercator(lon: float, lat: float) -> tuple[float, float]:
    """Forward EPSG:4326 -> EPSG:3857, i.e. what MapLibre does to place a point."""
    x = WEB_MERCATOR_R * math.radians(lon)
    y = WEB_MERCATOR_R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def warp_to_web_mercator(src_path: Path):
    """Reproject band 1 to EPSG:3857 at ~native resolution.

    Resampling MUST be nearest: GF mixes 0-100 percentages with categorical
    codes (205/210/255), so any averaging kernel would invent values - e.g.
    blending cloud with snow into a plausible-looking percentage.
    """
    with rasterio.open(src_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, "EPSG:3857", src.width, src.height, *src.bounds
        )
        dst = np.full((height, width), NODATA, dtype=np.uint8)
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=NODATA,
            dst_transform=transform,
            dst_crs="EPSG:3857",
            dst_nodata=NODATA,
            resampling=Resampling.nearest,
        )
        src_meta = {"crs": str(src.crs), "res": src.res[0], "size": [src.width, src.height]}
        src_arr = src.read(1)
    return dst, transform, width, height, src_meta, src_arr


def coverage_stats(arr: np.ndarray) -> dict:
    total = arr.size
    valid = arr <= 100
    pct = lambda mask: round(100.0 * int(np.count_nonzero(mask)) / total, 2)  # noqa: E731
    return {
        "validPct": pct(valid),
        "snowFreePct": pct(arr == 0),
        "partialPct": pct(valid & (arr > 0) & (arr < 100)),
        "fullSnowPct": pct(arr == 100),
        "cloudPct": pct(arr == CLOUD),
        "waterPct": pct(arr == WATER),
        "noDataPct": pct(arr == NODATA),
        "meanFscOfValid": round(float(arr[valid].mean()), 1) if valid.any() else None,
    }


def show(path: Path) -> str:
    """Repo-relative where possible - --input may point anywhere."""
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--input", type=Path, default=DEFAULT_GF,
        help="GFSC ..._GF.tif to render (default: the Ortles-Cevedale sample "
             "under data/research/, which is gitignored and may not be present)",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=DEFAULT_OUT_DIR,
        help="directory to write the .png and .json into "
             "(default: app/public/snow, the committed fallback asset)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    src_path = args.input.resolve()
    out_dir = args.output_dir.resolve()
    if not src_path.exists():
        print(f"error: no such file: {src_path}", file=sys.stderr)
        return 1

    product = src_path.name.removesuffix("_GF.tif")
    m = re.search(r"_T(\w{5})_(\d{4})(\d{2})(\d{2})P7D", product)
    if not m:
        print(f"error: cannot parse tile/date from {product}", file=sys.stderr)
        return 1
    tile, yyyy, mm, dd = m.group(1), m.group(2), m.group(3), m.group(4)
    date = f"{yyyy}-{mm}-{dd}"
    stem = f"gfsc_{tile}_{yyyy}{mm}{dd}"

    print(f"source : {show(src_path)}")
    dst, transform, width, height, src_meta, src_arr = warp_to_web_mercator(src_path)
    print(f"warped : {src_meta['crs']} {src_meta['size'][0]}x{src_meta['size'][1]} "
          f"@ {src_meta['res']:.0f} m  ->  EPSG:3857 {width}x{height} @ {transform.a:.2f} units")

    # EPSG:3857 is metres-at-the-equator; ground resolution shrinks with latitude.
    left, top = transform.c, transform.f
    right, bottom = transform * (width, height)
    to_wgs84 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    (west, north), (east, south) = to_wgs84.transform(left, top), to_wgs84.transform(right, bottom)
    for label, lat in (("N edge", north), ("centre", (north + south) / 2), ("S edge", south)):
        print(f"         ground res at {label} ({lat:.2f}N): "
              f"{transform.a * math.cos(math.radians(lat)):.1f} m")

    lut = build_lut()
    out_dir.mkdir(parents=True, exist_ok=True)
    png_path = out_dir / f"{stem}.png"
    # Paletted rather than RGBA: GF only ever holds ~103 distinct values, so the
    # LUT *is* the palette and alpha rides along in a tRNS chunk. Byte-identical
    # to the RGBA encoding once the browser decodes it, at ~1/4 the size
    # (0.79 MB vs 2.89 MB) - worth it for a mobile-first app.
    paletted = Image.fromarray(dst, mode="P")
    paletted.putpalette(lut[:, :3].tobytes())
    paletted.save(png_path, optimize=True, transparency=lut[:, 3].tobytes())

    # Stats describe the product itself. The output rectangle is deliberately
    # larger - the UTM tile is slightly rotated in Mercator, so its corners are
    # padded with nodata - and that padding would otherwise pollute the numbers.
    stats = coverage_stats(src_arr)
    padding_pct = round(100.0 * float(np.count_nonzero(dst == NODATA) - np.count_nonzero(src_arr == NODATA)) / dst.size, 2)
    sidecar = {
        "image": png_path.name,
        "product": product,
        "tile": tile,
        "date": date,
        "layer": "GF",
        "sourceCrs": src_meta["crs"],
        "sourceResolutionMeters": src_meta["res"],
        "renderCrs": "EPSG:3857",
        "size": [width, height],
        # MapLibre image-source order: top-left, top-right, bottom-right, bottom-left.
        "coordinates": [[west, north], [east, north], [east, south], [west, south]],
        "bounds": [west, south, east, north],
        "bounds3857": [left, bottom, right, top],
        "coverage": stats,
        "outputPaddingPct": padding_pct,
        "note": (
            "Generated by pipeline/tools/make_sample_overlay.py. Base coverage "
            "ramp is frozen "
            "in docs/spec.md section 5.2; this GF-only artifact has no AT-based "
            "freshness multiplier."
        ),
    }
    json_path = out_dir / f"{stem}.json"
    json_path.write_text(json.dumps(sidecar, indent=2) + "\n")

    print(f"\nwrote  : {show(png_path)}  ({png_path.stat().st_size / 1e6:.2f} MB)")
    print(f"         {show(json_path)}")
    print(f"\ncoverage of the product ({tile}, {date}):")
    for k, v in stats.items():
        print(f"  {k:16} {v}")
    print(f"  {'(warp padding)':16} {padding_pct}% of the output rectangle "
          f"falls outside the rotated UTM tile")

    return check_alignment(src_path, png_path, sidecar, lut)


# --------------------------------------------------------------------------
# Alignment check
# --------------------------------------------------------------------------

# Landmarks inside tile 32TPS, with what a 6 Feb 2026 snow map should show.
# Chosen against the real raster, so these are assertions, not aspirations:
# Ortles and Similaun really are under cloud on this date, and the water-mask
# blobs really are where Lago di Resia is.
def pct_between(lo: int, hi: int):
    """Predicate on a *valid* percentage - the codes 205/210/255 never satisfy it."""
    return lambda v: v <= 100 and lo <= v <= hi


LANDMARKS = [
    ("Gran Zebru summit (3851 m)", 10.5833, 46.4933, "snow >=75%", pct_between(75, 100)),
    ("Cevedale summit (3769 m)", 10.6161, 46.4517, "snow >=75%", pct_between(75, 100)),
    ("Palla Bianca summit (3739 m)", 10.6864, 46.8000, "snow >=75%", pct_between(75, 100)),
    ("Presanella summit (3558 m)", 10.6667, 46.2333, "snow >=75%", pct_between(75, 100)),
    ("Adamello summit (3539 m)", 10.4956, 46.1594, "snow >=75%", pct_between(75, 100)),
    ("Cima Tosa, Brenta (3136 m)", 10.8797, 46.1653, "snow >=75%", pct_between(75, 100)),
    ("Bolzano centre (262 m)", 11.3548, 46.4983, "bare <=25%", pct_between(0, 25)),
    ("Merano centre (325 m)", 11.1600, 46.6700, "bare <=25%", pct_between(0, 25)),
    ("Trento centre (194 m)", 11.1167, 46.0667, "bare <=25%", pct_between(0, 25)),
    ("Ortles summit (3905 m)", 10.5449, 46.5089, "cloud", lambda v: v == CLOUD),
    ("Lago di Resia reservoir", 10.5305, 46.8054, "water", lambda v: v == WATER),
]


def sample_source(src_ds, arr, lon, lat, to_src):
    """Path A: original UTM GeoTIFF, addressed via pyproj."""
    x, y = to_src.transform(lon, lat)
    row, col = src_ds.index(x, y)
    if not (0 <= row < arr.shape[0] and 0 <= col < arr.shape[1]):
        return None, None
    return int(arr[row, col]), (row, col)


def sample_png(png, sidecar, lon, lat):
    """Path B: shipped PNG, addressed the way the browser will address it -
    forward Web Mercator, then linear interpolation across the sidecar bounds."""
    x, y = lonlat_to_mercator(lon, lat)
    w, s, e, n = sidecar["bounds3857"]
    width, height = sidecar["size"]
    col = int((x - w) / (e - w) * width)
    row = int((n - y) / (n - s) * height)
    if not (0 <= row < height and 0 <= col < width):
        return None
    return tuple(int(c) for c in png[row, col])


def check_alignment(src_path: Path, png_path: Path, sidecar: dict, lut: np.ndarray) -> int:
    """Cross-check two independent lon/lat -> pixel paths.

    If the reprojection or the corner coordinates were wrong, these would
    disagree systematically. Sub-pixel disagreement is expected and fine: the
    60 m UTM grid and the 87 m Mercator grid don't share pixel boundaries, so a
    point near an edge can legitimately fall either side.
    """
    print("\nalignment check - original GeoTIFF (UTM, via pyproj) vs shipped PNG "
          "(3857, via sidecar):")
    png = np.array(Image.open(png_path).convert("RGBA"))

    with rasterio.open(src_path) as src_ds:
        arr = src_ds.read(1)
        to_src = Transformer.from_crs("EPSG:4326", src_ds.crs, always_xy=True)

        print(f"\n  {'landmark':30} {'expected':11} {'GeoTIFF':>8}  {'PNG rgba':>20}  result")
        failures = 0
        for name, lon, lat, expect, ok in LANDMARKS:
            value, _ = sample_source(src_ds, arr, lon, lat, to_src)
            rgba = sample_png(png, sidecar, lon, lat)
            if value is None or rgba is None:
                print(f"  {name:30} {expect:11} {'OUTSIDE TILE':>8}")
                failures += 1
                continue
            # Two things must hold: the value is what this place should show
            # (proves we are reading the right place at all), and the PNG shows
            # the colour that value maps to (proves the two paths agree).
            plausible, agree = ok(value), tuple(int(c) for c in lut[value]) == rgba
            failures += not (plausible and agree)
            shown = {CLOUD: "cloud", WATER: "water", NODATA: "nodata"}.get(value, f"{value}%")
            mark = ("ok" if agree else "PNG MISMATCH") if plausible else "UNEXPECTED VALUE"
            print(f"  {name:30} {expect:11} {shown:>8}  {str(rgba):>20}  {mark}")

        # Statistical pass: random points across the footprint.
        rng = np.random.default_rng(0)
        w, s, e, n = sidecar["bounds"]
        exact = near = tested = 0
        while tested < 300:
            lon = rng.uniform(w, e)
            lat = rng.uniform(s, n)
            value, rc = sample_source(src_ds, arr, lon, lat, to_src)
            rgba = sample_png(png, sidecar, lon, lat)
            if value is None or rgba is None or value == NODATA:
                continue  # corners of the Mercator rectangle fall outside the UTM tile
            tested += 1
            if tuple(int(c) for c in lut[value]) == rgba:
                exact += 1
            else:
                # Sub-pixel jitter, or a real offset? Check the 3x3 neighbourhood.
                r0, c0 = rc
                block = arr[max(r0 - 1, 0):r0 + 2, max(c0 - 1, 0):c0 + 2]
                near += any(tuple(int(x) for x in lut[v]) == rgba for v in np.unique(block))

    print(f"\n  random points: {tested} tested, {exact} exact ({100 * exact / tested:.1f}%), "
          f"{near} within one source pixel, {tested - exact - near} unexplained")

    unexplained = tested - exact - near
    if failures or unexplained:
        print(f"\n  FAILED: {failures} landmark issue(s), {unexplained} unexplained mismatch(es)")
        return 1
    print("\n  PASSED: georeferencing is consistent end to end.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
