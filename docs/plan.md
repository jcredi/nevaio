# Current plan

**This file is the future tense only.** What is next, what is open, what we are
deliberately not doing. When something ships it *leaves* this file - the record
of what was done and why lives in [`worklog.md`](worklog.md), newest entry
first. Do not add a "done" section here; it only grows a third copy of history
that then drifts.

**Status (2026-09-09).** MVP snow layer is functionally complete and live on
`https://nevaio.netlify.app`: the real GFSC pipeline composes the frozen spec
section 9.2 AS-OF rule over a 30-day window across 58 MGRS tiles, publishes to
Cloudflare R2 on a daily 04:35 UTC schedule, and has run unattended since
2026-08-28. Place search (section 6.1) is done, on MapTiler Geocoding. A
security review and its remediation closed on 2026-09-09; posture is in
[`security.md`](security.md). Next work is the OSM object panel and A-to-B
routing.

## Next, in order

1. **Proper mobile testing pass.** Spec section 10 is mobile-first, but the UI
   has only ever been verified on a desktop viewport and in Playwright at a
   desktop size. A quick real-device check on 2026-09-09 found the search bar
   overflowing the screen, and more besides. Test on real handsets rather than
   only a resized desktop window - notch/safe-area insets, the on-screen
   keyboard shrinking the viewport, and touch target sizes are all things a
   narrow desktop window does not reproduce. Fix what it turns up; the floating
   panels (`app/src/ui/searchBar.ts`, `snowControl.ts`, `app/src/style.css`)
   are the likely surface. In particular, confirm the search bar's new reserved
   top-right-control column at 320 and 390 CSS pixels on actual handsets, along
   with the existing snow-control clearance. `npm run check-mobile-layout`
   provides the repeatable emulator baseline (with `npm run dev` running), but
   is not a substitute for the handset checks - see `worklog.md` (2026-09-06,
   2026-09-10).
2. **OSM object panel: publish the index, then the snow history (spec
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
   - **Precompute the per-object GFSC time series**, keyed on the same stable
     OSM ids, by batch-sampling the rasters the daily pipeline already
     downloads and backfilling from Copernicus's multi-year archive. No new
     running server.
   - **Then the chart itself** (spec section 7.1), including its honest
     treatment of cloud/no-data/stale gaps. The panel currently shows a
     labelled placeholder, on purpose.
   - **Wire place search into the panel**: a search result is a MapTiler
     geocoding hit, not an index record, so it needs the same matching
     question answered again - most likely reusing `resolveSelection` at the
     result's coordinates rather than trusting the geocoder's own identity.
   - Open contract questions for the pipeline, from the first consumer:
     whether `bytes`/`sha256` stay in the contract (the frontend does verify
     them), and whether two OSM objects for one building - `Rifugio Quinto
     Alpini` appears as both `shelter` and `hut`, 10 m apart - should be
     deduplicated upstream or surfaced as a choice.
   - Anything needing to know where Nevaio shows snow must ask
     `nevaio_pipeline.footprint`, not re-derive it.

3. **The date picker for historical AS-OF dates (spec section 5.3).** The
   storage half shipped on 2026-09-11 - see `worklog.md` for the schema and
   the retention argument. R2 now carries `dates.json` (the authoritative
   catalogue, newest first, `{asOfDate, runId, manifest}` per entry) and one
   `asof-<date>-<runId>.json` manifest per available date, latest plus 30
   preceding. What remains is the frontend: fetch and validate `dates.json` at
   startup with a runtime validator alongside `manifestSchema.ts`, resolve
   each entry's relative `manifest` key against the catalogue's own URL, and
   let the compact control select one. An archived date manifest is
   `latest.json`-shaped and lives in the same directory, so
   `validateTileManifest` accepts it unchanged - keep it that way. A date
   absent from the catalogue is unavailable: no falling back to latest, to a
   nearby date, or to anything recomposed in the browser. No CSP change is
   needed; the new objects are on the R2 origin `_headers` already allows.
   The latest-date text stays non-interactive until the picker lands.
4. **A-to-B routing + snow/elevation profile (spec section 8).** Needs a hosted
   routing provider chosen (spec section 15 item 6). Firm requirement, stronger
   than sections 8.4-8.5 currently read: observation freshness and quality must
   be shown clearly and prominently on the route profile, not "where
   practical". Spec section 15 item 11.
5. **Repository structure refactor, stage 3 onward**
   ([`../REFACTOR.md`](../REFACTOR.md)). Stages 1 (dissolve `recon/`) and 2
   (package the pipeline) are done - 2026-09-09. Sequencing decided that day and worth not re-deriving: stage 3
   regroups the frontend into feature folders and therefore must come *after*
   the mobile pass above, because its own instruction is to "preserve
   responsive styling" and that styling is currently broken - fix it and verify
   on a device first, so the move has a known-good baseline. Stage 4
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
