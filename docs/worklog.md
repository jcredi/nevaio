# Working session log

A dated, narrative record of what was done, decided, and rejected each session -
newest first. `git log` has the diffs; this has the reasoning that produced them,
especially the roads *not* taken (a rejected approach usually costs real time to
rediscover if it isn't written down).

This is not a duplicate of other docs: `docs/spec.md` is frozen product intent,
`docs/plan.md` is what's next, `recon/findings.md` is what the data actually is.
This file is what *we* did and why, across sessions.

---

## 2026-09-06 - Fixed the initial-zoom gap, confirmed nine days of unattended daily publishes

**Did:** Closed out items 1 and 2 carried forward from 2026-08-28, in order.

*The initial-zoom gap (item 1).* `docs/plan.md` framed this as a decision
between two candidate fixes: open the map at z8+, or extend the tile pyramid
down to z6-7. Looked at both before choosing. Extending the pyramid is
possible without a frontend change - `snowOverlay.ts` already reads
`minzoom`/`maxzoom` off the manifest rather than hardcoding them - but
`snapshots.py`'s metatile renderer defines one metatile grid per base zoom
level, sized `TILE_SIZE * 2**(max_zoom - min_zoom)`. Dropping `min_zoom` from
8 to 6 would grow that from 2048x2048 to 8192x8192 pixels, and each of
`AsOfComposite`'s eight per-pixel fields (`acquisition_time` alone is 8 bytes)
means roughly 1.7 GB for one metatile's destination arrays plus another ~1.3
GB transiently per source tile warped into it - untested at that scale, in a
GitHub Actions runner, for a genuine product-decision problem (whether users
even want the wide overview) rather than a bug fix. Chose the z8+ fix instead:
raised `app/src/map/config.ts` `initialView.zoom` from `6.3` to `8.3` (just
above `PREVIEW_MIN_ZOOM`, not exactly at the boundary). MVP success criterion
1 asks for understanding "where snow is currently present in a mountain
area" (singular), which a z8.3 view centered on the Aosta Valley/Gran
Paradiso area satisfies directly, without touching the pipeline at all.
`npm run build` and the 51 pipeline tests both still pass (the pipeline was
untouched). Pushed, and re-ran `npm run verify` against the live site once
Netlify's auto-deploy picked it up: the initial page load now requests 21
real snow tiles from R2 (`.../tiles/9/267-269/182-184.png`), all `200`, up
from 0 of 24 before.

*Nine days of unattended scheduling (item 2).* Listed the
`publish-latest-preview.yml` workflow runs via the GitHub API: all 10 most
recent scheduled runs since 2026-08-28 completed successfully, one per day,
with no manual dispatches needed. R2's `latest.json` is at `runId
20260906T085410Z`, `asOfDate 2026-09-06`, 58/58 tiles, confirming the pointer
has advanced daily rather than sticking on the first run. Also listed the
bucket's `runs/` prefixes directly (boto3, using the existing
`pipeline/.env.r2.local` credentials in a subshell, never printed) and got
back exactly 7 run IDs, `20260831T110934Z` through today's - `--keep-runs 7`
is pruning correctly now that there have been enough runs to matter, not just
in the one deliberate exercise on 2026-08-28.

One thing not on the carried-forward list, worth flagging: actual run start
times are landing 4-12 hours after the scheduled `04:35 UTC`
(`08:31`-`16:51 UTC` across the 10 runs checked), not the ~1h40m margin the
cron time was chosen for on 2026-08-28. This doesn't break correctness - the
15-day AS-OF window absorbs a same-day delay of any size - but it does mean
the "published before the European morning" framing from that decision isn't
actually happening in practice. Not fixed this session: GitHub's own
scheduled-workflow delays under load are outside this repo's control short of
moving the trigger off GitHub's `schedule:` entirely (e.g. an external cron
hitting `workflow_dispatch` via the API), which would be a bigger change than
today's scope. Worth another look if it gets worse or if same-day freshness
ever matters more than it does now.

**Decided:**
- Fix the initial zoom rather than extend the tile pyramid, given the
  pyramid change is unvalidated at the scale it would need (memory, timing)
  and the narrower fix satisfies MVP criterion 1's actual wording without
  touching the pipeline.
- Leave the `04:35 UTC` cron time as-is. The observed multi-hour delay is a
  GitHub Actions platform behavior, not a bug in this repo's scheduling
  choice, and does not affect data correctness given the 15-day AS-OF window.

**Rejected:**
- Extending `PREVIEW_MIN_ZOOM`/rendering z6-7, for now - see above. Revisit
  if a future decision explicitly wants the wider single-glance overview back
  (it would need a real memory/timing test on a full-area run before shipping
  it to the daily cron, not just a local smoke test).

---

## 2026-08-28 - The 4 missing tiles explained, section 9.2 AS-OF implemented, daily cron enabled

**Did:** Closed out the three carried-forward items from yesterday, in order,
and each turned out to change the answer to the next one.

*The four tiles.* Rather than re-running a fetch with a longer lookback and
hoping, listed the HR-WSI S3 catalogue directly for `33SVD`, `33SXB`, `33TTF`
and `33TUE`. All four have **zero objects** under `GFSC/<tile>/` - not for the
lookback window, but for every year the bucket holds (2016-2026) - and zero
under `FSC/`, `SWS/` and `WDS/` too. Then enumerated HR-WSI's own GFSC tile
grid with a delimited listing: **983 tiles, containing none of the four.**
So this was never catalogue lag or a discovery bug in `pipeline/fetch.py`;
these squares are simply not part of the service's production grid.

Why not: all four are offshore. Per Copernicus's own `MGRS_tiles.gpkg`
(56,984 Sentinel-2 squares, read straight out of the GeoPackage envelopes),
`33SVD` is 13.832-15.114E/38.755-39.750N and `33SXB` is
16.123-17.387E/36.935-37.942N - open Tyrrhenian and Ionian sea - while
`33TTF` (11.406-12.754E/40.508-41.529N) and `33TUE`
(12.635-13.949E/39.638-40.646N) are Tyrrhenian squares whose only land is a
sliver of sea-level coastal plain at one corner. Note what this does and does
not say: the four *are* valid Sentinel-2 tiles, present in Copernicus's grid.
They are simply not part of HR-WSI's production grid, which excludes sea-only
squares - as it also does for every other square missing nearby (`33TXG`,
`33TYG` mid-Adriatic; `33SUA`, `33SXA` Sicily Channel and Ionian). The
Apennine spine at those latitudes sits at 15-16E and is covered by `33SWD`,
`33TVE`, `33TVF` and `33TWE`, all present. No snow-relevant land is lost.
Removed the four from `MVP_MGRS_TILES` (62 -> 58 tiles) with the evidence
recorded in `pipeline/config.py`, which turns "a tile is missing" from
expected noise into a real signal - so `build_preview` now *fails* by default
when any requested tile has no product (`--max-missing-tiles`, default 0)
instead of quietly publishing a partial map.

*Cadence, measured before choosing a cron.* Listed the last two months of
products for four tiles across three UTM zones and read the S3
`LastModified` of each layer, which is when a product actually became
fetchable. Result: **strictly daily**, 57/57 consecutive product dates
present on every tile with no gaps, and in steady state a product dated `D`
lands at `D+1 00:16-02:55 UTC` (median ~00:45). There is also a real failure
mode: 13-16 Aug 2026 all landed together on the 15th and 17th at 14:00-16:45,
a ~3-day processing backlog later backfilled. Chose `35 4 * * *` - about
1h40m of margin over the worst observed steady-state arrival, off the top of
the hour where GitHub delays scheduled runs most, and finished before the
European morning (06:35 CEST).

*The AS-OF fallback - much smaller than it looked.* The framing carried in
`docs/plan.md` was that this is the biggest open architectural piece. Reading
the code first showed it mostly already existed: `pipeline/asof.py`
`compose_as_of` already takes a *sequence* of daily products and runs the
full section 9.2 per-pixel backward search, and `preview.py` was the only
thing restricting it - `load_tile_products([triplet])`, a one-element list.
So the change was discovery and download (`select_window_products` /
`discover_window_products`, one product per date with the same
greatest-version policy, because `raster_io` refuses two versions of the same
tile/date), plus threading a window through `preview.py`. The frozen semantic
core needed no change at all.

Quantified the benefit on real data before committing to it, using the
Jan-Apr 2026 winter products already on disk from the reconnaissance work.
Composing each date twice - newest product only, then the full 15-day window
- gives, as percent of tile area valid:

| tile | AS-OF | newest only | 9.2 window | gain |
| --- | --- | --- | --- | --- |
| 32TPS | 2026-02-06 | 97.2% | 97.3% | +0.1pp |
| 32TPS | 2026-02-20 | 13.6% | 39.7% | +26.0pp |
| 32TPS | 2026-03-10 | 62.1% | 85.6% | +23.5pp |
| 32TPS | 2026-04-01 | 31.2% | 97.7% | +66.5pp |
| 33TUG | 2026-02-06 | 7.4% | 8.9% | +1.4pp |
| 33TUG | 2026-02-20 | 17.6% | 17.6% | +0.0pp |
| 33TUG | 2026-03-10 | 3.9% | 77.9% | +74.0pp |
| 33TUG | 2026-04-01 | 18.8% | 51.4% | +32.6pp |

Two things worth keeping in mind about that table. The large gains are real
but much of the recovered area is 8-14 days old and therefore drawn at
0.45x opacity per the frozen section 5.2 ramp - the map becomes honest about
older evidence, not uniformly confident. And on `33TUG` 2026-02-20 the
fallback adds exactly nothing: 82% cloud with no valid earlier pixel anywhere
in the window, which is the 14-day ceiling correctly refusing to invent
coverage. Both are the specified behavior, not a shortfall.

Then re-measured at production scale on the actual published run - all 58
tiles, 194.2 M pixels, AS-OF 2026-08-27, composed both ways:

| state | newest only | 9.2 window | delta |
| --- | --- | --- | --- |
| valid | 46.59% | 69.55% | +22.96pp |
| cloud | 19.50% | 3.22% | -16.28pp |
| no-data | 33.01% | 26.33% | -6.68pp |
| water | 0.90% | 0.90% | 0.00pp |
| stale | 0.00% | 0.00% | 0.00pp |

Cloud all but disappears (19.5% -> 3.2%), and of the resulting valid pixels
40.3% are 0-3 days old (full opacity), 26.7% are 4-7 days (0.75x) and 33.0%
are 8-14 days (0.45x), median 4 days. `water` not moving is the terminal-mask
rule behaving correctly, and `stale` staying at zero is expected while every
tile has products throughout the window. The residual 26.33% no-data is
mostly *not* fillable: it is sea and out-of-mask area inside coastal tiles and
the Po plain, where no product on any date has a value - the backward search
removed the 6.68pp that was genuinely recoverable and correctly left the rest.

Also noticed a property that makes this safe: a GFSC product's per-pixel `AT`
never postdates its own product date, so the newest product always wins
wherever it holds a valid pixel and the older window members can only fill
what it left as cloud or no-data. The backward search is purely additive - it
cannot reinterpret fresh data. That also fixes the window size exactly:
section 9.2's 14-day age ceiling means product dates `D-14..D`, 15 days.

*Verified before publishing, not after.* Ran the full 58-tile area locally
with no `--publish-r2` (812 products, 1.0 GB downloaded, 3,492 tiles rendered,
0 missing tiles), captured the live production site's current rendering for
comparison, then served the local run through a dev server on the
CORS-allowed port and captured the same five regions. The Bergamasque Prealps
view - near-solid violet yesterday - resolves to visible terrain with residual
cloud only where it persisted across the whole window. Only then published the
exact run already inspected, without re-rendering it. Afterwards confirmed the
live site had picked it up (`mode: asof-window`, 58 tiles, 0 missing, 24
requests, 0 failures), and that the workflow's own verify step passes against
the real published manifest by extracting and running it.

Published with `keep_runs=2` rather than 7 as a deliberate live exercise of the
prune path on the least valuable object available: it deleted the superseded
2026-08-26 3-tile smoke-test run and left the previous full-area run intact as
the rollback target. Retention is the one operation here that deletes
anything, and last session had already rejected "verified only via a mocked S3
client" for exactly this kind of code. The workflow uses 7.

Added `npm run verify` for that comparison rather than scripting it ad hoc,
since the same five regions will be wanted after every encoding change. It
degrades gracefully against the deployed site, where `window.map` is dev-only:
manifest, control text and request statuses are still checked, and only the
camera moves are skipped.

**Decided:**
- Implement the section 9.2 window *before* enabling the cron, not after.
  Turning on a daily schedule first would have meant publishing a knowingly
  degraded product every day and then changing the encoding under users
  later; the measured cost of doing it now is one afternoon and 1 GB of
  download per run instead of 0.07 GB.
- `--keep-runs 7` retention in R2, and a daily cron *requires* it. Measured
  rendered output per source tile: 0.24 MB in August (near-snowless, so
  almost everything compresses to near-transparent), but 3.1 MB for a snowy
  Alpine tile (`32TPS`, 2026-02-20) and ~1 MB for Apennine tiles. That puts
  a mid-winter full-area run around 130 MB, so unbounded daily retention
  would pass R2's 10 GB free tier inside a single season - against the
  section 12 "free where possible" target. Seven runs keeps a week of
  rollback at roughly 1 GB steady state.
- Prune only *after* `latest.json` has been replaced, and never prune the run
  just published (checked explicitly by run ID rather than trusting it to
  sort newest, so a clock skew cannot delete the run being committed).
- Upload the run's objects concurrently (16 workers, matching `fetch.py`).
  This was not a premature optimization - it came out of the first real
  publish attempt of a 3,492-object run, which was still uploading
  sequentially after ten minutes. `ThreadPoolExecutor.map` keeps the property
  that matters: it is a barrier, so every object is uploaded and any failure
  re-raised before `latest.json` moves.
- Default `keep_runs=None` - never delete anything - so retention only
  happens where it is asked for explicitly, in the workflow. Deleting objects
  from the user's bucket should not be a silent default of a library call.
- Keep `discover_latest_products` / `select_latest_products` rather than
  replacing them, and keep `--window-days 1` working as an exact reproduction
  of the old newest-product-only behavior. It is the natural control when
  something looks wrong in a published run, and it is what produced the
  comparison table above.
- **Do not delete `recon/` yet** (the session's item 5), because three of its
  parts are still load-bearing rather than scaffolding, and today made that
  sharper rather than less so. `recon/.venv` *is* the environment the pipeline
  runs in (yesterday's decision, still true). `recon/data/` holds the Jan-Apr
  2026 winter product archive - gitignored, so not a repo-size question - and
  it is the only local winter data there is; it is what made today's AS-OF
  measurement possible at all, and it would be needed again to re-measure any
  change to the section 5.2/9.2 encoding out of season. `recon/make_overlay.py`
  is the provenance of `app/public/snow/gfsc_32TPS_20260206.png`, which is
  still the frontend's fallback when the R2 manifest is unreachable; deleting
  the script while the asset stays wired in would leave an unreproducible
  binary in the repo. The concrete trigger is therefore not "the pipeline
  works" but **"the fallback is removed"**: once the daily cron has a track
  record and `app/src/map/config.ts` no longer needs the checked-in sample,
  `make_overlay.py` and the asset go together, and `recon/` reduces to
  `findings.md` plus the vendored HR-WSI client kept as the provenance of the
  public S3 credentials in `pipeline/fetch.py`.

**Rejected:**
- Re-running a targeted fetch with a longer `--lookback-days` for the four
  tiles, as the session prompt suggested as the first step. Started with the
  catalogue listing instead because a fetch can only ever report "still
  nothing" without saying why, and the prompt's own instruction was not to
  assume transient lag a second time. The listing answered it definitively in
  one call, and cost less than a download.
- Trusting my own geography for "these are sea tiles", and then trusting my
  own arithmetic for it either. First decoded the MGRS bounds numerically and
  validated the decoder against a known product's real bounds; then, once
  Copernicus's `MGRS_tiles.gpkg` turned up locally, checked the derived bounds
  against the authoritative geometry rather than leaving a derivation in the
  record. Worth having done: the derived latitudes were uniformly 0.090 deg
  too far north across all eight tiles checked, because a Sentinel-2 tile
  extends ~9.8 km past its 100 km MGRS square and I had placed the south edge
  on the square boundary. A systematic offset, not a misplacement - the sea
  conclusion is unchanged - but the numbers in this entry are now the
  authoritative ones. It also sharpened the claim: the four are perfectly
  valid Sentinel-2 tiles, just not ones HR-WSI produces.
- Publishing the new encoding straight to production and checking afterwards.
  Ran the full area locally with no `--publish-r2` first, inspected, and only
  then published - the same reasoning as yesterday's "a rendering bug and a
  cloudy day look identical on screen", applied before rather than after.
- A daily cron without a retention policy, which is what "just add a
  schedule" would have produced. The August run size (14 MB) makes unbounded
  retention look harmless; only measuring a *winter* tile showed it is not.

**Found, not fixed:** The app opens at `initialView.zoom` 6.3 but the tile
pyramid starts at `PREVIEW_MIN_ZOOM = 8`, so a first-time visitor sees the
"Snow cover" control checked and no snow layer at all until they zoom in.
Measured on the live site: of 24 requests on first load, 22 were basemap tiles
and not one was a snow tile. Pre-existing and unrelated to today's change, but
it now hides real daily data and works against MVP success criterion 1. Left
for a decision rather than edited quietly, because both fixes (open at z8+, or
render z6-7) touch a frozen spec choice - see `docs/plan.md`.

**Open / carried forward:** No custom domain in front of `r2.dev` yet
(optional, pre-launch; needs the Cloudflare dashboard or an Admin-scoped
token, same limitation as the CORS policy last session). `recon/` deliberately
not deleted - see the decision above for what still depends on it and the
concrete trigger. Arbitrary historical AS-OF map dates remain deferred
(section 5.3), though the daily job now downloads the whole 15-day window
anyway, so archiving per-day composites is a smaller step from here than it
was yesterday. The first unattended scheduled run has not happened yet - it
will fire at 04:35 UTC.

---

## 2026-08-27 - Production wiring fixed, full-area MVP published and visually verified

**Did:** Picked up from a diagnostic (run right after `52aac84` landed, not yet
acted on) that found the deployed site was still showing nothing real: its
`/snow/latest.json` 404'd, `VITE_SNOW_MANIFEST_URL` had never been set as a
Netlify env var (so Vite baked in the local-file fallback at build time), the
R2 bucket's CORS policy from `docs/r2-setup.md` step 5 was still unapplied,
and only the earlier 3-tile smoke test had ever been published - a local
`npm run build` had looked fine only because gitignored local `snow/`
artifacts from manual testing were still sitting on disk, never committed.

Tried applying the CORS policy myself via the R2 S3 API (`boto3
put_bucket_cors`, credentials sourced from `pipeline/.env.r2.local` into a
subshell as usual) - got `AccessDenied`. The bucket's API token is scoped to
"Object Read & Write" per `docs/r2-setup.md` step 2, which covers object
operations but not bucket-level configuration like CORS; that needs either
an Admin-scoped token or the Cloudflare dashboard. Same story for the Netlify
env var and redeploy: no Netlify credentials or CLI auth were available in
this non-interactive session. Asked the user to do those three dashboard
steps directly (Cloudflare R2 CORS policy, add `VITE_SNOW_MANIFEST_URL` in
Netlify without pasting the value in chat, "Clear cache and deploy site").

While that was pending, ran the full 62-tile MVP publish locally - reused
`recon/.venv` rather than building a new environment, since it already had
rasterio/numpy/boto3/Pillow from the earlier reconnaissance work, and
`pipeline` imports cleanly under it. 58 of 62 tiles had a complete product
within the 21-day lookback as of 2026-08-27 (`33SVD`, `33SXB`, `33TTF`,
`33TUE` did not - worth rechecking on a later run rather than a pipeline
bug, since `32TNP` in the same neighborhood came back 84% no-data on its own
newest product too); rendered 3,411 tiles across z8-11 and published them
atomically to R2 (run `20260827T132216Z`).

Once the user confirmed the dashboard steps, verified all of it end-to-end:
downloaded the live production JS bundle and confirmed the real `r2.dev`
manifest URL is baked in (not the local-file fallback); `curl`-checked CORS
preflight and actual-request headers from both the production origin and a
local Vite dev origin against `latest.json` and a tile PNG (all correct);
confirmed R2's `latest.json` pointer had moved to the new 58-tile run. Then
did the actual "see what the app looks like" check that had been deferred
twice before: a Playwright script drove the live `https://spikely.netlify.app`
(not a local dev server) across several regions and zoom levels. All 71
tile/manifest requests captured during the run returned `200` from `r2.dev`,
and the overlay renders correctly geo-aligned to the basemap. One area (the
Bergamasque Prealps around Vedeseta/Olda) rendered as almost solid violet
(cloud) at hiking zoom, enough to double-check it wasn't a rendering bug:
sampling the raw downloaded `GF.tif` for that exact sub-region directly
confirmed 62.4% real cloud fraction there on the 26 Aug 2026 source product,
with the rest at valid 0%-snow (expected for August, and rendered at a
nearly-invisible 10%-opacity per the frozen ramp) - genuine weather on a
single source day, not a bug, and a concrete illustration of why the
single-newest-product-per-tile preview (no section 9.2 AS-OF backward
search yet) leaves visible gaps.

**Decided:**
- Reuse `recon/.venv` for pipeline runs instead of provisioning a separate
  `pipeline` virtualenv - it already has every dependency in
  `pipeline/requirements.txt`, and `pipeline` imports and runs correctly
  under it. No need for a second environment until something in the two
  dependency sets actually diverges.
- Account-level dashboard steps (R2 CORS, Netlify env vars, Netlify
  redeploys) are the user's to run directly, not something to route through
  credentials pasted into the session - consistent with the existing
  R2-credential-handling rule, extended to Netlify/Cloudflare account access
  more generally now that this session had no automatable path to either.

**Rejected:**
- Installing and interactively authenticating `gh`/`netlify` CLIs to
  automate the dashboard steps - this is a non-interactive session, so no
  OAuth browser flow could complete either way, and account-scoped
  dashboard changes are exactly the kind of action that should go through
  the user directly regardless.
- Trusting the visual "wall of violet" over the Prealps at face value
  without checking it against source data - verified against the raw `GF.tif`
  for that exact sub-region first, since a rendering bug and a genuinely
  cloudy day would look identical on screen but call for very different
  next steps.

**Open / carried forward:** The 4 tiles with no current product
(`33SVD`, `33SXB`, `33TTF`, `33TUE`) - recheck on a future run. No cron
schedule yet (intentional). No custom domain yet. `recon/` not yet deleted.
The single-newest-product-per-tile limitation is now visually confirmed to
matter in practice (see the Prealps cloud check above), strengthening the
case for prioritizing the section 9.2 AS-OF multi-day fallback decision
next. See `docs/plan.md` for the concrete next-session order.

---

## 2026-08-26 - R2-based latest-only preview pipeline: built and live-verified

**Did:** Revised the storage half of the same-day "ship latest only" decision
below, then implemented and live-tested it. Compared three ways to serve the
daily-rendered tiles: (A) the originally-decided static republish through the
existing Netlify deploy, (B) Netlify Blobs, (C) Cloudflare R2. Chose R2, then
built `pipeline/config.py` (the 62-tile MGRS set covering a 60 km corridor
around the Alpine arc and Italian Apennine spine, resolved once against
Copernicus's own `MGRS_tiles.gpkg`), `fetch.py` (lists the HR-WSI S3 catalogue
and selects/downloads only the single newest complete GF/GF-QA/AT product per
tile, never historical ones), `snapshots.py` (compact per-tile `.npz`
composites plus memory-bounded rendering one z8 metatile at a time so the full
AOI never needs to fit in RAM at once), `preview.py` (chains discovery through
render to a local `latest.json` and optional R2 publish), and `publish.py`
(uploads the immutable run first, replaces `latest.json` last, so the app
never observes a partially-published run). Added `.github/workflows/publish-
latest-preview.yml` (manual `workflow_dispatch` only) and `docs/r2-setup.md`.
Updated `app/src/map/snowOverlay.ts`/`config.ts`/`main.ts` to load that XYZ
manifest, falling back to the checked-in one-tile sample overlay if it's
unreachable. Added 16 tests (41 total, all passing); `npm run build` is clean.

Then set up a real Cloudflare R2 bucket (bucket-scoped Object Read & Write API
token, Public Development URL enabled) and ran a live 3-tile smoke test
(`32TNS 32TNT 33TUN`) end to end: real Copernicus catalogue discovery and
download (2026-08-25 products), render (292 tiles across z8-11), atomic R2
upload, and a public fetch of both the resulting `latest.json` and one actual
tile PNG (`200`, valid 256x256 RGBA) - all successful. Credentials were kept
out of the coding session entirely: they live only in a gitignored
`pipeline/.env.r2.local` (matches the existing `.env.*.local` rule; template
committed as `pipeline/.env.r2.local.example`), sourced into a subshell and
never read or printed.

**Decided:**
- Cloudflare R2 over a static Netlify republish: R2 serves tiles as public CDN
  objects with no egress fee; republishing the full static site through
  Netlify on every run risks exceeding the Free plan's credit allowance well
  before meaningful traffic, per Netlify's current per-GB/per-request credit
  pricing. This revises this same MVP decision from earlier today (see the
  entry directly below) before any of it was built - the storage question
  turned out to need settling before the scheduler, not after.
- R2 over Netlify Blobs: Blobs are private to the owning site and need a
  Function/Edge Function to serve each read, turning every tile request into
  an extra hop and consuming Netlify request/bandwidth credits; R2 objects are
  fetched directly by the CDN. Blobs remain the better fit for the day this
  pipeline needs private, site-scoped state instead of public read-heavy
  raster tiles - not the case here.
- Immutable versioned run prefixes (`runs/<runId>/tiles/...`) plus a single
  short-TTL `latest.json` pointer, updated only after every object in the run
  has uploaded. This is what makes the publish atomic from the app's point of
  view and gives cheap rollback (point `latest.json` at a prior run) without
  needing R2 versioning or lifecycle rules yet.
- Keep the GitHub Actions workflow manual-dispatch only, no cron, until a
  human has visually verified real R2-served tiles in the running app - the
  smoke test proves the pipe works, not that the rendered result looks right.
- Preview scope stays "one newest product per MGRS tile," explicitly not the
  frozen section 9.2 multi-day AS-OF fallback - the manifest's `notice` field
  says so. Good enough to validate the whole path end-to-end; not yet the
  eventual daily production job.

**Rejected:**
- Building the scheduler/cron job before the storage architecture was
  settled, as originally planned earlier today - would have wired daily
  automation on top of a storage choice (static Netlify republish) that
  turned out to be the wrong one once actually compared against alternatives.
- Verifying R2 only via unit tests with a mocked S3 client - those already
  passed before any bucket existed and prove the upload *sequence* is
  correct, not that a real bucket/token/CORS-less public URL actually serves
  the result to a browser-shaped request. Ran a real 3-tile smoke test against
  the user's actual bucket instead.
- Pasting R2 credentials into the coding session to run the smoke test -
  used a gitignored local env file sourced into a subshell instead, so the
  values never appear in any transcript or tool output.

**Open / carried forward:** CORS policy not yet applied to the bucket (was
blocked on an empty bucket per Cloudflare's own CORS-editor prerequisite; the
smoke test just populated it, so this is now unblocked). No custom domain yet
- fine short-term, `r2.dev` is rate-limited but usable for this stage. No
visual verification yet of real R2-served tiles in the running app - the
actual point of this whole preview milestone, still pending. No cron schedule
- intentional. `recon/` not yet deleted. The single-newest-product-per-tile
limitation still needs a decision before this preview becomes the real daily
job (see `docs/plan.md` "Next session" list for the concrete order).

---

## 2026-08-26 - MVP data-pipeline/storage architecture: ship "latest only"

**Did:** Brainstormed the data-pipeline hosting/storage architecture (spec
section 15 item 8), triggered by realizing spec section 5.3 ("historical
AS-OF map date") is a required MVP feature, not just the section 7.1 point
chart - and that it implies a forever-growing daily raster archive back to
20 January 2025 (spec section 4.1), not just "today's snow state." Compared
two shapes: (A) daily GitHub Actions job renders one static "latest
conditions" tile set and republishes it through the existing Netlify deploy,
with arbitrary historical map dates deferred; (B) the same daily job instead
appends one compact per-day raster to object storage, plus a small always-on
or scale-to-zero Python/rasterio service that runs the frozen section 9.2
AS-OF selection on demand for any requested date/tile, cached aggressively
since a historical (date, tile) result never changes once computed.

**Decided:**
- Ship Option A for the MVP. It reuses 100% of the pipeline code already
  built (`asof.py`, `mosaic.py`, `tiles.py`) with zero throwaway work, adds
  no new infrastructure or cost beyond the existing free GitHub Actions +
  Netlify setup, and matches the project's running preference for the
  smallest thing that closes the loop over building ahead of validated need.
- Defer arbitrary historical AS-OF **map** browsing (spec section 5.3) out
  of MVP scope. The OSM-object **historical chart** (spec section 7.1) is
  unaffected and stays required - it's small time-series data, not raster
  tiles, and was never the expensive part.
- Set the concrete operating-cost target discussed while comparing options:
  free where possible, up to EUR 20/month acceptable if it substantially
  simplifies things. Recorded in spec section 12.
- Revisit trigger for Option B: once real usage shows people actually want
  to look at past dates on the map, not before. When revisited, the leading
  candidate is Cloudflare R2 (its zero egress fees matter for unpredictable
  tile-read traffic, unlike S3) plus a scale-to-zero container service
  (Cloud Run or Fly.io) reusing `asof.py`'s backward-search logic directly.

**Rejected:**
- Building Option B now. The storage volume itself is cheap either way
  (rough estimate: ~10-20 GB backfill since Jan 2025, growing ~5-10 GB/year,
  a few dollars a month on any provider) - the real cost of Option B is
  operational complexity (a live Python/GDAL rendering service, a cache
  strategy, an object-storage bucket), not money. Not worth taking on before
  the "crazy basic" app has validated anyone wants historical browsing.
- Recomputing historical tiles live from Copernicus/CDSE on each user
  request instead of maintaining any archive of our own. Rejected regardless
  of which storage option we pick later: CDSE's per-run product limits (see
  `docs/plan.md` Track B step 3) and unknown live-request latency/reliability
  make it unfit for synchronous user-facing map requests.

**Open / carried forward:** Full spec/plan updates for this decision (spec
sections 5.3, 12, 13, 15; plan.md pipeline and stack bullets). When Option B
is revisited, first define the exact MGRS tile set covering the Alps +
Italian Apennines footprint (needed for both the one-time backfill and the
ongoing daily job either way).

---

## 2026-08-26 - Real pipeline: browser-ready XYZ tile renderer

**Did:** Added `pipeline/tiles.py`, which colorizes a merged AS-OF composite
per the frozen visual encoding in spec sections 5.2 and 5.4 (snow-cover ramp,
freshness-attenuated alpha, fixed violet cloud, transparent water/stale/
no-data) and slices the result into standard `{z}/{x}/{y}.png` Web Mercator
tiles, skipping fully-transparent ones. Added eight focused tests, bringing
the pipeline suite to 25 tests. Ran it end to end on a real `32TPS` (Ortles-
Cevedale) 11 Feb 2026 composite reprojected through `mosaic.py`'s target-grid
path: 329 tiles written across z8/10/12, and a z8 tile visually inspected
against a dark background matches the tile footprint and snow ramp already
verified by `recon/make_overlay.py`.

**Decided:**
- One module, `render_rgba` (pure colorization) plus tile-warp/write
  functions, not a bigger renderer package - this is the entire remaining gap
  between `mosaic.py`'s composite and "browser-ready tiles" per `docs/plan.md`.
- `render_rgba` needs no per-pixel state branching beyond a cloud override:
  building a 256-entry LUT where indices 101-255 (all non-percentage GF/state
  codes) default to transparent black means water/stale/no-data fall out for
  free, since their `fsc` is already `NO_VALUE` and their `freshness` is
  already zero in `AsOfComposite`. Only cloud needs an explicit override,
  because spec 5.4 gives it a fixed alpha independent of freshness.
- Standard XYZ addressing (`{z}/{x}/{y}.png`, 256px tiles, the OSM slippy-map
  convention) via `rasterio.warp.reproject` per tile, not a single big
  pre-warped raster sliced in Python - reuses the same nearest-neighbour
  warping already validated in `mosaic.py`, and keeps memory bounded per tile
  regardless of composite extent.
- Skip fully-transparent tiles rather than writing them - a mosaic's footprint
  is a rotated MGRS-tile rectangle or a small overlap region, never the whole
  world, so most of any bounding box's tile range would otherwise be empty
  files.
- 0 as a shared nodata sentinel across all four RGBA bands in the tile warp:
  no legitimate encoded pixel is ever all-zero (colors start at 130/160/190,
  alpha at 26), so treating exact zero as "no data" on both source and
  destination is unambiguous and lets one sentinel cover every band.

**Rejected:**
- Reusing `recon/make_overlay.py`'s LUT by import - that module is scaffolding
  with a "GF-only, no freshness multiplier" placeholder ramp explicitly marked
  not authoritative; `tiles.py` rebuilds the same stops directly from the now-
  frozen spec 5.2 hex/alpha values as the source of truth instead.
- `dst_nodata=0` without also setting `src_nodata=0` on the `reproject` calls:
  the first version passed this test suite's synthetic-grid check but silently
  turned every transparent `(0,0,0,0)` pixel into `(1,1,1,1)` on a real GDAL
  warp. This is a known GDAL behaviour - a resampled value that happens to
  equal `dst_nodata` gets bumped by 1 so it isn't mistaken for the nodata flag
  - and it only shows up once source and destination grids actually go through
  GDAL's warp machinery, not in pure-Python arithmetic. Caught by an end-to-end
  run against real data, not by the unit tests alone; worth remembering that
  gap next time a rasterio warp path only gets synthetic-array coverage.
- A paletted PNG per tile (as `make_overlay.py` uses for its one image): the
  freshness multiplier means a single tile can already contain up to ~305
  distinct (color, alpha) pairs (101 percentages x up to 3 freshness bands,
  plus cloud and transparent), over a 256-color palette's capacity without
  quantization. Plain RGBA per tile avoids that complexity; tile files stay
  small regardless.

**Open / carried forward:** Wire up the daily fetch/schedule/publish job that
chains `raster_io.py` -> `asof.py` -> `mosaic.py` -> `tiles.py` end to end and
uploads the result, once the storage/hosting choice (spec section 15 item 8)
is made.

---

## 2026-08-25 - Real pipeline: MGRS overlap and UTM-seam mosaic

**Did:** Added `pipeline/mosaic.py`, which composes each MGRS tile on its native
grid, reprojects semantic fields to a common target grid with nearest-neighbour
resampling, and selects one source for every overlap pixel. Added three focused
tests, bringing the pipeline suite to 17 tests. Tested the real 32TQS/33TUM
Dolomites overlap across the UTM zone 32/33 seam using 6 and 11 February 2026
products: the 90 m Web Mercator overlap grid was 98.80% valid, 0.54% cloud,
0.23% water, and 0.42% no-data. The remaining no-data is source data, not a
seam-generated gap.

**Decided:**
- Compose each tile before reprojecting it. This retains native 60 m evidence
  and lets the frozen AS-OF rule operate where the data is actually aligned.
- In an overlap, water is terminal; otherwise choose the newest valid `AT`,
  then better quality, then lexicographically earlier MGRS tile ID. With no
  valid value, precedence is cloud, stale, then no-data. This rule is now
  frozen in spec section 9.3.
- Reproject every semantic field with nearest-neighbour only. This preserves
  distinct cloud/water/no-data categories and does not manufacture fractional
  snow values across a seam.

**Rejected:**
- Assigning every overlap to a fixed tile: simple, but can discard a newer,
  better-quality observation already available in the neighbouring tile.
- Averaging/blending overlapping values: it would hide disagreement and invent
  percentage values at both snow and categorical boundaries.
- Letting source-file traversal order choose an exact tie: outcomes must remain
  stable across machines and pipeline runs.

**Open / carried forward:** Render the merged semantic result into browser-ready
Web Mercator XYZ tiles, then add daily fetch, object storage, and publication.

---

## 2026-08-25 - Deployed to Netlify

**Did:** Connected `app/` to Netlify via its dashboard's GitHub import (base
directory `app`, build command `npm run build`, publish directory `dist`).
Set `VITE_MAPTILER_API_KEY` as a Netlify env var across all deploy contexts.
Site is live at https://spikely.netlify.app; every push to `main` now
auto-deploys with no manual step. This is the project's first deploy.

**Decided:**
- Ship now, even with a crazy-basic app, to close the deploy loop end-to-end
  and unblock inspecting the app on a real phone - more valuable at this
  stage than waiting for more features.
- Netlify over Vercel/Cloudflare Pages: for a static Vite build with no
  backend, all three are effectively equivalent (free, git-connected,
  auto-HTTPS). Netlify won on zero-preference tie-break, and it was already
  anticipated in `.gitignore` (`.netlify/`).
- Dashboard-based git integration over CLI-based deploys, since the goal is
  hands-off auto-deploy on every push, not one-off manual pushes.
- Left `VITE_MAPTILER_API_KEY` **unmarked** as a Netlify "secret value" and
  scoped to **all** deploy contexts with one shared value.

**Rejected:**
- Marking `VITE_MAPTILER_API_KEY` as a Netlify "secret value" - Vite inlines
  `VITE_*` vars into the client bundle by design, so Netlify's secret-scanning
  would fail the build on a value meant to reach the browser. The real access
  boundary for this key is MapTiler's own domain restriction, not Netlify.
- Scoping the env var to specific deploy contexts (e.g. separate keys for
  production vs. deploy previews) - unnecessary while the MapTiler key has no
  domain restriction yet; would only matter once one is added and it doesn't
  cover preview URLs.
- A committed `netlify.toml` - dashboard-configured build settings were
  simpler for a first deploy; revisit if build config needs to be versioned.

**Open / carried forward:** Set the MapTiler key's allowed-domains restriction
to `spikely.netlify.app` (and any future custom domain) now that the live
domain is known. `app/package-lock.json` is still untracked in git; committing
it would make Netlify's installs reproducible.

---

## 2026-08-25 - Real pipeline: validated GFSC raster-I/O adapter

**Did:** Added `pipeline/raster_io.py`, which discovers the three required
rasters in every GFSC product, parses tile/date/version from the official name,
and reads only one MGRS tile at a time into the AS-OF core. It rejects an
incomplete triplet, duplicate tile/date versions, multi-band data, absent CRS,
unexpected GF/GF-QA/AT dtypes or nodata sentinels, and any CRS/transform/shape
mismatch. Added five temporary-GeoTIFF tests, bringing the pipeline suite to 14
tests.

Validated the adapter on the real 6 and 11 February 2026 `32TPS` products: it
confirmed the shared EPSG:32632 1830×1830 grid, then fed the two daily arrays
to the compositor and reproduced 97.22% valid AS-OF coverage for 11 February.
It also discovered all 91 complete `32TPS` products in the full 15 January to
15 April sample window without exceptions.

**Decided:**
- Treat a product triplet as an all-or-nothing input. A failed/incomplete
download must stop the job instead of silently shrinking the AS-OF search set.
- Refuse multiple versions for a tile/date until a separate explicit version
selection policy exists. Choosing based on filesystem order would undermine the
deterministic selection guarantee.
- Validate daily grids before composition, including across product dates. The
AS-OF core is only meaningful when a pixel means the same ground location in
every source array.

**Rejected:**
- Glob only `*_GF.tif` and assume its sibling layers exist - this turns a
partial product into a later, harder-to-diagnose semantic error.
- Silently resample a mismatched daily source in the loader. Reprojection
belongs to the later render stage, not before native-grid AS-OF selection.

**Open / carried forward:** Define how overlapping MGRS tiles, particularly the
zone 32/33 seam, contribute to one rendered view. Then add Web Mercator XYZ
rendering and daily fetch/publish infrastructure.

---

## 2026-08-25 - Real pipeline started: AS-OF semantic core

**Did:** Committed and pushed the completed post-reconnaissance semantics/UI
checkpoint as `5a53bc5`. Added `pipeline/asof.py`, the first production-pipeline
slice: a vectorized, raster-I/O-independent compositor over aligned GF, GF-QA,
and AT arrays. Added nine unit tests covering minimal-quality forest data,
selection tie-breaks, the 14-day gap boundary, day-15 hiding, categorical
states, terminal water, malformed inputs, and exact freshness factors.

Ran the compositor against real `32TPS` products from 6 and 11 February 2026.
The 11 February product was about 90.5% no-data by itself; two-date AS-OF
selection produced 97.22% valid coverage with acquisition ages of 0-11 days,
0.42% water, and 2.35% remaining no-data.

**Decided:**
- Put production code in a new `pipeline/` package and keep the semantic core
  independent of GeoTIFF discovery, reprojection, XYZ writing, storage, and
  scheduling. Those concerns will wrap one tested implementation of the frozen
  rules rather than each reimplementing them.
- Represent validity separately from FSC with explicit valid/cloud/water/stale/
  no-data states. Non-valid pixels cannot accidentally enter analysis as 0%
  snow; stale pixels retain acquisition age for truthful UI reporting but not
  an FSC value.
- Reject duplicate product dates and misaligned arrays at this boundary. A
  caller must resolve product versions and grids explicitly instead of making
  results depend on input order.
- Use the standard-library `unittest` runner and the existing reconnaissance
  environment for this first slice; introduce a separate production environment
  when raster-I/O dependencies land.

**Rejected:**
- Embedding AS-OF decisions directly in a GeoTIFF/XYZ loop - that would couple
  correctness to storage and make the rules harder to test in isolation.
- Treating the sample overlay generator as the production pipeline - it lacks
  GF-QA/AT and only understands one hardcoded product/tile/UTM zone.
- Starting with scheduling or object storage before the transformation itself
  is correct and testable.

**Open / carried forward:** Add a raster-I/O adapter that discovers GF/GF-QA/AT
triplets, validates their grids/metadata, and feeds them to the compositor. Then
resolve MGRS overlap/UTM seam policy, produce XYZ output, and add scheduled
fetch/publish infrastructure. `recon/` remains until those duties are replaced.

---

## 2026-08-25 - Removed the convergence-only zoom control

**Did:** Removed the throwaway **Zoom to data** button from the snow control,
including its click handler and now-dead CSS. The control now contains only the
snow visibility toggle and current sample-product metadata. The screenshot
harness still drives the map directly and needs no change.

**Decided:** Do not replace it with another recenter/fit-bounds action. The
button existed only to reach one reconnaissance tile from the Alps-wide initial
view; carrying that scaffold into the real-coverage UI would preserve the wrong
interaction model.

**Rejected:** Keeping the button until the pipeline lands - it has completed its
milestone purpose, and leaving known throwaway UI in place makes it easier to
mistake for a product requirement later.

**Open / carried forward:** Build the real GFSC pipeline; no pipeline work was
started in this cleanup.

---

## 2026-08-25 - Snow-data semantics frozen after convergence

**Did:** Closed the five snow-data decisions that reconnaissance had deliberately
left open. Updated `docs/spec.md` sections 4.1, 5.2-5.4, 7.1, and 9.2 with
reproducible rules, removed those items from section 15's open list, and marked
the post-convergence semantics step done in `docs/plan.md`. Aligned the GF-only
reconnaissance LUT with the frozen base ramp and violet cloud color, regenerated
its one sample overlay, and reran its georeferencing check; did not start the
real pipeline.

**Decided:**
- Preserve the proven steel-blue-to-white coverage ramp: sRGB `#82A0BE` at 0%,
  `#C8DEF0` at 50%, and `#FFFFFF` at 100%, with base alpha 26/150/224 out of
  255. Freshness multiplies that alpha by 1.00 at age 0-3 days, 0.75 at 4-7,
  0.45 at 8-14, and 0 from day 15. Nearest-neighbour resampling and hillshade
  above snow are part of the rule, not renderer preferences.
- Treat `AT` acquisition time as freshness and GF-QA as a separate confidence
  signal. All tiers 0-3 remain valid and equally eligible; quality is preserved
  and reported but never used to hide or fade a percentage. Otherwise the real
  Paneveggio forest point, tier 3 on every valid day, would be unusable.
- Keep cloud (`205`), water (`210`), and no-data (`255`) semantically distinct.
  Cloud falls back to violet rather than rock-like grey when no recent value is
  available; water is a terminal transparent mask; no-data is transparent and
  never treated as 0% snow.
- For AS-OF date `D`, choose the valid candidate with the newest `AT`; ties use
  better quality then newer product date. Search backward only while source age
  is at most 14 days. This handles the observed 14-day gap and poor same-day
  coverage, while the 8-14-day alpha makes the age visible and day 15 prevents
  an old value from becoming an indefinite claim about current snow.
- Historical charts show explicit valid product-day values only. They neither
  interpolate nor carry values into cloud/no-data/missing days, including via
  the map's AS-OF fallback; gaps stay visible and labelled.

**Rejected:**
- Filtering out low/minimal GF-QA or attenuating it as though it meant age -
  this would erase forested terrain and conflates confidence with the measured
  `AT` freshness signal.
- Same-day-only or 5-7-day fallback - median valid coverage was only 25-63%, a
  tile became 90% no-data within five days, and a real gap lasted 14 days.
- Carry-forward beyond 14 days or chart interpolation - both create plausible
  snow values with no explicit supporting observation.
- Neutral grey for cloud - it was visually confusable with rock/scree on the
  MapTiler Outdoor basemap. Also retained the earlier rejection of linear
  resampling and of reducing snow opacity to recover relief.
- Extending the GF-only reconnaissance overlay to fake freshness or quality:
  it has neither `AT` nor GF-QA. It was regenerated only to sanity-check the
  frozen base ramp and categorical cloud color; the real pipeline is the right
  place to render their combined semantics. Its numerical/alignment check
  passed; an optional browser re-check could not run because no browser surface
  was available in this session, which does not block the semantic decision.

**Open / carried forward:** Build the real multi-tile GFSC pipeline from these
frozen rules; this session intentionally stopped at the semantic gate.

---

## 2026-08-25 - Multi-tool agent instructions (Claude Code + OpenAI Codex)

**Did:** Split `.claude/CLAUDE.md`'s content into a shared `docs/agent-guide.md`.
Added a root `AGENTS.md` and rewrote `.claude/CLAUDE.md` as one-line adapters
that both point to it, so Claude Code and OpenAI Codex work from identical
instructions instead of two copies that could drift.

**Decided:**
- Third neutral file (`docs/agent-guide.md`) rather than making either tool's
  file the canonical source - keeps the two adapters symmetric, so adding a
  third tool later is another one-line adapter, not a decision about which
  existing file to subordinate.
- `docs/agent-guide.md`, not repo root, for the shared file: it sits alongside
  `spec.md`/`plan.md`/`worklog.md`, the other files it already tells agents
  to read.

**Rejected:**
- `.codex/AGENTS.md`, as originally proposed - Codex (and the open agents.md
  spec more broadly: Cursor, Jules, etc.) looks for `AGENTS.md` at the repo
  root, not inside a `.codex/` folder. Placed at root instead; a file Codex
  never reads would have made this exercise pointless.

---

## 2026-08-25 - Converge: first real snow tile (Track A + B)

**Did:** Scanned all 580 downloaded GFSC products to pick the best sample date.
Built `recon/make_overlay.py`, which reprojects a GFSC `GF.tif` to EPSG:3857 and
writes a paletted PNG + JSON sidecar. Loaded it into the MapLibre map as an
`image` source (`app/src/map/snowOverlay.ts`), added a layer toggle + "Zoom to
data" control (`app/src/ui/snowControl.ts`), and Copernicus attribution. Built a
Playwright screenshot harness (`app/scripts/screenshot.mjs`) to verify the result
visually. Milestone from `docs/plan.md` "Converge: first real snow tile".

**Decided:**
- Product: `T32TPS_20260206` (Ortles-Cevedale). Not the highest-coverage date
  available overall - chosen because the date matters more than the area (see
  findings.md), and this date's ~21% snow-free valley floor doubles as a free
  alignment test against the basemap.
- One reprojected PNG + MapLibre `image` source, not an XYZ tile pipeline: an
  axis-aligned EPSG:3857 rectangle maps exactly onto the source's four-corner
  quad, so no warping pipeline is needed to answer this milestone's questions.
- `raster-resampling: nearest`, not `linear`: GF mixes 0-100 percentages with
  categorical codes (cloud/water/nodata); any averaging kernel invents values
  at the boundary between them.
- Paletted PNG instead of RGBA: GF has ~103 distinct values, so the colour LUT
  doubles as the palette (alpha via tRNS) - 772 KB vs 2.89 MB, byte-identical
  after decode.
- Verified alignment two ways: numerically (independent GeoTIFF-via-pyproj vs.
  PNG-via-sidecar sampling at 11 landmarks + 300 random points, 0 unexplained
  mismatches) and visually (Playwright screenshots at hiking zoom levels).
- Snow layer inserted above landcover/hillshade, below contours/trails/labels -
  then the basemap's existing hillshade layer moved to sit *above* the snow
  (not duplicated) so full-opacity snow doesn't erase the shaded relief.
- `initialView` in `app/src/map/config.ts` left at the Alps-wide default; a
  "Zoom to data" button reaches the one sample tile instead, since retargeting
  the whole map for one sample tile would misrepresent actual coverage.
- `recon/make_overlay.py` is explicitly scaffolding, not the data pipeline -
  marked for deletion once the real fetch/tile job exists (see docs/plan.md).
  Its output PNG is committed anyway: `recon/data/` is gitignored, so without
  the PNG in git a fresh clone has no way to reproduce or see it.

**Rejected:**
- Lowering the snow layer's max opacity to let hillshade show through - fixes
  the relief but makes snow itself harder to read (50% and 100% cover start to
  look similar). The problem was layer order, not opacity.
- Moving the snow layer *below* hillshade - fails specifically on MapTiler
  Outdoor, which draws the `parks` fill above hillshade; snow under a national
  park polygon rendered green.
- A second, duplicate hillshade layer above the snow - brings relief back but
  double-shades every non-snow pixel, making the whole basemap more contrasty
  than intended.
- Git LFS for the overlay PNG - LFS earns its cost on binaries that change
  often; this one is a single 772 KB scaffolding artifact scheduled for
  deletion, and the eventual pipeline ships tiles via object storage, not git.

**Open / carried forward:**
- Whether to commit the overlay PNG + `make_overlay.py` as a unit (decided:
  yes, see CHANGELOG).
- Three new inputs to spec.md section 15's visual-encoding decision: resampling
  choice as an honesty tradeoff, grey cloud vs. rock confusability on this
  basemap, and (now resolved) the hillshade order fix.

---

## 2026-08-25 - GFSC reconnaissance, first real downloads

**Did:** Set up `recon/.venv`, vendored the HR-WSI S3 client, and downloaded real
GFSC products for 4 sample areas (glaciated Alps, forested foothills, Apennines,
an MGRS tile-boundary point) over a 2026-01-15 to 2026-04-15 window - 580
products, ~1.6 GB total. Read the Product User Manual directly to build an
authoritative value codebook rather than guessing from pixel values. Full detail
in `recon/findings.md`; this entry is the narrative summary.

**Decided:**
- No personal Copernicus/WEkEO account needed - the HR-WSI S3 client ships a
  read-only access key; confirmed by reading the client source, not just its docs.
- pip + a plain venv instead of the client's documented conda flow - all its
  dependencies have PyPI wheels.
- Computed the actual MGRS tile-boundary point from real tile-overlap geometry
  (`MGRS_tiles.gpkg`) rather than guessing from a map; the first visual guess
  turned out to fall inside only one tile, not the boundary.

**Findings that shaped later decisions:**
- Quality tier was minimal (tier 3) on every single day at one forested test
  point - not a fluke; the PUM explains gap-filling is mainly for non-forested
  terrain. Directly informed former spec.md section 15 item 2.
- NODATA gaps up to 14 consecutive days at one pixel, longer than the PUM's
  stated 5-7 day compositing window. Directly informed former section 15 item 4.
- Confirmed `QAFLAGS` bit7 (radar/SWS source) lines up exactly with wet-snow
  pixels forced to 100% FSC - documented PUM behaviour, not a bug.

**Rejected:** A separate catalogue-only query pass before downloading - a
handful of tiles/dates is nowhere near the 500-products-per-run limit, and
downloading directly gives the catalogue metadata for free.

**Open / carried forward:** Hadn't yet reprojected or rendered anything for the
map - became the next session's "Converge: first real snow tile" milestone.
