# GFSC data pipeline

Production snow-data processing lives here. The first vertical slice is the
pure per-pixel AS-OF compositor in `asof.py`; it implements the frozen rules in
`docs/spec.md` section 9.2 over already aligned GF, GF-QA, and AT arrays.
`raster_io.py` discovers real daily GeoTIFF triplets and rejects incomplete,
misaligned, or unexpected source metadata before handing arrays to that core.
`mosaic.py` reprojects independently composed MGRS tiles with nearest-neighbour
resampling and merges overlaps using the frozen rule in spec section 9.3.
`tiles.py` colorizes a merged composite per the frozen visual encoding in spec
sections 5.2 and 5.4 and slices it into standard `{z}/{x}/{y}.png` Web Mercator
tiles.

`render.py` chains all of that into one end-to-end run: it discovers and
downloads every complete GFSC product in the 15-day AS-OF window for each MGRS
tile, composes each tile through `asof.py`, renders the full MVP area, and can
publish immutable XYZ tiles plus an atomic `latest.json` pointer to Cloudflare
R2. The 15-day window is what spec section 9.2's 14-day acquisition-age ceiling
implies: a product's per-pixel `AT` never postdates its own product date, so
product dates `D-14..D` are exactly the set that can contribute at AS-OF `D`.

Two consequences of that are worth knowing before changing anything here. The
backward search is purely **additive** - the newest product wins wherever it
holds a valid pixel, and older window members only fill what it left as cloud
or no-data - so a window can never reinterpret fresh data. And much of the
recovered area is 8-14 days old, which the frozen section 5.2 ramp draws at
`0.45x` opacity; a fuller map is a more faint one, by design.

`--window-days 1` reproduces the older newest-product-only behavior exactly,
which is the useful control when a published run looks wrong.

## Static OSM object index (in progress)

The future object panel and historical chart use Nevaio's own static OSM index,
not MapTiler's rendered feature properties. The pure
`nevaio_pipeline.object_index` core currently accepts a **normalized** local
GeoJSON FeatureCollection and writes deterministic `schemaVersion: 1` JSON:

```sh
PYTHONPATH=pipeline/src pipeline/.venv/bin/python -m nevaio_pipeline.object_index \
  --input /path/to/normalized-osm-objects.geojson \
  --output /path/to/object-index.json
```

Every input feature must be a Point with `properties.osmType` (`node`, `way`,
or `relation`), positive `properties.osmId`, and a `properties.tags` object.
The index keeps only named peaks, huts/refuges, saddles/passes, shelters,
parking, and city/town/village/hamlet settlements. It rejects malformed
eligible records and duplicate OSM identities; it deliberately does **not**
download OSM data, publish to R2, or sample snow yet. Those are the next
adapters, not implicit side effects of a local format conversion.

### Regional extract adapter

The checked-in local adapter consumes regional `.osm.pbf` extracts through
[`osmium-tool`](https://osmcode.org/osmium-tool/), filters only the approved
OSM tags (retaining referenced geometry nodes), and normalizes the resulting
GeoJSON before building the index. It retains node/way/relation identity; areas
and lines get a deterministic representative point. It is intentionally not a
pipeline job yet and has no network or R2 side effect:

```sh
pipeline/tools/build_osm_object_index.sh \
  --output /tmp/nevaio-object-index.json \
  /path/to/region-a.osm.pbf /path/to/region-b.osm.pbf
```

Use extracts made from the same OSM snapshot where they overlap. Identical
overlap is deduplicated; conflicting duplicate IDs fail, which prevents a
mixed-snapshot index from being published accidentally. The final public UI
must credit OpenStreetMap contributors and link the ODbL licence before an
index is shipped. Osmium reports and omits the occasional incomplete area
relation at an extract boundary; all emitted records still pass the strict
normalization and index validation contract.

## Local environment

`pipeline/.venv`, on **Python 3.12** to match CI (`uv` fetches the interpreter;
nothing is installed system-wide):

```sh
uv venv --python 3.12 pipeline/.venv
uv pip install --python pipeline/.venv -r pipeline/requirements-dev.in
```

Three dependency surfaces, deliberately separate:

| File | Used by | Hash-locked |
|---|---|---|
| `requirements.in` / `.txt` | the render job | yes, linux x86_64 |
| `requirements-publish.in` / `.txt` | the publish job | yes, linux x86_64 |
| `requirements-dev.in` | local development only | no |

The two locks are compiled for linux x86_64 (see the `uv pip compile` command in
each header), so they **cannot** be installed on a developer Mac - that is why a
separate dev input exists rather than a missing one. It mirrors the render
surface and adds only dev-tool dependencies. Do not add a tool's dependency to
either lock to make a local script run; the publish environment staying minimal
is a security property, not tidiness (see `docs/publishing-security.md`).

Install the package itself for local use (src layout, so it must be on the path
one way or the other):

```sh
uv pip install --python pipeline/.venv --no-deps -e ./pipeline
```

Run the tests from the repository root:

```sh
PYTHONPATH=pipeline/src pipeline/.venv/bin/python \
  -m unittest discover -s pipeline/tests -t pipeline
```

CI deliberately does not install the package - it sets `PYTHONPATH=pipeline/src`
instead. Installing would require a build backend inside the publish job, whose
whole purpose is to carry one dependency; see the comment in
`pipeline/pyproject.toml`.

Build a local full-area preview without publishing it:

```sh
pipeline/.venv/bin/python -m nevaio_pipeline.render \
  --raw-dir /tmp/nevaio-gfsc/raw \
  --work-dir /tmp/nevaio-gfsc/work \
  --output-dir /tmp/nevaio-gfsc/output
```

The GitHub Actions entry point is `Publish latest GFSC snapshot`. It runs daily
at `04:35 UTC` and on manual dispatch, and passes `--keep-runs 7` so R2 holds a
week of immutable runs rather than growing without bound. There is still
deliberately no historical backfill - the job renders "today" only (spec
section 5.3). Cloudflare bucket, token, GitHub variable, invocation, and
verification instructions are in [`docs/r2-setup.md`](../docs/r2-setup.md).

The schedule is set from measured behavior, not assumption: HR-WSI publishes
GFSC strictly daily, and a product dated `D` becomes fetchable at roughly
`D+1 00:15-03:00 UTC`. Multi-day processing backlogs do happen, but the 15-day
window absorbs them without a special case.

## Secure publication

See [publication security](../docs/publishing-security.md) for the split
render/publish workflow, required GitHub environment migration, hash-locked
dependency updates and credential-free artifact verification.
