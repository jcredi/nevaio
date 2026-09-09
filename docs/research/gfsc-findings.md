# Recon findings (running notes)

> **Historical record, Aug 2026.** The 1.5 GB sample archive and the vendored
> HR-WSI client described below were deleted on 2026-09-09, once the fallback
> overlay they existed to produce was removed. The findings still stand; the
> files do not. HR-WSI's catalogue keeps history back to 2016, so any of this is
> re-downloadable if a question needs real winter rasters again.

## 2026-08-25 - setup, before any real GFSC download

- No personal Copernicus/WEkEO/CDSE registration needed for GFSC via the HR-WSI S3
  client (`pipeline/tools/vendor/hrwsi/`). The script uses a read-only access key hardcoded
  in `s3_hrwsi_downloader.py` itself, pointing at a CloudFerro S3 endpoint
  (`s3.WAW3-2.cloudferro.com`, bucket `HRWSI`) - consistent with Copernicus's
  full/open/free data policy. Confirmed by reading the script source directly,
  not just the README.
- Client's own install docs are conda-only (`env.yaml`); all its deps
  (boto3, geopandas, pyproj, pyogrio, shapely, retry, tqdm) have PyPI wheels for
  Python 3.14 (confirmed via `pip install --dry-run`), so a venv + pip is
  fine, no conda needed. *(Aug 2026 note. The environment is now
  `pipeline/.venv` on Python 3.12, matching CI - see `pipeline/README.md`.)*
- Verified the "MGRS tile-boundary" sample point against the client's own
  `MGRS_tiles.gpkg` rather than guessing: tiles overlap by design (~10km margin),
  so a boundary point needs to fall inside the overlap of two tiles' polygons, not
  just near a visual edge. My first guess (11.95, 46.45) landed cleanly inside
  `32TQS` only - not a boundary case at all. Computed actual tile overlaps instead:
  - `32TPS` & `32TQS` overlap centered ~(11.667, 46.430)
  - `32TQS` & `33TUM` overlap centered ~(12.713, 46.431) - this one is the more
    interesting case since it's also a UTM zone 32/33 seam, not just an MGRS grid
    edge within one zone
  - Picked **(12.5, 46.6)**, near Sesto / Val Comelico in the Dolomites - confirmed
    it falls inside both `32TQS` and `33TUM`.

## 2026-08-25 - first real GFSC downloads (window: 2026-01-15 to 2026-04-15)

Downloaded all 4 sample areas via `-query_and_download`, `-wkt` boxes, `-epsg 4326`:

| Area | Tile(s) resolved | Products | Size |
|---|---|---|---|
| `ortles-cevedale-glaciers` | 32TPS | 91 | 334 MB |
| `paneveggio-forest` | 32TPS, 32TQS | 182 | 598 MB |
| `gran-sasso-apennines` | 33TUH, 33TUG | 125 | 145 MB |
| `dolomites-tile-boundary` | 33TUM, 32TQS | 182 | 508 MB |

The Dolomites query resolving to exactly `33TUM` + `32TQS` empirically confirms the tile-boundary
point computed above was correct.

### Format, resolution, projection

Each product = one MGRS/S2 tile (110x110 km, 1830x1830 px at 60m) in native UTM zone
(EPSG:326XX), delivered daily as 4 GeoTIFFs + 1 XML per date:
`AT` (uint32), `GF` (uint8), `GF-QA` (uint8), `QAFLAGS` (uint8), `_MTD.xml`.
Filename pattern: `CLMS_WSI_GFSC_060m_<TILE>_<YYYYMMDD>P7D_COMB_<VERSION>_<LAYER>`. The `P7D`
is not a typo/mystery - **confirmed from the official Product User Manual** (fetched
directly, Table 7 / p.44-48, linked from spec.md section 4.1) that it means "aggregation
duration in days retrospectively from the product date" - i.e. gap-filling looks back up to
7 days.

### Authoritative value codebook (from the PUM, not guessed)

- **GF** (the 0-100% layer) also carries non-percentage codes: `205` = cloud/cloud-shadow,
  `210` = inland water (static mask), `255` = no data.
- **GF-QA**: `0`=high, `1`=medium, `2`=low, `3`=minimal quality, plus the same `205`/`210`/`255`
  codes for cloud/water/nodata pixels.
- **QAFLAGS** (bitmask): bit0=hillshade coverage, bit1=tree-cover-density (TCD) too high
  (>90%) for accurate forest correction, bit2=snow estimated despite cloud (except high
  cloud), bit3=TCD undefined, bit4=shaded-snow via hillshade threshold, bit5-6=unused,
  **bit7=sensor type (0=optical/FSC, 1=radar/SWS)**.
- **AT**: per-pixel Unix timestamp of the actual satellite acquisition used - confirmed by
  decoding real values (e.g. `1770787121` -> 2026-02-11 05:18 UTC). This is a much finer
  freshness signal than the quality tier alone - it lets us compute real observation age per
  pixel relative to any AS-OF date, directly (spec section 5.2/9.2).
  - Explains an earlier puzzle: in the Ortles sample, `QAFLAGS=128` (bit7 set, i.e.
    radar/SWS-sourced) lined up exactly with `GF=100` pixels and nothing else - consistent
    with the PUM's statement that "wet snow pixels from SWS are considered 100% FSC for
    gap-filling purposes." Not a coincidence, not a bug - documented behavior.

### Point time series (Paneveggio forest, 11.75, 46.30, all 91 days)

Real per-day extraction at one pixel, full window - see this as the first concrete answer to
`docs/plan.md` step 4 ("what does a real time series at one point look like"):

- **Quality tier was `3` (minimal) on every single valid day, no exceptions.** Never 0/1/2.
  This one point is forested, and QAFLAGS bit1 (TCD>90%) plus the PUM's own text ("spatial
  gap filling is mainly applicable... in non-forested, non-urban... areas") suggests this
  isn't a fluke - forested terrain may systematically cap out at "minimal" quality. This
  matters a lot for former spec section 15 item 2 (quality-tier treatment): a policy of "only show
  high/medium quality" would blank out forested regions entirely, not just degrade them.
- **NODATA gaps up to 14 consecutive days** (2026-02-08 to 2026-02-21) at this single pixel -
  longer than the PUM's stated 7-day max compositing window and its "5 days under good
  conditions" claim. This is a real, observed instance of the "prolonged cloud gap" spec
  former section 15 item 4 explicitly flagged as an open decision - worth widening the historical-chart
  interpolation/carry-forward discussion around this kind of multi-week gap, not just 2-3 day
  gaps.
  - CLOUD (`205`, distinct from NODATA/`255`) also appeared in its own multi-day blocks
    (e.g. 2026-02-22 to 2026-02-27), so the two states are genuinely distinguishable in
    practice, not just in theory.
  - Where a value *was* available, only `33%` and `100%` appeared at this point (no smooth
    gradient) - plausible for one pixel's real snow accumulation/melt pattern, but shouldn't
    be generalized from a single point.

### Open follow-ups

- Haven't yet checked the glacier (Ortles) or Apennine (Gran Sasso) time series the same way -
  worth doing before finalizing the then-open AS-OF/quality rules in spec section 15.
- Haven't yet rendered/reprojected anything for the map (that's the "first real snow tile"
  convergence milestone in `docs/plan.md`, not part of this reconnaissance pass).

## 2026-08-25 - first real snow tile on the map (convergence milestone)

First time Track A and Track B met: one real GFSC product reprojected and rendered over
the MapLibre basemap. Script: `pipeline/tools/make_sample_overlay.py`. Artifacts: `app/public/snow/`.

### Picking a product: the date matters far more than the area

Scanned all 580 downloaded products (decimated reads via the built-in overviews - fast,
the whole scan is a few seconds) scoring on valid-pixel coverage and snow content:

| Area | best valid% | median valid% |
|---|---|---|
| ortles-cevedale-glaciers | 98.6 | 63.2 |
| paneveggio-forest | 98.6 | 53.3 |
| dolomites-tile-boundary | 96.0 | 49.7 |
| gran-sasso-apennines | 99.1 | 25.3 |

- **Median valid coverage is only 25-63%.** "Gap-filled" does not mean "usable everywhere,
  every day". The same tile `32TPS` is 97.2% valid on 2026-02-06 and **90.5% NODATA on
  2026-02-11**, five days later. Any AS-OF rule (spec section 5.3 / 15) has to expect that a
  large fraction of requested dates are mostly empty, and to reach back further than a
  day or two.
- Gran Sasso has the best single day but the worst median - consistent with an Apennine
  site that is simply snow-free much of the window.
- Chosen for the overlay: `CLMS_WSI_GFSC_060m_T32TPS_20260206P7D_COMB_V102`
  (Ortles-Cevedale, 6 Feb 2026): 97.2% valid, 0% nodata, 2.36% cloud, 0.42% water,
  97 distinct percentage values, mean FSC 71%. Distribution: 21.0% at 0%, 18.5% partial,
  57.7% at 100%.

### Reprojection: EPSG:3857 + a MapLibre `image` source, no tiling pipeline

MapLibre renders Web Mercator, so an axis-aligned rectangle in EPSG:3857 maps *exactly*
onto the four-corner quad an `image` source takes - the quad's UV interpolation
degenerates to the identity affine map. One PNG plus four lon/lat corners is enough; no
XYZ tiling needed to answer this milestone's questions.

- `32TPS` EPSG:32632 1830x1830 @ 60 m -> EPSG:3857 1873x1879 @ 87.07 map units.
  Ground resolution stays essentially native: 59.4 m at the north edge, 60.0 m at centre,
  60.6 m at the south edge.
- **Resampling must be nearest.** GF mixes 0-100 percentages with categorical codes, so
  bilinear would average `205` (cloud) with a snow percentage and invent a value.
- The UTM tile is slightly rotated in Mercator, so the output rectangle is 4.85% larger
  than the tile; the corners are transparent nodata. This is visible on the map as a
  tilted tile footprint - correct, not a bug.
- **Paletted PNG, not RGBA.** GF only ever holds ~103 distinct values, so the colour LUT
  *is* the palette and alpha rides in a tRNS chunk: **0.79 MB vs 2.89 MB**, byte-identical
  once the browser decodes it. Worth remembering when this becomes a real tile pipeline.

### Alignment verified numerically, not just by eye

`make_overlay.py` cross-checks two independent paths to the same pixel: the original UTM
GeoTIFF addressed via pyproj, and the shipped PNG addressed via the sidecar's EPSG:3857
bounds plus the forward Web Mercator formula (what the browser effectively does).

- All 11 landmarks pass: six 3000 m+ summits at 100%, Bolzano/Merano/Trento valley floors
  at 0%, Ortles summit correctly reported as cloud, Lago di Resia as the water code.
- 300 random in-footprint points: 263 exact (87.7%), 37 explained by sub-pixel grid jitter
  (the 60 m UTM and 87 m Mercator grids don't share pixel boundaries), **0 unexplained**.
  A real projection error would show as systematic, large disagreement; this is the
  signature of a correct warp.

### What it actually looks like - answers to the milestone's two questions

1. **Does the projection line up? Yes, convincingly.** The snow-free valley floors trace
   the Adige/Etsch through Merano - Bolzano - Trento and the Vinschgau exactly as drawn on
   the basemap. This was the point of picking a date with ~21% snow-free pixels: the
   snow/no-snow boundary is itself the alignment test.
2. **Does 60 m look reasonable?** At z8-11, yes - clearly good enough to read where snow
   is on a massif. At z13+ the 60 m pixels are plainly blocky against 100 m contour
   detail. Usable for "is this face snow-covered", too coarse to resolve an individual
   couloir or a narrow ridge - which is the concrete case spec section 15 item 10 (optional
   20 m FSCOG/FSCTOC layer) was reserved for.

### New questions this raised for the formerly open spec section 15 items

- **Snow at high opacity erased the hillshade - fixed by layer order, not by opacity.**
  First attempt put snow above landcover *and* hillshade, below contours/roads/trails/
  labels. Everything navigational stayed legible, but at 88% alpha over the 57.7% of the
  tile at 100% snow the relief vanished and the massif read as a flat white blob.
  Compared four options on the same view:
  - lowering alpha (x0.55) does bring the relief back, but snow stops reading as snow -
    it greys toward the basemap and the 50%-vs-100% distinction weakens. It trades the
    data away to fix a rendering problem.
  - moving snow *below* the hillshade layer does **not** work on this style: MapTiler
    Outdoor draws `parks` (a green fill) above `hillshade`, so the snow ends up under the
    national-park polygon and turns green. Worth knowing before trying it elsewhere.
  - adding a *second* hillshade layer above the snow works, but double-shades everywhere
    the snow isn't - the whole basemap gets noticeably more contrasty.
  - **moving the style's existing hillshade layer to sit above the snow is the answer.**
    Full snow opacity, full relief, shaded exactly once. One `map.moveLayer` call; now in
    `app/src/map/snowOverlay.ts`. Side effect: `parks` is now hillshaded too, which looks
    fine.

  Generalisable point: the "snow hides the terrain" problem is a layer-order problem, and
  spending opacity on it is the expensive fix. Max alpha stays a free parameter in the LUT
  for former section 15 item 1, but it no longer has to carry this.
- **`nearest` vs `linear` resampling is an honesty question, not a taste one.** `linear`
  looks considerably better - smooth, less blocky - but it invents sub-60 m detail the
  data doesn't have and smooths across categorical cloud boundaries. Kept `nearest`.
  Worth revisiting deliberately rather than by default.
- **Cloud grey is confusable with rock/scree shading** on the Outdoor basemap at z11.
  Section 5.4 requires cloud to be distinguishable from snow-free; against this basemap
  a neutral grey is a weak choice.
- The colour ramp used here (steel-blue -> white, alpha 0.10 -> 0.88, grey cloud,
  transparent water/nodata) is a placeholder chosen to make the overlay readable, not a
  proposal. It lives in one LUT in `make_overlay.py`.
