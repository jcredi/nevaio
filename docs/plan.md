# Current plan

**Status:** Real GFSC pipeline live in production, running the frozen section 9.2 AS-OF rule over a now-30-day window on a daily 04:35 UTC schedule, published to R2 and visually verified on `https://spikely.netlify.app`. Nine consecutive days of unattended scheduled publishes confirmed (2026-09-06), the initial-zoom gap that hid the snow layer on first load is fixed, and the snow-cover visual encoding was revised (opacity=coverage, color=freshness, sky-to-indigo palette). The MVP snow layer is functionally complete; place search (spec section 6.1) is also built on Nominatim; the next work is the OSM object panel and A-to-B routing.
**Date:** 2026-09-06

## Why this replaces the original reconnaissance plan

The original plan (`docs/archive/original-reconnaissance-plan.md`) sequenced about eight documentation-heavy phases before any visible output. Good instincts (decide from real data, not assumptions) but too much process before anything runs. This doc replaces it as the thing to actually follow. The original is kept for reference only - its sample-area table, freshness-analysis structure, and quality-code questions are still useful *inputs* to Track B below, just not a phase gate.

Two independent tracks run in parallel and converge at one milestone: a real GFSC tile rendered on a real map.

## Track A - Map shell (`app/`)

Goal: a mobile-friendly topo map, no snow data yet.

- MapLibre GL JS + an OSM-based outdoor/topo basemap (exact provider TBD - compare a couple of free options, at least one with contour/hillshade support, and pick one)
- Pan/zoom, responsive layout, deployable as a static site
- No dependency on Track B - this can start immediately

## Track B - GFSC reconnaissance (`recon/`)

Goal: understand what the real GFSC data looks like over the Alps + Italian Apennines before committing to a pipeline design.

1. Get Copernicus/WEkEO/CDSE access working (see `docs/spec.md` section 4.1 for links). If access isn't set up yet, this is the literal first step.
2. Pick 3-4 contrasting sample areas: glaciated high Alps, forested Alpine foothills, Apennines, and one location near an MGRS tile boundary. One recent ~60-90 day window is enough to start - widen later only if something's ambiguous.
3. Download real GFSC products for those samples directly (no separate catalogue-only pass first - a handful of tiles/dates is nowhere near the 500-products-per-run limit, and downloading gives you the catalogue metadata for free).
4. Inspect what you actually got: resolution/projection, quality-tier (0-3) distribution, how often cloud/no-data shows up, what a real time series at one point looks like.
5. Write findings to `recon/findings.md` as short running bullet notes - not a formal report.

## Converge: first real snow tile - DONE

Take one real downloaded GFSC raster from Track B, reproject/tile it, and render it as an overlay on the Track A map. This is the first real milestone. It answers most of the remaining open questions from both tracks at once (does the projection actually line up, does the resolution look reasonable at the zoom levels people will actually use, etc).

**Outcome.** `recon/make_overlay.py` reprojects one GFSC product (Ortles-Cevedale, 6 Feb 2026) from native UTM to EPSG:3857 and writes a paletted PNG plus a JSON sidecar into `app/public/snow/`; the app loads it as a MapLibre `image` source. Also added the spec section 5.2 snow on/off toggle and Copernicus attribution. Full notes in `recon/findings.md`.

- **Projection lines up** - verified numerically (11 landmarks, 300 random points, 0 unexplained mismatches) as well as visually: snow-free pixels trace the Adige valley exactly.
- **60 m is fine at z8-11, visibly blocky at z13+** - good enough for "is this face snow-covered", too coarse for an individual couloir. That's the concrete trigger for spec section 15 item 10.
- **An EPSG:3857 `image` source needs no tiling pipeline** - worth keeping in mind for how much machinery the real pipeline actually requires.
- Two new inputs to the formerly open section 15 visual-encoding decision came out of looking at it: `nearest` vs `linear` resampling is an honesty tradeoff, and grey cloud is confusable with rock on this basemap. A third - snow at full opacity hiding the shaded relief - turned out to be a layer-order problem and is already fixed (the basemap's hillshade is moved above the snow).

## After convergence

- **DONE - Freeze snow-data semantics from reconnaissance.** Sections 5.2-5.4, 7.1, and 9.2 of `docs/spec.md` now fix the visual encoding, quality/category handling, AS-OF selection, 14-day staleness ceiling, prolonged-gap behavior, and no-interpolation historical-chart rule. The former section 15 items 1-5 have been removed from the open list.
- **DONE - Build and ship the real GFSC data pipeline, latest-product preview.** `pipeline/asof.py`/`raster_io.py`/`mosaic.py`/`tiles.py` are the frozen semantic core (selection, quality/staleness, seam merge, colorized XYZ rendering). `pipeline/config.py` (62-tile Alps+Apennines MGRS coverage), `fetch.py` (newest-product-only Copernicus discovery/download), `snapshots.py` (memory-bounded per-z8-metatile rendering), `preview.py` (end-to-end orchestration), and `publish.py` (atomic R2 upload: immutable run first, `latest.json` pointer last) chain those into a runnable preview. `.github/workflows/publish-latest-preview.yml` (manual dispatch only, no cron yet) and `docs/r2-setup.md` wire it to Cloudflare R2. The frontend (`app/src/map/snowOverlay.ts`, `config.ts`, `main.ts`) loads that R2 `latest.json` manifest as XYZ tiles, falling back to the checked-in sample overlay if it's unavailable. 41 pipeline tests pass; `npm run build` is clean.

  **2026-08-27: live in production.** R2 bucket CORS policy applied, `VITE_SNOW_MANIFEST_URL` set on Netlify, and a full-area publish (58/62 tiles - see below) run and verified end-to-end on `https://spikely.netlify.app`: correct manifest/tile URLs baked into the deployed bundle, correct CORS headers from both the production and local-dev origins, and the overlay rendering correctly geo-aligned across multiple regions/zoom levels in a real browser (Playwright against the live site, not a local dev server). See `docs/worklog.md` (2026-08-27) for the full verification, including a direct source-data check that confirmed one heavily-violet (cloud) area was genuine 26 Aug cloud cover, not a rendering bug.

- **DONE (2026-08-28) - Full section 9.2 AS-OF composition, daily schedule, and the missing-tile mystery.** The three carried-forward items are closed; full reasoning and measurements in `docs/worklog.md` (2026-08-28).
  - **The 4 tiles were never a pipeline bug.** `33SVD`, `33SXB`, `33TTF` and `33TUE` have zero objects in HR-WSI for every year 2016-2026, across all product families, and are absent from HR-WSI's own 983-tile GFSC grid: all four are open-sea squares the service does not produce. Removed from `MVP_MGRS_TILES` (now 58 tiles, all real), and a missing tile now *fails* the run by default (`--max-missing-tiles`) instead of silently publishing a partial map.
  - **Daily at `04:35 UTC`,** chosen from measured cadence: products are strictly daily (57/57 consecutive dates, four tiles, three UTM zones) and arrive at `D+1 00:16-02:55 UTC` in steady state.
  - **The AS-OF fallback was small, not architectural.** `pipeline/asof.py` already implemented the per-pixel backward search; only `preview.py` was restricting it to a one-element list. Now composes the whole 15-day window. Measured on real winter data: +23 to +74 percentage points of valid coverage on 4 of 6 sampled tile-dates, and correctly no change during genuinely cloudy multi-day spells.
  - **`--keep-runs 7` retention was a prerequisite, not a nicety.** A mid-winter full-area run is ~130 MB (vs 14 MB in near-snowless August), so an unbounded daily cron would pass R2's 10 GB free tier within one season.

  **DONE (2026-09-06) - The initial-zoom gap.** `initialView.zoom` raised from `6.3` to `8.3` (`app/src/map/config.ts`), just above the tile pyramid's `PREVIEW_MIN_ZOOM = 8`, rather than extending the pyramid down to z6-7 - the pyramid change is unvalidated at the memory/timing scale it would need and the narrower fix satisfies MVP criterion 1's actual wording ("a mountain area", not the whole Alps arc) without touching the pipeline. Reasoning in `docs/worklog.md` (2026-09-06).

  **DONE (2026-09-06) - Confirmed unattended daily scheduling.** All 10 most recent `publish-latest-preview.yml` runs since 2026-08-28 fired on schedule and succeeded; R2's `latest.json` has advanced daily (now `runId 20260906T085410Z`); `--keep-runs 7` is pruning correctly (exactly 7 run prefixes in the bucket). Actual run start times land 4-12 hours after the scheduled `04:35 UTC`, a GitHub Actions platform delay under load rather than a bug here - doesn't affect correctness given the AS-OF window, but worth another look if same-day freshness ever matters more. Details in `docs/worklog.md` (2026-09-06).

  **DONE (2026-09-06) - Snow-cover visual encoding revised, and the AS-OF ceiling raised to 30 days.** Prompted by a critical read of an alternative (Lovable-built) implementation: opacity and color are now independent channels (previously one combined alpha), so a faint pixel always means "little snow," never an ambiguity with "old observation." Cloud no longer gets a distinct violet map indicator - it renders transparent like water/stale/no-data, matching how those already worked. Separately, the AS-OF age ceiling was raised from 14 to 30 days after measuring the real benefit first (concentrated in multi-week cloudy spells, up to +59pp on one sampled tile-date). Full reasoning, the 6-candidate palette review, and the measurement are in `docs/worklog.md` (2026-09-06). Spec sections 5.2, 5.4, and 9.2 amended (v1.7).

  **DONE (2026-09-06) - Place search (spec section 6.1).** A standalone floating search bar (`app/src/ui/searchBar.ts`), not a MapLibre `IControl` like `SnowControl`, given section 10's mobile-first/near-full-width intent for the app's primary search entry point. Search-by-coordinates (`app/src/search/coordinates.ts`) resolves client-side with no network call; search-by-name (`app/src/search/nominatim.ts`) queries Nominatim's free/keyless public endpoint, decided for MVP over reusing the MapTiler key for its own Geocoding API (spec section 15 item 5) - full reasoning in `docs/worklog.md` (2026-09-06).

  **Next, in order:**
  1. Optional, pre-public-launch: attach a custom domain in front of the `r2.dev` URL (`docs/r2-setup.md` step 4). Needs the Cloudflare dashboard or an Admin-scoped token - the Object Read & Write token cannot set bucket-level config.
  2. Move on to the rest of `docs/spec.md` in vertical slices (OSM object panel + historical chart, A-to-B routing) - search is done, and the snow layer is no longer the bottleneck. When routing (section 8) is built, freshness/quality must be clearly and prominently shown on the route profile, not merely "where practical" as sections 8.4-8.5 currently read - see spec section 15 item 11 and `docs/worklog.md` (2026-09-06). When the OSM object panel + historical chart (section 7) is built, note the rendered map tiles cannot be used as its data source (the color/opacity encoding is lossy - it cannot be inverted back to exact FSC%/age/quality) - the architecture decided but not yet built is a precomputed per-object time series, batch-sampled per tile/date from the same rasters the daily pipeline already loads, backfilled once from Copernicus's own multi-year archive, published statically to R2 (no new running server). Blocked on section 15 item 3 (which OSM object classes are in scope). See `docs/worklog.md` (2026-09-06).
  3. `recon/` stays for now: `.venv` is the pipeline's environment, `data/` is the only local winter archive (it is what made the AS-OF measurements above possible), and `make_overlay.py` is the provenance of the frontend's still-wired fallback image. The trigger for deleting it is removing that fallback, not the pipeline working.
- **DONE - Frontend hosting.** `app/` deploys to Netlify (https://spikely.netlify.app), connected to this GitHub repo and auto-deploying on every push to `main`. See `docs/agent-guide.md` for build config.
- **DONE, revised same day - Data-pipeline hosting/storage architecture for MVP (2026-08-26).** GitHub Actions job -> immutable run + atomic `latest.json` pointer published to Cloudflare R2 -> app reads the manifest directly from R2. This supersedes the original same-day plan to republish static tiles through the Netlify deploy; see `docs/worklog.md` for both the original brainstorm and the same-day revision (R2 vs. Netlify Blobs vs. Netlify static republish).
- Pick the rest of the stack: hosted routing API (for the A-to-B planner). Geocoder is decided (Nominatim, 2026-09-06).
- Build out the rest of `docs/spec.md` in vertical slices: OSM object panel + historical chart, A-to-B routing + snow/elevation profile. Search (section 6) is done.

## Explicitly not doing yet

Full Europe coverage, user accounts, saved routes, GPX/KML upload, native Android app, offline support. See `docs/spec.md` sections 13-14 for the full list.
