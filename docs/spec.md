# Nevaio MVP Product Specification

**Status:** Draft v1.13 - object history chart reduced to one 30-day window
**Date:** 2026-09-12
**Product stage:** Planning only

**Amendment (v1.13):** Section 7.1's chart period options are reduced to a
single trailing 30-day window ending on the map's AS-OF date. The last-90-days
and last-year presets, the custom period, and the comparable-period-in-a-
previous-year comparison are all dropped (owner decision, 2026-09-12); the
chart shows one window and offers no picker. Everything else in 7.1 stands
unchanged - in particular the honest treatment of cloud/no-data/stale gaps and
the per-mark eligibility rule, which is what the section is really for. This
also shortens what the per-object backfill must reach: enough history to fill
a 30-day window, not the two years the previous-year comparison implied. See
`docs/worklog.md` (2026-09-12) and `docs/plan.md`.

**Amendment (v1.12):** The map will gain an AS-OF date selector for the latest
available date and up to the preceding 30 calendar dates. It must select
already-rendered, date-specific R2 manifests and tiles, never reinterpret the
current map as an older date. The daily pipeline will retain the bounded
30-day archive and publish a small public date catalogue; a date absent from
that catalogue is unavailable, not silently substituted with another date.
This preserves the no-running-server design and the frozen section 9.2
selection semantics. The current compact control shows the latest AS-OF date
as non-interactive until this storage/catalogue work exists. See section 5.3
and `docs/plan.md`.

**Amendment (v1.11):** The object panel and chart will consume a Nevaio-owned,
static OSM object index, published to R2 beside the precomputed per-object snow
series. Each index record keeps a stable OSM type/ID, approved object class,
name, coordinates, and optional elevation. The MapTiler basemap remains visual
context only: its rendered feature properties are not the durable identity
contract for history. This retains the no-running-server architecture. The
source acquisition adapter and publication format remain implementation work;
the panel must not pretend a provider-tile click is an identity it cannot later
match to its snow history. See section 7 and `docs/worklog.md` (2026-09-10).

**Amendment (v1.10):** The initial set of interactive OSM objects is peaks,
huts/refuges, passes/saddles, shelters, parking, and settlements/named places.
Trails, paths, and roads remain visible map context but are not selectable by
default: their dense linear geometry would make accidental selection common and
would expand the first object-history dataset without a correspondingly useful
panel interaction. Exact zoom/layer matching is an implementation detail of
the selected vector style; an eligible object must be selectable wherever that
style renders it. See sections 4.2, 6.2, and 15 item 3, and
`docs/worklog.md` (2026-09-10).

**Amendment (v1.9):** Place search (section 6.1) moved from the public OSMF
Nominatim endpoint to MapTiler's Geocoding API (2026-09-09), reversing the
v1.8-era decision recorded in section 15 item 5. Reason: the OSMF usage policy
prohibits client-side autocomplete outright and limits the whole application to
one request per second, which a per-browser debounce cannot enforce - so the
shipped as-you-type search was not merely near a ceiling but outside the
provider's terms (security audit F11). The original decision's stated reason
for preferring Nominatim, OSM-native results matching the section 4.2 object
classes, is preserved: MapTiler's results are OSM-derived and carry their raw
OSM tags, which is what the search icons classify on. It also needs no new
credential, since it uses the basemap's existing key, and no new origin in the
deployed CSP. Cost: results now depend on a keyed commercial service subject to
that account's quota, and MapTiler's default result set had to be narrowed to
POI and place classes because the default ranking buried peaks and huts under
same-named streets. See sections 6.1 and 15 item 5, and `docs/worklog.md`
(2026-09-09).

**Amendment (v1.8):** Product renamed from Spikely to Nevaio (2026-09-07), the
user's pick from a naming brainstorm - see `docs/worklog.md` for the full
candidate list and reasoning. Cosmetic only: no product behavior, data
semantics, or architecture changed. `docs/agent-guide.md`, `README.md`, and
the frontend's page title were updated to match; historical dated entries in
this spec, `CHANGELOG.md`, and `docs/worklog.md` that reference the old
`spikely.netlify.app` domain describe what was literally live at that past
moment and are left as-is rather than rewritten.

**Palette revision (2026-09-06):** Sky to Indigo replaces Mint to Amethyst in section 5.2 because mint blends into green topo terrain. Age bands and opacity are unchanged.

**Amendment (v1.7):** Revised the section 5.2 visual encoding after review of an
alternative implementation surfaced a real ambiguity: the frozen v1.2 encoding
multiplied a snow-cover-derived alpha by a freshness multiplier into one
channel, so a faint pixel could mean "little snow" or "old observation"
indistinguishably. Opacity now encodes snow-cover percentage alone (linear
0-255 alpha over 0-100%, no non-zero floor at 0%); color now encodes
freshness alone, as 4 discrete tiers from mint (0-3 days) to amethyst (15-30
days), chosen from 6 candidate ramps rendered on real winter data. Cloud
(section 5.4) no longer gets a distinct violet indicator - it renders fully
transparent like water/stale/no-data, consistent with how those three states
already worked; the distinction survives only in point/object details and the
historical chart, not the map raster itself. Separately, and prompted by the
same review, the section 9.2 AS-OF age ceiling was raised from 14 to 30 days
after measuring the real-data benefit first: the gain is concentrated
specifically in multi-week cloudy spells (up to +59 percentage points of
valid coverage on one sampled tile-date), recovering observations that are
genuinely 13-19+ days old, not immediately-fresher data. Full reasoning,
rejected alternatives, and the palette comparison are in `docs/worklog.md`
(2026-09-06).

**Amendment (v1.6):** The production pipeline now implements section 9.2 in
full. It loads every complete GFSC product in the 15-day AS-OF window per MGRS
tile and selects per pixel, replacing the single-newest-product-per-tile
preview; measured on real winter data this recovers 23-74 percentage points of
valid coverage on 4 of 6 sampled tile-dates while correctly leaving genuinely
cloudy multi-day spells missing. The publish workflow moved from
manual-dispatch to a daily `04:35 UTC` schedule, matched to HR-WSI's measured
daily cadence and `D+1 00:15-03:00 UTC` publication latency, with a
seven-run R2 retention bound. The four MVP tiles that never had a product
(`33SVD`, `33SXB`, `33TTF`, `33TUE`) were confirmed absent from HR-WSI's own
983-tile grid - all four are open-sea squares - and removed from the tile set,
so a missing tile now fails the run instead of silently publishing a partial
map. Full reasoning and measurements in `docs/worklog.md` (2026-08-28). See
sections 9.2, 12, and 15.

**Amendment (v1.5):** The R2-based preview pipeline (v1.4) is live in
production: bucket CORS applied, `VITE_SNOW_MANIFEST_URL` set on Netlify, and
the full 58/62-tile MVP area published and visually verified rendering
correctly on `https://spikely.netlify.app` across multiple regions and zoom
levels. Still open: a cron schedule for the publish workflow, the section 9.2
multi-day AS-OF fallback (a single cloudy source day currently leaves visible
gaps - see the verification writeup), and 4 tiles without a current product
in the last run. Full detail in `docs/worklog.md` (2026-08-27). See sections
12 and 15.

**Amendment (v1.4):** Revised the same-day v1.3 storage decision: the MVP data pipeline publishes to Cloudflare R2 (immutable versioned run prefixes plus an atomically-updated `latest.json` pointer), not a static republish through the Netlify deploy. R2 serves tiles directly as public CDN objects with no egress fee, at Netlify credit costs a daily full-site republish would consume quickly. Implemented as `pipeline/preview.py` (orchestration), `fetch.py` (newest-product-only Copernicus discovery/download), `snapshots.py` (memory-bounded per-metatile rendering), and `publish.py` (atomic R2 upload); validated end-to-end against a real bucket. Full reasoning, the Netlify Blobs alternative considered and rejected, and the live verification are in `docs/worklog.md` (2026-08-26). See sections 12 and 15.

**Amendment (v1.3):** Deferred arbitrary historical AS-OF map-date browsing (section 5.3) out of MVP scope; the MVP ships "latest" conditions only, still computed via the frozen section 9.2 AS-OF rule. Decided the MVP data-pipeline/storage architecture: a daily GitHub Actions job renders one static "latest conditions" tile set and republishes it through the existing Netlify frontend deploy - no object storage or on-demand tile-rendering service for now. Set the operating-cost target: free where possible, up to EUR 20/month if it substantially simplifies things. Full reasoning, alternatives considered, and the revisit trigger are in `docs/worklog.md` (2026-08-26). See sections 5.3, 12, 13, and 15.

**Amendment (v1.2):** Froze the MVP snow-data semantics after empirical GFSC reconnaissance: `AT`-based freshness, all-tier quality handling, exact visual/category encoding, a 14-day AS-OF ceiling, and no app-created chart interpolation or carry-forward. See sections 5.2-5.4, 7.1, and 9.2.

**Amendment (v1.1):** Switched primary snow data source from raw FSCOG/FSCTOC (20 m) to GFSC, the Copernicus gap-filled composite (60 m). Rationale: GFSC trades spatial resolution and some observation-level precision for near-complete daily spatial/temporal coverage, which meaningfully simplifies the data pipeline and AS-OF logic for the MVP. This is a deliberate, reversible choice - raw FSCOG/FSCTOC remain available as a future upgrade path if 60 m proves too coarse for specific terrain (narrow ridges, passes) or the GFSC quality tier proves too coarse a freshness signal. See section 4.1, section 7.2, and section 15.

## 1. Product summary

The product is a free, mobile-friendly web application for hikers and mountaineers that combines an outdoor/topographic map with a quasi-real-time, near-complete Copernicus snow-cover layer (GFSC).

Its main purpose is to answer practical questions such as:

- How much of this mountain area is currently snow-covered?
- How recent is the satellite observation I am looking at?
- How has snow cover at this peak, hut, pass, or other mapped place changed over time?
- If I hike from point A to point B, where along the route am I likely to encounter snow?

The MVP is a planning and situational-awareness tool. It is not a snow-depth product, an avalanche forecasting product, or a turn-by-turn navigation system.

## 2. Initial target users

Primary users:

- hikers;
- mountaineers;
- alpinists;
- other outdoor users planning mountain travel.

The first release should prioritize clarity and usefulness for people deciding whether and where they are likely to encounter snow on a mountain route.

## 3. Initial geographic scope

The MVP should cover:

- the Alps;
- the Italian Apennines.

The architecture should not unnecessarily prevent later expansion to the rest of Europe, but Europe-wide support is not an MVP requirement.

## 4. Core data sources

### 4.1 Snow data

Primary snow product:

**Copernicus Land Monitoring Service - Gap-filled Fractional Snow Cover (GFSC), 60 m**

GFSC is a daily gap-filled composite built by Copernicus from FSC (Sentinel-2 optical), WDS/SWS (Sentinel-1 radar), and DEM inputs. It reports a single fractional snow-cover percentage per pixel (0-100%), already on-ground-corrected - there is no separate top-of-canopy variant to toggle. Compared to raw FSC, GFSC trades spatial resolution (60 m vs. 20 m native) and some per-observation precision for broader daily coverage. Real samples still contained large residual gaps, so GFSC simplifies but does not remove cloud/revisit gap handling from the MVP.

Each pixel carries a quality tier (0 = high, 1 = medium, 2 = low, 3 = minimal), an `AT` timestamp for the source acquisition actually used, plus explicit codes for cloud/cloud-shadow, inland water, and no-data. `AT`, measured relative to the selected AS-OF date, is the freshness signal. Quality is a separate confidence/gap-filling signal and must not be used as a proxy for age (see sections 5.2, 5.4, and 9.2).

For MVP purposes, historical support only needs to cover data from **20 January 2025 onward**.

Reference sources:

- Product page: https://land.copernicus.eu/en/products/snow/high-resolution-gap-filled-fractional-snow-cover
- Product User Manual: https://land.copernicus.eu/en/technical-library/product-user-manual-high-resolution-snow-products-europe/@@download/file
- HR-WSI Python/S3 client: https://github.com/eea/clms-hrwsi-api-client-python

### 4.2 Map and geographic objects

OpenStreetMap is the primary source for geographic and outdoor features.

The map should support mountaineering-relevant objects such as:

- peaks;
- huts/refuges;
- passes/saddles;
- shelters;
- trails and paths;
- roads and access points;
- parking;
- settlements and named places;
- other useful OSM objects exposed by the chosen map/search stack.

For the first interactive object panel, peaks, huts/refuges, passes/saddles,
shelters, parking, and settlements/named places are selectable wherever the
vector style renders them. Trails, paths, and roads remain map context only;
they are not selectable by default.

The exact basemap, tile provider, vector source, terrain source, geocoder, and elevation source are technical choices to be made later.

## 5. Core user experience

### 5.1 Main map

On opening the app, the user sees an outdoor/topographic map centered on the supported mountain region or on a sensible default view.

The base map should eventually include, directly or through combined data sources:

- hiking paths/trails;
- peaks and named mountain features;
- mountain huts and shelters;
- passes;
- contour lines;
- hillshade/terrain relief;
- rocky terrain/glaciers where available;
- access roads, parking, settlements, and labels.

A snow-cover layer is displayed over the topographic map.

### 5.2 Snow-cover visualization

Each GFSC pixel represents approximately 60 m x 60 m at native resolution.

The map must visually communicate at least two quantities:

1. fractional snow cover percentage;
2. freshness/age of the observation used for that pixel.

For a valid GFSC percentage `s` from 0 through 100, the MVP rendering (revised
2026-09-06 - see the v1.7 amendment above for why) fixes opacity and color as
two independent channels, so a faint pixel always means one thing (little
snow), never an ambiguity between "little snow" and "old observation":

- **opacity = snow-cover percentage:** piecewise-linear alpha from `0` at 0%, through `150` at 50%, to `255` at 100% (out of 255), rounded to the nearest 8-bit integer. There is no non-zero floor at 0%: a confirmed 0%-snow pixel is fully transparent, visually indistinguishable on the map from cloud/water/stale/no-data (section 5.4). The distinction survives in point/object details and the historical chart, not the raster itself.
- **color = freshness tier**, four discrete steps ("Sky to Indigo," selected to stand out against green topo terrain): `#38BDF8` for an observation age of 0-3 calendar days, `#5185ED` for 4-7 days, `#6957CE` for 8-14 days, and `#713A9C` for 15-30 days. Age is defined in section 9.2; day 31 onward is not rendered (see section 9.2's Stale rule).

Quality tier does not change color or opacity; its separate treatment is in section 5.4. Cloud, water, and no-data use categorical handling rather than this ramp - all four render fully transparent (opacity 0), with no distinct color.

Raster reprojection and map rendering must use nearest-neighbour resampling. GFSC mixes percentage values with categorical codes, so linear resampling would invent sub-60 m detail and plausible-looking percentages at category boundaries. The basemap's existing hillshade must remain above the snow layer; terrain relief must not be recovered by weakening the snow encoding.

The user must be able to toggle the snow overlay on/off.

The map renderer may display progressively coarser representations at lower zoom levels for performance. However, map rendering resolution and analytical resolution must remain conceptually separate.

### 5.3 Latest and historical AS-OF dates

The user must be able to view the latest available snow conditions and choose
any available AS-OF date from the preceding 30 calendar days. The date control
is enabled only after a date-specific archive is published; until then the UI
shows the latest date as text rather than offering a non-functional picker.

Each selectable date maps to that date's own immutable R2 manifest and tiles.
The public date catalogue is authoritative about availability. A failed or
missing historical day must remain unavailable; the app must not show the
latest map, a nearby map, or a client-recomposed substitute under the selected
date. The OSM-object historical chart (section 7.1) remains independent.

A selected date is an **AS-OF date**, not a requirement that every pixel have an observation acquired exactly on that date.

For a selected AS-OF date `D`, each pixel uses the latest valid observation available on or before `D` under the deterministic selection and staleness rule in section 9.2.

Example:

If the user selects 15 March and a pixel has valid observations on 11 March and 17 March, the app should use the 11 March observation.

Observation age/freshness should be calculated relative to the selected AS-OF date, not necessarily relative to today's date.

### 5.4 Clouds, missing values, water, and quality

The application must not confuse unavailable observations with 0% snow.

GFSC distinguishes ordinary 0-100% values from an explicit cloud/cloud-shadow code and no-data, and carries a four-level quality tier (high/medium/low/minimal) reflecting how much spatial/temporal gap-filling went into a given pixel. Even a gap-filled, spatially-complete product can still have genuine no-data (e.g. persistent cloud with no usable source data at all).

The MVP treatment is:

- GF values 0-100 with a quality tier 0-3 and usable `AT` are valid. High, medium, low, and minimal tiers are all retained for map rendering and analysis; tier alone never hides or attenuates a value. The tier must be preserved and displayed by name in point/history details and included in route-quality summaries. This is necessary because a real forested sample was tier 3 on every valid day.
- QA flags are retained as metadata but do not exclude a valid percentage in the MVP.
- Cloud/cloud-shadow (`205`) is not a snow value. If AS-OF fallback finds no usable earlier value, render the snow layer transparent (revised 2026-09-06 - previously a distinct violet `#A855F7`; the map raster no longer visually distinguishes cloud from water/stale/no-data, only opacity=coverage and color=freshness are encoded there) and label it **Cloud** in point/object details and the historical chart.
- Inland water (`210`) is a terminal mask, not 0% snow: do not search earlier products for a snow value, render the snow layer transparent, and report **Water** in details and analysis.
- No-data (`255`), a missing product, an unusable `AT`, or inconsistent GF/GF-QA category codes is unavailable, not 0% snow: render the snow layer transparent and report **No data**. A valid 0% pixel is *not* distinguishable from these on the map raster (both are fully transparent, per section 5.2's revised opacity rule) - only point/object details and the historical chart tell them apart.
- A structurally valid percentage whose newest usable `AT` is more than 30 days old is hidden and reported as **Stale - last observation N days old**, not collapsed into cloud, no-data, or 0% snow.

Cloud and no-data remain separate states throughout storage, APIs, point/object details, and the historical chart even though both can trigger AS-OF fallback and now render identically (fully transparent) on the map raster itself. They were observed as distinct multi-day runs in real data and must not be collapsed into one generic missing code anywhere except that shared raster appearance.

## 6. Place search and selectable OSM objects

### 6.1 Search

The user can search for a place by:

- name;
- coordinates.

Search should support ordinary locations and mountain-relevant named OSM objects, subject to the capabilities of the selected geocoder/search stack.

Examples include peaks, huts, passes, villages, parking areas, and other named features.

### 6.2 Selectable objects

Mountaineering-relevant OSM objects shown on the map should be interactive map entities, not merely labels baked into a raster image.

The initial eligible classes are peaks, huts/refuges, passes/saddles, shelters,
parking, and settlements/named places. Trails, paths, and roads are excluded
from the default interaction target to avoid dense-line accidental selection.

When the user selects an eligible OSM object, an information panel opens below or adjacent to the map depending on screen size.

The detailed snow-history panel applies to OSM objects only.

Clicking an arbitrary raster pixel does **not** need to open a historical snow panel in the MVP.

## 7. OSM object information and snow history panel

For a selected OSM object, the panel should display relevant object metadata where available, for example:

- name;
- object type;
- elevation;
- coordinates;
- relevant OSM attributes.

It should also display current/as-of snow information derived at the object's location, including at minimum:

- GFSC percentage;
- GFSC product date (the daily composite date, not necessarily the underlying satellite acquisition date);
- age of that product date relative to the map AS-OF date;
- quality tier for that pixel (high/medium/low/minimal), as the primary indicator of how much gap-filling was involved.

### 7.1 Historical chart

The panel and chart use a static Nevaio-owned OSM object index published to R2
alongside the precomputed per-object time series. Every record has a stable OSM
type/ID, approved object type, name, coordinates, and optional elevation. The
rendered MapTiler basemap is visual context, not the identity source for a
history lookup; no new running server is introduced for this feature.

The panel should include an interactive snow-cover history chart for the selected object.

The chart covers a single period: the trailing 30 days ending on the map's
AS-OF date. There is no period picker, no custom range, and no previous-year
comparison - see amendment v1.13, which replaced the earlier list of presets.

The chart must handle missing/cloudy observations honestly rather than silently converting them to snow-free conditions.

Historical charts plot one discrete mark for a product date only when that product's own pixel has GF 0-100, GF-QA 0-3, and a usable `AT` no more than 14 days before that product date. The mark uses that product's explicit GF value. Charts do not interpolate, smooth, or carry the last value into a cloud/no-data/missing date, and they do not populate chart gaps from the map's AS-OF fallback. A gap remains a gap and is labelled **Cloud**, **No data**, or **Stale** where applicable. Every mark's details expose product date, source `AT`, observation age, and quality tier. This rule does not undo gap-filling already performed inside an explicit GFSC product; it only forbids the app from inventing additional values.

### 7.2 FSCOG / FSCTOC toggle - removed for MVP

GFSC does not provide a separate top-of-canopy layer, so this toggle no longer applies. GFSC is effectively on-ground-corrected already.

If 60 m resolution or GFSC's smoothing proves too coarse for specific terrain during implementation, raw FSCOG/FSCTOC remain available as a future higher-resolution layer (see section 15). Any such addition should still avoid implying that either value is snow depth.

## 8. A-to-B hiking route planner

### 8.1 Scope

The MVP includes simple walking/hiking routing from point A to point B.

The route should be produced through a hosted OSM-based routing API. The app should not implement or self-host a routing engine for the initial MVP unless later investigation reveals a compelling reason.

Candidate providers will be evaluated later.

The route planner is intentionally limited to:

- one origin;
- one destination;
- walking/hiking mode.

### 8.2 Route endpoints

The preferred interaction is selection of OSM objects or searched places as origin and destination.

The detailed UX for choosing endpoints will be designed later.

### 8.3 Route outputs

Once a route is calculated, the application should show basic route information such as:

- distance;
- elevation gain/loss where available or derivable;
- route geometry on the map.

The route must then be analyzed against native-resolution or appropriately sampled FSC and elevation data.

Analytical results must not change simply because the user changes map zoom level.

### 8.4 Snow coverage along the route

The route view should include:

- snow coverage profile along distance;
- elevation profile along the same distance axis;
- route-level summary snow statistics;
- a route line that can visually encode snow coverage along its length.

A useful MVP headline statistic is the proportion of the route currently/as-of-date affected by snow, with the exact definition to be decided after data reconnaissance.

Potential additional statistics, if straightforward and defensible, include:

- distance with FSC above a selected threshold;
- longest continuous snow-covered section;
- snow coverage by elevation band;
- freshness/quality summary for the observations intersecting the route.

These are optional unless promoted into scope later.

### 8.5 Linked map/profile interaction

The elevation and snow profile must be interactive.

When the user moves a mouse pointer or finger along the profile:

- the corresponding route location is identified;
- a marker/dot moves to the corresponding point on the map;
- the profile can show local elevation, FSC, and observation freshness/quality where practical.

This interaction is a core MVP requirement.

### 8.6 Routing disclaimer

Automatically generated hiking routes depend on OSM completeness and the routing provider's interpretation of paths and trail difficulty.

The app should make clear that a suggested route must be independently verified and is not a guarantee of safety, accessibility, or suitability.

The MVP is a route-planning aid, not a safety-critical navigator.

## 9. Snow data semantics

### 9.1 What GFSC means

GFSC is fractional surface snow coverage (on-ground corrected), expressed as a percentage of the pixel area.

The app must not present GFSC as:

- snow depth;
- snow water equivalent;
- snow hardness;
- avalanche risk;
- a determination that crampons, skis, snowshoes, or other equipment are required.

A value of 100% means that the pixel is assessed as completely snow-covered according to the product, not that snow is deep.

### 9.2 Latest valid observation

All dates and acquisition timestamps are compared in UTC. For an AS-OF calendar date `D`, observation age is `D - UTC-date(AT)` in whole calendar days, with a minimum of zero.

For each pixel:

1. If the newest available product on or before `D` identifies the pixel as inland water (`210`), return **Water** immediately.
2. Consider products with product date on or before `D`. A candidate is valid only when GF is 0-100, GF-QA is 0-3, `AT` is usable and no later than the end of `D`, and its observation age is at most 30 days (raised from 14 on 2026-09-06 - see below). Quality tiers 0-3 are equally eligible.
3. Select the candidate with the greatest `AT`. Break an `AT` tie by better quality tier (lower numeric GF-QA), then by the later product date. This makes the result independent of file or query ordering.
4. Render the selected value with the freshness color from section 5.2: sky blue at 0-3 days, through two intermediate tiers, to indigo at 15-30 days.
5. If no candidate exists, return no snow value. Preserve the newest product's reason as **Cloud** for `205` or **No data** for `255`; no product or malformed/inconsistent metadata is **No data**. If valid-form percentages exist but their usable acquisitions are all older than 30 days, return **Stale** with the most recent acquisition age. Do not search or carry forward beyond 30 days.

The backward search is required because median same-day valid coverage was only 25-63% across the reconnaissance samples and one tile changed from 97% valid to 90% no-data in five days. The ceiling (originally 14 days, raised to 30 on 2026-09-06 after measuring the real-data benefit first) keeps a genuinely useful backward search available through ordinary multi-week cloudy spells, while still making anything older genuinely unavailable instead of presenting an indefinite carry-forward as current evidence. The 2026-09-06 measurement found the gain from extending past 14 days is concentrated almost entirely in exactly those multi-week cloudy spells - negligible (+1 to +4 percentage points) on ordinary days, but substantial (+33 to +59 percentage points on sampled tile-dates) when a tile had been cloud-bound for two-plus weeks; full measurement in `docs/worklog.md` (2026-09-06).

### 9.3 MGRS tile overlaps and UTM-zone seams

GFSC MGRS tiles overlap by design, including across the UTM zone 32/33 seam in the Dolomites. Each tile must first be composed independently on its native grid using section 9.2. When native composites are reprojected onto a common output grid, every field must use nearest-neighbour resampling; averaging is forbidden because it would blend categorical states or invent snow percentages.

For each output pixel covered by more than one tile, choose exactly one result in this order:

1. **Water** wins, because it is a terminal static mask.
2. Otherwise, choose a **valid** observation with the newest `AT`; break a tie with the lower numeric quality tier, then the lexicographically earlier MGRS tile ID.
3. If no valid observation exists, choose **Cloud**, then **Stale**, then **No data**.

This rule is applied per output pixel, never by arbitrary file order or map viewport. It yields one continuous result through an overlap while preserving the evidence/freshness semantics elsewhere in this section.

## 10. Responsive/mobile web behavior

The first product is an open web application but must be designed mobile-first enough to work comfortably on a phone browser.

Requirements include:

- touch-friendly map controls;
- touch-friendly date and layer controls;
- selectable OSM objects without relying on mouse hover;
- route-profile scrubbing by touch;
- information panels that work on narrow screens;
- no essential interaction that requires a desktop mouse.

Desktop may offer hover as an additional convenience.

## 11. State, accounts, and privacy

The MVP is completely stateless from the user's perspective.

It should require:

- no user account;
- no login;
- no saved routes;
- no saved favorite places;
- no personal profile.

Backend caching, shared precomputed data, and anonymous operational telemetry are separate technical considerations and do not constitute user-specific persisted state.

## 12. Operating model

The app is free to users.

Operating-cost target (decided 2026-08-26): free where possible; up to EUR 20/month is acceptable if it substantially reduces complexity, improves reliability, or avoids building/operating unnecessary infrastructure.

The frontend (`app/`) deploys to Netlify, connected to this GitHub repo and auto-deploying on every push to `main` - see `docs/agent-guide.md` for build config. The MVP data pipeline is a GitHub Actions job running daily at `04:35 UTC` (and on manual dispatch) that composes each MGRS tile's 15-day GFSC window under the section 9.2 AS-OF rule, renders one "latest conditions" tile set, and publishes it to Cloudflare R2 as an immutable run plus an atomically-updated `latest.json` pointer; the app reads that manifest directly from R2 (see section 15 item 8 and `docs/worklog.md`, 2026-08-26 and 2026-08-28).

The schedule is set from HR-WSI's measured behavior rather than assumption: products are published strictly daily, and a product dated `D` becomes fetchable at roughly `D+1 00:15-03:00 UTC`. The job keeps only the newest seven runs in R2, which bounds storage inside the free tier - a mid-winter full-area run is roughly 130 MB, so unbounded daily retention would exceed R2's 10 GB allowance within one season. Because the run publishes `latest.json` last and prunes only afterwards, a failed run leaves the previous day's map serving unchanged rather than a partial one.

## 13. MVP feature scope

| Capability | MVP status |
| --- | --- |
| Outdoor/topographic map | Required |
| GFSC snow overlay | Required |
| Latest snow conditions | Required |
| Historical AS-OF map date (latest 30 days) | Planned - needs dated R2 archive/catalogue |
| Observation freshness visualization | Required |
| Quality/missing-data handling | Required |
| Search by name | Required |
| Search by coordinates | Required |
| Interactive mountaineering-relevant OSM objects | Required |
| OSM-object historical snow chart | Required |
| A-to-B hiking route planning | Required |
| Route elevation + snow profile | Required |
| Linked profile/map cursor | Required |
| Basic route snow summary | Required |
| User accounts | Out of scope |
| Saved routes/favorites | Out of scope |
| GPX/KML upload | Out of scope |
| Multi-waypoint routes | Out of scope |
| Circular route generation | Out of scope |
| Turn-by-turn/live navigation | Out of scope |
| Offline maps/snow | Out of scope |
| FSCOG/FSCTOC on-ground/canopy toggle | Out of scope (GFSC has no canopy variant) |
| Android native app | Future |
| Notifications | Future |

## 14. Explicit non-goals for v1

The MVP should not attempt to become:

- a full GIS application;
- an avalanche bulletin or hazard model;
- a snow-depth estimator;
- a weather forecast app;
- a live GPS navigation app;
- an offline field-navigation tool;
- a social/community platform;
- an account-based route library.

These exclusions are important to keep the first release manageable.

## 15. Important open decisions

Snow/freshness encoding, quality and categorical-code handling, staleness, prolonged gaps, and historical-chart carry-forward are now frozen in sections 5.2-5.4, 7.1, and 9.2. The remaining open decisions are:

1. Exact route sampling method and sampling spacing.
2. Exact definition of route "snow-covered percentage."
3. **Decided for MVP (2026-09-10):** Peaks, huts/refuges, passes/saddles,
   shelters, parking, and settlements/named places are interactive wherever
   the chosen vector style renders them. Trails, paths, and roads remain visible
   but are not selectable by default: their dense linear geometry makes
   accidental selection common and does not justify expanding the first
   per-object snow-history dataset. See sections 4.2 and 6.2.
4. Basemap/vector/terrain provider.
5. **Decided for MVP (2026-09-06; reversed 2026-09-09, amendment v1.9):**
   Nominatim's free, keyless public search endpoint was chosen over reusing
   the existing MapTiler API key for MapTiler's own Geocoding API -
   OSM-native (matching where the mountaineering objects in section 4.2
   already come from), at the cost of the anonymous endpoint's own
   usage-policy rate ceiling. **Now superseded:** that policy does not merely
   set a ceiling, it prohibits client-side autocomplete and caps the whole
   application at one request per second, so the shipped as-you-type search
   was outside the provider's terms rather than close to its limit (security
   audit F11). Place search now uses MapTiler Geocoding, whose results are
   still OSM-derived and still carry raw OSM tags. Revisit (self-host
   Nominatim or Photon) if MapTiler's quota or ranking becomes the
   constraint. See amendment v1.9 and `docs/worklog.md` (2026-09-06,
   2026-09-09).
6. Hiking routing provider.
7. Elevation/DEM source.
8. **Decided for MVP (2026-08-26, revised same day; completed 2026-08-28):** frontend on Netlify (done, see section 12); data pipeline is a GitHub Actions job rendering one "latest conditions" tile set, publishing an immutable run plus an atomic `latest.json` pointer to Cloudflare R2 (not a static Netlify republish - see `docs/worklog.md`, 2026-08-26, for the Netlify Blobs/static-republish alternatives considered and rejected). Implemented, live on production (`https://spikely.netlify.app`), and visually verified end-to-end (2026-08-27, again 2026-08-28). As of 2026-08-28 the job composes the **full section 9.2 AS-OF rule** over a 15-day product window per tile rather than the single newest product. **New planned extension (2026-09-10):** retain a bounded 30-day set of immutable daily runs and publish a date catalogue so the frontend can select an actual archived AS-OF manifest/tiles with no running server. The catalogue and retention policy must arrive before the UI date picker; an unavailable date is unavailable, never a fallback to latest. The existing seven-run rollback policy is therefore not yet sufficient for this feature. **Still open:** a custom domain in front of the `r2.dev` URL (optional, pre-launch).
9. **Decided for MVP (2026-08-26):** operating-cost target is free where possible, up to EUR 20/month if it substantially simplifies things (see section 12).
10. Whether raw FSCOG/FSCTOC (20 m) should be added later as an optional higher-resolution layer for terrain where 60 m GFSC proves too coarse.
11. **Noted 2026-09-06, detail deferred:** the route planner's snow/elevation profile (sections 8.4-8.5) must clearly and prominently display observation freshness/quality, not merely "where practical" as currently worded - the user wants this treated as a firm requirement once routing is built, not an optional extra. Exact treatment (per-point badges, a color-coded profile band, a separate freshness track, etc.) to be decided when section 8 is actually implemented; see `docs/worklog.md` (2026-09-06).

## 16. MVP success criteria

The MVP is successful if a hiker or mountaineer can, on desktop or mobile web:

1. open the app and understand where snow is currently present in a mountain area;
2. distinguish fresh observations from stale or unavailable observations;
3. move the map to a named mountain location quickly;
4. inspect historical FSC at a mapped peak, hut, pass, or similar OSM object;
5. change the map to an earlier AS-OF date and understand what snow information was available then;
6. plan an A-to-B hiking route;
7. see where snow occurs along that route in combination with elevation;
8. interactively link the route profile to the map;
9. understand that the product represents snow cover, not snow depth or route safety.

## 17. Product principle

The app should make sophisticated geospatial data useful without requiring the user to understand satellite products, MGRS tiles, GeoTIFFs, quality bitmasks, or GIS software.

The interface should expose uncertainty and freshness honestly while keeping the default experience simple enough to answer one practical question quickly:

**"Where am I likely to encounter snow on this mountain or route, based on the most recent usable satellite observations?"**
