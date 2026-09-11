# Current plan

**This file is the future tense only.** What is next, what is open, what we are
deliberately not doing. When something ships it *leaves* this file - the record
of what was done and why lives in [`worklog.md`](worklog.md), newest entry
first. Do not add a "done" section here; it only grows a third copy of history
that then drifts.

**Status (2026-09-11).** MVP snow layer is functionally complete and live on
`https://nevaio.netlify.app`: the real GFSC pipeline composes the frozen spec
section 9.2 AS-OF rule over a 30-day window across 58 MGRS tiles, publishes to
Cloudflare R2 on a daily 04:35 UTC schedule, and has run unattended since
2026-08-28. Place search (section 6.1) is done, on MapTiler Geocoding. A
security review and its remediation closed on 2026-09-09; posture is in
[`security.md`](security.md). The mobile-first UI was verified on a real
handset on 2026-09-11. Next work is the OSM object panel and A-to-B routing.

## Next, in order

1. **OSM object panel: publish the index, then the snow history (spec
   section 7).** Selection is done and runs on a committed fixture: the tap
   rule, the shard-index/shard validators, lazy shard loading and the minimal
   panel are in `app/src/objects/` and `app/src/ui/objectPanel.ts`, and
   `docs/research/maptiler-outdoor-objects.md` records what the basemap really
   renders. What remains, in order:
   - **Publish the sharded index to R2** and point `VITE_OBJECT_INDEX_URL` at
     it. That is the URL in `app/src/map/config.ts` and nothing else; the
     bucket host is already in `app/public/_headers`' `connect-src`, so no CSP
     change is needed for that host. Then delete the fixture in
     `app/public/object-index/`, or keep it only as a local-dev fallback -
     decide deliberately, and remember there is no offline snow data by design.
     **Decided 2026-09-11: a new `workflow_dispatch` GitHub Action, reusing the
     existing `production-r2` environment, into the same bucket as the snow
     data.** Not a manual upload: the index is rebuilt whenever the OSM
     extracts refresh, so a repeatable job is worth its cost the second time,
     and it keeps the publication key inside GitHub. The artifact is 54 files
     and 28.6 MB, trivial against the free tier. It is a different lifecycle
     from the daily snapshot, so it is a separate workflow, not a stage bolted
     onto `publish-latest-preview.yml`.
     Until then the deployed site selects objects only inside the four fixture
     tiles - the tap rule is live and correct, the data behind it is a stub.
   - **Precompute the per-object GFSC time series**, keyed on the same stable
     OSM ids, by batch-sampling the rasters the daily pipeline already
     downloads and backfilling from Copernicus's multi-year archive. No new
     running server. Shape, from measurements taken 2026-09-11:
     - **Do the daily increment first; it is nearly free.** `build_preview`
       already holds every window product's GF/GF-QA/AT arrays in RAM per
       tile, so sampling is one numpy fancy-index - 0.03 ms for a tile's
       7,878 points, ~2 s for the whole run. Take the pixel index from the
       product's own affine transform, never from `footprint.parse_mgrs_tile`:
       the real granule origin is offset by up to 40 m from the 100 km grid
       (measured, and the offset differs per tile), so a footprint-derived
       index is off by a column for two thirds of objects. Footprint still
       owns *which* tile covers a point.
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
       order, or the next OSM refresh invalidates every offset.
     - **Depth: two years first** - that satisfies every spec 7.1 preset
       including the previous-year comparison - then extend backwards a month
       at a time. HR-WSI reaches back to September 2016 (~1.3 MB per
       tile-date, 27 GB per year of downloads).
     - Two assumptions still unverified and cheap to check before building:
       GitHub-runner throughput to CloudFerro (read one render run's step
       timings), and whether the bucket's CORS policy passes a browser Range
       request (`ExposeHeaders` is `ETag` only today).
     - Not worth doing, each measured and rejected: HTTP range reads inside
       the source products (they *are* COGs, but 1024 px blocks over 1830 px
       is four blocks and a layer is only ~200 KB, so a whole-file GET wins);
       deduplicating co-located objects (208,993 distinct pixels for 211,855
       objects - 1.4%); sampling every granule covering an object instead of
       its home shard's (+26% points sampled for +0.3 pp of valid marks).
   - **Then the chart itself** (spec section 7.1), including its honest
     treatment of cloud/no-data/stale gaps. The panel currently shows a
     labelled placeholder, on purpose.
   - **Wire place search into the panel**: a search result is a MapTiler
     geocoding hit, not an index record, so it needs the same matching
     question answered again - most likely reusing `resolveSelection` at the
     result's coordinates rather than trusting the geocoder's own identity.
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
   That research is queued and does not block item 1. Firm requirement, stronger
   than sections 8.4-8.5 currently read: observation freshness and quality must
   be shown clearly and prominently on the route profile, not "where
   practical". Spec section 15 item 11.
3. **Repository structure refactor, stage 3 onward**
   ([`../REFACTOR.md`](../REFACTOR.md)). Stages 1 (dissolve `recon/`) and 2
   (package the pipeline) are done - 2026-09-09. Sequencing decided that day
   and worth not re-deriving: stage 3 regroups the frontend into feature
   folders and had to come *after* the mobile pass, because its own instruction
   is to "preserve responsive styling" and that styling was broken - it needed
   a known-good baseline to preserve. **That baseline now exists** (handset
   check, 2026-09-11), so stage 3 is unblocked. Stage 4
   (contracts) waits for the OSM object panel, which is the work that would
   actually consume a shared encoding.

## Open

- **Spec section 15** is the canonical list of undecided product questions.
  Live ones: route sampling method and "snow-covered percentage" definition
  (1, 2), basemap/terrain provider (4), routing provider (6), elevation/DEM
  source (7), optional 20 m FSCOG layer (10).
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
- **R2 free-tier headroom is now the binding constraint on what else ships
  there.** A 31-date archive is roughly 4.0 GB and ~109,000 objects against
  the 10 GB allowance (it was ~0.9 GB at seven runs). The static OSM object
  index and any precomputed per-object series have to fit in the remaining
  ~6 GB, or the date window shortens - `config.ASOF_CATALOGUE_DATES` is the
  one dial. Worth an actual `du` against the bucket once a full window exists,
  since 130 MB/run is a mid-winter figure and summer runs are smaller.
- **The recovery path is unrehearsed** - revoke the publication key, restore
  trusted code, rebuild dependencies, republish known-good data.

## Explicitly not doing yet

Full Europe coverage, user accounts, saved routes, GPX/KML upload, native
Android app, offline support. See [`spec.md`](spec.md) sections 13-14 for the
full list.
