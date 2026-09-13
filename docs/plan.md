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
handset on 2026-09-11.

**Spec section 7 - the OSM object panel - completed 2026-09-12** and is live:
the object index is published to R2 (54 shards, 211,881 objects), selection
covers all 58 tiles, the daily pipeline samples per-object GFSC, and the panel
draws real snow history over a trailing 30-day window; item 1 is now watching
rather than building.

**A-to-B routing (item 2) is half done as of 2026-09-13.** The route itself
works - endpoints picked from the object panel, a real hiking route on the map,
distance, and the section 8.6 disclaimer - and is committed behind
`VITE_GEOAPIFY_API_KEY`, which is not set anywhere, so the feature is invisible
on production. **The provider is Geoapify**, switched the same day the routing
code landed: Mapbox began asking for payment details at signup, which a feature
budgeted at zero should not require. **Next work is the owner's free Geoapify
key, then a smoke test of that provider's elevation data.**

## Next, in order

1. **OSM object panel - spec section 7 is complete, and now needs watching
   rather than building.** Selection, the panel, the chart, the published
   index, the daily sampling and the historical backfill all shipped
   2026-09-12; the chart draws real per-object GFSC history on the deployed
   site. What is left is operational, not construction:
   - **Watch the next few daily runs.** The first run created every tile's
     permanent slot map; subsequent runs exercise the *extend* path, which has
     never run. The invariant to watch is that slot counts only ever grow and
     that `series/<TILE>/<YYYY-MM>.bin` length stays `slots x days x 2`.
   - **The backfill exists but is probably not needed.** The daily job samples
     its whole 31-day window every run, so the first run alone populated 13
     Aug - 11 Sept, and a trailing 30-day window is continuously covered
     without any backfill at all. `backfill-object-series.yml` is there for
     history *deeper* than 30 days, which since amendment v1.13 nothing
     requires. Run it only if that depth is wanted for its own sake; it merges
     rather than overwrites, so running it is safe but not free.
   - One open contract question from the first consumer: whether
     `bytes`/`sha256` stay in the shard index (the frontend does verify them).
   - Anything needing to know where Nevaio shows snow must ask
     `nevaio_pipeline.footprint`, not re-derive it.

2. **A-to-B routing + snow/elevation profile (spec section 8) - the route
   ships, the profile does not.** Shipped 2026-09-13 in
   `app/src/features/route/`: the Geoapify Routing API in `hike` mode,
   endpoints nominated from the object panel, route geometry and endpoints on
   the map, distance, and the section 8.6 disclaimer with every route. Sampling
   geometry (`routeProfile.ts`) is built and tested but nothing consumes it
   yet. What is left, in the order it unblocks:
   - **Create the free Geoapify API key** (owner console work - see "Open"
     below). No card required. Until it exists and is set as a Netlify env var,
     the whole feature is invisible on production by design, and nothing else
     here can be verified against a real route.
   - **The Copernicus GLO-30 extract is not needed for section 8** (decided
     2026-09-13 on measurement): no pipeline job, no R2 storage claim, no
     sizing exercise. It stays documented as the fallback if Geoapify is ever
     dropped, and the 2026-09-12 analysis behind it is unchanged.
   - **Snow along the route is built and now enabled** (owner's decision,
     2026-09-13: latest date only). The whole path exists and is tested end to
     end: a lossless data pyramid encoder in the pipeline (`data_tiles.py`), the
     render flag `--data-tiles`, artifact validation, manifest announcement, the
     frontend decoder, sampler and summary, and the panel section. Verified in a
     browser on 2026-09-13 against a pipeline-generated tile: canvas decode,
     sampling, and a summary reporting 71% observed / 29% cloud exactly as
     encoded.

     The daily workflow's render step now passes `--data-tiles`
     unconditionally, which is what makes "latest date only" true by
     construction: every scheduled run renders the current date, and the
     historical dates already published were deliberately not backfilled.
     Live cost is about 27 MB per date and, against `--keep-runs 7`, under
     200 MB on a 10 GB free tier. The visual pyramid is unaffected - a test
     asserts those tiles stay byte-identical with the flag on and off.

     **Still to confirm on the first real run**: that a route on production
     reports snow rather than "unavailable". The publish job's timeout was
     checked and is not a concern - it uploads with 16 workers, and the run
     grows from ~1,066 objects to ~4,200 (about ~6,600 at midwinter coverage),
     against a 45-minute budget the existing comment sizes at ten minutes for
     3,500 objects *sequentially*. See
     [`research/snow-along-route.md`](research/snow-along-route.md) for why the
     flag's failure mode is silent and which test guards it.
   - **Spec section 15 items 1 and 2 are still open** and should be decided
     against real numbers rather than in advance: the sampling *mechanism* is
     now concrete (even spacing in ground metres, endpoints preserved exactly,
     bounded sample count, default 60 m = GFSC's native pixel), but the
     spacing value and the definition of "route snow-covered percentage" are
     not closed by that.
   - **What is left of section 8 is the snow half, and only that.** Distance,
     the elevation profile, ascent/descent, the linked map/profile interaction
     (8.5) and the 8.6 disclaimer all shipped 2026-09-13.

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
  **Item 6 (routing provider) was decided 2026-09-13: Geoapify, `hike` mode.**
  It replaced Mapbox Directions, decided the day before and abandoned when
  Mapbox asked for payment details at signup; Mapbox in turn had replaced
  OpenRouteService, which forbids client-side keys. The full comparison, both
  reversals and the reasoning are in
  [`research/routing-and-dem-options.md`](research/routing-and-dem-options.md)
  - read the 2026-09-13 amendment before reopening this.
  **Item 7 (elevation/DEM source) was settled 2026-09-13: the routing
  provider's own elevation**, measured accurate to about a metre on the terrain
  routes actually cross. A precomputed Copernicus GLO-30 extract into R2 stays
  documented as the fallback if Geoapify is ever dropped, but is not being
  built.
- **Create the free Geoapify API key** (owner console work, 2026-09-13; routing
  is built and waiting on it). No credit card. Restrict it to the Netlify
  origin in the Geoapify console - the key ships inside a public bundle, and
  the origin restriction is the only thing standing between it and anyone who
  lifts it. Set it as a Netlify env var (`VITE_GEOAPIFY_API_KEY`) across all
  contexts, and deliberately do **not** mark it secret, for the same reason
  `VITE_MAPTILER_API_KEY` is not: Vite inlines `VITE_*` into the client bundle
  by design, so secret-scanning would fail the build on a value meant to reach
  the browser. `api.geoapify.com` is already in `connect-src` in
  `app/public/_headers` (added 2026-09-13 with the switch), and the mandatory
  "Powered by Geoapify" free-plan credit is already in the map's attribution
  control, so the key is the only remaining step.
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
  claimants. The first two are rounding errors, and **the DEM extract - which
  was the one worth sizing before building - is no longer being built at all**
  (measured 2026-09-13: the routing provider's own elevation is good enough),
  which takes the largest single unknown out of this projection. What is left
  has to fit in the remaining
  ~6 GB, or the date window shortens - `config.ASOF_CATALOGUE_DATES` is the
  one dial. Re-measure in midwinter, when the number means something - the
  September reading above cannot tell us whether the DEM fits.
- **The recovery path is unrehearsed** - revoke the publication key, restore
  trusted code, rebuild dependencies, republish known-good data.

## Ideas parked - owner's, 2026-09-13, not scheduled

Neither is committed to; both are recorded so they are not re-invented from
scratch, and because the second one needs its risks written down *before*
anyone gets enthusiastic about it.

- **Flag suspicious values in the data rather than only rendering them.**
  Worth doing, and cheap. The per-object series already carries everything a
  detector needs - GF, QA tier, observation age - and
  `docs/research/gfsc-findings.md` (2026-09-13) has the first real measurements
  to calibrate against. Candidate signals, in rough order of
  value-per-effort: a large day-over-day swing where *both* endpoints are
  age 0 (the Monte Cevedale shape); a value far from its neighbours' on the
  same day at similar elevation, which is what separates a sampling fault from
  weather; a whole tile flipping together, which is the opposite signature and
  usually real; and a value physically implausible for its elevation and date.
  The honest output is a flag on the mark - "this looks odd" - never
  suppression: hiding a suspect reading is the same class of lie as inventing
  one. Note the trap found on 2026-09-13: 82% of marks are the product's own
  gap-fill, so any detector must compare like with like or it will flag every
  carried-forward run as an anomaly.

- **Nearest measured snow depth, with distance and elevation delta - a
  nice-to-have for a future version.** Owner's decision, 2026-09-13: this is
  the shape worth building if snow depth is ever added. Public alpine station
  networks publish real snow-depth readings - SLF/IMIS in Switzerland, the
  regional Lawinenwarndienste in Austria, AINEVA/Meteomont in Italy. Surface
  the nearest stations' *actual* measurements beside a selected object, stating
  plainly how far away each is and how much higher or lower, and let the
  mountaineer do the extrapolating. It invents nothing, and it fits the
  existing architecture: another periodic static fetch published to R2, no new
  running server, no backend. Unscheduled, and behind spec section 8 routing in
  any case.
  Worth checking before building: each network's licence and whether it permits
  redistribution (they differ, and some are more restrictive than Copernicus);
  update cadence; and whether station metadata carries a usable elevation, since
  the elevation delta is most of the value.

- **Rejected, and worth not re-litigating: modelling or estimating snow depth
  ourselves.** Considered 2026-09-13 and turned down on the merits, not for
  effort. GFSC measures fractional *area*, not depth, and there is no sound
  conversion - 100% cover is 5 cm or 5 m - so any figure would come from a
  model in which GFSC only constrains where snow is. Errors would be largest
  exactly where the decisions are made: wind-loaded lee slopes, gullies and
  cornices, where depth varies over metres in terrain no tractable resolution
  can see. And it is avalanche-adjacent: this app already refuses to show a
  months-old raster because it could be read as current (spec section 5.4),
  and a modelled depth carries the same hazard with a wider blast radius,
  because a number reads as more authoritative than an image. Authoritative
  regional avalanche bulletins exist; a hobby estimate sitting beside them is
  worse than no estimate. If it is ever attempted anyway, the honest form is a
  range wide enough to be uncomfortable, labelled an estimate, never a single
  number, and validated against held-out station data before it ships.

## Explicitly not doing yet

Full Europe coverage, user accounts, saved routes, GPX/KML upload, native
Android app, offline support. See [`spec.md`](spec.md) sections 13-14 for the
full list.
