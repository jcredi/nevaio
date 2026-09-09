# Nevaio repository refactor — implementation prompt

Status: accepted direction, deferred; no implementation authorized by recording
this document. Recorded 2026-09-09.

## Instructions to the implementing assistant

Implement this plan only when the user explicitly asks to begin the refactor.
Reading this file during normal onboarding does not authorize execution. Work
in small, independently verifiable stages, preserving product behavior. Before
editing, inspect the current repository and report the proposed first stage.
Do not assume the paths, test counts, dependency versions, or deployment status
recorded here are still current.

Read AGENTS.md and docs/agent-guide.md in full, applicable nested instructions,
docs/spec.md, docs/plan.md, recent docs/worklog.md entries, and publishing
security/operations documentation. Inspect git status and existing changes;
preserve unrelated work. Do not commit, push, deploy, change account settings,
or perform a live publication without explicit authorization.

This document captures the user's latest approved structural direction. It
supersedes the older four-stage layout proposal in docs/plan.md where they
differ: keep the pipeline modules mostly flat inside an installable package,
group frontend features, use contracts/, and recreate the environment under
pipeline/.venv/. Do not combine both trees. Reconcile the older active planning
section when implementation starts; preserve historical worklog entries.

## Objective and boundaries

Retire recon/ by separating its responsibilities, not by indiscriminate
deletion. Keep app/ and pipeline/ as the two top-level application boundaries.
Separate production code, development tools, cross-language contracts, durable
research data, generated output, and documentation.

Do not introduce a monorepo framework, UI framework, database, microservices,
generic repository/controller layers, or a new test framework just for this
refactor. Do not fix unrelated audit findings or change frozen snow semantics.
Keep the current package managers and hash-locking guarantees unless a concrete
compatibility issue requires a separately explained adjustment.

## Current rationale (verify before implementation)

- recon/.venv is referenced by local pipeline/test commands.
- recon/data contains the local winter GFSC archive used for real-data checks.
  It is valuable research material, not an expendable download cache.
- recon/make_overlay.py generated the checked-in fallback PNG/JSON. The frontend
  still loads that historical sample when loading the snapshot manifest fails.
- The production downloader has its own implementation, rather than importing
  the vendored reconnaissance client. Check research scripts and procedures too
  before declaring the vendor removable.
- Search and snow behavior are split between frontend map/search/ui folders.
- Python rendering and TypeScript legend colors are manually synchronized.
- The production rendering entry point is still named preview.py.
- Publishing security work separates rendering and publishing on fresh runners
  with separate hash-locked dependency sets. Preserve this boundary throughout.

## Target structure

This tree shows relevant destinations, not permission to delete omitted files.
Keep existing filenames where no rename is specified or clearly necessary.

```text
app/
  src/
    main.ts
    map/config.ts
    features/
      snow/
        overlay.ts
        manifest.ts
        control.ts
      search/
        searchBar.ts
        coordinates.ts
        nominatim.ts
    style.css
  public/
  scripts/
pipeline/
  pyproject.toml
  .venv/                       # ignored; recreated, not moved
  requirements/
    render.in
    render.txt
    publish.in
    publish.txt
  src/nevaio_pipeline/
    __init__.py
    asof.py
    config.py
    fetch.py
    raster_io.py
    mosaic.py
    snapshots.py
    tiles.py
    render.py
    artifact_validation.py
    publish.py
  tests/
  tools/make_sample_overlay.py
contracts/
  snow-manifest.schema.json
  snow-encoding.json
data/
  README.md
  research/                    # ignored; durable winter archive
  cache/                       # ignored; disposable downloads
  output/                      # ignored; generated artifacts
docs/
  spec.md
  plan.md
  architecture.md
  agent-guide.md
  worklog.md
  operations/
  research/gfsc-findings.md
  archive/
```

Do not create empty placeholder folders for hypothetical features. Keep the
root README, license, and agent adapters. Note that `CHANGELOG.md` and
`PROMPT_TO_RESUME.md` were retired on 2026-09-09 (see `docs/agent-guide.md`);
the changelog now lives in `docs/archive/`. Do not relocate the human-only
security audit report, which is kept outside the repository.

## Implementation sequence

### 0. Establish a safe baseline

Inspect current code, CI, dependency locks, package imports, asset generation,
and documentation references. Identify ongoing security work and its actual
state; do not infer live activation from a committed workflow. Finish or obtain
a safe user-approved checkpoint for overlapping work before restructuring it.

Record baseline pipeline tests, frontend build, and existing verification
results. Record pre-existing failures separately. Use a representative local
dataset for before/after output comparison without publishing or downloading
large datasets. Never print credentials from environment files.

### 1. Extract reconnaissance responsibilities

- Recreate a documented environment at pipeline/.venv using the supported
  Python version and reproducible dependencies. Align with CI where supported;
  do not assume the old local interpreter version is the intended version.
  Account explicitly for sample-tool-only dependencies without adding them to
  the minimal publisher environment.
- Migrate recon/data to data/research, preserving internal paths and provenance.
  Inventory files and verify content integrity before removing originals. Keep
  recoverable originals until validation succeeds; do not rely on Git rollback
  for ignored data. Ask before an irreversible cleanup if safe recovery is not
  available. Document provenance, locations, and backup expectations in
  data/README.md without committing raw rasters or credentials.
- Move findings to docs/research/gfsc-findings.md and the generator to
  pipeline/tools/make_sample_overlay.py. Give the tool explicit input/output
  arguments, preserve its rendering and alignment checks, and document an
  equivalent invocation. Preserve the existing fallback URLs and assets.
- Verify the vendor's remaining callers and research uses. Remove it only if
  unused, retaining acquisition/source provenance and any required license or
  attribution for retained material. An ignored reference file may still be
  useful research data even if the downloader is obsolete.
- Update ignore rules before moving data. Remove obsolete requirements and the
  residual recon directory only after all live responsibilities are accounted
  for. Existing output provenance is historical: do not hand-edit generated
  sidecars just to erase an old path.

### 2. Package the pipeline

- Add pyproject.toml and move production modules into src/nevaio_pipeline.
  Rename preview.py to render.py; keep useful processing modules mostly flat.
- Preserve the pure AS-OF core's independence from raster I/O and storage.
  Avoid eager package exports that import the native raster stack when the
  publisher is imported. Folder placement alone is not security isolation.
- Retain separate render and publish dependency inputs and hash locks. Define
  package metadata/install commands so publisher installation cannot silently
  resolve renderer dependencies. Do not weaken hash enforcement to simplify
  packaging; account for the package build/install step explicitly.
- Update module commands, test imports/discovery, workflow paths, scripts, and
  active documentation together. Document editable local installation and
  verify a non-editable installation outside the checkout as well.
- Preserve fresh-runner isolation, artifact validation before secret exposure,
  check-only operation without secrets, immutable run publication, atomic
  latest pointer behavior, retention, and publication receipt verification.
- Add compatibility wrappers only for actual consumers needing them, with a
  removal plan; do not retain obsolete entry points indefinitely by default.

### 3. Regroup frontend features

- Move snow overlay/control and search UI/helpers into their feature folders.
- Extract manifest types/loading from MapLibre layer manipulation without
  changing loading, URL resolution, fallback, control, or error behavior.
- Keep main.ts a small composition point and map/config.ts for map setup.
- Keep global CSS together initially. Split only when feature ownership makes
  it materially easier to maintain. Preserve attribution, layer ordering,
  search behavior, responsive styling, and current asset URLs.
- Keep the app/ deployment base and existing build/publication arrangement.

### 4. Introduce explicit contracts

- Describe the existing snapshot manifest in snow-manifest.schema.json; preserve
  current schema version and optional-field compatibility. A schema document
  does not replace security-sensitive artifact validation.
- Use snow-encoding.json as the authoritative machine-readable representation
  of the current production palette and observation-age bands. Keep frozen
  product rules in the spec authoritative; do not redesign the encoding.
- Consume the encoding from Python and TypeScript and test both consumers
  against expected semantics. Include representative valid/invalid manifest
  fixtures and contract checks at the appropriate boundaries.
- Ensure Python package resources and frontend builds contain what they need.
  No runtime dependency on the checkout's contracts/ path. Any resource-copy
  step must be deterministic and checked for drift, not a second manually
  maintained source. Avoid elaborate code generation or shared-code frameworks.
- Do not force the legacy GF-only sample generator to adopt an age-based
  encoding it lacks the data to calculate. Preserve that intentional difference
  until the separate fallback decision is authorized.

### 5. Reconcile documentation and finish

Make README the concise entry point for setup and navigation. Keep current
priorities in docs/plan.md, architecture/data flow in docs/architecture.md,
deployment/security/recovery procedures in docs/operations, and GFSC research
in docs/research. Archive obsolete planning material without rewriting history.
Update relative links after moves, active commands, agent-guide conventions,
and required changelog/worklog/resume records. Avoid duplicating full setup
instructions across documents. Mark this plan's actual completion state.

## Deferred product decision — NOT part of this refactor

The recommendation is eventually to replace automatic historical sample
fallback with an explicit "snow data unavailable" state and retain the sample
as an opt-in demo. This needs separate user approval: it changes behavior and
possibly the product spec. During structural work, preserve the fallback,
its assets, rendering semantics, and provenance. Removing recon/ does not
require removing the fallback.

## Acceptance criteria and handoff

- No active runtime, CI, or setup dependency on recon/ remains. Historical
  references in dated logs and original provenance are allowed and explained.
- Research archive integrity is verified; raw data and secrets remain ignored.
- Pipeline tests and frontend build pass, or baseline unrelated failures are
  clearly distinguished. Add focused regressions within existing test patterns.
- Publisher import and check-only validation succeed in a clean minimal
  environment without NumPy, Rasterio, or Pillow. Isolation tests still pass.
- Installed Python commands work outside the checkout; bundled contract
  resources are available there. Frontend production build resolves contracts.
- Representative rendering output retains pixel/semantic equivalence. Compare
  metadata after accounting only for legitimately variable fields such as run
  IDs or timestamps; investigate unexplained differences.
- Existing browser verification covers successful manifest loading and forced
  manifest failure/fallback, snow controls/legend, search, and attribution.
- Workflow validation and repository whitespace/link/reference checks pass.
  Do not run a live publish merely to validate file moves.
- Each stage has a clear, reviewable diff and validation summary. Report moved
  paths, changed commands, tests actually run, unresolved risks, and remaining
  work. Do not claim unrun tests, remote settings, or deployments are verified.

If current repository facts conflict with this plan, explain the discrepancy
and choose the smallest compatible adjustment. Ask before changing product
behavior, weakening security boundaries, or risking irreplaceable local data.
