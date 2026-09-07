# Current plan

**Status:** Product renamed from Spikely to Nevaio (2026-09-07); the app now deploys to `https://nevaio.netlify.app`. Real GFSC pipeline live in production, running the frozen section 9.2 AS-OF rule over a now-30-day window on a daily 04:35 UTC schedule, published to R2 and visually verified. Nine consecutive days of unattended scheduled publishes confirmed (2026-09-06), the initial-zoom gap that hid the snow layer on first load is fixed, and the snow-cover visual encoding was revised twice (opacity=coverage, color=observation age, sky-to-indigo palette). The MVP snow layer is functionally complete; place search (spec section 6.1) is also built on Nominatim; the next work is the OSM object panel and A-to-B routing.
**Date:** 2026-09-07

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

  **DONE (2026-09-06) - Search result type icons.** Each result now shows a small icon (peak, hut/shelter, pass, camp site, trail, parking, settlement, or a generic pin) from Nominatim's `category`/`type` fields. Found and fixed a real bug along the way (`nominatim.ts` was reading a `class` field that doesn't exist in the `jsonv2` response - it's `category`). User explicitly declined a proposed fix for a separate complaint (searching "Adamello" doesn't surface the Adamello peak within Nominatim's own top results) - no client-side re-ranking was built; see `docs/worklog.md` (2026-09-06) for the diagnosis if this is revisited.

  **DONE (2026-09-06) - Snow-layer legend.** `SnowControl` (`app/src/ui/snowControl.ts`) now explains both spec section 5.2 visual channels: a coverage gradient bar (reproducing the exact 0/150/255-at-0/50/100% alpha curve, not a plain linear approximation) and four Sky-to-Indigo freshness-tier swatches. The four hex values are hardcoded there, matching `pipeline/tiles.py`'s `_FRESHNESS_COLORS` by hand - no shared config exists between the pipeline and frontend. See `docs/worklog.md` (2026-09-06).

  **DONE (2026-09-06) - "Observation age" wording fix and a full visual redesign.** The legend's "Color = freshness" label was ambiguous with "fresh snow" - now "Color = observation age". `app/src/style.css` rewritten around design tokens for a cohesive frosted-glass look across every floating panel (including MapLibre's own default controls), an accent color reused from the map's own Sky-to-Indigo palette, an animated toggle switch replacing the plain checkbox, and a pill-shaped search bar. Found and fixed a real, previously-unnoticed bug along the way: the search bar and `SnowControl` have always overlapped on narrower viewports, hiding the "Snow cover" toggle row entirely - fixed with an unconditional vertical offset rather than a breakpoint. See `docs/worklog.md` (2026-09-06).

  **Next, in order:**
  1. Optional, pre-public-launch: attach a custom domain in front of the `r2.dev` URL (`docs/r2-setup.md` step 4). Needs the Cloudflare dashboard or an Admin-scoped token - the Object Read & Write token cannot set bucket-level config.
  2. Move on to the rest of `docs/spec.md` in vertical slices (OSM object panel + historical chart, A-to-B routing) - search is done, and the snow layer is no longer the bottleneck. When routing (section 8) is built, freshness/quality must be clearly and prominently shown on the route profile, not merely "where practical" as sections 8.4-8.5 currently read - see spec section 15 item 11 and `docs/worklog.md` (2026-09-06). When the OSM object panel + historical chart (section 7) is built, note the rendered map tiles cannot be used as its data source (the color/opacity encoding is lossy - it cannot be inverted back to exact FSC%/age/quality) - the architecture decided but not yet built is a precomputed per-object time series, batch-sampled per tile/date from the same rasters the daily pipeline already loads, backfilled once from Copernicus's own multi-year archive, published statically to R2 (no new running server). Blocked on section 15 item 3 (which OSM object classes are in scope). See `docs/worklog.md` (2026-09-06).
  3. Repository structure refactor - see the dedicated section below. Supersedes the earlier "`recon/` stays for now" holding position: the blocker was never the fallback image, it was that `recon/` bundles four things with four different lifecycles, so no single delete trigger could ever fire. Stage 1 unbundles it; the `.venv`, the winter archive, and the fallback overlay's provenance all survive the move.
- **DONE - Frontend hosting.** `app/` deploys to Netlify (https://nevaio.netlify.app, renamed from spikely.netlify.app on 2026-09-07), connected to this GitHub repo and auto-deploying on every push to `main`. See `docs/agent-guide.md` for build config.
- **DONE, revised same day - Data-pipeline hosting/storage architecture for MVP (2026-08-26).** GitHub Actions job -> immutable run + atomic `latest.json` pointer published to Cloudflare R2 -> app reads the manifest directly from R2. This supersedes the original same-day plan to republish static tiles through the Netlify deploy; see `docs/worklog.md` for both the original brainstorm and the same-day revision (R2 vs. Netlify Blobs vs. Netlify static republish).
- Pick the rest of the stack: hosted routing API (for the A-to-B planner). Geocoder is decided (Nominatim, 2026-09-06).
- Build out the rest of `docs/spec.md` in vertical slices: OSM object panel + historical chart, A-to-B routing + snow/elevation profile. Search (section 6) is done.

## Repository structure refactor - planned, not started (2026-09-07)

Agreed after a structural review of the whole tree. Nothing here is started;
each stage is independently shippable and revertible. The ordering is by
value-per-unit-risk, and stages 1-2 deliver most of the readability win with
no behavioral change at all.

### Why: `recon/` is four things with four lifecycles

The folder is documented as temporary scaffolding to delete, but the delete
trigger can never fire, because only one of its contents is actually
reconnaissance:

| Contents | Size | What it really is | Lifecycle |
| --- | --- | --- | --- |
| `.venv/` | 347 MB | The Python interpreter the pipeline runs in locally (3.14.7) | Permanent infra |
| `data/` | 1.5 GB | The only local Jan-Apr 2026 winter GFSC archive (gitignored) | Permanent fixture cache |
| `vendor/hrwsi/` | 15 MB | Vendored Copernicus S3 client, **fully superseded** by `pipeline/fetch.py` (which talks to `s3.WAW3-2.cloudferro.com` directly). Nothing imports it. | Dead code / provenance |
| `make_overlay.py` | 336 lines | Generator of the committed fallback overlay. Nothing imports it, but its *output* is load-bearing. | Live, misfiled |
| `findings.md` | 13 KB | Durable knowledge about the data | Docs |
| `requirements.txt` | - | 7 unpinned deps, superset of the pipeline's | Superseded by the locks |

So "delete `recon/`" was always the wrong operation, and that is why it kept
getting deferred. The right one is to **unbundle it**, after which the residue
genuinely is deletable.

### The other four structural problems

1. **The local Python environment is undeclared and mislocated.** CI is now
   hash-locked and reproducible (`pipeline/requirements.in` ->
   `requirements.txt`, plus the publisher's `requirements-publish.*`), but
   local dev still runs Python 3.14.7 out of a venv inside a folder marked for
   deletion, against CI's pinned 3.12. Every documented command hardcodes
   `recon/.venv/bin/python -m unittest discover -s pipeline/tests -t .`, which
   is why that path is repeated in five files and rots.
2. **The dependency boundary that CI now enforces is invisible in the
   layout.** The publish job deliberately installs boto3 only - no
   rasterio/pillow/numpy - and `pipeline/__init__.py` was made lazy purely so
   `import pipeline` would not drag the raster stack into the privileged job.
   That lazy-import shim is a workaround for a package layout that cannot
   express "these modules are safe for the publisher." The two surfaces are
   already cleanly separable: publisher = `publish.py`,
   `artifact_validation.py`, `config.py`; renderer = `asof.py`, `mosaic.py`,
   `tiles.py`, `raster_io.py`, `snapshots.py`, `fetch.py`, `preview.py`.
3. **`preview.py` is the production renderer.** Publication genuinely split
   out of it during the F1 work, so the name is now doubly wrong: it renders,
   on a daily cron, in production.
4. **Frozen constants are duplicated across the language boundary by hand.**
   The four freshness hexes live in both `pipeline/tiles.py`
   (`_FRESHNESS_COLORS`) and `app/src/ui/snowControl.ts`, with a comment
   admitting the manual sync; a third, divergent ramp sits in
   `recon/make_overlay.py`'s `build_lut`. `PREVIEW_MIN_ZOOM = 8` in
   `pipeline/config.py` is mirrored as prose next to `zoom: 8.3` in
   `app/src/map/config.ts`. This is a correctness hazard - a palette change
   silently desyncs the legend from the map - not a tidiness one.

`app/` itself is fine: ~740 lines of TypeScript in a clean `map/` / `search/`
/ `ui/` split. Leave it alone.

### Target layout

```
nevaio/
├── Makefile                    # NEW: the only place command paths are written
├── README.md  CHANGELOG.md  LICENSE.md  AGENTS.md
├── .venv/                      # MOVED from recon/, gitignored
├── .github/workflows/
├── app/                        # UNCHANGED
├── data/gfsc-samples/          # MOVED from recon/data, gitignored
├── pipeline/
│   ├── requirements*.in/.txt   # unchanged; local env spec added
│   ├── core/                   # pure, no I/O: asof.py  mosaic.py  encoding.py
│   ├── io/                     # adapters: rasters.py  hrwsi.py  xyz.py  snapshots.py
│   ├── publishing/             # boto3-only surface: r2.py  artifact_validation.py
│   ├── config.py
│   ├── render.py               # was preview.py
│   └── tests/{core,io,publishing}/
├── shared/snow-encoding.json   # NEW: single source for palette + zoom range
├── tools/make_fallback_overlay.py   # was recon/make_overlay.py
└── docs/
    ├── spec.md  plan.md  worklog.md  agent-guide.md
    ├── data-findings.md        # was recon/findings.md
    ├── ops/{r2-setup.md, publishing-security.md, security-audit-2026-09.md}
    └── archive/{original-reconnaissance-plan.md, hrwsi-vendored-client/}
```

`recon/` disappears entirely - by redistribution, not deletion.

### Stage 1 - dissolve `recon/` (~1h, pure moves, no behavior change)

- `recon/.venv` -> `.venv` at the repo root. **Recreate, do not move**: venvs
  hardcode absolute paths in `bin/`.
- `recon/data` -> `data/gfsc-samples/`, still gitignored. It is a fixture
  archive, not recon output.
- `recon/findings.md` -> `docs/data-findings.md`.
- `recon/make_overlay.py` -> `tools/make_fallback_overlay.py`, docstring
  rewritten: it is no longer "scaffolding with an end of life," it is the
  documented provenance of a committed asset. Update the `note` string it
  writes into the sidecar, and the matching comment in
  `app/src/map/snowOverlay.ts`.
- `recon/vendor/hrwsi/` -> `docs/archive/hrwsi-vendored-client/` with a
  "superseded by `pipeline/fetch.py`" note, or simply delete it - upstream is
  public and nothing imports it.
- Delete `recon/requirements.txt`, `recon/.gitkeep`, `recon/.DS_Store`.
- Move root `SECURITY_AUDIT_REPORT.md` -> `docs/ops/security-audit-2026-09.md`
  (it is currently untracked; decide then whether it should be committed).

### Stage 2 - declare the local environment and add a Makefile (~1h)

CI is already reproducible; local is not. Add a local env spec that matches
CI's Python 3.12 rather than 3.14.7. **Constraint:** the existing lock is
compiled `--python-platform x86_64-unknown-linux-gnu`, so it cannot be
installed directly on macOS arm64 - either compile a second platform lock
from the same `.in` files, or accept an unlocked local resolve from the
pinned `.in` versions and keep the hash-locked file as CI's alone.

Then a root `Makefile`: `make setup`, `make test`, `make render`,
`make publish-check`, `make dev`, `make build`. Every doc line that currently
spells out an interpreter path collapses to `make test`. This is what stops
Stage 1's path churn from recurring.

### Stage 3 - split `pipeline/` along the dependency boundary (~2-3h)

Mostly file moves plus import rewrites, with tests moving alongside. The one
real split is `tiles.py` (164 lines), already two clean halves its own
docstring describes: the LUT / `render_rgba` half is pure and goes to
`core/encoding.py`; the slippy-map slicing half goes to `io/xyz.py`.

The payoff is that the CI trust boundary becomes structural: `publishing/`
must import nothing from `core/` or `io/`, which is a one-line test instead of
a lazy-import shim in `__init__.py`. Rename `preview.py` -> `render.py`.

Call sites to update: the two `python -m pipeline.{preview,publish}`
invocations in `.github/workflows/publish-latest-preview.yml`,
`pipeline/README.md`, and `pipeline/tests/test_workflow_security.py` (it
resolves the workflow via `parents[2]` and asserts on the publisher lock's
contents). Re-run the publisher-isolation check afterwards - a bad move here
would silently re-admit the raster stack into the privileged job.

### Stage 4 - kill the cross-language duplication (~1h)

`shared/snow-encoding.json` holding the four tier hexes, the alpha stops, and
the zoom range. `core/encoding.py` loads it; `app/src/ui/snowControl.ts`
imports it (Vite handles JSON natively); `app/src/map/config.ts` derives its
zoom floor from it instead of a prose comment. Add one pipeline test asserting
the JSON matches what `render_rgba` actually emits. This is the only stage
touching behavior-adjacent code, so it goes last.

### Explicitly rejected

- **Renaming `app/` to `web/` or `frontend/`.** Netlify's base directory is
  `app`, set in the dashboard with no committed `netlify.toml`. Pure churn
  plus a manual dashboard step, for nothing.
- **src-layout (`pipeline/src/nevaio_pipeline/`).** Correct for a distributed
  library, overhead for one app CI runs as `python -m` from the repo root.
  Revisit only if the pipeline is ever installed elsewhere.
- **A monorepo tool** (Nx, Turborepo, pnpm workspaces). Two apps, two
  languages. A Makefile covers it.
- **A `pyproject.toml` replacing the `.in`/`.txt` locks.** The hash-locked,
  wheel-only, two-surface split from the F1 security work is deliberate and
  more constrained than a plain pyproject would be. Keep it.
- **Splitting `pipeline/tests/` finer than the three surfaces, or breaking up
  `snowControl.ts`.** Both are already the right size.
- **Touching the content of `docs/spec.md`, `plan.md`, or `worklog.md`.**
  Stages 1-4 change paths in them, nothing else.

This cuts against the standing "small, visible, working steps over broad
refactors" ground rule. It is justified here because the disorder now costs
real safety margin rather than aesthetics - an undeclared local interpreter
and a hand-synced palette are latent bugs - but stages 1 and 2 are the part
that pays for itself immediately. Stages 3 and 4 can wait for the next time
that code is open anyway.

## Explicitly not doing yet

Full Europe coverage, user accounts, saved routes, GPX/KML upload, native Android app, offline support. See `docs/spec.md` sections 13-14 for the full list.
