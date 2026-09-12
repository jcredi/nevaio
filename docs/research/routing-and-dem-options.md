# Routing provider and elevation/DEM source: options, pros/cons, recommendation

**2026-09-12.** Written ahead of the owner's decision per `docs/plan.md` (decision,
2026-09-11): item 2 in the plan says this costed shortlist comes *before* the
pick, not after. Covers spec section 15 items 6 (hiking routing provider) and 7
(elevation/DEM source), both currently open. Numbers below are sourced as of
2026-09-12; anything I could not pin down from a primary page is marked
**unconfirmed** rather than guessed - verify before committing budget or code
to it.

## The question

Spec section 8 needs, for one origin/destination pair, walking/hiking mode
only:

- a route geometry over OSM ways, from a **hosted** routing API (section 8.1:
  "should not implement or self-host a routing engine for the initial MVP
  unless later investigation reveals a compelling reason");
- distance and elevation gain/loss (8.3);
- a snow-coverage and elevation profile along the route, sampled against
  native-resolution GFSC and an elevation model (8.3-8.4);
- observation freshness/quality shown "clearly and prominently" on that
  profile, upgraded from "where practical" to a firm requirement on
  2026-09-11 (section 15 item 11, plan item 2).

Two separate provider decisions follow from this: who computes the route
(6), and where elevation values along it come from (7). GFSC itself is
already decided (section 4, section 9) and is out of scope here.

## Constraints every candidate is checked against

1. **Free or very cheap.** No accounts, no backend database, no paying
   customers (spec section 11; operating-cost target is free-where-possible,
   up to EUR 20/month, spec section 15 item 9).
2. **Browser-side calls only.** There is no server to proxy through - every
   request comes straight from the user's browser. A provider whose terms
   forbid client-side/browser use, or that requires a secret which cannot be
   inlined into a public bundle, is disqualified unless it offers a
   domain-restricted *public* key the way MapTiler does today
   (`VITE_MAPTILER_API_KEY` is deliberately not marked secret in Netlify -
   Vite inlines all `VITE_*` vars into the client bundle, and the real access
   control is MapTiler's own domain allowlist, not Netlify's secret masking -
   see `app/src/features/search/geocode.ts` and `docs/security.md`).
3. **Attribution and licensing.** OSM/ODbL requires attribution wherever OSM
   data or its derivatives are shown (already carried for the basemap and
   geocoding); Copernicus data requires its own attribution string
   (`docs/agent-guide.md`).
4. **CSP cost.** Every new outbound origin is a one-line-but-mandatory edit to
   `app/public/_headers` (`connect-src`, and `img-src` if the origin serves
   raster tiles), verified by `npm run check-csp`. Not a blocker, but a cost
   to weigh against "just use the incumbent" (MapTiler already has a CSP
   entry, and its geocoding key already exists).
5. **Freshness/quality display fit.** Spec 15 item 11 wants observation
   freshness/quality "shown clearly and prominently" along the profile - a
   trait of the *snow* data, not the routing/DEM provider, but a provider
   that returns elevation as part of the same route response (rather than a
   second per-point elevation call) leaves more of the UI budget for that
   freshness treatment instead of stitching together two APIs' worth of
   per-point data. Noted per-candidate below where it applies.

Precedent this follows: `app/src/features/search/geocode.ts` picked MapTiler
Geocoding over Nominatim specifically because Nominatim's own usage policy
*prohibits* client-side autocomplete outright (spec amendment v1.9, audit
F11) - a terms-of-service disqualification, not a quality one. The same
question - "does the provider's ToS actually permit what a client-only app
needs to do" - is asked of every candidate below, not just pricing.

---

## Decision A: hiking routing provider (spec section 15 item 6)

### Comparison table

| Provider | Free tier | Hiking/walking profile | Client-side/CORS | Commercial-use allowed on free tier | New CSP origin |
|---|---|---|---|---|---|
| OpenRouteService (HeiGIT) | Directions: 2,000 req/day, 40 req/min sliding window per key ([forum thread citing the docs](https://ask.openrouteservice.org/t/pricing-plan-from-the-api/5806); overall account cap reported as 2,500 req/day - **the two figures come from different, non-primary sources and were not cross-checked against the current heigit.org dashboard page, which returned no numbers when fetched directly on 2026-09-12 - treat both as unconfirmed until read from the live dashboard**) | `foot-walking` and `foot-hiking` (SAC-scale aware) profiles exist ([forum thread](https://ask.openrouteservice.org/t/request-profile-foot-hiking-gets-blocked-by-cors-policy/3685)) | Designed for a public API key used from JS (`openrouteservice-js`); the same forum thread shows `foot-hiking` occasionally 403s with "access to this API has been disallowed" for reasons unrelated to CORS - **unconfirmed whether that is a per-account entitlement or a live bug** | ToS requires attribution "in your API implementation, site, or other properties" ([ToS](https://openrouteservice.org/terms-of-service/)); no explicit non-commercial clause found, but not independently confirmed for a free/no-revenue product | Yes, `api.openrouteservice.org` |
| GraphHopper Directions API | 500 credits/day free ([graphhopper.com/pricing](https://www.graphhopper.com/pricing/)) | Explicit `foot` **and** `hike` profiles, the latter tuned for "beautiful hiking tours," SAC-scale aware ([GraphHopper GitHub issue #2820](https://github.com/graphhopper/graphhopper/issues/2820)); elevation precision upgraded March 2026 ([GraphHopper blog](https://www.graphhopper.com/blog/2026/03/23/more-precise-elevation-data-for-graphhopper/)) | No CORS/domain-restriction documentation found; IP-based throttling noted on their forum, not domain allowlisting | **"The Free Plan is for non-commercial use only"** ([graphhopper.com/pricing](https://www.graphhopper.com/pricing/)) - a free, no-account, no-revenue app plausibly qualifies, but this is a self-declared reading of an ambiguous term, not a vendor confirmation | Yes, `graphhopper.com` (or their API host) |
| Mapbox Directions API | 100,000 requests/month free, then ~$2/1,000 up to 500k, volume discounts beyond ([mapbox.com/pricing](https://www.mapbox.com/pricing)) | `walking` profile exists, described by Mapbox's own docs as pedestrian/hiking routing over sidewalks and trails, up to 25 waypoints | Public (`pk.`) access tokens are designed for client-side use across Mapbox's whole product line; ToS requires visible Mapbox attribution | Free tier has no stated non-commercial restriction in the pricing page fetched | Yes, `api.mapbox.com` - a second full-stack provider alongside MapTiler, i.e. duplicate vendor surface for one feature |
| Stadia Maps Routing API | 200,000 credits/month shared across all Stadia products; routing costs 20 credits/request (up to 60-120 for traffic-influenced profiles, not needed here) ([stadiamaps.com/pricing](https://stadiamaps.com/pricing)) | Valhalla-based; pedestrian profile available (not separately verified for a SAC-scale-aware hiking mode - **unconfirmed**) | Built for client-side web use, similar public-key model | **"Commercial use not allowed"** on the free plan, and Stadia's own definition is broad: "usage counts as commercial if it is in a product or service that generates revenue... or if the organization using it is for-profit" ([stadiamaps.com/pricing](https://stadiamaps.com/pricing)). Nevaio generates no revenue but is a public "product or service" - **this reads as more likely to disqualify a free app than GraphHopper's wording does**, though neither has been confirmed by asking the vendor | Yes, `api.stadiamaps.com` |
| MapTiler Directions (own routing) | Not priced yet - beta, waitlist-gated | Car/truck/bicycle/pedestrian profiles planned | N/A | N/A | Would add nothing new if it ships (MapTiler origin/key already present) |
| Self-hosted engine (Valhalla/GraphHopper/OSRM on our own infra) | Free compute-wise but needs a server, which the app does not have today | Full control of any profile | N/A - the app would need a backend for the first time | We would own attribution correctly by construction | New origin either way (our own host) |

**MapTiler's own routing (checked directly, 2026-09-12):** confirmed still in
active beta as of the news post dated July 2026 and the product page fetched
today - "currently in active development," beta access is waitlist-gated via
a Google form, positioned explicitly for "enterprise routing and logistics"
(fleet/delivery), with no published pricing. Not usable today. Worth
revisiting once it exits beta, purely because it would mean zero new
vendors, zero new CSP origins, and one fewer key to manage - but it is not a
2026 MVP option.

**Self-hosting** is the spec's own named baseline to beat (section 8.1: "should
not... unless later investigation reveals a compelling reason"). None of the
above investigation surfaces a compelling reason to override that - every
hosted candidate clears a free tier adequate for a low-traffic MVP, so
self-hosting would trade zero dollars for a first backend, a new deploy
target, and OSM planet-extract/graph-build maintenance this project has
deliberately avoided everywhere else (agent-guide.md: "no backend database
for the MVP"). Rejected on the same reasoning the spec already states.

### Pros/cons

**OpenRouteService**
- Pro: purpose-built for exactly this - `foot-hiking` is SAC-scale aware, i.e.
  it can route hikers away from exposed scrambles by difficulty grade, which
  none of the general-purpose commercial APIs advertise.
- Pro: OSM-native by construction (same data lineage as the basemap and the
  section 4.2 object index), so attribution language is consistent with what
  is already on the map.
- Con: the free-tier numeric limits could not be confirmed from HeiGIT's own
  current dashboard page (it returned no content on fetch) - only from a
  forum post and a third-party pricing aggregator. Verify by creating a key
  and reading the dashboard's own quota display before committing.
- Con: at least one real forum report of `foot-hiking` returning "access...
  disallowed" for reasons that read as entitlement- or plan-related, not a
  transient bug - worth a smoke test with a real key before relying on it.
- Con: no confirmed domain-restriction option for the API key (MapTiler's key
  is safe to inline specifically because MapTiler restricts it by domain;
  that has not been confirmed as available on ORS keys).

**GraphHopper**
- Pro: `hike` profile is the most purpose-fit of the commercial options, and
  elevation is returned as part of the route response (with a precision
  upgrade as recently as March 2026), which would satisfy 8.3's "elevation
  gain/loss" and part of 8.4's elevation profile from the *same* call - no
  separate DEM round-trip for that specific number, though the *per-point*
  elevation profile spec 8.4-8.5 asks for still likely wants finer sampling
  than one route response returns.
- Con: 500 credits/day is the smallest routing-specific free allowance found
  (each Directions call typically costs more than 1 credit; the pricing page
  did not give a per-request credit cost, so the effective daily route count
  is **unconfirmed**).
- Con: free plan is explicitly "non-commercial use only" - the safest
  candidate to actually ask the vendor about before relying on for a public
  URL.

**Mapbox Directions**
- Pro: largest, best-documented free allowance found (100k/month) and public
  tokens are a first-class, well-understood client-side pattern - Mapbox's
  entire JS SDK ecosystem assumes browser-only use.
- Con: introduces a second full basemap/geocoding/routing vendor stack
  alongside MapTiler for one feature; separate account, separate key,
  separate line in `_headers`, separate attribution string to keep current.
  Given MapTiler is already the app's incumbent (basemap + geocoding), adding
  Mapbox only for routing is the one candidate that adds a whole new vendor
  relationship rather than reusing or extending an existing one.
- Con: `walking` is a general pedestrian profile, not hiking/trail-difficulty
  aware the way ORS's `foot-hiking` or GraphHopper's `hike` are - fine for
  "a trail exists between A and B," weaker for "is this trail exposed."

**Stadia Maps**
- Pro: single unified credit pool across tiles/geocoding/routing, transparent
  published pricing, Valhalla-based (mature open engine).
- Con: the free tier's own definition of "commercial use" is the broadest and
  most likely to catch a free, ad-free, revenue-free public app ("a product
  or service," full stop) - the weakest free-tier fit of the four commercial
  options on the licensing axis specifically, even though the credit
  allowance itself (200k/month) is generous.
- Con: pedestrian/hiking-specific profile depth (SAC-scale awareness) not
  confirmed.

### RECOMMENDATION: OpenRouteService, `foot-hiking` profile

**Reasoning.** It is the only candidate whose routing profile is actually
built for the stated use case - hiking with trail-difficulty awareness, on
OSM data with the same lineage as the rest of the app - rather than a
general pedestrian mode borrowed from a commercial fleet/delivery product.
That fit matters more here than raw request-count headroom: this is a
free, no-account, low-traffic MVP (spec section 11), so 2,000 requests/day is
almost certainly enough, and the OSM-native lineage keeps attribution
reasoning identical to what the app already states for the basemap and
geocoding.

**Main risk.** The free-tier numbers in this doc for ORS are the least
solidly sourced of the four commercial candidates - HeiGIT's own
dashboard/plans page would not render its content on a direct fetch today,
so the 2,000/day and 40/min figures rest on a forum post and a third-party
aggregator, not a primary page. **Before wiring this in, register for a key
and read the actual quota shown in the ORS dashboard**, and smoke-test
`foot-hiking` specifically against a real Alpine A-to-B pair - the one
forum report of that exact profile getting rejected is enough reason not to
assume it works from the pricing page alone.

**Fallback if ORS's real quota or the `foot-hiking` profile proves
unworkable:** Mapbox Directions, on the strength of its confirmed 100k/month
free allowance and its unambiguous client-side/public-token model - at the
cost of standing up a second full mapping vendor relationship next to
MapTiler.

### Rejected, and why

- **Self-hosting a routing engine (Valhalla/GraphHopper/OSRM on our own
  infra).** The spec's own explicit default to beat (8.1). No hosted
  candidate's free tier is inadequate enough to justify the first backend
  this project would ever need, plus planet-extract storage and graph-build
  maintenance the agent-guide's "no backend database" rule was written to
  avoid.
- **MapTiler's own Directions API.** Confirmed today (2026-09-12) to be an
  enterprise-logistics beta, waitlist-gated, unpriced, not usable for a
  shipping MVP. Would be the obvious first re-check once it exits beta,
  purely to avoid a second vendor, but is not an option now.
- **Stadia Maps.** Not disqualified outright, but its free-tier "commercial
  use" definition is the broadest of the four and the one most likely to
  read a free public app as covered by the restriction - a worse licensing
  fit than the alternatives even before comparing routing profile depth.
- **GraphHopper.** Kept as the closest runner-up rather than rejected
  outright - the `hike` profile is genuinely well-suited - but its free-tier
  "non-commercial use only" language is the most explicit of the group and
  the smallest daily allowance (500 credits, of unconfirmed per-request
  cost), so it is a second choice behind ORS rather than the pick.

---

## Decision B: elevation / DEM source (spec section 15 item 7)

### Comparison table

| Source | Access model | Resolution / coverage | Vintage | License/attribution | Client-side feasible without our own hosting |
|---|---|---|---|---|---|
| Copernicus DEM GLO-30 | Free, no registration, direct S3 (`s3://copernicus-dem-30m/`), Cloud-Optimized GeoTIFF ([AWS Registry of Open Data](https://registry.opendata.aws/copernicus-dem/), [readme](https://copernicus-dem-30m.s3.amazonaws.com/readme.html)) | 30 m global; absolute vertical accuracy <4 m LE90, horizontal <6 m CE90 per the product handbook (found via search, not independently re-derived) | Sourced from TanDEM-X acquisitions 2011-2015, infilled with SRTM/ALOS/ASTER/TerraSAR-X ([Sentinel Online](https://sentinels.copernicus.eu/-/copernicus-dem-30-metre-dataset-now-freely-available)) | Free for the general public under the Copernicus DEM licence; attribution `© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved` ([license PDF](https://docs.sentinel-hub.com/api/latest/static/files/data/dem/resources/license/License-COPDEM-30.pdf)) | Not directly - S3 GeoTIFFs are not a browser-callable API. Fits the "precompute and host the extract ourselves" path below, not a live per-request call. |
| Copernicus DEM EEA-10 | Requires Copernicus Data Space Ecosystem / WEkEO registration, access rights gated by declared "user category" ([CDSE description](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)) | 10 m, but only for the EEA39 area (which includes Italy and the Alpine countries) | Public-Authorities access opened 2025 per CDSE's own news post; general-public terms for 10 m specifically are **unconfirmed** - the news post is explicit that 10 m access is currently scoped to "Public Authorities users," not the general public | Same Copernicus programme, terms likely similar to GLO-30 but not independently confirmed for EEA-10 | No - registration-gated, and the "Public Authorities" scoping is a real risk that this project (a free hobby/public-interest app, not a public authority) may not even qualify for the 10 m product. Needs a direct check before counting on it. |
| Mapbox Terrain-RGB / Terrain-DEM tiles | Raster tile API, `pk.` token, billed as part of Mapbox's per-map-load model (50,000 free map loads/month bundling vector+raster+terrain tiles per the docs found) ([Mapbox tilesets docs](https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/)) | Global, zoom-dependent (effectively sub-30 m at high zoom in populated/mapped regions) | Not independently dated in what was fetched - **unconfirmed vintage** | Requires visible Mapbox attribution when used publicly | Yes - this is exactly the RGB-PNG-tile-in-the-browser pattern, decodable client-side with `height = -10000 + (R*256*256 + G*256 + B) * 0.1` |
| MapTiler Terrain-RGB | Tile or Elevation-API access, up to zoom 14, billed per request/tile like the rest of MapTiler Cloud ([docs.maptiler.com](https://docs.maptiler.com/schema-raster/terrain-rgb/), [pricing](https://www.maptiler.com/cloud/pricing/)) | Global composite of multiple curated DEMs, resolution not stated as a single number | Not independently dated - **unconfirmed vintage** | MapTiler's standard terms, same attribution already carried for the basemap | Yes, and it is the only elevation option that reuses the exact key, origin, and CSP entry the app already has for the basemap - zero new vendor, zero new `_headers` line |
| OpenTopoData (public `api.opentopodata.org`) | Free, no key, JSON point-query API | Serves `eudem25m` (25 m, "Europe") for this region, or coarser `srtm30m`/`aster30m` globally ([opentopodata.org](https://www.opentopodata.org/)) | EU-DEM vintage not restated here - it is the older EEA product, roughly mid-2010s per general EU-DEM documentation, **not independently re-verified in this pass** | EU-DEM/SRTM/ASTER attribution terms per their respective source licenses, not independently re-checked here | Yes, but capped at **1,000 calls/day, 1 call/second, 100 locations/request** on the shared free public instance (found via search, not from the primary docs page which did not surface the number on fetch) - workable only with a real per-route sampling budget, and it is a shared public resource with no SLA |
| Precompute our own DEM extract into R2 (from Copernicus GLO-30) | We fetch GLO-30 once, clip to the same 58-MGRS-tile footprint the GFSC pipeline already uses, and republish as a static, versioned raster/tile artifact in the same R2 bucket | 30 m, matches GFSC pipeline's own resolution class reasonably well (GFSC is 60 m) | Fixed at whatever vintage we pull, refreshed only if we choose to re-run the extract - simplest freshness story of all the options, since it is not a live third-party call at all | We own the attribution string and apply it once, correctly, the way the pipeline already does for GFSC | Yes - served as a static file from the same bucket/CSP origin already used for snow tiles, so **no new CSP origin at all** if placed alongside the existing R2 objects |

### Pros/cons

**Copernicus GLO-30 via S3, precomputed into our own R2 extract**
- Pro: no per-request quota, no third-party rate limit, no new runtime
  dependency at all - once the extract is built and published, elevation
  reads are exactly as reliable as the snow tiles already are, because
  they're the same kind of object on the same infrastructure.
- Pro: no new CSP origin - the R2 bucket host is already allowlisted.
- Pro: matches this project's existing pattern exactly (GFSC pipeline
  fetches from Copernicus, republishes to R2, frontend reads only R2) rather
  than adding a second, structurally different data-fetch pattern.
- Con: real, measured cost against a real constraint: `docs/plan.md`'s "Open"
  section already states R2 headroom is the binding limit on what else can
  ship there - a 31-date snow archive is ~4.0 GB of the 10 GB free tier,
  leaving roughly 6 GB for the OSM object index and the planned per-object
  snow series *combined*. A rough size check (not independently re-verified
  against a real download, arithmetic only): GLO-30 tiles are ~3,600x3,600
  px at 16-bit depth; even lightly compressed, a full 58-tile Alps+Apennines
  extract plausibly lands in the **several-hundred-MB to low-single-digit-GB**
  range - not free against that same headroom, and it would be competing
  directly with the per-object snow series the plan already flags as the
  next big consumer of that space. This needs an actual `du`-style estimate
  before committing, not the arithmetic above.
- Con: it is new pipeline work - a new build/publish step - which the spec's
  MVP-scope preference for "small, visible, working steps" (agent-guide.md)
  weighs against, compared to a live tile call to a vendor that already has
  a global CDN.

**MapTiler Terrain-RGB / Elevation API**
- Pro: zero new vendor. Reuses `VITE_MAPTILER_API_KEY` exactly as it already
  works for the basemap and geocoding - no new key, no new domain
  restriction to configure, and (if request-billed) it is one more request
  type against an account that already exists.
- Pro: RGB-tile decoding is a simple, well-documented client-side formula;
  no server round-trip beyond the tile fetch itself.
- Con: resolution is described only as "a composite of high-resolution DEMs,"
  not stated as a single number, and vintage is unconfirmed - weaker to cite
  in a product that otherwise measures and states its data provenance
  carefully (see `docs/research/gfsc-findings.md` for the standard this app
  holds itself to).
- Con: introduces a genuine per-tile cost line if usage is high, though at
  MVP traffic this is unlikely to matter.

**OpenTopoData public instance**
- Pro: genuinely free, no key, no account - the purest "free" option on this
  list, and the `eudem25m` dataset is a reasonable resolution for this
  region.
- Con: 1,000 calls/day and 1 call/second on a *shared* public resource with
  no SLA, no domain restriction, and no ability to inline a "key" (there is
  none) - fine for prototyping, risky for a public production route
  planner where request volume is not fully in our control.
- Con: EU-DEM vintage is older and less current than GLO-30 (unverified
  precisely, but EU-DEM is the earlier EEA product); no clear win over
  precomputing GLO-30 ourselves except zero engineering effort.

**Mapbox Terrain tiles**
- Con, decisively: same "second full vendor" objection as Mapbox Directions
  above, doubled - it would mean Mapbox for elevation *and* possibly routing,
  next to MapTiler for the basemap/geocoding. Only worth it if Mapbox is
  independently chosen for routing too, in which case reusing its terrain
  tiles for elevation becomes the efficient choice instead of an added cost.

**Copernicus EEA-10 (10 m)**
- Con, likely decisive: CDSE's own 2025 announcement scopes the newly opened
  10 m access to "Public Authorities users," and Nevaio is neither
  registered as, nor plausibly qualifies as, a public authority. This needs
  a direct check against CDSE's actual user-category terms before assuming
  it is available at all - treat as **probably not accessible**, not
  "available but harder."

### RECOMMENDATION: precompute a Copernicus GLO-30 extract into the existing R2 bucket, with MapTiler Terrain-RGB as the pragmatic fallback if the R2 headroom check fails

**Reasoning.** GLO-30 is free with no registration, has a stated, credible
vertical accuracy figure (<4 m LE90), and - critically - fits this project's
existing architecture exactly: fetch once from an open Copernicus source,
publish a static artifact to the R2 bucket the frontend already trusts, with
no new CSP origin and no new runtime rate limit to worry about at 2am when
someone is actually on a mountain. That is the same shape as the GFSC
pipeline itself, so it is the smallest conceptual addition even though it is
not the smallest engineering task.

**Main risk.** This recommendation is conditional on an actual size check
against the R2 free-tier headroom that `docs/plan.md`'s "Open" section
already flags as the binding constraint - the arithmetic above is a rough
estimate, not a verified number, and the per-object snow series described in
plan item 1 is competing for the same remaining ~6 GB. **If a real `du`
against a built extract shows it does not fit comfortably alongside the
snow-series build-out, fall back to MapTiler Terrain-RGB** - it costs zero
new vendor relationships (same key, same origin, already in `_headers`), at
the price of an unconfirmed exact resolution/vintage that this app would
otherwise want to state precisely.

### Rejected, and why

- **Copernicus EEA-10.** Higher resolution would be nice, but CDSE's own
  2025 announcement reads as scoping general 10 m access to "Public
  Authorities," which this project is not. Not worth building around until
  someone actually confirms general-public access terms with CDSE directly.
- **OpenTopoData public instance.** Attractive for being genuinely free and
  keyless, but 1,000 calls/day shared across every user of a public instance
  with no SLA is not something to build a public production feature on, and
  it offers no accuracy or freshness advantage over precomputing GLO-30
  ourselves.
- **Mapbox Terrain tiles.** Rejected as a standalone pick for the same reason
  as Mapbox Directions: it is a second full vendor stack for one feature.
  Only reconsider this together with a Mapbox routing decision, not in
  isolation.
- **Live third-party elevation API on every route request (any vendor).**
  Rejected in favor of precomputing, for the same reason self-hosting
  routing was rejected in the other direction: this app already has a
  working pattern (precompute once, publish to R2, serve statically with no
  per-request third-party dependency) and elevation data does not change day
  to day the way GFSC does, so there is no freshness reason to prefer a live
  call over a static extract the way there is for snow cover.

---

## What the owner still has to decide or sign up for

1. **Create an OpenRouteService account and read the real dashboard quota**
   for the `foot-hiking` profile specifically - the numbers in this doc are
   the least solidly sourced of the routing candidates and need a primary-source
   check before this becomes the committed choice. Smoke-test `foot-hiking`
   against a real Alpine A-to-B pair before wiring it into the app.
2. **Decide whether "free, no accounts, no revenue" reads as "non-commercial"**
   under GraphHopper's and Stadia's free-tier terms, if either is ever
   reconsidered - this doc treats both as ambiguous-to-risky rather than
   confirmed-clear, and only the owner (or a direct question to the vendor)
   can resolve that for a real product with a real public URL.
3. **Run an actual size check** (build a real GLO-30 extract for the 58-tile
   footprint, `du` it) against the R2 free-tier headroom before committing to
   precomputing elevation into R2 - `docs/plan.md`'s "Open" section already
   names this as the binding constraint on what else can ship there, and the
   per-object snow series (plan item 1) is the other large claimant on the
   same space.
4. **If GLO-30-in-R2 doesn't fit**, decide whether MapTiler Terrain-RGB's
   unconfirmed exact resolution/vintage is an acceptable trade against zero
   new vendor overhead - this app otherwise states its data provenance
   precisely (see the GFSC findings doc), so this is a real, if small,
   values trade-off, not just an engineering one.
5. **Independently confirm CDSE's EEA-10 access terms** if 10 m resolution is
   ever worth chasing - the "Public Authorities" scoping found here was from
   a single 2025 news post, not CDSE's actual terms-of-use page.
6. Neither decision here changes spec section 8's shape in a way that needs
   a spec edit - both `foot-hiking`-style routing and a precomputed DEM
   extract fit the existing 8.1-8.5 wording without amendment. The one
   detail worth carrying into implementation: if GraphHopper's `hike` profile
   is ever revisited, it returns route-level elevation gain/loss inline,
   which could simplify 8.3's "elevation gain/loss where available or
   derivable" - but the per-point elevation *profile* 8.4-8.5 needs still
   wants an independent, denser DEM sampling either way, so this does not
   remove the need for Decision B.
