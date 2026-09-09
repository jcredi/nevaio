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

`preview.py` chains all of that into one end-to-end run: it discovers and
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

Run its tests from the repository root with the existing Python environment:

```sh
recon/.venv/bin/python -m unittest discover -s pipeline/tests
```

Build a local full-area preview without publishing it:

```sh
recon/.venv/bin/python -m pipeline.preview \
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
