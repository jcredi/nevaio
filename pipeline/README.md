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
`nevaio_pipeline.object_index` core accepts a **normalized** local GeoJSON
FeatureCollection and writes deterministic `schemaVersion: 1` JSON, in two
forms:

```sh
# One readable file - local inspection, not shippable (39 MB).
PYTHONPATH=pipeline/src pipeline/.venv/bin/python -m nevaio_pipeline.object_index \
  --input /path/to/normalized-osm-objects.geojson \
  --output /path/to/object-index.json

# The publishable form: object-index.json plus objects/<TILE>.json.
PYTHONPATH=pipeline/src pipeline/.venv/bin/python -m nevaio_pipeline.object_index \
  --input /path/to/normalized-osm-objects.geojson \
  --output-dir /path/to/index/
```

Every input feature must be a Point with `properties.osmType` (`node`, `way`,
or `relation`), positive `properties.osmId`, and a `properties.tags` object.
The index keeps only named peaks, huts/refuges, saddles/passes, shelters,
parking, and city/town/village/hamlet settlements. It rejects malformed
eligible records and duplicate OSM identities; it deliberately does **not**
download OSM data, publish to R2, or sample snow yet. Those are the next
adapters, not implicit side effects of a local format conversion.

### Snow footprint

Both forms keep only objects inside Nevaio's snow footprint. An object outside
it would be a selectable target whose every answer is "no data", and the
regional OSM extracts are much wider than the area the app shows snow for.

`footprint.py` is the one definition of that area, derived from
`config.MVP_MGRS_TILES`: it decodes an MGRS tile id into the 109.8 km granule
it names (north-west corner on the lettered 100 km square's north-west corner)
and answers whether a WGS84 point is inside the union of them, in each
granule's own UTM zone rather than in a longitude/latitude box that would be
wrong by kilometres at the corners. `raster_io.py` takes its tile-to-EPSG rule
from the same module. Anything else that needs to ask "is this inside Nevaio?"
must ask it too - a second outline would drift.

It is pure standard library, deliberately: the MGRS set exists precisely so
production carries no spatial-library stack. The transverse Mercator is the
Kruger series, pinned in `tests/test_footprint.py` against PROJ reference
values it matches to nanometres - four orders of magnitude finer than the 60 m
pixels the footprint is made of.

### Shards

Scoped to the footprint the index is still 211,865 objects and 39 MB, so the
publishable artifact is split by MGRS tile:

- `object-index.json` - the index of shards. Per shard: `tile`, `path`,
  `objectCount`, `bounds` (`[west, south, east, north]` around the objects it
  actually holds), `bytes` and `sha256` of the payload.
- `objects/<TILE>.json` - that tile's objects, in the same record shape as the
  single-file build.

Granules overlap by 9.8 km, so an object can be inside several; it is filed
under the first covering tile in sorted order. Every object is therefore in
exactly one shard and a consumer never de-duplicates. A consumer picks shards
by intersecting its viewport with each shard's `bounds` - no MGRS arithmetic in
the browser, and no second definition of the footprint to drift from this one.
A tile with no eligible object gets no shard.

Shard payloads are compact JSON (no indentation); the single-file build keeps
its readable formatting because it is for reading. Neither carries a timestamp
or provider metadata, so identical input gives byte-identical output.

### Regional extract adapter

The checked-in local adapter consumes regional `.osm.pbf` extracts through
[`osmium-tool`](https://osmcode.org/osmium-tool/), filters only the approved
OSM tags (retaining referenced geometry nodes), and normalizes the resulting
GeoJSON before building the index. It retains node/way/relation identity; areas
and lines get a deterministic representative point. It is intentionally not a
pipeline job yet and has no network or R2 side effect:

```sh
pipeline/tools/build_osm_object_index.sh \
  --output-dir /tmp/nevaio-object-index/ \
  /path/to/region-a.osm.pbf /path/to/region-b.osm.pbf
```

`--output FILE.json` builds the single readable file instead.

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
at `04:35 UTC` and on manual dispatch. There is still deliberately no
historical backfill - the job renders "today" only (spec section 5.3).
Cloudflare bucket, token, GitHub variable, invocation, and verification
instructions are in [`docs/r2-setup.md`](../docs/r2-setup.md).

## What a publication puts in R2

Four kinds of public object, all read directly by the browser:

| Key | What it is | Cache |
|---|---|---|
| `runs/<runId>/tiles/{z}/{x}/{y}.png`, `runs/<runId>/run.json` | one immutable run | one year, immutable |
| `latest.json` | atomic pointer to the newest run | no-cache |
| `asof-<YYYY-MM-DD>-<runId>.json` | that date's manifest, `latest.json`-shaped | one year, immutable |
| `dates.json` | the AS-OF date catalogue | no-cache |

`dates.json` is **authoritative about availability** (spec section 5.3): a date
absent from it is unavailable, and must never be substituted with the latest
map or a nearby date. It is small enough to fetch at startup - about 3 KB at a
full window - and carries `schemaVersion`, `kind`, `generatedAt`, `maxDates`,
and `dates` newest-first, each entry `{asOfDate, runId, manifest}`. The
`manifest` value is a *relative* key, resolved against the catalogue's own URL,
so a poisoned catalogue cannot point the browser at another host.

Date manifests sit at the bucket root rather than under a `dates/` prefix on
purpose: `app/src/map/manifestSchema.ts` resolves tiles as
`<manifest directory>/runs/<runId>/tiles/…`, so a root-level manifest validates
through the identical code path as `latest.json`. The run ID is part of the key
so the whole public layer is derivable from two bucket listings with no GETs,
and so each manifest is immutable. `nevaio_pipeline.catalogue` holds all of
this (pure, no boto3); `artifact_validation.validate_date_catalogue` is the
stdlib validator the publisher runs over its own bytes before the PUT.

## Retention

Two independent rules, both applied after `latest.json` moves:

- `--keep-dates` (default `config.ASOF_CATALOGUE_DATES` = 31) is a **calendar
  window**: the newest available date and the 30 dates before it. Not a count
  of the newest 31 published dates - after a failed day a count would keep
  advertising dates further back than the selector may offer.
- `--keep-runs` (7 in the workflow) is the **rollback buffer**: that many
  newest runs survive whatever their date. It is what keeps the superseded run
  of a same-date re-run recoverable, and it is unchanged from the original
  policy.

A run survives if it backs a catalogue entry, is in the rollback buffer, or is
the run being published. Order is the safety property: upload the run, put its
date manifest, put the catalogue, move `latest.json`, then delete - so a date
is advertised only after its data is complete, and an object is deleted only
after a durable catalogue that omits it exists. A crash leaves unreferenced
objects, never an advertised date with no tiles. Omit `--keep-runs` (the
library default `keep_runs=None`) and nothing is ever deleted.

Storage: a mid-winter full-area run is ~130 MB / ~3,500 objects, so a full
31-date archive is ~4.0 GB and ~109,000 objects against R2's 10 GB free
allowance.

The schedule is set from measured behavior, not assumption: HR-WSI publishes
GFSC strictly daily, and a product dated `D` becomes fetchable at roughly
`D+1 00:15-03:00 UTC`. Multi-day processing backlogs do happen, but the 15-day
window absorbs them without a special case.

## Secure publication

See [publication security](../docs/publishing-security.md) for the split
render/publish workflow, required GitHub environment migration, hash-locked
dependency updates and credential-free artifact verification.
