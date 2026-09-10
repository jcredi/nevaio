import maplibregl from "maplibre-gl";
import {
  initialView,
  snowManifestUrl,
  styleUrl,
} from "./map/config";
import { addSnowOverlay } from "./map/snowOverlay";
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
});

if (import.meta.env.DEV) {
  // Used by scripts/screenshot.mjs to drive the camera.
  (window as unknown as { map: maplibregl.Map }).map = map;
}
