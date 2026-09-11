# Nevaio - agent guide

Shared instructions for any coding agent working in this repo (Claude Code,
OpenAI Codex, or otherwise). Tool-specific entry points - `.claude/CLAUDE.md`,
`AGENTS.md` - are one-line adapters that point here; keep the actual content
in this file only, so the two never drift apart.

## What this is
A free, mobile-friendly web app showing quasi-real-time Copernicus snow-cover data (GFSC) over an outdoor/topo map of the Alps + Italian Apennines, for hikers and mountaineers. Full requirements: @docs/spec.md. Current plan and status: @docs/plan.md.

## Security
Controls, deliberate decisions that look like oversights, and how to re-check
them: @docs/security.md. Read it before touching `app/public/_headers`,
`app/src/map/manifestSchema.ts`, the publishing workflow, or the `maplibre-gl`
version.

## Project areas
- **`app/`** - frontend map (MapLibre GL JS + OSM-based topo basemap).
- **`pipeline/`** - production GFSC processing, a src-layout package at `pipeline/src/nevaio_pipeline/` with its tests in `pipeline/tests/` and dev tools in `pipeline/tools/`. Its pure AS-OF semantic core is independent of raster I/O so the frozen rules stay directly testable.
- **`data/`** - local only, nothing committed but its README. `research/` is the durable winter GFSC archive (~1.5 GB) that real-data checks depend on; `cache/` and `output/` are disposable. See `data/README.md`.
- **`docs/research/`** - what the GFSC data actually is (`gfsc-findings.md`), as opposed to what we decided about it.

`recon/` was dissolved on 2026-09-09 - it bundled four things with four lifecycles, so its long-promised deletion could never fire. Its parts are now the `data/` tree, `docs/research/`, `pipeline/tools/`, and `pipeline/.venv`.

## Ground rules
- Early planning/prototyping stage. Favor small, visible, working steps over broad refactors, heavy abstraction, or building for hypothetical scale.
- No user accounts, no backend database for the MVP - see docs/spec.md section 11.
- Snow data source is GFSC (60 m, gap-filled, single value per pixel) - not raw FSCOG/FSCTOC. Don't reintroduce an on-ground/top-of-canopy toggle; see docs/spec.md section 7.2 for why.
- Copernicus data requires attribution; so does OpenStreetMap (ODbL). Don't drop attribution from any map view.
- docs/spec.md is the frozen product spec. Don't treat something as an open question if it's already answered there - check first.

## `app/` conventions
- Vite + TypeScript, no UI framework yet (deferred until panels/charts are actually built - see docs/spec.md section 15 item 8). Package manager: npm.
- Basemap: MapTiler "Outdoor" vector style via MapLibre GL JS. Requires `VITE_MAPTILER_API_KEY` in `app/.env` (see `app/.env.example`); get a free key at maptiler.com. OpenTopoMap (raster, no key) is the documented fallback if that becomes a blocker.
- Layout: `src/main.ts` (map instantiation), `src/map/config.ts` (style URL, initial view, overlay URL), `src/map/snowOverlay.ts` (GFSC image source + raster layer), `src/ui/snowControl.ts` (layer toggle), `src/style.css` (full-bleed responsive layout, mobile safe-area insets).
- **There is no offline/sample snow data.** When the published snapshot is missing or fails validation, `addSnowOverlay` returns `null` and the control renders "Snow data unavailable" - no layer, no toggle, no legend. Don't reintroduce a checked-in sample raster: a months-old image read as today's conditions is a real hazard for the decisions this app supports (spec section 5.4). Removed 2026-09-09 along with the archive and tooling behind it.
- MapLibre's own CSS styles `.maplibregl-ctrl-group button` at 29x29px; custom controls in a ctrl-group need a more specific selector to override it.
- Dev server: `npm run dev` (from `app/`), bound to loopback on purpose - use `npm run dev -- --host` for a deliberate LAN opt-in (phone testing), not the config. Build: `npm run build` (outputs static `dist/`, deployable as-is). Visual check: `npm run shot` (Playwright, needs the dev server running).
- **`maplibre-gl` stays on 4.7.1 deliberately.** `npm audit` reports a critical advisory against it (GHSA-jrc7-96c5-q579, sanitizer bypass in `DOM.sanitize()`, affecting **all** versions <= 6.4.0, so 4.x and 5.x alike). Do not "fix" it by upgrading: 6.x fetches the MapTiler TileJSON and then requests zero vector tiles, giving a blank basemap with no console error - measured, not guessed (4.7.1: 54 tiles / 2279 rendered features; 6.0.0, 6.4.1 and 6.9.0: 0 / 0). The advisory's sink is HTML MapLibre renders itself - popups, HTML markers, attribution - and this app has no popups, no HTML markers, and a literal attribution string, so there is no attacker-reachable path without MapTiler itself being compromised, and the deployed CSP blocks the script execution an injection would need. Revisit when a 6.x release renders this style, or if the app ever adds popups or renders remote HTML - that changes the analysis.
- Place search uses MapTiler Geocoding (`app/src/search/geocode.ts`), not Nominatim - the OSMF endpoint prohibits client-side autocomplete (spec amendment v1.9). Response parsing/classification lives in `geocodeResult.ts` with no config or `import.meta.env` imports, so `npm test` can run it directly under Node; keep it that way. MapTiler's default result ranking buries peaks and huts under same-named streets, hence the explicit POI/place `types` list.
- Snow metadata arriving over the network (`latest.json`) is validated by `app/src/map/manifestSchema.ts` before any value reaches MapLibre; tile URLs must stay on the manifest's own origin and run directory. If the pipeline ever adds a field the frontend needs, or moves where tiles live, that validator changes with it. `npm test` runs its cases (Node executes the TypeScript directly, no bundler).
- `app/public/_headers` carries the deployed CSP and other browser policy headers, as an explicit allowlist of the origins the app talks to. Adding an outbound destination (new geocoder, new tile host, the F10 R2 custom domain) means editing it in the same change. `npm run check-csp` replays those headers over the real build and fails on any violation; `NEVAIO_URL=https://nevaio.netlify.app npm run check-csp` checks the live deployment, which is the only mode that can exercise the R2 legs (bucket CORS allows production only).
- Deploy: Netlify, connected to this GitHub repo via its dashboard (no committed `netlify.toml`) - base directory `app`, build command `npm run build`, publish directory `dist`. Every push to `main` auto-deploys to https://nevaio.netlify.app; no manual step.
- `VITE_MAPTILER_API_KEY` is also set as a Netlify env var (all deploy contexts), deliberately **not** marked "secret": Vite inlines `VITE_*` vars into the client bundle by design, so Netlify's secret-scanning would fail the build on a value that's supposed to reach the browser. The real access control for that key is MapTiler's own domain restriction, not Netlify's secret masking.

## Research and sample data
- Findings go in `docs/research/gfsc-findings.md` as you go - short bullet notes, not a formal write-up. That file is a dated record of the Aug 2026 reconnaissance; the 1.5 GB archive it describes was deleted on 2026-09-09 once nothing depended on it. HR-WSI keeps its own history back to 2016, so re-download if a question needs real winter rasters again.
- Never commit downloaded raster samples (see .gitignore) - they're large and not ours to redistribute outside the app itself.

## `pipeline/` conventions
- Python. Keep the semantic core independent of raster I/O, reprojection, storage, and scheduling; those are adapters around it.
- AS-OF behavior must match `docs/spec.md` sections 5.2-5.4 and 9.2. Add focused tests for every semantic edge case rather than re-encoding rules in callers.
- **Where Nevaio shows snow is defined once**, in `footprint.py`, derived from `config.MVP_MGRS_TILES`. Anything that needs a geographic answer - is this point inside, what are a tile's bounds, which UTM zone is a tile in - asks that module. Don't add a second outline of the same area, in Python or in the frontend, and don't reach for a spatial library to do it: the MGRS set was resolved by hand precisely so production carries no such stack, and the module is pure standard library for that reason.
- Entry points are `python -m nevaio_pipeline.render` (was `pipeline.preview`) and `python -m nevaio_pipeline.publish`. `pipeline/src/nevaio_pipeline/__init__.py` exports lazily on purpose - the publisher must import without the native raster stack, so never add an eager `from .tiles import ...` there.
- CI does not pip-install the package; it sets `PYTHONPATH=pipeline/src`. That is deliberate - a build backend inside the publish job would enlarge a dependency surface that exists to be exactly one package. Don't "tidy" it into a pip install.
- Local environment is `pipeline/.venv` on **Python 3.12**, matching CI. Create it with `uv venv --python 3.12 pipeline/.venv && uv pip install --python pipeline/.venv -r pipeline/requirements-dev.in`. Tests: `pipeline/.venv/bin/python -m unittest discover -s pipeline/tests`.
- Three dependency surfaces, deliberately: `requirements.in`/`.txt` (render, hash-locked) and `requirements-publish.in`/`.txt` (publish, hash-locked) are CI's contract and are compiled for **linux x86_64**, so they cannot be installed on a Mac. `requirements-dev.in` is the local mirror and the only one carrying dev-tool-only dependencies. Don't add a tool's dependency to the render or publish locks to make a local script run.

## Workflow
- Use plan mode (or the equivalent approval/preview step in whichever tool you are) for anything touching more than one file, or where the approach isn't obvious. Skip it for small, clearly-scoped fixes.
- Favor steps with a visible or checkable result: for `app/`, "does it render correctly in a browser"; for `pipeline/`, "does the script run and produce inspectable output."

## Recordkeeping - update before ending a session
Two files survive past this conversation, and they are split **by tense**.
Update both whenever code changed or a real decision got made; skip both for
pure exploration that changed nothing.
- **`docs/worklog.md` - the past.** Narrative session log, newest entry first:
  what was done, what was decided *and why*, what was explicitly rejected and
  why, what is still open. The "rejected" section matters most - it is what
  stops a later session re-litigating a dead end. Append; never rewrite old
  entries.
- **`docs/plan.md` - the future.** Status, what is next in order, what is open,
  what we are not doing yet. **When something ships it leaves this file** - the
  worklog entry is the record. Never add a "done" section here.

Neither is `docs/spec.md` (frozen intent), `docs/research/gfsc-findings.md` (what the data
is), or `docs/security.md` (what protects the project).

Retired on 2026-09-09, deliberately - do not reinstate without asking:
- **`CHANGELOG.md`** (now `docs/archive/CHANGELOG.md`). It was a third
  narration of what the worklog already held, and there are no releases for it
  to sit between. Bring back a generated one at the first public MVP release.
- **`PROMPT_TO_RESUME.md`**. An honestly maintained `docs/plan.md` *is* the
  resume prompt, and rewriting a separate untracked copy on every push was the
  most expensive rule in this guide.
