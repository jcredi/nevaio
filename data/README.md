# Local data tree

Nothing in here is committed except this file (`.gitignore`: `data/*`,
`!data/README.md`). Three subdirectories with three different lifecycles - the
distinction that `recon/` used to blur, which is why it could never be deleted:

| Directory | What it is | If you lose it |
|---|---|---|
| `research/` | Durable GFSC archive: 3484 files, ~1.51 GiB, four contrasting sample areas downloaded Aug 2026 | Re-downloadable but slow, and **out of season** - see below |
| `cache/` | Disposable pipeline downloads | Just re-runs |
| `output/` | Generated tiles and artifacts | Just re-runs |

Only `research/` matters. Treat it as research material, not a download cache.

## `research/` - the winter archive

Moved here from `recon/data/` on 2026-09-09 with all 3484 md5 checksums
verified identical before and after.

| Area | Size | Files |
|---|---|---|
| `dolomites-tile-boundary/` | 487 MB | 1095 |
| `gran-sasso-apennines/` | 140 MB | 751 |
| `ortles-cevedale-glaciers/` | 320 MB | 549 |
| `paneveggio-forest/` | 573 MB | 1095 |
| `reference/MGRS_tiles.gpkg` | 16 MB | HR-WSI's own MGRS grid |

**Why it is worth keeping.** It holds Jan-Apr real snow, and the repository's
real-data checks depend on that: any change to the frozen section 5.2/9.2
encoding needs to be evaluated against genuine winter coverage, which cannot be
re-downloaded *out of season* - the live catalogue in September returns a
near-snowless Alps. It is also the input to the sample overlay tool below, and
the source of the 2320-layer measurement behind `pipeline/config.py`'s
`GFSC_TILE_PIXELS` and the 16 MiB layer ceiling.

`reference/MGRS_tiles.gpkg` is HR-WSI's own tile grid, used during
reconnaissance to verify tile overlap rather than guessing at it. Production
discovery does **not** read it - `pipeline/config.py` hardcodes its 58-tile list
precisely so publication has no dependency on a 16 MB ignored file.

## Provenance

Downloaded with the vendored HR-WSI S3 client, retained for provenance at
`pipeline/tools/vendor/hrwsi/` (its own LICENSE and README travel with it). No
production code imports it; `pipeline/fetch.py` has its own implementation. It
is not installable from the current `pipeline/.venv`, which deliberately omits
its geopandas/pyogrio/shapely/retry/tqdm dependencies - see
`pipeline/requirements-dev.in`.

Findings from this archive: `docs/research/gfsc-findings.md`.

## Regenerating the committed fallback overlay

`app/public/snow/gfsc_32TPS_20260206.{png,json}` is the archived sample the
frontend shows when the live snapshot is unavailable. It comes from
`research/ortles-cevedale-glaciers/`:

```sh
pipeline/.venv/bin/python pipeline/tools/make_sample_overlay.py
```

Verified 2026-09-09 to reproduce the committed PNG byte-for-byte from this
relocated archive. The committed `.json` sidecar's `note` field still names the
tool's former path (`recon/make_overlay.py`); that is historical provenance of
when the asset was generated and is deliberately not rewritten.
