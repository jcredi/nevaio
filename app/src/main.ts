import maplibregl from "maplibre-gl";
import {
  initialView,
  objectIndexUrl,
  snowManifestUrl,
  styleUrl,
} from "./map/config";
import { metersPerPixel } from "./map/scale";
import { SelectionHighlight } from "./map/selectionHighlight";
import { addSnowOverlay } from "./map/snowOverlay";
import { loadObjectIndex } from "./objects/objectIndex";
import type { ObjectRecord } from "./objects/objectIndexSchema";
import { resolveSelection } from "./objects/selection";
import { ObjectPanel, type IndexStatus } from "./ui/objectPanel";
import { SnowControl } from "./ui/snowControl";
import { createSearchBar } from "./ui/searchBar";
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
document.body.append(createSearchBar(map));

// Object selection (spec section 7, amendment v1.11). The identity contract is
// Nevaio's own static index, never MapTiler's rendered feature properties -
// see docs/research/maptiler-outdoor-objects.md.
const objectPanel = new ObjectPanel();
document.body.append(objectPanel.element);

let objects: ObjectRecord[] = [];
let indexStatus: IndexStatus = "loading";
let highlight: SelectionHighlight | null = null;

loadObjectIndex(objectIndexUrl)
  .then((index) => {
    objects = index.objects;
    indexStatus = "ready";
  })
  .catch((error) => {
    // Same principle as the snow overlay: no data is reported as no data,
    // never as an empty map the user might read as "nothing is here".
    indexStatus = "unavailable";
    console.error("Object index failed to load", error);
  });

map.on("load", async () => {
  try {
    // Null means there is no usable published snapshot; the control says so
    // rather than the app going quiet about it.
    const overlay = await addSnowOverlay(map, snowManifestUrl);
    map.addControl(new SnowControl(overlay), "bottom-left");
  } catch (error) {
    // A missing overlay shouldn't take the basemap down with it.
    console.error("Snow overlay failed to load", error);
  }
  // Added last so the selection marker sits above the snow raster.
  highlight = new SelectionHighlight(map);
});

objectPanel.setChoiceHandler((record) => highlight?.show(record));
objectPanel.setCloseHandler(() => highlight?.clear());

map.on("click", (event) => {
  const selection = resolveSelection(
    objects,
    { longitude: event.lngLat.lng, latitude: event.lngLat.lat },
    metersPerPixel(map),
  );
  objectPanel.present(selection, indexStatus);
  if (selection.status === "selected" && indexStatus === "ready") {
    highlight?.show(selection.record);
  } else {
    highlight?.clear();
  }
});

if (import.meta.env.DEV) {
  // Used by scripts/screenshot.mjs to drive the camera.
  (window as unknown as { map: maplibregl.Map }).map = map;
}
