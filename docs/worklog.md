# Working session log

## 2026-09-09 - Refactored pipeline verified end to end in production

Run #15 (`workflow_dispatch`, `a754d13`) published successfully - the first CI
execution of the stage-2 package layout, and the thing that turns "the tests
pass locally" into evidence.

What it proved, in order: the render job's test step passed on a clean runner
under the new `-t pipeline` discovery, including the subprocess isolation test
with its deliberately bare environment; `python -m nevaio_pipeline.render`
resolved through `PYTHONPATH=pipeline/src` with the package never pip-installed;
and the publish job on its separate runner validated the artifact and swapped
the pointer. R2's `latest.json` moved from `20260909T193729Z` to
`20260909T220225Z`, 58/58 source tiles, 979 tiles, no missing tiles.

Then confirmed where it actually matters, in a real browser against production:
the served manifest is the new `runId`, tiles load from that run's directory,
the control reads "9 Sept 2026 - 58 source tiles" with no warning. Netlify had
shipped the frontend half from the same push - the deleted sample PNG returns
404 and the bundle contains no reference to it - so the fallback removal and the
pipeline repackaging were both live simultaneously without either breaking.

**Noted for later, not fixed:** the pipeline publishes only tiles that contain
data, but MapLibre requests the full grid inside the manifest's `bounds`, so
empty cells 404 - five in one production viewport. Long-standing and harmless
in itself; the cost is that a genuine error can hide in the noise. Both
candidate fixes are recorded in `docs/plan.md` rather than argued here.

Self-inflicted annoyance worth remembering: polling the GitHub API every 20-25
seconds from two watchers hit the unauthenticated rate limit mid-run. Checking
R2's public `latest.json` answered the question directly and would have been the
better instrument from the start - the pointer moving *is* the success
condition, and it needs no credentials.

## 2026-09-09 - Snow fallback removed; the reconnaissance archive deleted

The owner took the deferred product decision recorded in REFACTOR.md: drop the
automatic archived-sample fallback rather than keep it as an opt-in demo. When
the published snapshot is missing or fails validation the map now shows no snow
layer at all, and the control renders "Snow data unavailable" - no toggle for a
layer that is not there, and no legend explaining an encoding nothing on screen
uses. `addSnowOverlay` returns `null` instead of throwing, so the caller can
render that state deliberately rather than the app going quiet.

The reasoning that decided it: a months-old raster that reads as current
conditions is a hazard for the decisions this app exists to support, not a
graceful degradation. The amber "showing an old sample tile" warning added for
audit F6 was mitigation for a design that should not have existed.

**A correction that changed the risk assessment.** `data/README.md`, written
earlier the same day, claimed the winter archive "cannot be re-downloaded out
of season". That was wrong and was flagged before the deletion: what cannot be
re-downloaded in September is *today's* snow. HR-WSI keeps catalogue history
back to 2016 - this repository already relied on that when it queried 2016-2026
to prove the four missing tiles were open sea. So deleting the 1.5 GB archive
costs a slow re-download, not the data.

Removed together, because each existed only for the next: the committed
`app/public/snow/gfsc_32TPS_20260206.{png,json}` (the repo's only image, 772
KB), `pipeline/tools/make_sample_overlay.py` that generated it, the vendored
HR-WSI client that was its acquisition provenance, the `pyproj` dev dependency
only that tool needed, `validateImageMeta`/`SnowImageMeta` in the manifest
validator, and `data/` itself. Stage 1 had carefully relocated most of this
hours earlier; it turned out to be a waypoint rather than a destination, which
is the honest outcome of separating things before deciding what they are for.

**Browser-verified before commit, both paths.** Unavailable: control reads
"Snow data unavailable", no toggle, no legend, no `gfsc-snow` layer, basemap
still rendering 737 features, zero console errors. Available (synthetic local
manifest): toggle and legend present, layer added, meta line "9 Sept 2026 - 58
source tiles", no warning. The second case matters because the normal branch
gained a local `overlay` binding - TypeScript rejected reading the narrowed
`this.overlay` inside the change listener's closure, which is a real bug it
caught rather than a style preference.

83 pipeline tests, 30 frontend tests (down from 33: the three sidecar-validator
cases went with the validator), clean build.

## 2026-09-09 - Refactor stage 2: pipeline packaged as `nevaio_pipeline`

`pipeline/*.py` moved to `pipeline/src/nevaio_pipeline/`, with `preview.py`
finally renamed `render.py` - it stopped being a preview on 2026-08-28 when it
became the thing that publishes production. Tests stay at `pipeline/tests/`,
now discovered with `-t pipeline` so they import `tests.artifact_fixture`.

**The interesting decision was whether CI should pip-install the package.** It
should not, and the reason is the F1 isolation boundary: the publish job exists
to hold exactly one dependency (boto3), and installing a src-layout package
needs a build backend inside that job. So the workflow sets
`PYTHONPATH=pipeline/src` instead - hash enforcement stays absolute, the
privileged dependency surface stays at one package, and there is no build step
to audit. `pyproject.toml` exists for local development and carries a comment
saying all of this, because "why is this not pip-installed in CI" is exactly
the tidy-up a future session would attempt.

`[project.dependencies]` is deliberately empty for the same reason. If the real
dependencies were declared there, `pip install .` in the publish job would
resolve the renderer's native raster stack and silently undo the split. They
live in `[project.optional-dependencies]` as `render` and `publish` extras
instead, mirroring the two hash-locked files that remain the actual contract.

**Verified rather than assumed.** A non-editable install into a throwaway venv
outside the checkout: the package resolves from site-packages (asserted, not
eyeballed), `nevaio_pipeline.publish` imports with boto3 alone and no rasterio,
numpy or PIL in `sys.modules`, and the lazy `__init__` exports still defer -
`render_rgba` raises only when touched without the render extra. That is the
F1 property surviving packaging, checked directly.

**One real bug caught by the existing tests,** which is the best argument for
having written them: `test_cli_validation_needs_no_credentials_and_does_not_
import_native_stack` spawns a subprocess with a deliberately bare environment
to prove publication needs no credentials. Under src layout that subprocess
could no longer find the package. Fixed by adding `PYTHONPATH` to that bare
env - it grants no credentials, so the test's point is intact - rather than by
loosening what the test asserts.

83 pipeline tests, 33 frontend tests and a clean build, identical to the
pre-refactor baseline. Both entry points run. The workflow YAML parses and
`test_workflow_security` enforces the new module name, so a half-renamed
workflow fails the suite rather than the 04:35 UTC job.

## 2026-09-09 - Refactor stage 1: `recon/` dissolved

Started the deferred repository refactor, on the argument that this is the
cleanest checkpoint available - security work just closed, tree clean, nothing
half-done - and that stage 1 is the one that gets genuinely worse with time,
since it hinges on verifying a data archive that grows every winter.

**Sequencing decided, and worth not re-deriving.** Only stage 3 (regroup the
frontend into feature folders) touches the same files as the pending mobile
fix. Stages 1, 2, 4 and 5 are Python, docs and contracts, so they are
orthogonal to it. Stage 3 therefore goes *after* the mobile pass rather than
before: its own instruction is to "preserve responsive styling", and that
styling is currently broken, so there is nothing to preserve until it is fixed
and verified on a device. Doing the moves first would mean debugging layout in
a tree that had just been rearranged, with no known-good baseline to diff
against. Note the counter-argument that was weighed and rejected - "sooner is
cheaper" does not apply here, because `git mv` preserves in-file edits, so
fixing mobile before the move costs exactly zero rework.

**Baseline first.** 83 pipeline tests, 33 frontend tests, clean build recorded
before touching anything; all three identical afterwards.

**The environment was the real finding.** `recon/.venv` was Python 3.14.5,
undeclared, and its `pyvenv.cfg` still pointed at `/Projects/spikely/` from
before the rename. Meanwhile CI runs 3.12 - so every local test run was
evidence about a different interpreter than the one that publishes production
data. Worse, `pipeline/requirements.txt` is hash-locked for **linux x86_64**
(it says so in its own `uv pip compile` header), so CI's lock cannot be
installed on a Mac at all; there was no reproducible local install path, only
an accreted venv. Now `pipeline/.venv` on 3.12 via `uv`, from a new
`pipeline/requirements-dev.in` that mirrors the render surface and carries the
one dev-tool-only dependency (`pyproj`, for the sample overlay tool). The two
hash-locked files stay CI's contract and stay minimal - the publish
environment's smallness is a security property from the F1 work, not tidiness.

**The 1.5 GB archive moved with proof, not hope.** md5 of all 3484 files before
and after: identical. It was a same-filesystem rename, so no copy and no
delete-originals step ever existed - the failure mode the plan warns about
could not arise. Now `data/research/`, with `data/README.md` recording what it
is, why it matters (it holds Jan-Apr real snow, and the live catalogue in
September returns a near-snowless Alps, so encoding changes cannot be evaluated
against re-downloaded data out of season), and where it came from.

**Strongest verification available:** `pipeline/tools/make_sample_overlay.py`
run from its new home against the relocated archive reproduces the committed
`app/public/snow/gfsc_32TPS_20260206.png` **byte-for-byte**, and its own
georeferencing self-check passes - 11/11 landmarks, 300 random points, 0
unexplained. That single run validates the data move, the tool move, the path
rewrites and the new interpreter at once. The tool gained explicit
`--input`/`--output-dir` arguments instead of a positional-or-hardcoded path.

**Kept, against the instinct to delete.** The vendored HR-WSI client is unused
by production (`pipeline/fetch.py` has its own downloader) but it is the
acquisition provenance for the archive and carries a third-party licence, so it
moved to `pipeline/tools/vendor/hrwsi/` with a README note that it is provenance
only and not installable from the current venv. Its 16 MB `MGRS_tiles.gpkg` is
research reference data, not a build input - production hardcodes its 58-tile
list in `pipeline/config.py` precisely so publication never depends on it - so
it went to `data/research/reference/`, still ignored.

**Deliberately not done:** the committed sidecar's `note` field still reads
"Generated by recon/make_overlay.py". That is historical provenance of when the
asset was made, and the plan says not to hand-edit generated sidecars to erase
an old path. The PNG is byte-identical, so only the note differs; `data/README.md`
explains why it looks stale.

**Answered along the way:** asked why the repo contains images at all. It
contains exactly one - the 772 KB fallback overlay - and it is a shipped
frontend asset in `app/public/`, not data; the whole `.git` is 5.2 MB. Whether
the automatic fallback should exist at all is REFACTOR.md's deferred product
decision, still unapproved, and recommended for after the OSM panel work since
the sample is currently the only way to exercise that path without breaking R2.

## 2026-09-09 - Recordkeeping cut from four surfaces to two

Four files were narrating the same events - `CHANGELOG.md`, this worklog,
`docs/plan.md` and `PROMPT_TO_RESUME.md` - and "what is left to do" was spread
across five (those, plus `docs/spec.md` section 15 and `docs/security.md`).
Today's maplibre revert got written four times. The fix is a rule rather than a
merge: **records are split by tense.** The worklog is the past, `docs/plan.md`
is the future, and nothing appears in both.

`docs/plan.md` went from 252 lines to 62. It had accreted a status paragraph, a
55-line DONE list and the entire 170-line repository refactor plan (a second
copy of `REFACTOR.md`), leaving roughly twelve lines of genuinely
forward-looking content buried at the end. It is now status, next-in-order,
open, and not-doing-yet, with a rule at the top: when something ships it
*leaves* the file. The refactor plan is a pointer to `REFACTOR.md` now, since
two copies of a deferred plan will drift and the drifted one is what gets read.

**`CHANGELOG.md` retired to `docs/archive/`, not deleted.** The counterintuitive
call, so the reasoning: the usual instinct is to keep the changelog and treat a
decisions log as the optional extra. Inverted here. A changelog answers "what
changed between versions" for people who were not present - this repo has no
tags, no releases and no external users, and all 240 of its content lines sat
in one `[Unreleased]` block. The worklog answers "why is it like this," which
is the question that actually costs a future session money. Restore a generated
changelog at the first public MVP release. The archived file carries a header
saying so.

**`PROMPT_TO_RESUME.md` retired.** An honestly maintained plan.md *is* the
resume prompt, and the guide's rule to rewrite it fully on every commit and
push was the most expensive line in the whole document. It was untracked, so it
was moved out of the tree rather than deleted.

Also folded in: the mobile testing pass is now item 1 in the plan. A quick
real-device check found the search bar overflowing the screen. The UI has only
ever been verified at desktop viewport sizes, including in Playwright, against
a spec whose section 10 is explicitly mobile-first.

**Rejected:** merging the worklog and the changelog into one file. The split
that mattered was tense, not audience, and the changelog side of that merge had
no distinct content left to contribute.

## 2026-09-09 - Security work wrapped up; posture recorded in-repo

Closed out the audit. The owner confirmed the remaining console items: the
repository-level R2 secret copies are deleted, the Cloudflare token is Object
Read & Write on this bucket alone, Netlify has only the two intended VITE_
variables, and Actions failure alerting is on. F10 (the r2.dev endpoint) is the
one finding left open, deliberately deferred.

`main` now has a ruleset blocking force pushes and deletions, with no
pull-request requirement and no bypass actors - the middle ground proposed
after the owner pointed out that requiring PRs would stop the coding agent
pushing entirely. Worth knowing for next time: GitHub creates rulesets with
enforcement **disabled**, so one has to be switched to Active separately; the
public API reports `protected: false` until that happens, which is how this was
caught.

Wrote docs/security.md so the audit report itself can leave the repository. The
report is untracked, so deleting it would destroy the only record of *why*
things are the way they are; and the repository is public, so committing it
verbatim would publish a catalogue of weaknesses, accepted risks and infra
detail. The new doc is control-focused instead - safe to publish, and it names
the couplings that are invisible in the code: the CSP is an origin allowlist
that must change with any new outbound destination, the manifest validator must
change if the pipeline moves where tiles live, and maplibre must not be
"upgraded" to silence npm audit. Recommended keeping the original report
outside the repo rather than deleting it.

Also folded the CSP warning into docs/r2-setup.md at the custom-domain step,
since that is where someone will actually be standing when the trap matters.


## 2026-09-09 - maplibre-gl upgrade attempted, measured, and rejected

`npm audit` reports a critical advisory against maplibre-gl
(GHSA-jrc7-96c5-q579, XSS sanitizer bypass in `DOM.sanitize()`) affecting every
version <= 6.4.0, which includes the 4.7.1 this app uses. The upgrade to 6.9.0
was started on the strength of that severity label before asking whether the
vulnerability was reachable here. That was the wrong order, and the user
challenged it; the pinned 4.7.1 was the version every visual check in this repo
had been done against, and it turned out to be load-bearing.

**Reachability.** `DOM.sanitize()` guards HTML that MapLibre renders itself:
popups, HTML markers, attribution. This app opens no popups, creates markers
with no HTML, and its custom attribution is a literal string in main.ts. The
only remote HTML near that sink is MapTiler's own attribution from style.json,
so reaching the bug requires MapTiler to be compromised - and the CSP shipped
earlier today (`script-src 'self'`, no unsafe-inline) blocks the script
execution an injection would then need.

**Cost of the upgrade.** 6.x does not render this basemap at all. Measured by
counting requests and rendered features against the real MapTiler style: 4.7.1
fetches 54 vector tiles and renders 2279 features; 6.0.0, 6.4.1 and 6.9.0 fetch
the TileJSON, then request zero `.pbf` tiles and render nothing. No console
error, no map error event, no failed request - the map just comes up blank
under a working snow overlay, which is exactly the failure most likely to reach
production unnoticed. 5.x renders correctly but is inside the same advisory
range, so it is not an option either.

**Decision: stay on 4.7.1**, documented in docs/agent-guide.md so a future
session does not reflexively "fix" the audit warning. Revisit when a 6.x
release renders this style, or if the app gains popups or starts rendering
remote HTML - either changes the reachability analysis.

Two incidental findings worth keeping. First, under 6.x the `load` event never
fires for this style, because the MapTiler style's unused sources
(terrain-rgb, maptiler_planet) never report themselves loaded; anything built
on `map.on("load")` would silently never run. Second, `app/scripts/screenshot.mjs`
waits on `map.loaded() && map.areTilesLoaded()`, so it would hang forever under
6.x - noted in case the upgrade is retried.

Also verified on the shipping 4.7.1 build, which is what F6 and F11 now rest
on: 54 vector tiles, 2279 rendered features, the snow overlay present, the
"Live data unavailable" sample warning showing for the fallback, and a search
for "Rifugio Payer" returning the hut first with its hut icon and flying the
map to 10.543/46.528 at zoom 15 with one marker. The MapTiler key now accepts
localhost (the user added it while fixing F9), which is what made this
verification possible at all.


## 2026-09-09 - F11 place search moved to MapTiler Geocoding

The audit's F11 was not just a rate-limit warning: the OSMF Nominatim policy
prohibits client-side autocomplete outright and caps the whole application at
one request per second, which no per-browser debounce can enforce. So the
shipped as-you-type search was outside the provider's terms, not merely near a
limit. The user chose to switch to a provider that permits autocomplete rather
than degrade the search to explicit submissions.

Picked MapTiler Geocoding: it reuses the basemap's existing key (no new
credential, no new CSP origin - `nominatim.openstreetmap.org` came back out of
`connect-src`), and its results are still OSM-derived, which was the original
reason for preferring Nominatim in the first place. Recorded as spec amendment
v1.9, since section 15 item 5 had explicitly considered and rejected this exact
provider; the amendment states what changed and what it costs rather than
quietly editing the old decision.

Two things only became visible by querying the real API rather than reading
docs. First, the default result set is dominated by streets and addresses:
"Ortles" returned four streets named Via Ortles and no mountain at all, and
"Gran Sasso" and "Passo dello Stelvio" behaved the same way. Constraining
`types` to POI and place classes fixes it - Ortler/Ortles, Payerhuette/Rifugio
Payer and Stelvio Pass then rank first. Second, POI features expose their raw
OSM tags in `properties.feature_tags`, so the existing icon rules keep working
unchanged; administrative results have no tags and fall back to MapTiler's
place vocabulary under a "place" category, matching how Nominatim reported
towns.

Classification takes the first meaningful tag from an ordered key list and
skips bare `yes` values, because Payerhuette carries `building=yes` alongside
`tourism=alpine_hut` and the wrong precedence would silently cost every hut its
icon. There is a test for exactly that.

Changed the result bounds from Nominatim's `[south, north, west, east]` tuple
to named edges. The old shape was a standing transposition hazard - the same
class of silent bug as the `category`/`class` field-name mistake this file
records from 2026-09-06 - and MapTiler's bbox is in yet another order
(`[west, south, east, north]`), so converting between two differently ordered
anonymous tuples was worth removing outright.

Geocoder responses are now treated as untrusted, per the audit's point that a
malformed response should not be able to break map navigation: a feature whose
centre is missing, non-numeric, non-finite or outside real lon/lat is dropped
rather than passed to `map.flyTo`, one bad feature does not empty an otherwise
good list, result counts and label lengths are bounded, and a broken bbox
degrades to the point-zoom behavior instead of producing a nonsense span.

Split the pure parsing into `geocodeResult.ts` so `npm test` can exercise it
under plain Node (the network module imports Vite config and
`import.meta.env`, which Node cannot resolve). Same core-independent-of-I/O
split the Python pipeline already follows.

Verification: 33 frontend tests pass, tsc and the Vite build are clean, and the
fixtures are trimmed from real API responses rather than invented. Not yet
verified in a browser: the production MapTiler key now correctly rejects
localhost, so no local run can load the map until a development key exists.


## 2026-09-09 - F6 manifest validation

The frontend now validates the snow metadata it fetches
(`app/src/map/manifestSchema.ts`) before any of it reaches MapLibre. The design
question was where to get the allowlist of acceptable tile hosts from. Rejected
a hardcoded R2 hostname in the frontend, which would have to be kept in sync
with the CSP, the pipeline and the F10 custom-domain migration in three
places. Used the manifest URL itself as the trust anchor instead: it comes from
build-time configuration rather than from the network, so requiring every tile
URL to resolve to the same origin *and* the same directory, under
`runs/<the manifest's own runId>/tiles/`, needs no extra configuration and
survives the custom-domain move untouched. The deployed CSP remains the
independent second layer.

Also refused: embedded URL credentials, query strings and fragments, scheme
changes (so `data:`/`javascript:` templates cannot get through), protocol-
relative hosts, path traversal out of the run directory, and a template naming
a different run than the manifest does. Zooms, bounds, counts, identifier
formats and string lengths are bounded, and contradictory counts
(sourceTileCount above requestedSourceTileCount) are rejected.

Per the audit's point about not silently presenting stale data as ordinary
data, `SnowOverlay` now carries `isSample`, and the snow control renders an
amber "Live data unavailable - showing an old sample tile" line when the
fallback is in use. A rejected manifest logs at error level, not warn: a
malformed published document is a louder event than a missing one.

Tests run headlessly under Node 26, which executes the TypeScript directly, so
the validator needed no bundler or browser harness - `npm test`, 21 cases.
Test files are excluded from the browser build's tsc pass rather than pulling
@types/node into the app.

Verification: 21 validator tests pass; the real live `latest.json` from R2 and
the checked-in sidecar both validate, which matters more than the negative
cases - a validator that rejected production would be worse than none. tsc and
the Vite build are clean. Not yet verified: how the sample-data warning
actually looks, because the production MapTiler key now correctly refuses
localhost and no development key exists yet.


## 2026-09-09 - F2 input boundaries

Restricted and bounded what the renderer will parse. The audit's demonstrated
primitive was a VRT named `*.tif` whose SimpleSource read a raster outside the
input directory; the fix is opening with the driver pinned to GTiff, verified
by reproducing the probe both ways in a test - an unrestricted open really does
return the outside file's marker pixels, and the pipeline's restricted open
raises. Keeping the demonstration in the test is deliberate: a bare "it raises"
assertion would still pass if the restriction were quietly removed and the file
merely happened to be invalid for some other reason.

All shape checks moved ahead of `dataset.read`, so nothing allocates an array
for a raster it has already decided to refuse. Added: exactly 1830x1830, 60 m
axis-aligned pixels, an origin inside the northern-UTM range, and a CRS whose
EPSG code matches the UTM zone in the product's own MGRS tile name - a raster
filed under 32TPS but georeferenced in zone 33 is not that tile. Symlinked
inputs are refused, matching the artifact validator.

The exact-1830 requirement broke the existing 2x2 synthetic fixtures. Rejected
weakening the check to "square and no larger than 1830", which would have kept
the fixtures working: the equality is the stronger authenticity signal and
costs nothing in production. Instead `load_tile_products` takes an
`expected_pixels` argument that only tests pass, and a test asserts the
production default is still the real measured shape.

Volume ceilings live in `pipeline/config.py`, derived from measurement rather
than guesswork: 2320 real layer files in `recon/data` are all 1830x1830 GTiffs
under 1.4 MB, so the per-object limit is 16 MiB and the per-run download limit
12 GiB (about 3x a normal 58-tile, 31-date window). An oversize catalogue
object is dropped during grouping rather than raising, so its product becomes
incomplete and the tile falls back to another date in the window; a tile left
with nothing still raises through the existing require_all path. Chose that
over failing the whole daily run on one anomalous upstream object.

Not implemented: the audit's suggestion to parse in a network-isolated
sandbox. The render job already holds no publication credentials after F1, and
adding a container/seccomp layer to a GitHub-hosted runner is a larger change
than the residual risk justifies right now. Recorded rather than silently
skipped.

Verification: 83 tests pass (up from 78, up from 70 before F1). A real
end-to-end render of 31 genuine GFSC products for 32TPS produced 123 tiles and
passed `pipeline.publish --check-only`, so the stricter loader accepts real
Copernicus data.


## 2026-09-09 - F1 verified; F4/F5/F7/F8 fixed

Confirmed F1's activation from evidence rather than assumption. The manual
`workflow_dispatch` run on `main` (sha f4ee604) succeeded on both jobs:
rendering on one runner with no R2 credentials, then validation-before-secrets
and publication on a second. The published run 20260909T193729Z covers 58/58
source tiles with none missing, and the live `latest.json` matches it, so the
receipt verification is real rather than vacuous. The GitHub API also confirmed
that the `production-r2` environment has exactly one deployment branch policy -
branch `main`, with no tag rule - which is the independent control the YAML
guard cannot provide. The one F1 item that cannot be checked without an
authenticated client is the removal of the repository-level R2 secret copies;
the owner reports having deleted them.

F3 needs no separate work: F1's artifact validator is on both the CI and local
`--publish-r2` paths, so the "upload everything, follow symlinks" primitive is
already gone. Recorded rather than reimplemented.

Then a batch of the low-risk findings, by the owner's choice of batching:
- F5: `app/public/_headers` with a `default-src 'none'` CSP. The allowlist was
  derived from the actual style graph (fetched MapTiler's outdoor style and
  walked it for hosts: only `api.maptiler.com` for data) rather than guessed.
  `style-src` keeps `'unsafe-inline'` because MapLibre sets style attributes;
  `script-src` deliberately does not get a matching concession, since a CSP
  that allows arbitrary script defeats its own purpose. `worker-src blob:` is
  required by MapLibre's worker construction.
- F4: Vite 5.4.21 to 8.2.2. Staying on 5.x was rejected: the advisory ranges
  include every 5.x and 6.x release, so no patch-level move exists. The dev
  server binds 127.0.0.1 by default; `--host` still opts in, verified by
  checking the listening socket both ways.
- F8: ignore-all-then-allowlist environment rules, verified with
  `git check-ignore` for both the secret shapes and the committed templates.
- F7: `pipeline/.env.r2.local` set to 0600.

New finding, not in the 2026-09-06 audit: maplibre-gl has a since-published
**critical** advisory (GHSA-jrc7-96c5-q579, XSS sanitizer bypass in
`DOM.sanitize()`, affecting <= 6.4.0). The app is on 4.7.1, so the fix is a
two-major upgrade and is being handled as its own verified step, not folded
into this batch.

Verification: `npm run build` (tsc + Vite 8) clean; `npm run check-csp` reports
no CSP violations with the MapTiler style, vector tiles, glyphs and workers all
loading under `default-src 'none'`. The R2 legs cannot be exercised from
localhost because the bucket's CORS policy allows only the production origin -
which is the bucket behaving correctly - so the harness takes `NEVAIO_URL` to
run the same checks against the deployment after these headers ship.

Rejected: hardcoding a wildcard `https://*.r2.dev` in the CSP (it would allow
any Cloudflare account's dev bucket, defeating the point of an origin
allowlist). The specific bucket host is pinned instead, with a maintenance note
in `_headers` that the F10 custom-domain migration must update it in the same
change.

Still open: F2 (raster driver/resource bounds), F6 (manifest validation),
F9-F11, the maplibre upgrade, and the owner-side provider settings.


## 2026-09-09 - Deferred refactor prompt recorded

The user accepted the latest chat refactor direction but explicitly deferred
implementation. Added root REFACTOR.md as a self-contained prompt for a future
coding assistant, including prerequisites, stage ordering, data preservation,
publisher isolation, contract packaging, and acceptance criteria. No source,
data, environment, or deployment changes were made.

The new prompt explicitly supersedes conflicting layout details in the older
docs/plan.md proposal: installable mostly-flat Python package, frontend feature
grouping, contracts/, and pipeline/.venv. Historical records stay unchanged;
reconciling the older active plan is an implementation prerequisite. Automatic
fallback removal remains a separately approved product change, not part of the
structural migration. Refactoring must not interrupt security activation work.

Validation: documentation-only change; checked whitespace/diff integrity. No
application tests or live publishing required. Implementation remains deferred.

## 2026-09-09 - F1 workflow activation approved

The user confirmed that the GitHub environment is configured, then explicitly
approved committing and pushing the prepared F1 changes to main. Re-ran all
70 tests successfully before activation; git diff --check also passes.
Environment settings are user-confirmed, not independently API-verified:
this session has no authenticated GitHub management client.

The remaining activation steps are removing the repository-level copies of
R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (keeping the production-r2 environment
copies), then running and checking a full-area publication. Until these are
verified, do not describe F1 as operationally closed. Pushing main also triggers
Netlify's normal build. The audit report and local resume file stay untracked;
no credentials are included in the commit. F2 and other remaining findings
have not been authorized for implementation yet.


## 2026-09-07 - Repository structure review; refactor plan recorded

**Did:** Reviewed the whole tree for readability/maintainability and wrote the
resulting four-stage refactor plan into `docs/plan.md` ("Repository structure
refactor"). No code moved - this session only inspected and recorded.

The framing question was "why do we still have the old `recon/` folder," and
the answer turned out to be structural rather than neglect: `recon/` holds
four things with four different lifecycles - the local Python interpreter
(`.venv`, 347 MB, Python 3.14.7), the 1.5 GB winter GFSC fixture archive, a
dead vendored Copernicus S3 client (fully superseded by `pipeline/fetch.py`,
imported by nothing), and the live generator of the committed fallback overlay
- plus `findings.md` and a stale requirements file. Because they share one
folder, no single delete trigger could ever fire, which is exactly why the
"delete `recon/` when the pipeline replaces it" note has been carried forward
unactioned since 2026-08-25. The plan unbundles rather than deletes.

Three further problems were found while looking: the local environment is
undeclared and runs 3.14.7 against CI's hash-locked 3.12; the dependency
boundary the F1 security work now enforces (publisher installs boto3 only) is
invisible in the flat package layout, which is why `pipeline/__init__.py`
needed lazy exports as a workaround; and the four freshness hex values are
hand-synced across `pipeline/tiles.py` and `app/src/ui/snowControl.ts`, with a
third divergent ramp in `recon/make_overlay.py`.

**Validated:** Nothing to validate - no code changed. Claims in the plan were
checked against the tree: `grep` confirms nothing imports `make_overlay.py` or
`recon/vendor/hrwsi/`; `pipeline/fetch.py` reaches
`s3.WAW3-2.cloudferro.com`/`HRWSI` directly via boto3; the duplicated hexes
are at `pipeline/tiles.py:64-67` and `app/src/ui/snowControl.ts:8-11`.

**Decided/rejected:** Unbundle `recon/` instead of deleting it - the `.venv`,
the winter archive, and the fallback overlay's provenance are all load-bearing
and simply misfiled. Rejected renaming `app/` (Netlify's base directory is set
to `app` in the dashboard, with no committed `netlify.toml` - pure churn plus
a manual dashboard step). Rejected a Python src-layout and any monorepo tool
(Nx/Turborepo/pnpm workspaces) as overhead for two apps in two languages.
Rejected replacing the `.in`/`.txt` dependency locks with a `pyproject.toml`:
the hash-locked, wheel-only, two-surface split from today's F1 work is
deliberately more constrained than a plain pyproject would be. Noted but not
resolved: the existing lock is compiled for `x86_64-unknown-linux-gnu`, so a
single lock cannot serve both CI and local macOS arm64 - Stage 2 has to pick
between a second platform lock and an unlocked local resolve.

Also noted that this plan cuts against the standing "small, visible, working
steps over broad refactors" ground rule, and accepted on the grounds that
stages 1-2 are behavior-free and the remaining disorder now costs safety
margin (undeclared interpreter, hand-synced palette) rather than aesthetics.
Stages 3-4 are explicitly allowed to wait.

## 2026-09-07 - Security audit F1: isolate publication credentials

**Did:** With the user's explicit approval for F1 implementation/testing only,
prepared a split render/publish workflow. Renderer has no R2 credentials;
publisher runs on a fresh GitHub-hosted runner, downloads data outside its
source checkout and injects environment secrets only at publication. Both
jobs are restricted to main, and publication names `production-r2` (the owner
must configure its branch rule and migrate the secrets). Pinned official
Actions SHAs; generated hashed, wheel-only Python 3.12 dependency locks for
render/test (16 packages) and publisher (7). No shared pip cache.

Added standard-library artifact validation, a check-only/publish CLI and
regression tests. Validation rejects links, unexpected paths/metadata,
inconsistent coverage, oversized inputs and invalid PNGs before any S3
client is created. This also fixes the generic unsafe upload behavior from
F3 as a necessary part of the F1 transfer boundary. Receipt verification now
checks that public latest.json equals this run's publication. A new isolation
test caught eager package exports importing the native raster stack in the
publisher; lazy exports preserve the API without that import side effect.

**Validated:** 70 tests pass in a fresh Python 3.12 environment; actionlint
1.7.12 passes (external shellcheck/pyflakes disabled). A separate environment
with only the seven publisher dependencies successfully ran --check-only
without credentials or native raster imports. Linux x86_64/Python 3.12 wheels
were resolved and their lock hashes checked, but no Linux runner was executed.
OSV returned zero known advisory matches for the 16 locked packages. Tests
cover malformed/oversized PNGs, bounded decompression, metadata poisoning,
symlinks/hardlinks, unsafe paths, credential scopes and upload failure before
pointer/prune. The installed affine version emits existing pending-deprecation
warnings; no production raster semantics were changed.

**Decided/rejected:** Step-only secret scoping in the original job would allow
malicious render software to persist into the publication step, so use separate
runners. Do not import or execute transferred code. Do not install Pillow/GDAL
just to validate output in the privileged job; validate the bounded renderer
PNG format with the standard library. Do not enable required human reviewers
by default because that would stop unattended daily updates. Do not claim
validated files prove honest snow pixels or eliminate publisher supply-chain
risk. Keep the audit report unchanged as requested.

**Open:** Changes are local only: no commit/push, GitHub settings, R2 writes or
deployment. Owner must create production-r2, allow exactly branch main, copy
R2 secrets there, then remove repository copies when the revised workflow is
activated. See docs/publishing-security.md for the safe migration sequence.
F1 is not operationally closed until that configuration and a live run are
verified. F2 and the other findings still need their own approval/work.
The directory and git remote now both use nevaio; the old resume note's rename
follow-ups had already been completed by the user.

## 2026-09-07 - Renamed Spikely -> Nevaio

**Did:** Asked for a better app name than "Spikely" and proposed a broad,
grouped brainstorm: descriptive options (Snowline, SnowTrail, Snowfield),
alpine/mountaineering vocabulary (Névé, Firn, Nevaio, Cresta, Vetta, Passo),
freshness/honesty-themed options (SnowSight, ClearSnow, SnowWatch), and
gear-themed options keeping some DNA from "Spikely" (Crampon(s), IceSpike).
Flagged names to avoid and why: anything implying live/real-time data
(fights the app's own honesty-about-staleness design) or safety/avalanche/
depth (explicit spec section 9.1/14 non-goals). Checked the top 4-5 picks
with a web search for an existing competing app of the same name before
recommending; none collided. User picked **Nevaio** (Italian for a
persistent snow patch - fits the Alps + Italian Apennines MVP scope).

User then renamed the Netlify site directly (now `nevaio.netlify.app`),
which broke the snow layer - diagnosed live rather than guessing: `curl`
against the R2 manifest with `Origin: https://nevaio.netlify.app` initially
returned no CORS header (the bucket's CORS policy still only allowlisted
`spikely.netlify.app`), confirming the cause before the user fixed it
themselves in the Cloudflare dashboard. Re-ran `npm run verify` against the
live site afterward: manifest loads (58 tiles, run `20260906T210131Z`), and
the only failed requests are the same 9 known low-snow-season empty-tile
omissions already documented, not a regression.

Then renamed the rest of the project to match, per the user's explicit
"rename everywhere, including GitHub" request. `grep -rliE spikely`
(excluding `node_modules`/`.git`/`dist`) found 16 files.

**Decided:**
- **Historical/dated content is never rewritten**, only added to - the same
  policy this file already applies to itself. `CHANGELOG.md` entries,
  earlier `docs/worklog.md` entries, and `docs/spec.md`/`docs/plan.md`
  amendment notes describing a specific past verification (e.g. "verified
  end-to-end on `https://spikely.netlify.app`" on 2026-08-27) describe what
  was literally true at that moment; rewriting the URL there would be
  revisionist. Only "living" text - titles, current-status lines, active
  config/instructions, dev tooling - was updated to Nevaio. New dated
  entries (this one; `docs/spec.md` Amendment v1.8; a `CHANGELOG.md`
  `[Unreleased]` bullet) record the rename itself instead.
- **The Cloudflare R2 bucket itself stays `spikely-snow`, not renamed.** R2
  has no in-place bucket rename - doing this "properly" means creating a new
  bucket, copying every object, and repointing `R2_BUCKET`/
  `R2_PUBLIC_BASE_URL`, for a name nobody outside this repo ever sees. Added
  a clarifying note in `docs/r2-setup.md` instead so a future reader isn't
  confused finding a bucket called `spikely-snow` in a project called
  Nevaio.
- **The GitHub repository rename is a manual step for the user.** `gh` is
  not installed in this environment, so it can't be done from here; GitHub
  Settings (or the user's own `gh`/API access) is the path. Once done, the
  local `origin` remote needs `git remote set-url origin
  git@github.com:jcredi/nevaio.git` (not run yet - pointing the remote at a
  name that doesn't exist yet would just break `fetch`/`push` until the
  rename actually happens).
- **The local project directory** (`/Users/jacopo.credi/Projects/spikely`)
  is left alone - not something to rename out from under the session
  actively operating in it (and the user's open editor tabs). Manual
  follow-up, whenever convenient.

**Rejected:** nothing structural - this was a scoped cosmetic rename, not a
redesign. The main judgment call (what counts as "history" vs. "current
text") is recorded above precisely so it doesn't need re-litigating if more
`spikely` references turn up later.

**Verified:** `npm run build` (from `app/`) clean after `package.json`'s
`name` change and an `npm install` to sync `package-lock.json`. `grep -rliE
spikely` afterward lists exactly the expected set: `PROMPT_TO_RESUME.md` and
`SECURITY_AUDIT_REPORT.md` (both untracked, generic brand mentions updated,
timestamped findings preserved), `CHANGELOG.md`/`docs/worklog.md` (historical
entries), `docs/spec.md`/`docs/plan.md` (historical amendment/narrative
prose), and `docs/r2-setup.md` (the intentional bucket-name note) - nothing
missed by accident.

---

## 2026-09-06 - "Freshness" -> "observation age" wording fix, a full visual redesign, and a real overlap bug found along the way

**Did:** Two requests from the user after seeing the new legend: the
"freshness" label reads ambiguously as "fresh snow" (new snowfall) rather
than "how recent the observation is," and the app's floating UI should look
more polished/modern, not just functional, even as an MVP.

*Wording.* Changed `SnowControl`'s legend label from "Color = freshness" to
"Color = observation age", matching the phrasing the pipeline's own manifest
`notice` text already used ("Color shows how old that observation is") -
that string was already unambiguous, so no pipeline change was needed, only
the frontend's own label. Also tightened "Opacity = coverage" to "Opacity =
snow coverage" for the same parallel clarity.

*Visual redesign.* Rewrote `app/src/style.css` around a small set of design
tokens (`--accent`/`--accent-strong` reusing the map's own Sky-to-Indigo
freshest-tier color rather than an unrelated blue, plus shared radius/shadow/
blur variables) and applied a cohesive frosted-glass treatment - translucent
background, backdrop blur, soft layered shadow, larger consistent border
radius - to every floating panel, including MapLibre's own default control
groups (zoom buttons, attribution), not just the custom ones, so the whole
app reads as one design rather than "our controls" plus "MapLibre's
defaults." Specific changes: the "Snow cover" checkbox became a real
animated toggle switch (`app/src/ui/snowControl.ts` now renders a visually-
hidden checkbox plus a styled track/thumb sibling, using the CSS
adjacent-sibling selector and the existing wrapping `<label>` for
click/keyboard behavior - no new JS event handling needed); the legend's
"Opacity ="/"Color =" labels became small uppercase tracked captions; the
search bar gained a magnifying-glass icon, a pill shape, a focus-ring
glow, and a rounded hover highlight per result row; and every panel gets a
short fade/slide-in entrance animation on load.

*The overlap bug.* While reviewing a mobile-viewport screenshot for the
redesign, noticed the search bar and `SnowControl` have always visually
overlapped on narrower viewports - the search bar's "Snow cover" toggle row
was completely hidden underneath the search bar's opaque white background in
every prior mobile screenshot this session; only the legend below it peeked
out, because the snow control's total height exceeds the search bar's, so
only the *excess* was visible below the search bar's bottom edge. Nobody had
looked at a full, un-cropped mobile screenshot of the top-left corner until
now - earlier verifications either cropped to `.snow-ctrl` alone or didn't
inspect that specific region closely. The new translucent panels made the
same overlap easier to spot (both layers partially visible through each
other) rather than one fully hiding the other, which is what actually
surfaced it. Fixed by pushing `.maplibregl-ctrl-top-left` down by a fixed
`4rem` (clearing the search bar's collapsed pill height plus a small gap)
rather than a viewport-width media query breakpoint - worked out that the
two controls' widths (search bar capped at `24rem`, `SnowControl` roughly
`235px`) only stop overlapping above roughly `870px` of viewport width, so a
breakpoint-based fix would need to cover far more than just phones and is
more fragile against future content-length changes on either control than
an unconditional vertical offset is.

**Decided:**
- Reuse the map's own Sky-to-Indigo accent color for interactive UI accents
  (toggle, focus rings, hover highlights) rather than an arbitrary blue -
  ties the chrome's visual identity to the product's own data encoding.
- Fix the overlap with an unconditional offset, not a media-query breakpoint
  - simpler, and robust to control-width changes neither control's own CSS
  rule needs to know about.
- Emoji icons again (search glyph) rather than an icon font/SVG set, matching
  the choice already made for search-result type icons earlier this session -
  zero new assets, consistent icon language across the app.

**Verified:** `npm run build` clean. Dev server on port 5173, Playwright
screenshots (not committed) at desktop (1100x850) and mobile (390x844)
viewports, before and after the overlap fix: confirmed the "Snow cover"
toggle row is now fully visible and un-occluded on mobile, the redesigned
panels render correctly at both sizes, and the search dropdown (tested with
"Adamello") still shows correctly alongside the redesigned chrome.

---

## 2026-09-06 - Snow-layer legend

**Did:** The user noticed the web app had no legend explaining the snow
overlay's visual encoding (spec section 5.2: opacity = coverage %, color =
freshness tier) and asked for one. Added it to the existing
`SnowControl` (`app/src/ui/snowControl.ts`) rather than a new floating
element, since that control is already the map's "what does the snow layer
mean" UI (toggle + AS-OF summary) and a legend belongs there rather than as
separate clutter. Two rows: a coverage gradient bar (a CSS `linear-gradient`
with stops at 0%, 50% (58.8% alpha - the exact `150/255` from the frozen
piecewise alpha rule, not a plain linear approximation), 100%, labeled `0%`
to `100%`) and four color swatches for the freshness tiers, labeled `0-3d`
through `15-30d`.

**Decided:**
- Hardcode the four Sky-to-Indigo hex values in `snowControl.ts` rather than
  invent a shared config between the Python pipeline and the TypeScript
  frontend - there's no existing shared-config mechanism between the two,
  spec section 5.2 already freezes these exact values, and past changes to
  this palette (see the Sky-to-Indigo entry above) already require touching
  multiple files by hand. Commented the duplication clearly
  (`pipeline/tiles.py`'s `_FRESHNESS_COLORS`) so a future palette change
  doesn't miss it again.
- Reproduce the exact alpha curve (0/150/255 at 0/50/100%) in the gradient's
  midpoint stop rather than a plain 0-to-100% linear fade - free precision,
  and the legend should show the real rule, not an approximation of it.
- Always-visible, not a collapsible/expandable section - MVP success
  criterion 2 ("distinguish fresh observations from stale or unavailable
  observations") is core, not a secondary detail worth hiding behind a tap.

**Verified:** `npm run build` clean. Dev server on port 5173, Playwright
screenshots (not committed) at both a desktop (1000x800) and mobile
(390x844) viewport: the legend renders clearly, readably, and doesn't
visually collide with the search bar added earlier this session.

---

## 2026-09-06 - Search result type icons, and a real Nominatim response bug found along the way

**Did:** User tried the new search feature and asked for two usability
improvements: typing "Adamello" should surface the Adamello peak first (or at
least sooner), and results should show an icon for what kind of place each
one is (peak, pass, town, etc.).

Investigated the ranking complaint first by querying Nominatim's raw API
directly for "Adamello" (`curl`, `format=jsonv2`). At `limit=6` the actual
peak ("Monte Adamello", `natural`/`peak`) doesn't appear at all - the top
results are an administrative village and its town hall, both named after the
massif, plus assorted unrelated amenities. Raising `limit=20` confirmed the
peak exists in Nominatim's results but ranks 10th by its own `importance`
score (0.35, versus 0.56 for the village) - Nominatim's importance metric
favors administrative/amenity entries over named natural features and has no
concept of "this is a hiking app." Proposed re-ranking client-side (fetch
more results than displayed, then reorder by a curated mountaineering-class
priority table) but the user explicitly said not to hack Nominatim's score -
only build the icons. Left ranking exactly as Nominatim returns it.

While building the icon feature, found and fixed a real latent bug: 
`app/src/search/nominatim.ts`'s `GeocodeResult`/`NominatimResponseItem` types
had a `class` field mapped from `item.class` - but Nominatim's `jsonv2`
response actually names that field `category`, not `class` (an older,
non-jsonv2 Nominatim response format used `class`). `item.class` was
therefore always `undefined`, silently, since nothing rendered it before now
(only `type` and `boundingbox` were actually used, for zoom calculation).
Renamed the field to `category` throughout and verified via direct `curl`
that the real API response carries `category`/`type` (e.g. `natural`/`peak`,
`place`/`village`), not `class`/`type`.

Added `resultIcon()` in `app/src/ui/searchBar.ts`: a small curated
`category`/`type` -> emoji map covering the mountaineering-relevant classes
from spec section 4.2 (peak/volcano, saddle, alpine/wilderness hut or
shelter, camp site, trail, parking, and settlements), falling back to a
generic pin for anything else (administrative boundaries, restaurants,
townhalls, bus stops, etc.) - the same "everything else" bucket that
crowded out the Adamello peak above. Rendered as a `search-bar__result-icon`
span before each result's label.

**Decided:**
- Icons only, no client-side re-ranking of Nominatim results - the user's
  explicit call after seeing the actual ranking problem demonstrated live.
  Revisit if this keeps coming up in practice; for now the fix is scoped to
  what was asked.
- Emoji glyphs rather than an icon font/SVG set - zero new assets or build
  changes, legible at the small size tested, and this is exactly the kind of
  small visible step the project favors over infrastructure for a cosmetic
  improvement.

**Rejected:**
- Client-side re-ranking (fetch a larger `limit`, sort by a mountaineering-
  class priority tier, slice to display count) - diagnosed and prototyped as
  the fix for the ranking complaint, but the user asked to skip it. The
  diagnosis (real peak ranks 10th by Nominatim's own importance at
  `limit=20`) stays here in case ranking is revisited later.

**Verified:** `npm run build` clean. Dev server on port 5173, driven by a
temporary Playwright script (not committed): "Gran Paradiso" shows a
mountain icon, "Courmayeur" shows a settlement icon on its `place`/`town`
result, "Adamello" shows a mix of pin and camp-site icons matching its actual
(unranked) result set - confirming icons reflect the real `category`/`type`
Nominatim returns rather than always falling back to the generic pin.

---

## 2026-09-06 - Try Sky to Indigo for observation age

**Changed:** User selected Sky to Indigo after finding mint snow hard to
separate from green topo terrain. Updated the raster renderer and existing
color assertions to `#38BDF8`, `#5185ED`, `#6957CE`, `#713A9C` for the
unchanged 0-3, 4-7, 8-14, and 15-30 day bands. Updated manifest tooltip wording,
the current specification, and plan status. Coverage opacity is unchanged.

**Rejected:** Keeping mint as the freshest tier because it blends into the
basemap's vegetation colors. Other proposed palettes remain untried.

**Validation:** All 52 pipeline unit tests pass, including RGBA and XYZ output
checks. Subsequently found all 58 saved AS-OF composites in the previous
session's temporary directory and re-rendered the same 2026-09-06 observations.
All 953 tiles have byte-identical alpha/coverage and the exact intended RGB
mapping. Published to R2 as `20260906T210131Z`; the live browser verification
loaded that run and captured the new palette. The same nine omitted-empty-tile
404s occur before and after (already documented below). Kept the previous
published run for rollback. Publication used only the palette renderer;
unrelated place-search work was excluded.

---


A dated, narrative record of what was done, decided, and rejected each session -
newest first. `git log` has the diffs; this has the reasoning that produced them,
especially the roads *not* taken (a rejected approach usually costs real time to
rediscover if it isn't written down).

This is not a duplicate of other docs: `docs/spec.md` is frozen product intent,
`docs/plan.md` is what's next, `recon/findings.md` is what the data actually is.
This file is what *we* did and why, across sessions.

---

## 2026-09-06 - Place search (spec section 6.1) built on Nominatim

**Did:** Resumed from `docs/plan.md`'s "Next, in order" item 2 - the snow
layer is no longer the bottleneck, so moved on to the rest of `docs/spec.md`
in vertical slices, starting with search (section 6), since it has no open
blocker unlike the OSM object panel (section 7, blocked on section 15 item 3)
or routing (section 8, blocked on several other section 15 items). Built a
standalone floating search bar (`app/src/ui/searchBar.ts`) rather than a
MapLibre `IControl` like `SnowControl` - section 10 wants a prominent,
near-full-width, touch-friendly element on mobile, which MapLibre's
corner-anchored `ctrl-group` styling isn't built for. Two independent input
paths: a decimal-degree coordinate pattern (`app/src/search/coordinates.ts`)
resolved entirely client-side with no network call, and everything else sent
to Nominatim's public `/search` endpoint (`app/src/search/nominatim.ts`),
debounced (350ms) with `AbortController` cancellation of stale in-flight
requests, biased (not restricted) to an approximate Alps+Apennines bounding
box via `viewbox`/`bounded=0`. Selecting a result flies the map there
(`zoomForBoundingBox` derives a zoom level from the result's bbox span
instead of a hardcoded per-OSM-type table, so it works for any class/type
Nominatim returns) and drops a single reused `maplibregl.Marker`.

**Decided:**
- **Nominatim over MapTiler Geocoding** for section 15 item 5 (still formally
  open) - asked the user directly given the real trade-off (MapTiler would
  reuse the already-required API key and likely get a clearer rate-limit
  story; Nominatim is free, keyless, and OSM-native, matching where the
  mountaineering objects themselves come from). User chose Nominatim,
  accepting its anonymous-endpoint usage-policy ceiling as the MVP starting
  point - self-hosting or switching provider is the documented revisit
  trigger if usage grows past what that endpoint allows.
- Zoom-from-bounding-box-span rather than a lookup table keyed on OSM
  `class`/`type` - simpler and works uniformly across peaks, huts, villages,
  and anything else Nominatim returns, without needing to enumerate types.
- Decimal-degree coordinates only, no DMS - not required by section 6.1 and
  keeps this slice small.

**Rejected:**
- MapTiler Geocoding (see above) - a real alternative, not a strawman, but
  the user preferred the OSM-native, keyless option for the MVP.
- A MapLibre `IControl` for the search bar, matching `SnowControl` - would
  confine it to a corner `ctrl-group`, working against section 10's
  mobile-first, near-full-width intent for the app's primary search entry
  point.

**Verified:** `npm run build` clean. Ran the dev server on port 5173 and
drove it with a temporary Playwright script (not committed): searching
"Gran Paradiso" renders a dropdown, selecting it flies the map to the peak
and drops a marker exactly on it (screenshot-confirmed); typing
`45.832, 7.281` skips the dropdown and goes straight there on Enter; the
clear button removes the marker; the existing MapTiler/OSM + Copernicus
attribution already satisfies Nominatim's attribution requirement, no
separate string needed.

---

## 2026-09-06 - Zoom gap fixed, cron confirmed, snow encoding revised after reviewing an alternative implementation

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

*Snow-cover encoding revised, and the AS-OF ceiling raised, after reviewing
an alternative implementation.* The user had asked a separate LLM (Lovable)
to build the same product independently and shared its architecture writeup
(`LOVABLE.md`, gitignored by convention, not part of this repo's history) for
critical review. Most of it doesn't transfer: it switched from Copernicus
GFSC (60 m) to NASA GIBS/MODIS-VIIRS (~500 m) specifically to avoid needing
server-side credentialed access - a problem this repo already solved
(`pipeline/fetch.py` fetches server-side via GitHub Actions, never from the
browser), so adopting it would be a pure resolution regression. Its server-
functions architecture (a live TanStack Start server decoding tiles per
request) is a heavier, costlier footprint than this repo's static
GH-Actions-to-R2 pipeline, a deliberate prior decision (spec section 15 item
8). Its "freshness stack" (4 fixed-day-offset layers at fixed opacities) is a
blunter approximation of what `pipeline/asof.py`'s per-pixel backward search
already does more precisely. Three things *did* transfer, one of them
substantial:

1. Its provider choices for three still-open section 15 decisions
   (Nominatim for search, Overpass for OSM objects, Open-Meteo for
   elevation/DEM) are free, keyless, and worth starting from rather than
   surveying cold when sections 6/7/15-item-7 are built.
2. GIBS ships palette-index PNGs where the palette index *is* the exact
   science value - recoverable losslessly. This repo's published XYZ tiles do
   not have that property: `tiles.py`'s `render_rgba` bakes `fsc` and
   freshness into a rounded, interpolated RGBA color for display, which
   cannot be inverted back to an exact FSC%/age/quality. That's fine for the
   map today, but it means **there is currently no way to point-sample exact
   snow data for the section 7 object panel + historical chart** - the very
   next planned feature. Recorded as a blocking prerequisite in
   `docs/plan.md` rather than designed further this session (see below).
3. Its own cloud/no-data handling is internally inconsistent in a way worth
   learning from rather than repeating: it renders confirmed 0%-snow, "no
   observation in window," and "persistent cloud" all identically
   (transparent) on the map, while its own writeup claims "no data is never
   rendered as no snow, enforced everywhere" - true only in its click-through
   panel, not the map itself. Useful as a concrete example of the tradeoff
   discussed below, not as a design to copy uncritically.

That third point reopened a question the frozen spec had already answered
once (section 5.4, Amendment v1.2: cloud renders as a distinct violet
`#A855F7`, chosen specifically *because* a neutral/absent treatment was
confusable with rock/scree). The user's own instinct, unprompted, was the
opposite of the frozen choice: hide cloud entirely, and go further - show
"our best estimate" using opacity for coverage and a color scale for
freshness, rather than the frozen ramp's single alpha channel doing both
jobs at once. That is a real improvement the frozen encoding didn't have:
under the old rule, alpha was `base_alpha(fsc) * freshness_multiplier(age)`,
so a faint pixel could mean *either* "little snow" *or* "old observation" -
indistinguishable by looking. Decoupling them into two independent channels
(opacity = coverage only, color = freshness only) removes that ambiguity
entirely, and turned out to be simpler to implement than the old multiplied
scheme, not just visually clearer.

Worked through the resulting design questions one at a time rather than
guessing at all of them:

- **Cloud:** removed the distinct violet indicator entirely. A pixel with no
  usable observation anywhere in the AS-OF window - cloud, water, stale, or
  no-data - now renders fully transparent, uniformly. The distinction between
  those states still exists in storage/APIs/point details/the historical
  chart (spec 5.4 still requires it there); only the map raster itself no
  longer shows it. This does trade away some at-a-glance honesty (a hiker
  can no longer tell "confirmed snow-free" from "unknown" without clicking
  through), accepted deliberately by the user given cloud's real-data
  prevalence is now only ~3.22% post-AS-OF-fix (was ~19.5% before), a much
  smaller cost than when 5.4 was first written.
- **Confirmed 0% snow:** also fully transparent, no floor tint (the old ramp
  kept alpha 26/255 specifically so a genuine 0% reading stayed visually
  distinct from missing data). Explicitly asked and explicitly accepted: the
  simpler "opacity = coverage %, full stop" rule wins over that residual
  distinction.
- **Freshness tiers:** kept the existing 3 age brackets (0-3/4-7/8-14 days)
  from spec 9.2 rather than a continuous gradient (discrete tiers stay easy
  to read at a glance and to legend), then added a 4th (15-30 days) once the
  ceiling itself moved - simplest option, zero change to the first three
  boundaries.
- **AS-OF age ceiling, 14 -> 30 days:** the user proposed this to fit the
  "best estimate, always" framing, then asked for it to be measured on real
  data first rather than assumed, matching how the original 15-day window
  was justified on 2026-08-28. Wrote a one-off comparison script
  (`compose_as_of` under `MAX_AGE_DAYS=14` vs `30`, same real winter archive
  used for the original AS-OF measurement) and got a genuinely uneven
  result, not a uniform improvement:

  | tile | AS-OF | 14-day valid | 30-day valid | gain |
  | --- | --- | --- | --- | --- |
  | 32TPS | 2026-02-20 | 39.7% | 98.4% | +58.8pp |
  | 32TPS | 2026-03-10 | 85.6% | 89.4% | +3.9pp |
  | 32TPS | 2026-04-01 | 97.7% | 99.2% | +1.4pp |
  | 33TUG | 2026-02-20 | 17.6%\* | 24.1%\* | +6.5pp\* |
  | 33TUG | 2026-03-10 | 77.9% | 84.4% | +6.5pp |
  | 33TUG | 2026-04-01 | 51.4% | 83.4% | +32.0pp |

  (\*33TUG/2026-02-20's 30-day window is truncated by the recon archive's own
  start date, so that row understates the true 30-day figure.) Dug into the
  32TPS/2026-02-20 outlier specifically: 2026-02-01 through 02-07 was a
  genuinely clear week (~97% valid daily), followed by persistent cloud
  02-08 through 02-20; the 14-day window's edge lands at 02-07 and just
  misses that clear week, while 30 days pulls it in at 13-19 days old. The
  gain is concentrated almost entirely in exactly these multi-week cloudy
  spells - negligible (+1 to +4pp) on ordinary days, substantial (+33 to
  +59pp) when a tile had been cloud-bound for two-plus weeks - which is also
  arguably the situation where showing a real, recent-ish (if aging)
  observation is most defensible against showing nothing. User confirmed
  proceeding with the full 30 days after seeing this.
- **Palette:** rendered the real 32TPS/2026-02-20 composite (the clearest
  demonstration case, spanning all 4 tiers at once) under 6 candidate 4-stop
  ramps as a published Artifact
  (`https://claude.ai/code/artifact/791294b5-cc52-4330-a31c-3492d995b742`) -
  swatches plus the same real tile under each - rather than describing
  colors in words. First pass used a muted icy-to-violet ramp the user found
  too dim; regenerated with 6 brighter, more saturated options spanning
  aquamarine/cyan/mint/electric variants. User picked **C, "Mint to
  Amethyst"**: `#8EEBC6` (0-3d) -> `#7AC2E1` (4-7d) -> `#6969D3` (8-14d) ->
  `#A459C5` (15-30d).

**Implemented:** `pipeline/asof.py` (`MAX_AGE_DAYS` 14->30; `freshness_tier`
replaces `freshness_multiplier`, returning a tier index 0-3 instead of an
opacity multiplier, tier 3 unbounded above rather than clamped at the old
ceiling so a STALE pixel's age never wraps back to "freshest"; the
`AsOfComposite.freshness` field is removed entirely - `tiles.render_rgba` now
derives the tier from `age_days`, already a field on the composite, instead
of carrying a redundant precomputed one). `pipeline/mosaic.py` and
`pipeline/snapshots.py` updated for the removed field. `pipeline/tiles.py`
rewritten: `_ALPHA_LUT` (256-entry, coverage-only, 0/150/255 at 0/50/100%,
index 101-255 - every non-VALID state per the `fsc=255-where-not-VALID`
convention - maps to alpha 0) replaces the old combined color+alpha LUT;
`_FRESHNESS_COLORS` (4 RGB rows) replaces the old cloud special-case
entirely, since routing every non-VALID state through the same `fsc=255`
alpha-0 path made the explicit `PixelState.CLOUD` check unnecessary.
`pipeline/config.py` `ASOF_WINDOW_DAYS` 15->31. `pipeline/preview.py`'s
published manifest `notice` text rewritten to describe color-as-freshness
instead of "drawn progressively more faintly." All touched tests updated (52
pipeline tests passing, including 3 new ones: day-30 still valid at the
oldest tier, day-31 correctly stale, confirmed-0%-is-transparent). Spec
sections 5.2, 5.4, and 9.2 amended (v1.7) to match exactly. Pushed, then
manually published a real full-area run rather than waiting for tomorrow's
cron - see the production-verification note below.

**Decided:**
- Decouple opacity (coverage) and color (freshness) into independent
  channels rather than patching the old combined-alpha scheme, because the
  ambiguity it removes ("faint = little snow" vs "faint = old") is a real
  correctness improvement, not just a restyle.
- Remove cloud's distinct violet indicator, accepting the map-level honesty
  cost given cloud's real prevalence has dropped to ~3.22% since the AS-OF
  window shipped - a materially different cost than when 5.4 froze the
  opposite choice.
- Raise the AS-OF ceiling to 30 days, but only after measuring the real
  benefit first (repeating the same discipline as the original 15-day
  decision) - the gain turned out genuinely concentrated in multi-week cloudy
  spells rather than uniform, which is itself useful context for anyone
  revisiting this number later.
- Keep the existing 3 age-tier boundaries unchanged and just append a 4th,
  rather than rebalancing all 4 - zero risk to categories the team already
  understands.
- Pick the color palette by rendering real data and looking at it, not by
  describing colors in prose - produced a materially better result (the
  first draft palette was too muted; seeing it made that obvious in a way
  hex codes alone would not have).

**Rejected:**
- Adopting NASA GIBS/MODIS-VIIRS as a data source (Lovable's choice) - a
  resolution regression (500 m vs 60 m) that solves a browser-credential
  problem this repo doesn't have.
- A live server-functions architecture for on-demand tile decoding (Lovable's
  choice) - heavier and costlier than the existing static GH-Actions-to-R2
  pipeline, for no benefit this repo needs today.
- Client-side tile recoloring (Lovable's technique) - unnecessary complexity
  given the color ramp is frozen and already baked server-side.
- A non-zero opacity floor for confirmed 0% snow - considered (it would keep
  0% distinguishable from missing data on the map itself, matching the old
  ramp's intent) but the user preferred the simpler unconditional rule.
- Designing/building the section 7 historical-chart data architecture this
  session - the direction (precomputed per-object time series, no new
  server) is decided and recorded in `docs/plan.md`, but building it is
  blocked on section 15 item 3 (which OSM object classes are in scope),
  which is its own feature-design session.

*Verified in production before waiting for tomorrow's cron.* Pushed the
commit, then ran a full-area publish locally (`pipeline.preview
--publish-r2 --keep-runs 7`, the same invocation the workflow uses) rather
than waiting for the next scheduled 04:35 UTC run, given how much the
rendered output changes. 1,736 source products (up from ~808 at the old
14-day window, as expected from roughly doubling it), 58/58 tiles, published
as `runId 20260906T203909Z`. `npm run verify` against the live site then
flagged 9 of 47 tile requests as 404 - all within the exact z9 region
(`267-269/182-185`) confirmed working after the morning's zoom fix, which
was concerning enough to check before calling it done rather than after.
Traced it to the underlying snapshots directly rather than guessing: the
four MGRS tiles under that area (`32TMQ/MR/NQ/NR`) are 88-97% "valid"
observations, but 98.7-99.99% of those valid pixels read a genuine 0%
(current real Alpine conditions - early September, off-season). Under the
new no-floor opacity rule that renders fully transparent, so
`write_xyz_tiles` correctly skips the whole tile as empty (a 404, not a
bug) where the old floor-alpha rule would have served an imperceptible tile
anyway - the two are visually indistinguishable to a human eye either way,
so this is a byte-savings side effect of the 0%-floor decision, not a
functional regression. Confirmed real snow still renders correctly
elsewhere in the same run by rendering `32TNS` (the tile with the most
current snow) directly from its snapshot: clear mint-colored high-elevation
patches with a few amethyst flecks from the 30-day fallback, transparent
everywhere else - exactly the expected pattern for early-September glacier
remnants. Fixed one remaining wording mismatch found along the way:
`preview.py`'s published `notice` text still said "icy/violet" from before
the palette was finalized (the actual render colors were already correct,
only the tooltip text lagged).

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
