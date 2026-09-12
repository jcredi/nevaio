import maplibregl from "maplibre-gl";
import {
  initialView,
  objectIndexUrl,
  snowManifestUrl,
  styleUrl,
} from "./map/config";
import { loadDateCatalogue } from "./features/snow/dateCatalogue";
import type { CatalogueEntry } from "./features/snow/dateCatalogueSchema";
import { metersPerPixel } from "./map/scale";
import { SelectionHighlight } from "./features/objects/highlight";
import { addSnowOverlay, type SnowOverlay } from "./features/snow/overlay";
import { ObjectIndexStore } from "./features/objects/objectIndex";
import type { Bounds } from "./features/objects/objectIndexSchema";
import {
  SELECTION_MAX_METERS_PER_PIXEL,
  resolveSelection,
  type Selection,
} from "./features/objects/selection";
import { ObjectPanel, type IndexStatus } from "./features/objects/panel";
import { SnowControl } from "./features/snow/control";
import { SnowDateControl } from "./features/snow/dateControl";
import { createSearchBar, type SearchPoint } from "./features/search/searchBar";
import "./style.css";

const map = new maplibregl.Map({
  container: "map",
  style: styleUrl,
  center: initialView.center,
  zoom: initialView.zoom,
  attributionControl: {
    // Keep full legal attribution visible on phones. The compact variant turns
    // it into a separate ⓘ disclosure, which is not the intended footer.
    compact: false,
    // The MapTiler style supplies its own MapTiler/OSM credit; this adds the
    // Copernicus one, now that we render Copernicus-derived data.
    customAttribution:
      '<a href="https://land.copernicus.eu/en/products/snow/high-resolution-gap-filled-fractional-snow-cover" target="_blank" rel="noopener">Snow: Copernicus HR-WSI GFSC</a> (© European Union, Copernicus Land Monitoring Service / EEA)',
  },
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

// Object selection (spec section 7, amendment v1.11). The identity contract is
// Nevaio's own static index, never MapTiler's rendered feature properties -
// see docs/research/maptiler-outdoor-objects.md.
const objectPanel = new ObjectPanel();
document.body.append(objectPanel.element);

const objectIndex = new ObjectIndexStore(objectIndexUrl, window.location.href);
let indexLoaded = false;
let indexFailed = false;
let highlight: SelectionHighlight | null = null;

function viewportBounds(): Bounds {
  const box = map.getBounds();
  return [box.getWest(), box.getSouth(), box.getEast(), box.getNorth()];
}

/** Only pull shards once a tap could actually select something. */
function shardsAreWorthLoading(): boolean {
  return metersPerPixel(map) <= SELECTION_MAX_METERS_PER_PIXEL;
}

function refreshShards(): void {
  if (!indexLoaded || !shardsAreWorthLoading()) return;
  void objectIndex.ensureLoaded(viewportBounds());
}

objectIndex
  .loadIndex()
  .then(() => {
    indexLoaded = true;
    refreshShards();
  })
  .catch((error) => {
    // Same principle as the snow overlay: no data is reported as no data,
    // never as an empty map the user might read as "nothing is here".
    indexFailed = true;
    console.error("Object index failed to load", error);
  });

// The snow layer and the AS-OF date that selects it (spec section 5.3). The
// overlay is replaced wholesale when a historical date is chosen, so both
// controls are held here and re-pointed rather than rebuilt.
let snowOverlay: SnowOverlay | null = null;
const snowControl = new SnowControl(null);
const snowDate = new SnowDateControl((entry) => void selectDate(entry));
document.body.append(snowDate.element);

async function showManifest(manifestUrl: string): Promise<void> {
  // Carry the user's own toggle across a date change: someone who turned the
  // snow layer off did not ask for it back by looking at another date.
  const visible = snowOverlay?.isVisible() ?? true;
  // Null means there is no usable snapshot at this URL; the controls say so
  // rather than the app going quiet about it.
  snowOverlay = await addSnowOverlay(map, manifestUrl);
  snowOverlay?.setVisible(visible);
  snowControl.setOverlay(snowOverlay);
  snowDate.setCurrent(snowOverlay?.date ?? null, snowOverlay?.title ?? "");
}

async function selectDate(entry: CatalogueEntry): Promise<void> {
  snowDate.setLoading();
  await showManifest(entry.manifestUrl);
}

map.on("load", async () => {
  try {
    // Always opens on latest.json. It is the build-time trust anchor, it is
    // the only object guaranteed to exist, and the catalogue is resolved
    // relative to it - so the map is never waiting on the catalogue to draw.
    await showManifest(snowManifestUrl);
    map.addControl(snowControl, "bottom-left");

    // A missing or rejected catalogue simply means no historical dates are on
    // offer: the display stays the non-interactive label it has always been.
    const catalogue = await loadDateCatalogue(snowManifestUrl, window.location.href);
    if (catalogue) snowDate.setCatalogue(catalogue.dates);
  } catch (error) {
    // A missing overlay shouldn't take the basemap down with it.
    console.error("Snow overlay failed to load", error);
  }
  // Added last so the selection marker sits above the snow raster.
  highlight = new SelectionHighlight(map);
  refreshShards();
});

// Shards for wherever the user has come to rest. Panning within one shard
// costs nothing; crossing into a new one fetches it once and caches it.
map.on("moveend", refreshShards);

objectPanel.setChoiceHandler((record) => highlight?.show(record));
objectPanel.setCloseHandler(() => highlight?.clear());

function indexStatusFor(viewport: Bounds): IndexStatus {
  if (indexFailed) return "unavailable";
  if (!indexLoaded) return "loading";
  if (objectIndex.hasCoverage(viewport)) return "ready";
  // A shard that failed is a gap the user must be told about, not a spinner
  // that never resolves.
  return objectIndex.failures > 0 ? "unavailable" : "loading";
}

/** Render a resolved selection and its highlight together - the one place both change. */
function presentSelection(selection: Selection, status: IndexStatus): void {
  objectPanel.present(selection, status);
  if (selection.status === "selected" && status === "ready") {
    highlight?.show(selection.record);
  } else {
    highlight?.clear();
  }
}

map.on("click", async (event) => {
  const viewport = viewportBounds();
  // A tap is also a request for the objects here: a user who taps before the
  // shard has arrived should get the answer, not a permanent "loading".
  if (indexLoaded && shardsAreWorthLoading()) await objectIndex.ensureLoaded(viewport);

  const status = indexStatusFor(viewport);
  const selection = resolveSelection(
    objectIndex.records(),
    { longitude: event.lngLat.lng, latitude: event.lngLat.lat },
    metersPerPixel(map),
  );
  presentSelection(selection, status);
});

/**
 * Ask a search result the same matching question a tap already answers.
 *
 * A search hit is a MapTiler geocoding result, not an index record - it can
 * be missing from the index entirely, or resolve to a record whose name
 * disagrees with the geocoder's. We never trust the geocoder's own identity
 * for the panel/history; `resolveSelection` runs again exactly as it would
 * for a tap at the same point, so "found nothing", "ambiguous", "too coarse a
 * scale" and "found it, but look what's actually there" all go through the
 * one honest pipeline `presentSelection` already implements. The search
 * marker (dropped by the search bar at the geocoder's own coordinate) and the
 * selection highlight (dropped at the index record's coordinate, if any) can
 * end up in visibly different places - that gap *is* the answer to "do these
 * two sources agree", not a bug to hide.
 *
 * The scale floor (`SELECTION_MAX_METERS_PER_PIXEL`) applies unchanged: a
 * search result is just another point on the map, and the floor exists
 * because coarse-scale proximity matching is unreliable regardless of how the
 * point arrived. A search that lands zoomed out (e.g. a whole valley or
 * region) will show the same "zoom in to select" notice a tap would - that is
 * the deliberate, consistent answer rather than a second invented rule for
 * "search near enough an object to guess".
 *
 * Shards load lazily by viewport (`objectIndex.ts`), so the destination's
 * shard may not be loaded yet even after the camera arrives. Rather than race
 * that load against `resolveSelection`, this waits for the fly to finish
 * (`moveend`, the same signal `refreshShards` already uses elsewhere) and
 * then awaits `ensureLoaded` itself before resolving - so a fresh search
 * result is judged against the shard it actually lands in, never a stale or
 * still-loading one. A `token` guards against a second search superseding
 * this one mid-flight: only the most recent search may reach the panel.
 */
let searchSelectionToken = 0;

function selectSearchResult(point: SearchPoint): void {
  const token = ++searchSelectionToken;

  void (async () => {
    // flyTo animates; wait for the camera to actually arrive before reading
    // scale or viewport, rather than judging the point against where the map
    // used to be.
    await new Promise<void>((resolve) => map.once("moveend", () => resolve()));
    if (token !== searchSelectionToken) return;

    const viewport = viewportBounds();
    if (indexLoaded && shardsAreWorthLoading()) await objectIndex.ensureLoaded(viewport);
    if (token !== searchSelectionToken) return;

    const status = indexStatusFor(viewport);
    const selection = resolveSelection(objectIndex.records(), point, metersPerPixel(map));
    presentSelection(selection, status);
  })();
}

document.body.append(createSearchBar(map, { onSelect: selectSearchResult }));

if (import.meta.env.DEV) {
  // Used by scripts/screenshot.mjs to drive the camera.
  (window as unknown as { map: maplibregl.Map }).map = map;
}
