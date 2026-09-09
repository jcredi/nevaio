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
   are the likely surface. Note the search bar and the snow control have
   collided on narrow viewports once before - see `worklog.md` (2026-09-06).
2. **OSM object panel + historical chart (spec section 7).** Blocked on spec
   section 15 item 3 - deciding which OSM object classes are interactive at
   each zoom. Two constraints already settled, so do not re-derive them: the
   rendered map tiles **cannot** be the data source (the opacity/color encoding
   is lossy and cannot be inverted back to FSC%/age/quality), and the intended
   architecture is a precomputed per-object time series, batch-sampled per
   tile/date from the rasters the daily pipeline already downloads, backfilled
   once from Copernicus's multi-year archive and published statically to R2 -
   no new running server. See `worklog.md` (2026-09-06).
3. **A-to-B routing + snow/elevation profile (spec section 8).** Needs a hosted
   routing provider chosen (spec section 15 item 6). Firm requirement, stronger
   than sections 8.4-8.5 currently read: observation freshness and quality must
   be shown clearly and prominently on the route profile, not "where
   practical". Spec section 15 item 11.
4. **Repository structure refactor, stage 3 onward**
   ([`../REFACTOR.md`](../REFACTOR.md)). Stage 1 (dissolve `recon/`) is done -
   2026-09-09. Sequencing decided that day and worth not re-deriving: stage 3
   regroups the frontend into feature folders and therefore must come *after*
   the mobile pass above, because its own instruction is to "preserve
   responsive styling" and that styling is currently broken - fix it and verify
   on a device first, so the move has a known-good baseline. Stage 4
   (contracts) waits for the OSM object panel, which is the work that would
   actually consume a shared encoding.

## Open

- **Spec section 15** is the canonical list of undecided product questions.
  Live ones: route sampling method and "snow-covered percentage" definition
  (1, 2), interactive OSM object classes (3), basemap/terrain provider (4),
  routing provider (6), elevation/DEM source (7), optional 20 m FSCOG layer
  (10).
- **Historical AS-OF map dates (spec section 5.3).** The daily job renders only
  "today" and discards each composite. Leading candidate: archive a per-day
  compact raster to the same R2 bucket plus on-demand tile rendering reusing
  the frozen section 9.2 logic, cached hard since a historical (date, tile)
  never changes. Smaller step than it looks - the job already downloads the
  whole window. Spec section 15 item 8.
- **Custom domain in front of the `r2.dev` endpoint** (security F10, optional
  pre-launch). Owner console work; needs an Admin-scoped Cloudflare token.
  `app/public/_headers` pins the bucket host in its CSP and must change in the
  same commit - see [`r2-setup.md`](r2-setup.md) step 4.
- **The recovery path is unrehearsed** - revoke the publication key, restore
  trusted code, rebuild dependencies, republish known-good data.

## Explicitly not doing yet

Full Europe coverage, user accounts, saved routes, GPX/KML upload, native
Android app, offline support. See [`spec.md`](spec.md) sections 13-14 for the
full list.
