# Security posture

What protects this project, where each control lives, and how to check it is
still working. This is the durable summary of a security review carried out on
2026-09-06 and the remediation that followed on 2026-09-09; the review's own
report is kept outside the repository.

Read this before changing anything it names. Several controls are coupled to
each other, and the coupling is not obvious from the code alone.

## Publication (the highest-value boundary)

Rendering and publication run as separate GitHub-hosted jobs. The renderer
downloads Copernicus rasters and produces tiles with **no R2 credentials
present at all**; a second job on a fresh runner validates the artifact
*before* any secret is exposed, then publishes. Details, including the artifact
contract and the dependency-pinning rules, are in
[`publishing-security.md`](publishing-security.md).

The R2 key pair lives only in the `production-r2` GitHub environment, which is
restricted to the `main` branch. There are no repository-level copies - that is
deliberate, because a repository secret can be read by a workflow on any
branch, which would defeat the environment restriction.

Inputs are bounded and type-restricted: GFSC layers open as GTiff only, are
validated for shape, resolution, CRS and origin before any array is allocated,
and per-object and per-run size ceilings apply. See "Input boundaries" in
[`publishing-security.md`](publishing-security.md).

## Browser

`app/public/_headers` carries the deployed Content-Security-Policy and the
other browser policy headers. The CSP is an **allowlist of the origins this app
actually talks to**, so adding an outbound destination - a new tile host, a new
geocoder, the eventual R2 custom domain - means editing that file in the same
change. Verify with:

```sh
cd app && npm run build && npm run check-csp        # local build
NEVAIO_URL=https://nevaio.netlify.app npm run check-csp   # the deployment
```

The deployed mode is the only one that exercises the R2 legs, because the
bucket's CORS policy allows the production origin alone.

Snow metadata fetched at runtime is validated by
`app/src/map/manifestSchema.ts` before any value reaches MapLibre. Tile URLs
must resolve to the manifest's own origin and its own run directory, so a
poisoned manifest cannot redirect the browser elsewhere. If the pipeline ever
changes where tiles live, that validator changes in the same commit or the map
goes blank. When the live snapshot is missing or fails validation the snow
control says so, rather than presenting the archived sample as current data.

Geocoder responses are treated as untrusted: a feature whose centre is missing
or not a finite, real coordinate is discarded rather than passed to the map.

## Keys, and what is public on purpose

- `VITE_MAPTILER_API_KEY` is **public by design** - Vite inlines it into the
  browser bundle. Its protection is MapTiler's origin restriction, not secrecy.
  Never mark it as a Netlify secret; that only breaks the build.
- The Copernicus HR-WSI credentials in `pipeline/fetch.py` are the read-only
  pair published in Copernicus's own official client. Public, not a leak.
- Everything genuinely private - the R2 key pair - lives in the GitHub
  environment and, locally, in gitignored `.env` files. `.gitignore` ignores
  every environment-file shape by default and re-allows only `*.example`
  templates, so a new `.env.production` cannot become committable by omission.

## Deliberate decisions that look like oversights

Recorded so they are not "fixed" by someone acting in good faith:

- **`maplibre-gl` stays on 4.7.1** despite a critical `npm audit` advisory. No
  patched version exists outside 6.x, and 6.x renders no basemap at all -
  measured, silent, no error. The advisory's sink is HTML MapLibre renders
  itself, which this app never feeds attacker-controlled content. Full
  reasoning and the conditions that would reopen it are in
  [`agent-guide.md`](agent-guide.md).
- **`main` allows direct pushes.** Requiring pull requests would stop the
  coding agent pushing at all. A ruleset blocking force pushes and deletions
  gives most of the protection at no workflow cost.

## Still open

- The public bucket is still served from its `r2.dev` development endpoint
  rather than a Cloudflare custom domain. See [`r2-setup.md`](r2-setup.md),
  which carries the CSP warning that goes with the migration.
- The recovery path - revoke the publication key, restore trusted code, rebuild
  dependencies, republish known-good data - has not been rehearsed.

## Re-checking

```sh
cd app && npm test                                   # 33 frontend cases
pipeline/.venv/bin/python -m unittest discover -s pipeline/tests   # 83 cases
cd app && npm audit --package-lock-only --ignore-scripts
```

The pipeline suite includes negative tests that reproduce the original review's
probes - a VRT disguised as a GeoTIFF, oversize inputs, symlinked layers - so a
regression in those boundaries fails the suite rather than passing silently.
