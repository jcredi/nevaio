# What the MapTiler Outdoor style actually renders

Companion to [`gfsc-findings.md`](gfsc-findings.md): *what the data is*, not what
we decided. This file records the measured behaviour of the basemap the app
already uses, for the section 4.2 / 6.2 object classes.

**Probed 2026-09-11** against the live service:
`https://api.maptiler.com/maps/outdoor/style.json` (`"name": "Outdoor"`,
style spec version 8, 140 layers), its four sources' TileJSON, and real `.pbf`
tiles decoded with `@mapbox/vector-tile`. Rendering was cross-checked in a real
browser with `map.queryRenderedFeatures()` on `maplibre-gl` 4.7.1.

Test areas (all in the MVP scope): Monte Rosa (7.867, 45.937), Ortles/Solda
(10.6, 46.51), Gran San Bernardo (7.171, 45.869), Chamonix (6.869, 45.923),
Gran Sasso (13.559, 42.469), Tre Cime (12.305, 46.618); zooms 9, 11, 13, 14, 15.
Tiles decoded: 6 areas x 5 zooms x 2 vector sources.

The probe scripts were scratch tools and are not committed - the numbers below
are the record. Re-derive them by fetching the style JSON and decoding tiles;
they will drift as MapTiler updates its schema.

## Sources in the style

| source | type | TileJSON zooms | used for |
| --- | --- | --- | --- |
| `maptiler_planet` | vector | 0-15 | `mountain_peak`, `place`, `poi`, `transportation`, ... |
| `outdoor` | vector | **5-14** | `outdoor_poi`, `trail`, `ski` |
| `contours` | vector | 9-14 | contour lines |
| `terrain-rgb` | raster-dem | 0-14 | hillshade/terrain |

`outdoor` stops at z14: a direct request for `outdoor/15/x/y.pbf` returns
**HTTP 400**. MapLibre overzooms z14 tiles above that, so huts and shelters keep
rendering but their geometry is z14 geometry.

## The six approved classes, as actually rendered

Zoom column = the style layer's own `minzoom`-`maxzoom`. "Renders" means a style
layer exists whose filter can match; it does **not** mean every such feature
appears (see "Symbol collision" below).

| Approved class (spec 4.2) | Source layer | Style layer(s) | Zooms | Style filter | Verdict |
| --- | --- | --- | --- | --- | --- |
| peak | `mountain_peak` (planet) | `mountain_peak`, `mountain_peak-us` | 9-24 | `class == peak` **and `rank == 1`** | partial - see below |
| saddle / pass | `mountain_peak` (planet) | *(none)* | - | - | **never rendered** |
| hut / refuge | `outdoor_poi` (outdoor) | `outdoor_poi_hut` | 14+ | `class == hut`, Point only | rendered |
| shelter | `outdoor_poi` (outdoor) | `outdoor_poi_shelter` | 13+ | `class == shelter`, Point only | rendered |
| parking | `poi` (planet) | `outdoor_poi_parking` | **15+** | `class == parking` | rendered, icon only |
| settlement | `place` (planet) | `place_city` 5-24, `place_town` 6-**16**, `place_village` 10-**16**, `place_other` (hamlet/island/islet/neighbourhood/suburb, all zooms), `place_capital` 5-15 | see cell | class-dependent | partial - see below |

Also present but not approved for selection: `mountain_peak` also carries
`class` values `volcano` (rendered), `ridge`, `cliff`, `arete` (not rendered);
`outdoor_poi` carries ~30 classes (guidepost, board, map, viewpoint, bench,
waterfall, cave_entrance, ruins, castle, fortress, ...).

### Trap 1 - `saddle` is in the data and in nothing else

The Planet `mountain_peak` source layer carries `class: "saddle"`, with `name`,
`ele`, `ele_ft` and `rank`, from z9 up. **No layer in the Outdoor style
references it.** 146 saddle features were decoded across the test tiles; zero
are rendered. (Confirms and extends the note in `worklog.md`, 2026-09-10.)

Passes/saddles are an approved, first-class object for this product. They can
only come from Nevaio's own index.

### Trap 2 - the style renders only `rank == 1` peaks, and `rank` moves

Both peak layers filter `["==", "rank", 1]`. Across the test tiles:

| `rank` | 1 | 2 | 3 | 4 | 5 | 6+ |
| --- | --- | --- | --- | --- | --- | --- |
| peak features | 236 | 203 | 183 | 162 | 157 | 16 |

**About 25% of the peaks in the source layer are rendered by this style, at any
zoom.** The other ~75% are in the tile the browser already downloaded and are
invisible and untappable.

Worse, `rank` is recomputed per zoom level. Of 124 named peaks seen in more than
one zoom's tile over Monte Rosa, 9 changed rank between zooms - e.g. Balmenhorn
is `rank: 2` at z11 (not rendered) and `rank: 1` at z13 (rendered). The same is
true off the mountain: Chamonix-Mont-Blanc is `place` `rank: 12` at z9 and
`rank: 11` at z10-15.

So "is this object rendered?" is not a property of the object. It is a property
of the object *and the current zoom*.

### Trap 3 - symbol collision culls most of what passes the filter

`queryRenderedFeatures()` returns only symbols MapLibre actually placed. Over
Monte Rosa in a 1280x900 viewport:

- z12: 20 `mountain_peak` symbols placed
- z14: **1** (`Dufourspitze`) - every other rank-1 peak in view lost its label
  to collision

Label density, not eligibility, decides. A rendered-feature-first selection rule
would make most eligible objects untappable at exactly the zooms a hiker uses.

### Trap 4 - `place: isolated_dwelling` is data-only

`place` carries `isolated_dwelling` (9 features in the test tiles). No style
layer matches it: `place_other` covers only hamlet/island/islet/neighbourhood/
suburb. Also note `place_village` and `place_town` have `maxzoom: 16`, so
village and town labels *disappear* above z16 while the city layer continues.

### Trap 5 - `outdoor_poi.osm_id` is advertised and always absent

The `outdoor` TileJSON declares `outdoor_poi` fields
`["class", "name", "osm_id", "subclass"]`. Across **7,618** decoded
`outdoor_poi` features, `osm_id` was present on **zero**. The only class/name/
subclass keys ever appear. (3,599 of those 7,618 carry a non-empty `name`.)

### Trap 6 - MVT feature ids are real OSM ids, differently encoded per layer, and undocumented

Every feature in every probed layer has an MVT feature `id`. Spot-checked
against the OSM API:

| layer | example feature id | resolves to | encoding |
| --- | --- | --- | --- |
| `mountain_peak` | `307196932` | `node/307196932` = `natural=peak`, `name=Punta Gnifetti / Signalkuppe` | raw OSM id |
| `outdoor_poi` | `1880342036` | `node/1880342036` = `tourism=wilderness_hut`, `Bivacco Città di Gallarate` | raw OSM id |
| `outdoor_poi` | `12923963421` | `node/12923963421` = `amenity=bench` | raw OSM id |
| `poi` | `973203491` | `way/97320349` (`id / 10`) | `osm_id * 10 + type` |
| `poi` | `14320908420` | `node/1432090842` (`id / 10`) | `osm_id * 10 + type` |

Two different encodings inside one style, neither documented by MapTiler, and
the OSM *type* is not recoverable from `mountain_peak`/`outdoor_poi` at all
(they happen to be nodes here; nothing says they must be). Ids **are** stable
across zoom levels - Dufourspitze is `414760065` at z9-z15 - but that is an
observation, not a contract.

### Trap 7 - the provider's tiles can be staler than OSM

`outdoor_poi` still serves `Capanna Damiano Marinelli` as feature id
`4747654476`. `https://api.openstreetmap.org/api/0.6/node/4747654476.json`
returns **HTTP 410 Gone**: the node was deleted. A live basemap feature pointing
at an object that no longer exists upstream is exactly the failure a snow-history
identity cannot tolerate.

## Other things worth knowing

- **Names are inconsistently populated.** `outdoor_poi` frequently carries
  `name: ""` (benches, guideposts, viewpoints). Of 158 decoded `poi`
  `class=parking` features, only **29** have any name. The pipeline's decision
  to skip unnamed source records (worklog 2026-09-11) therefore also matches
  what the basemap can show.
- **Classification differs from OSM.** `Capanna Damiano Marinelli` is
  `outdoor_poi class=shelter, subclass=weather_shelter`; node `1430428746`,
  tagged `tourism=information` with `name=viewpoint`, arrives as an
  `outdoor_poi` feature with **no `class` at all** and `name: "viewpoint"`.
  `outdoor_poi class=hut` subclasses seen: `alpine_hut`, `basic_hut`. Alpine
  huts that are tagged as accommodation land in the planet `poi` layer as
  `class=lodging, subclass=chalet` instead.
- **Localisation.** Peaks and places carry up to ~75 `name:<lang>` keys plus
  `name`, `name:latin`, `name_de`, `name_en`, `name_int`. The style labels with
  `{name:latin}`.
- **Parking has no label.** `outdoor_poi_parking` is an icon-only layer
  (`icon-image: parking`, no `text-field`), so parking is visually present from
  z15 but never named on the map.
- **Elevation.** `mountain_peak` `ele`/`ele_ft` are present on 953 of 957 peak
  features; 11 of 957 have no `name`.

## What this means for the object panel

The evidence supports spec amendment v1.11 rather than merely being consistent
with it. Using rendered basemap features as the selection identity would mean:
no passes at all, ~75% of peaks missing, the visible subset changing with zoom
and with label collision, parking only above z15, an id whose encoding differs
per layer and is undocumented, and at least one feature whose OSM object has
been deleted.

The selection rule the frontend actually adopted, and its failure modes, are in
[`../worklog.md`](../worklog.md) (2026-09-11) and
`app/src/objects/selection.ts`.
