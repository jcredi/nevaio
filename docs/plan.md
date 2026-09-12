# Current plan

**This file is the future tense only.** What is next, what is open, what we are
deliberately not doing. When something ships it *leaves* this file - the record
of what was done and why lives in [`worklog.md`](worklog.md), newest entry
first. Do not add a "done" section here; it only grows a third copy of history
that then drifts.

**Status (2026-09-12).** MVP snow layer is functionally complete and live on
`https://nevaio.netlify.app`: the real GFSC pipeline composes the frozen spec
section 9.2 AS-OF rule over a 30-day window across 58 MGRS tiles, publishes to
Cloudflare R2 on a daily 04:35 UTC schedule, and has run unattended since
2026-08-28. Place search (section 6.1) is done, on MapTiler Geocoding. A
security review and its remediation closed on 2026-09-09; posture is in
[`security.md`](security.md). The mobile-first UI was verified on a real
handset on 2026-09-11. Next work is the OSM object panel and A-to-B routing.
The object index publisher exists but **has never been run** (2026-09-12), so
the deployed site still selects objects only inside the four fixture tiles.

## Next, in order

1. **OSM object panel: publish the index, then the snow history (spec
   section 7).** Selection is done and runs on a committed fixture: the tap
   rule, the shard-index/shard validators, lazy shard loading and the minimal
   panel are in `app/src/features/objects/` and `app/src/features/objects/panel.ts`, and
   `docs/research/maptiler-outdoor-objects.md` records what the basemap really
   renders. What remains, in order:
   - **Run the object index publisher, then wire the frontend to it.** The
     publisher was built on 2026-09-12 to the 2026-09-11 decision and is
     unrun: `pipeline/src/nevaio_pipeline/publish_object_index.py` and the
     `workflow_dispatch` workflow `.github/workflows/publish-osm-object-index.yml`,
     reusing the `production-r2` environment and the snow data's bucket under
     the `object-index/` key prefix. In order:
     - **Decided 2026-09-12: Geofabrik's `alps-latest.osm.pbf` and
       `italy-latest.osm.pbf`**, now the dispatch input's default. Between them
       they cover the Alps and the Italian Apennines with overlap, and the
       build script deduplicates identical objects across extracts (failing on
       differing snapshots rather than silently picking one), so the overlap
       costs download time and nothing else. Verified the same day: both URLs
       resolve, 2.2 GB and 2.1 GB, 4.3 GB total.
     - **Run the workflow** from the Actions tab - the default input is now
       correct, so this is a click. It self-verifies the published index
       against its own receipt. **This is the remaining blocker for everything
       below**: it gates both the frontend URL flip and the daily per-object
       sampling, which sits implemented but switched off.
     - **Point `VITE_OBJECT_INDEX_URL`** at
       `<R2_PUBLIC_BASE_URL>/object-index/object-index.json`. That is the URL
       in `app/src/map/config.ts` and nothing else; the bucket host is already
       in `app/public/_headers`' `connect-src`, so no CSP change is needed.
       The path shape matches the fixture's, so only the host changes.
     - **Then delete the fixture** in `app/public/object-index/`, or keep it
       only as a local-dev fallback - decide deliberately, and remember there
       is no offline snow data by design.
     Do not flip the URL before the workflow has run: pointing the deployed app
     at an unpublished URL turns object selection from correct-over-a-stub into
     broken. Until it runs, the deployed site selects objects only inside the
     four fixture tiles - the tap rule is live and correct, the data behind it
     is a stub.
   - **Precompute the per-object GFSC time series**, keyed on the same stable
     OSM ids, by batch-sampling the rasters the daily pipeline already
     downloads and backfilling from Copernicus's multi-year archive. No new
     running server. **The foundation shipped 2026-09-12** - the permanent
     slot map (`object_slots.py`), the cell format and offset arithmetic
     (`object_series.py`), and the daily sampling wired into `build_preview`
     behind optional flags that default to off. **What remains is the backfill
     itself**: the `workflow_dispatch` matrix described below, and publishing
     `series/` to R2. Shape, from measurements taken 2026-09-11:
     - The daily increment is **done** (2026-09-12) and stays off until the
       object index publisher has run: `build_preview` takes optional
       `--object-index-dir`/`--series-output-dir` and does nothing without
       them. The pixel index comes from the product's own affine transform,
       never `footprint.parse_mgrs_tile`, with a regression test pinning it.
     - **Backfill chunk = one calendar month, all tiles**, as a separate
       `workflow_dispatch` matrix: ~1,740 tile-dates and ~2.3 GB per chunk,
       far inside a 6-hour job, and at most 31 product dates per tile so
       `select_window_products` is reused unchanged. 12 chunks per year of
       history; the Free plan allows 20 concurrent jobs and 256 matrix jobs
       per run, and Actions is unmetered on a public repo. Resume by HEADing
       each month shard's public R2 URL, so a failed chunk costs one chunk
       and no state lives between runs. Sampling needs the raster stack, so
       chunks hand artifacts to a publish job exactly as the daily workflow
       does - the publisher stays boto3-only.
     - **Artifact `series/<TILE>/<YYYY-MM>.bin`**: object-major, fixed 2-byte
       cell (GF byte, then GF-QA in 2 bits and AT age in 4 - real ages were
       0-6 days and spec 7.1 caps validity at 14), one column per calendar
       day. One object's month is then a 62-byte HTTP Range read, so the
       frontend needs no per-object objects in R2; ~155 MB per year of
       history for all 211,855 objects. Row order must be a permanent
       per-tile slot map published beside the index, not the index shard's
       order, or the next OSM refresh invalidates every offset. **Decided
       2026-09-12: a range read past the end of an older month file is
       no-data, not an error** - offsets depend only on an object's own slot
       and slots are append-only, so a slot allocated later is necessarily
       past an older month's length, which means the object was not in the OSM
       extract yet. Old month files are therefore never rewritten when the
       slot map grows, and the frontend must read a 416 as a gap. This is the
       one thing the decided format had left open.
     - **Depth: two calendar months.** Spec amendment v1.13 (2026-09-12) cut
       the chart to a single trailing 30-day window, so the two-years figure
       this line used to carry - which existed only to satisfy the
       previous-year comparison - goes with it. Two months is what makes a
       full 30-day window available on the first day whatever the date; after
       that the daily increment keeps it filled by itself. That is **2
       backfill chunks rather than 24**, and roughly **26 MB of series in R2
       rather than ~310 MB**. Going deeper is now a product choice with no
       requirement behind it; HR-WSI still reaches back to September 2016
       (~1.3 MB per tile-date) if that changes.
     - **Both assumptions this design rested on were checked on 2026-09-12
       and hold** - see `worklog.md`. Runner throughput: the daily job already
       does this workload (a 31-day window over 58 tiles is ~1,798 tile-dates
       against a chunk's ~1,740) and eight real runs took 11.8-20.75 min
       against a 6-hour budget, so the margin is ~17-30x. Browser Range reads:
       a 62-byte ranged GET from the production origin already returns `206`
       with the right bytes and CORS origin; `ExposeHeaders: ["ETag"]` does not
       bite, because the `206` status and `Content-Length` are readable from JS
       regardless. Nothing in the design needs to change.
     - Not worth doing, each measured and rejected: HTTP range reads inside
       the source products (they *are* COGs, but 1024 px blocks over 1830 px
       is four blocks and a layer is only ~200 KB, so a whole-file GET wins);
       deduplicating co-located objects (208,993 distinct pixels for 211,855
       objects - 1.4%); sampling every granule covering an object instead of
       its home shard's (+26% points sampled for +0.3 pp of valid marks).
   - The chart itself (spec section 7.1) **shipped 2026-09-12**, including the
     honest gap treatment, and renders "Not available yet" until
     `VITE_OBJECT_SERIES_URL` is set - which waits on the backfill publishing
     `series/` and `slots/`. It shows **one trailing 30-day window and no
     picker**, per spec amendment v1.13 the same day; the presets, custom
     range and previous-year comparison it briefly had are gone.
   - One open contract question from the first consumer: whether
     `bytes`/`sha256` stay in the shard index (the frontend does verify them).
     The hut/shelter duplicate question is closed - the pipeline drops a
     shelter that duplicates a same-named hut beside it, see `worklog.md`
     (2026-09-11).
   - Anything needing to know where Nevaio shows snow must ask
     `nevaio_pipeline.footprint`, not re-derive it.

2. **A-to-B routing + snow/elevation profile (spec section 8).** Needs a hosted
   routing provider chosen (spec section 15 item 6). **Decided 2026-09-11: the
   choice is made from a costed shortlist rather than cold** - a written
   options/pros-cons/recommendation pass covering the routing provider and the
   elevation/DEM source (section 15 item 7) comes first, then the owner picks.
   **Decided 2026-09-12: Mapbox Directions (`mapbox/walking`) for routing, and
   a precomputed Copernicus GLO-30 extract in R2 for elevation.** ORS was the
   pick for part of that day and was reversed the same day: its staff forbid
   delivering a key to a browser and it offers no domain restriction, which
   this app cannot work around without the backend it deliberately lacks.
   Before building: **create a separate, URL-restricted Mapbox token** - the
   default token cannot carry URL restrictions, and using it would discard the
   one control that makes a public token safe - and add `api.mapbox.com` to
   `connect-src` in `app/public/_headers` in the same change. Mapbox Directions
   returns no elevation, so the DEM is still needed; `du` the bucket first to
   confirm a GLO-30 extract fits beside the object index and the series.
   Fallback for elevation stays MapTiler Terrain-RGB.
   **The options pass behind this was delivered 2026-09-12:
   [`research/routing-and-dem-options.md`](research/routing-and-dem-options.md).
   The owner's pick is now the open step** - section 15 items 6 and 7 stay
   open, not closed by a recommendation. It recommends OpenRouteService
   `foot-hiking` (fallback: Mapbox Directions) and a precomputed Copernicus
   GLO-30 extract into the existing R2 bucket (fallback: MapTiler Terrain-RGB),
   each conditional on one check the doc names - ORS's real free quota from
   HeiGIT's own dashboard, and whether a GLO-30 extract fits the R2 headroom. Firm requirement, stronger
   than sections 8.4-8.5 currently read: observation freshness and quality must
   be shown clearly and prominently on the route profile, not "where
   practical". Spec section 15 item 11.
3. **Repository structure refactor, stage 4**
   ([`../REFACTOR.md`](../REFACTOR.md)). Stages 1 (dissolve `recon/`) and 2
   (package the pipeline) are done - 2026-09-09; stage 3 (regroup the frontend
   into `app/src/features/`) is done - 2026-09-12. Stage 4 (contracts) waits
   for the OSM object panel, which is the work that would actually consume a
   shared encoding - so it is gated on item 1, not on anything structural.
   When it starts, note that `REFACTOR.md`'s target tree was written
   2026-09-09 and has already drifted once: it names frontend files that no
   longer exist and renames that later work made wrong. Verify against the
   repository, as that document's own instructions say.

## Open

- **Spec section 15** is the canonical list of undecided product questions.
  Live ones: route sampling method and "snow-covered percentage" definition
  (1, 2), basemap/terrain provider (4), optional 20 m FSCOG layer (10).
  **Items 6 and 7 were decided 2026-09-12** from
  [`research/routing-and-dem-options.md`](research/routing-and-dem-options.md):
  routing is **Mapbox Directions** (`mapbox/walking`), elevation is a
  **precomputed Copernicus GLO-30 extract into the existing R2 bucket**.
  Routing was OpenRouteService for part of that day; it is not, because ORS
  forbids client-side keys and this app has no backend - see the correction in
  that document before reopening the question.
- **Create the URL-restricted Mapbox token** (owner console work, deferred
  2026-09-12 until routing is actually built). It must be a **new** token, not
  the account's default: Mapbox's URL restrictions do not apply to default
  tokens, so the default would ship unrestricted in a public bundle - the very
  problem that disqualified OpenRouteService. Restrict it to the Netlify
  origin, set it as a Netlify env var across all contexts, and deliberately do
  **not** mark it secret, for the same reason `VITE_MAPTILER_API_KEY` is not:
  Vite inlines `VITE_*` into the client bundle by design, so secret-scanning
  would fail the build on a value meant to reach the browser. `api.mapbox.com`
  joins `connect-src` in `app/public/_headers` in the same change.
- **Custom domain in front of the `r2.dev` endpoint** (security F10, optional
  pre-launch). Owner console work; needs an Admin-scoped Cloudflare token.
  `app/public/_headers` pins the bucket host in its CSP and must change in the
  same commit - see [`r2-setup.md`](r2-setup.md) step 4.
- **Snow tile 404s make the browser console noisy.** The pipeline publishes
  only tiles that contain data, but MapLibre requests the full grid inside the
  manifest's `bounds`, so every empty cell 404s - five in one production
  viewport on 2026-09-09. Functionally harmless and long-standing; the cost is
  that a real error can hide in the noise. Options when it is worth doing:
  publish a 1x1 transparent PNG for empty cells (simple, more objects in R2),
  or narrow the published `bounds`/per-zoom coverage so the grid matches what
  actually exists (cheaper at runtime, more pipeline work). Not urgent.
- **R2 free-tier headroom.** **Measured 2026-09-12: 40.79 MB across 7.07k
  objects** - far under the 10 GB allowance, but that is a *September* figure
  and must not be read as the steady state: the archive is mostly snow-free
  tiles right now. The projection that matters is mid-winter, where a 31-date
  archive is roughly 4.0 GB and ~109,000 objects. Against that, the object
  index (28.6 MB), the per-object series (~26 MB at the two-month depth
  amendment v1.13 leaves) and a Copernicus GLO-30 extract are the other
  claimants. The first two are rounding errors; **the DEM extract is the one
  worth sizing before it is built**, and its size is still an estimate. They
  have to fit in the remaining
  ~6 GB, or the date window shortens - `config.ASOF_CATALOGUE_DATES` is the
  one dial. Re-measure in midwinter, when the number means something - the
  September reading above cannot tell us whether the DEM fits.
- **The recovery path is unrehearsed** - revoke the publication key, restore
  trusted code, rebuild dependencies, republish known-good data.

## Explicitly not doing yet

Full Europe coverage, user accounts, saved routes, GPX/KML upload, native
Android app, offline support. See [`spec.md`](spec.md) sections 13-14 for the
full list.
