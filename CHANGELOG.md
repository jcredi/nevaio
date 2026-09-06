# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioned from `0.1.0` (2026-08-25), the first deploy.

## [Unreleased]

### Added
- Place search (spec section 6.1): a floating search bar
  (`app/src/ui/searchBar.ts`) supporting search by name (Nominatim, decided
  for MVP - spec section 15 item 5) and by coordinates
  (`app/src/search/coordinates.ts`, decimal degrees, resolved client-side
  with no network call). Selecting a result flies the map to it and drops a
  marker. See `docs/worklog.md` (2026-09-06).
- Search results show a small type icon (peak, hut/shelter, pass, camp site,
  trail, parking, settlement, or a generic pin) derived from Nominatim's
  `category`/`type` fields.
- Snow-layer legend (`app/src/ui/snowControl.ts`): explains both visual
  channels from spec section 5.2 - a coverage gradient bar and four
  freshness-tier color swatches (0-3d through 15-30d).

### Fixed
- `app/src/search/nominatim.ts` read a `class` field that doesn't exist in
  Nominatim's `jsonv2` response (it's `category`) - always `undefined`,
  silently, since nothing rendered it until the type-icon feature above.

### Changed
- Replace Mint to Amethyst with Sky to Indigo for snow observation age, improving separation from green topo terrain. Age bands and coverage opacity are unchanged; 953 raster tiles regenerated and published for the same 2026-09-06 observations.
- **Snow-layer visual encoding (spec 5.2/5.4, amended 2026-09-06):** opacity
  and color are now independent channels instead of one combined alpha.
  Opacity encodes snow-cover percentage alone (linear 0-255, no floor at 0%);
  color encodes freshness alone, as 4 discrete tiers from mint (0-3 days) to
  amethyst (15-30 days), chosen from 6 candidate ramps rendered on real
  winter data. Cloud no longer gets a distinct violet indicator - it renders
  fully transparent, the same as water/stale/no-data (the distinction
  survives in point/object details and the historical chart, not the map
  raster). `pipeline/tiles.py`'s `render_rgba` was rewritten accordingly;
  `AsOfComposite.freshness` (a stored multiplier) was removed in favor of
  computing the freshness tier from `age_days` at render time.
- **AS-OF age ceiling raised from 14 to 30 days** (`pipeline/asof.py`
  `MAX_AGE_DAYS`, `pipeline/config.py` `ASOF_WINDOW_DAYS` 15->31), measured on
  real winter data first: the gain is concentrated in multi-week cloudy
  spells (up to +59 percentage points of valid coverage on one sampled
  tile-date), negligible on ordinary days. See `docs/worklog.md` (2026-09-06).

### Fixed
- `app/src/map/config.ts` `initialView.zoom` raised from `6.3` to `8.3`. The
  snow tile pyramid starts at `PREVIEW_MIN_ZOOM = 8`
  (`pipeline/config.py`), so a first-time visitor previously saw the "Snow
  cover" control checked and no snow layer at all until zooming in - 22 of 24
  first-load requests were basemap tiles and none were snow tiles. See
  `docs/worklog.md` (2026-09-06).

### Changed
- The published snow map now applies the **full spec section 9.2 AS-OF rule**
  instead of one newest product per MGRS tile: `pipeline/preview.py` composes
  every complete GFSC product in the 15-day window (`ASOF_WINDOW_DAYS`) so
  `pipeline/asof.py` can pick, per pixel, the newest valid acquisition. On
  real winter data this recovers 23-74 percentage points of valid coverage on
  4 of 6 sampled tile-dates, and correctly recovers nothing during genuinely
  cloudy multi-day spells. Manifest `mode` is now `asof-window` (was
  `latest-product-only-preview`) and carries `asOfWindowDays`,
  `sourceProductCounts` and `sourceProductTotal`.
- `.github/workflows/publish-latest-preview.yml` runs **daily at `04:35 UTC`**
  rather than manual dispatch only, matched to HR-WSI's measured strictly-daily
  cadence and `D+1 00:15-03:00 UTC` publication latency.
- `MVP_MGRS_TILES` is 58 tiles, not 62. `33SVD`, `33SXB`, `33TTF` and `33TUE`
  are absent from HR-WSI's own 983-tile GFSC grid for every year 2016-2026 -
  all four are open-sea squares the service never produces - so they were
  never a transient catalogue gap. A tile missing from a run is therefore now
  a real anomaly, and `build_preview` fails rather than publishing a partial
  map (`--max-missing-tiles`, default 0), leaving the previous `latest.json`
  in place.

### Added
- R2 retention: `publish.py` can prune all but the newest N runs
  (`--keep-runs`, set to 7 in the workflow), always after the `latest.json`
  pointer has moved and never for the run just published. A daily schedule
  needs this - a mid-winter full-area run is roughly 130 MB, against 14 MB in
  near-snowless August, so unbounded daily retention would pass R2's 10 GB
  free tier within one season.
- `select_window_products` / `discover_window_products` in `pipeline/fetch.py`,
  returning each tile's whole AS-OF window (one product per date, greatest
  processing version). Ten new tests, bringing the pipeline suite to 51.
- `npm run verify` (`app/scripts/verify-snapshot.mjs`) drives a real browser
  against the deployed site by default, reporting the served manifest, the
  snow control's user-visible text, and any failed manifest/tile request, then
  capturing the same five regions every run so two publishes can be compared
  directly. The existing `npm run shot` remains the local-dev camera script.

### Fixed
- `publish.py` uploads a run's objects concurrently instead of one at a time;
  a full-area run is ~3,500 objects and was taking over ten minutes. Still a
  barrier before the `latest.json` pointer moves, so a partially uploaded run
  can never be committed.
- GFSC XYZ tile renderer (`pipeline/tiles.py`) that colorizes a merged AS-OF
  composite per the frozen spec 5.2/5.4 visual encoding (snow-cover ramp,
  freshness-attenuated alpha, violet cloud, transparent water/stale/no-data)
  and slices it into standard `{z}/{x}/{y}.png` Web Mercator tiles, skipping
  fully-transparent ones. Eight focused tests, bringing the pipeline suite to
  25 tests.
- Latest-product-only GFSC preview pipeline: `pipeline/config.py` (62-tile
  Alps+Apennines MGRS coverage), `fetch.py` (newest-product-only Copernicus
  catalogue discovery/download), `snapshots.py` (memory-bounded per-metatile
  rendering), `preview.py` (end-to-end orchestration), and `publish.py`
  (atomic Cloudflare R2 upload - immutable run first, `latest.json` pointer
  last). Sixteen new tests, bringing the pipeline suite to 41.
- `.github/workflows/publish-latest-preview.yml`, a manual-dispatch-only
  GitHub Actions job that runs the preview pipeline and publishes to R2, and
  `docs/r2-setup.md` documenting bucket/token/CORS/GitHub secrets setup.
- Frontend now loads the R2/local `latest.json` XYZ tile manifest
  (`app/src/map/snowOverlay.ts`, `config.ts`, `main.ts`), falling back to the
  checked-in one-tile sample overlay if the manifest is unavailable.

### Added
- Full 58/62-tile MVP-area GFSC preview published to production R2, with the
  bucket's CORS policy applied and `VITE_SNOW_MANIFEST_URL` set on Netlify -
  `https://spikely.netlify.app` now serves the real snow-cover overlay,
  visually verified across multiple regions and zoom levels against the live
  site. See `docs/worklog.md` (2026-08-27).

### Changed
- Spec v1.3: deferred arbitrary historical AS-OF map-date browsing out of MVP
  scope (OSM-object historical chart is unaffected and stays required).
  Decided the MVP data-pipeline/storage architecture - a daily GitHub Actions
  job renders one static "latest conditions" tile set and republishes it
  through the existing Netlify deploy, no object storage or on-demand
  tile-rendering service for now - and set the EUR 20/month operating-cost
  ceiling. See `docs/worklog.md` (2026-08-26) for the full brainstorm.
- Spec v1.4: revised the above storage decision the same day, before any of
  it was built - the MVP pipeline instead publishes to Cloudflare R2 (chosen
  over Netlify Blobs and over the static-republish plan). Implemented and
  verified end-to-end against a real bucket with a live 3-tile smoke test.
  See `docs/worklog.md` (2026-08-26, "R2-based latest-only preview pipeline").
- Spec v1.5: recorded the 2026-08-27 production verification and the still-open
  items (cron schedule, AS-OF multi-day fallback, 4 tiles missing a current
  product). See `docs/worklog.md` (2026-08-27).

## [0.1.0] - 2026-08-25

### Added
- Production GFSC AS-OF semantic core (`pipeline/asof.py`) with deterministic
  AT/quality/product-date selection, categorical states, staleness output, and
  focused unit tests.
- GFSC GeoTIFF adapter (`pipeline/raster_io.py`) that discovers complete daily
  GF/GF-QA/AT triplets and rejects inconsistent source grids or metadata.
- GFSC overlap/UTM-seam mosaic (`pipeline/mosaic.py`) that applies the frozen
  water/freshness/quality fallback rule on a common output grid.
- MapLibre GL JS map shell (`app/`): MapTiler Outdoor basemap, pan/zoom,
  mobile-safe-area layout.
- GFSC snow-cover overlay: one reprojected Copernicus product (Ortles-Cevedale,
  6 Feb 2026) rendered as a MapLibre `image` source (`app/src/map/snowOverlay.ts`).
- Snow layer on/off toggle (`app/src/ui/snowControl.ts`).
- Copernicus attribution alongside the MapTiler/OSM credit.
- `recon/make_overlay.py` - reprojects a GFSC `GF.tif` to EPSG:3857, writes a
  paletted PNG + JSON sidecar, self-verifies georeferencing against the source
  raster. Scaffolding: superseded once the real data pipeline exists.
- `app/scripts/screenshot.mjs` - Playwright harness for visually verifying the
  overlay against the basemap at hiking-relevant zoom levels.
- GFSC reconnaissance (`recon/`): HR-WSI S3 client, 580 downloaded sample
  products across 4 areas, value codebook and data-quality findings
  (`recon/findings.md`).
- Netlify deployment: `app/` connected to this GitHub repo, auto-deploying
  `main` to https://spikely.netlify.app on every push.

### Changed
- Hillshade layer moved above the snow overlay so shaded relief remains
  visible under snow at full opacity, instead of lowering snow opacity.
- Frozen the GFSC MVP semantics from reconnaissance: exact coverage/freshness
  rendering, all-tier quality handling, categorical cloud/water/no-data states,
  a 14-day AS-OF staleness ceiling, and no historical-chart interpolation or
  carry-forward.
- Updated the reconnaissance overlay's cloud color from rock-like grey to the
  frozen violet category and regenerated its sample artifact.
- Removed the convergence-only "Zoom to data" button now that its throwaway
  purpose is complete.

### Changed (recordkeeping)
- Agent instructions split out of `.claude/CLAUDE.md` into a shared
  `docs/agent-guide.md`. `.claude/CLAUDE.md` and the new root `AGENTS.md`
  (OpenAI Codex's entry point) are now one-line adapters pointing to it, so
  Claude Code and Codex read the same guidance.
