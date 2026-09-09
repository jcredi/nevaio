# Publication security (F1)

The renderer and publisher now run on separate GitHub-hosted runners. Only
`publish` references the `production-r2` environment, and only its publication
step receives the R2 key pair. Rendering, tests, dependency installation,
artifact download and the first validation pass receive no R2 credentials.
The pipeline's local `--publish-r2` option remains available for deliberately
trusted local work; the scheduled workflow never uses it.

## Required GitHub setup before activation

These settings cannot be enforced solely by the committed workflow.

1. Open `jcredi/nevaio` > **Settings > Environments**, create **production-r2**.
2. Under **Deployment branches and tags**, select **Selected branches and
   tags**. Add a **branch** rule for exactly **main**; do not allow all branches
   or add a same-named tag rule. The workflow also checks `refs/heads/main`,
   but the environment rule is the independent control against edited branch
   workflows. Protect main itself against unreviewed workflow/code changes.
3. Add environment secrets **R2_ACCESS_KEY_ID** and **R2_SECRET_ACCESS_KEY**
   using the existing dedicated-bucket credential values. GitHub does not show
   stored secret values: use your local credential store/file, without pasting
   them into chat or logs. Keep **R2_ACCOUNT_ID**, **R2_BUCKET**, and
   **R2_PUBLIC_BASE_URL** as the existing nonsecret repository variables.
4. Coordinate activation: keep the existing repository secrets only until the
   revised workflow is on main. Then **remove the two repository-level R2
   secrets**, leaving only the environment copies. Otherwise an edited
   workflow on another branch can still request the repository copies and
   bypass the environment restriction. During this transition F1 is not fully
   resolved. Do not delete the old copies before the old workflow is replaced
   unless you intend to pause its publications.
5. A required reviewer is optional: enabling it pauses **every daily run** for
   approval. For unattended publication, use the exact-main environment rule
   plus protected-main review controls. Availability of environment protection
   depends on GitHub plan/repository visibility; if this setting is unavailable,
   do not assume the YAML branch guard is equivalent. Use a supported setup
   before claiming branch-level secret isolation.
6. After a separately approved commit/push, run a full-area manual publication
   and inspect both jobs. Confirm the publisher validates the artifact, updates
   R2 and verifies that public latest.json equals its own publication receipt.
   Manual runs restricted to a few tiles replace the production pointer with
   that subset, so do not use a partial run as an innocuous production smoke
   test. A non-main dispatch should be skipped.

No account settings, remote workflow, objects or deployed app were changed
while implementing this fix. The security audit report is a historical,
human-only document and remains unchanged.

GitHub references: [environment management](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[secure use](https://docs.github.com/en/actions/reference/security/secure-use).

## Artifact boundary

Only a single `runs/<UTC run ID>/` tree is transferred, with a one-day artifact
retention. It is downloaded under runner temporary storage, outside the trusted
source checkout. The publisher never installs, imports or executes artifact
files and does not use a shared dependency cache with the renderer.

The validator accepts only run.json and canonical XYZ PNG paths at zooms 8–11.
It rejects unexpected/hidden files, symlinks, hardlinks, invalid coordinates,
unknown or duplicate metadata fields, inconsistent source counts and request
coverage, oversized files and malformed PNGs. Metadata is limited to 64 KiB,
individual PNGs to 1 MiB, and a run to 50,000 files / 2 GiB. PNG validation is
bounded standard-library parsing: 256x256, noninterlaced 8-bit RGBA, checked
chunk CRCs, no ancillary/trailing payloads, bounded zlib output and valid row
filter types. The real Pillow renderer format is covered by tests. A future
renderer format change must update this contract deliberately.

Validation runs before secrets are exposed, and the publisher checks again
before opening its S3 client or uploading anything. The same validator protects
local publication, closing the unsafe upload primitive described in F3 as part
of the required F1 artifact boundary. Input-raster isolation/resource fixes
(F2) and other audit items remain separate work.

This is **not proof of snow-data authenticity**. A compromised renderer can
still produce plausible but false pixels or metadata within the allowed
schema. A compromised reviewed/pinned publisher dependency can still misuse
credentials. Dependency pinning, updates and main-branch protection remain
necessary. Artifact extraction and the pinned GitHub actions are also part of
the trusted toolchain; output validation does not replace those controls.

## Input boundaries (F2)

`pipeline/raster_io.py` opens every GFSC layer with the driver restricted to
GTiff, inside a GDAL environment that does not probe for sidecar files. That is
what closes the audit's demonstrated primitive: a VRT named `*.tif` that reads
a raster outside the input directory. `pipeline/tests/test_raster_io.py`
asserts both halves - that an unrestricted open really does follow the external
reference, and that the pipeline's restricted open refuses the same file - so
the test would notice if the restriction were dropped.

Every check now runs before the band is read, so an unexpected raster never
gets an array allocated for it: one band, the layer's expected dtype and
nodata, exactly 1830x1830 pixels, an axis-aligned 60 m grid, an origin inside
the plausible northern-UTM range, and a CRS matching the UTM zone named by the
product's own MGRS tile. Symlinked inputs are rejected, as in the artifact
validator. `load_tile_products` takes `expected_pixels` only so tests can use
small fixtures; production uses the measured GFSC shape.

Volume is bounded in `pipeline/config.py` and enforced in `pipeline/fetch.py`.
A catalogue object over `MAX_LAYER_BYTES` (16 MiB, about 12x the largest of
2320 real layers measured in `data/research`) is dropped during grouping, which
makes its product incomplete so the tile falls back to another date in the
window instead of failing the run; a tile left with no complete product still
raises. `download_products` re-checks each object and refuses a run whose
planned download exceeds `MAX_DOWNLOAD_BYTES` (12 GiB, roughly 3x a normal full
window). `select_window_products` refuses more than `MAX_PRODUCTS_PER_TILE`
products for one tile.

These are integrity and resource bounds, not authenticity. Upstream bytes
within the accepted shape are still trusted, and the audit's recommendation to
parse in a network-isolated sandbox is not implemented - the render job simply
holds no publication credentials (F1). Size equality against the catalogue
detects truncation, not substitution.

## Dependency maintenance and local checks

`requirements.in` records the selected direct render/test dependencies;
`requirements.txt` locks the complete dependency graph and hashes.
`requirements-publish.in` / `.txt` contain only boto3 and its six dependencies.
The publish job does not install NumPy, Pillow, Rasterio, GDAL or PyYAML.
The package initializer lazily loads its existing public raster exports, so
importing the publisher cannot accidentally load the native stack.

To deliberately update a dependency, edit the relevant `.in` file, then run
(from the repository root, with a trusted installation of uv):

```sh
uv pip compile pipeline/requirements.in --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --generate-hashes --only-binary :all: --output-file pipeline/requirements.txt
uv pip compile pipeline/requirements-publish.in --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --generate-hashes --only-binary :all: --output-file pipeline/requirements-publish.txt
```

Use `--upgrade` when intentionally refreshing transitive versions; review the
result and advisory scan before accepting it. Regeneration requires network
access. CI uses `pip --require-hashes --only-binary=:all:` and never resolves
floating runtime package versions. Python 3.12 patch releases and the
ubuntu-24.04 runner image still receive provider maintenance updates.

All Actions references are full SHAs verified against the official actions
repositories. Review upstream changes and resolve their official SHAs for
updates; do not replace pins with movable major-version tags.

```sh
python -m pip install --require-hashes --only-binary=:all: -r pipeline/requirements.txt
python -m unittest discover -s pipeline/tests
# In a separate environment with only requirements-publish.txt installed:
python -m pipeline.publish --runs-dir /path/to/rendered/runs --check-only
```

`--check-only` never creates an S3 client and needs no credentials. Add
`--tiles 32TPS` when checking an intentionally partial fixture. Do not put
artifact directories on PYTHONPATH or run the command from inside them.
