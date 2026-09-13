# Snow along a route: why the published raster cannot answer it, and what can

**2026-09-13.** Written while finishing spec section 8. Distance, the elevation
profile, ascent/descent and the section 8.5 linked interaction all shipped
today; **snow along the route is the only part of section 8 still missing**, and
it is missing for a data reason rather than a UI one. This note records the
reason, the measured cost of each way out, and a recommendation. Numbers here
were measured against the live bucket and the real footprint, not estimated.

## The question

For each sample point along a route (60 m spacing, `routeProfile.ts`), the
profile needs the same four facts the object panel already shows for a point:

- the GFSC value (0-100%),
- which of the four states it is (valid / cloud / water / no data), because
  spec section 5.4 forbids confusing an unavailable observation with 0% snow,
- the QA tier 0-3,
- the observation age in days.

Spec section 15 item 11 is explicit and was strengthened deliberately on
2026-09-11: freshness **and quality** must be shown "clearly and prominently" on
the route profile, not "where practical".

## Why the published PNG tiles cannot supply it

The obvious idea - read the snow tiles the app already displays, with a canvas -
does not work, and **the spec says so itself**. Section 5.4:

> A valid 0% pixel is *not* distinguishable from these on the map raster (both
> are fully transparent, per section 5.2's revised opacity rule) - only
> point/object details and the historical chart tell them apart.

The published raster encodes exactly two things: colour = freshness tier (five
discrete tiers), alpha = coverage. So reading it back would lose:

- **the difference between "no snow here" and "we have no observation here"** -
  both are alpha 0. For a route profile that is not a detail, it is the whole
  question. A hiker reading "no snow" where the truth is "unknown, persistent
  cloud" is exactly the confusion section 5.4 exists to prevent;
- **the QA tier entirely**, which spec 15 item 11 requires;
- **exact observation age**, which survives only as one of five tiers.

This is a deliberate property of the rendering, not an oversight to work around.
Any approach that recovers data from the visual tiles is therefore rejected on
the spec's own terms.

## What would work: a separate lossless data raster

A second tile pyramid, published beside the visual one, carrying values rather
than appearance. One RGBA PNG per tile, read by the frontend with a canvas:

| channel | meaning |
|---|---|
| R | GF value 0-100, or 255 for "no value" |
| G | observation age in days 0-30, or 255 for "not applicable" |
| B | bits 0-1 QA tier (0-3), bits 2-4 state (0 valid, 1 cloud, 2 water, 3 no data, 4 stale) |
| A | always 255 |

**Alpha must be a constant 255**, and that is not a style preference: canvas
`getImageData` returns premultiplied-then-unpremultiplied values, so any alpha
below 255 silently corrupts the other three channels by rounding. A data raster
that used alpha as a fourth field would return subtly wrong snow values, and
would do it without any error. This mirrors the per-object cell format in
`object_series.py`, which packs the same facts into two bytes.

**Only one zoom level is needed.** The published pyramid is z8-z11, and z11 at
the footprint's latitude is 53 m/px against GFSC's 60 m native pixel - so z11
already *is* native resolution, and a data pyramid needs that level alone. The
frontend fetches only the tiles a route crosses, typically one to four.

### Measured cost

- **3,119 z11 tiles** cover the real footprint (computed from
  `footprint.mvp_footprint()`, counting tiles whose centre or any corner falls
  inside the 58 MGRS squares). This is substantially more than the 1,066 tiles
  the *visual* pyramid publishes across all four zooms, because the visual
  pyramid publishes only tiles that contain snow, while a data raster must cover
  every tile that carries any observation at all.
- Mean published z11 visual tile, sampled across nine real locations on
  2026-09-13: **9.2 KB**.
- **Mean modelled data tile: 8.7 KB.** Built by taking five real published z11
  tiles, recovering their snow field by inverting the published alpha ramp, and
  re-encoding it in the format above with spatially smooth age and QA fields -
  smooth because a whole acquisition swath shares a date, and modelling them as
  noise would badly overstate the compressed size.

  The first version of this model was wrong in an instructive way: it treated a
  transparent visual pixel as *uncovered*, when transparency on the visual tile
  means **no snow**, not no observation. Corrected to near-full observation
  coverage, the tiles got *smaller*, not larger, because a large uniform region
  of "valid, 0%" compresses about as well as a large uniform region of
  "absent".

| scope | per date | 31-date archive |
|---|---|---|
| measured September mix (8.7 KB/tile) | 26.6 MB | 0.80 GB |
| the snowiest sampled tile as the mean (14.8 KB/tile), i.e. a midwinter proxy | 45.1 MB | 1.37 GB |

Against the R2 free tier's 10 GB and a midwinter visual archive projected at
roughly 4 GB, even the whole 31-date archive is affordable at around 1.4 GB -
materially cheaper than the 2.8 GB the pre-measurement bracket feared. A single
date, at under 50 MB, is a rounding error.

## RECOMMENDATION: publish the data raster for the latest date only

Build the format and the pipeline stage now, but publish it for `latest` alone,
not for all 31 archived dates.

- **It is what the feature is for.** A route planner answers "should I go",
  which is a question about current conditions. The historical AS-OF picker
  exists so the *map* can be looked at over time; nobody has asked to plan a
  route against three weeks ago.
- **It costs under 50 MB instead of ~1.4 GB**, leaving the free tier's headroom
  for the winter visual archive, which is the thing that actually has to grow.
  The measurement weakens this argument from "prohibitive" to merely
  "unnecessary" - 1.4 GB would fit - so if per-date profiles are ever wanted,
  storage is not the reason to refuse them.
- **It is extendable without a format change.** If per-date profiles are ever
  wanted, the same stage runs over the archived dates and the frontend path is
  unchanged.

The honest consequence, which the UI must state rather than hide: **when the
user has selected a historical date, the route profile cannot show snow.** It
should say that plainly - "snow along the route is available for the latest date
only" - in the same spirit as every other unavailable-data message in this app.
Silently showing the latest snow against a historical date would be the worst
option available, and is precisely the class of error spec section 5.4 exists to
rule out.

## Settled by the owner, 2026-09-13

**Confirmed: latest date only, and publishing is now enabled.** The reasoning
given was the one this document recommends - "nobody plans a route for last
week". The daily workflow's render step passes `--data-tiles` unconditionally,
which satisfies "latest date only" by construction rather than by a condition:
every scheduled run renders the current date, so the newest date always has a
pyramid, and the historical dates already in the catalogue were deliberately
**not** backfilled.

Live cost is the figure this document already sized: **about 0.8 GB, up to
~1.4 GB at midwinter cover**, on a 10 GB free tier.

A correction worth recording, because it was briefly written down the other way
on 2026-09-13: `--keep-runs 7` does **not** cap this. That flag is only the
rollback buffer for superseded same-date runs. `catalogue.plan_retention` keeps
every run that backs a catalogue entry, so the real bound is
`ASOF_CATALOGUE_DATES = 31`.

That has a second consequence. Each daily run's own date manifest announces its
data pyramid, so within 31 days every date in the catalogue will answer
snow-along-route - not only the latest. "Latest date only" therefore describes
what is published *going forward* (nothing is backfilled, and the historical
dates that predate the flag never gain one); it is not a limit the app
enforces, and no pruning stage exists to impose one. If the storage is ever
wanted back, pruning `data/` from non-latest runs is the place to add it.

Two consequences worth knowing before changing any of this:

- **The flag's failure mode is silent.** Drop `--data-tiles` and nothing breaks:
  the run publishes, the map is correct, and the route panel simply says snow is
  unavailable - which is also the honest message for a date genuinely rendered
  without it. `DailySnowDataPyramidTests` in
  `pipeline/tests/test_workflow_security.py` asserts the flag is present *and*
  that it sits in the unconditional `args=(...)` literal rather than in one of
  the dispatch-input blocks below it, since the scheduled run is the one that
  must always have it.
- **Data tiles outnumber visual tiles**, and that is the feature. On the run
  this was sized against there were 1,066 visual tiles and ~3,100 data tiles:
  the visual pyramid draws only where there is snow, while this one must record
  everywhere there was an *observation*, including a confirmed zero.
