import type { Map } from "maplibre-gl";

import {
  ManifestError,
  validateTileManifest,
  type SnowTileManifest,
} from "./manifestSchema";

export type { SnowTileManifest };

export const SOURCE_ID = "gfsc-snow";
export const LAYER_ID = "gfsc-snow";

const INSERT_BEFORE = ["contour_index", "contour", "waterway_river", "water"];

export type SnowOverlay = {
  date: string;
  summary: string;
  title: string;
  bounds: [number, number, number, number];
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
};

function finishOverlay(
  map: Map,
  info: Pick<SnowOverlay, "date" | "summary" | "title" | "bounds">,
): SnowOverlay {
  const beforeId = INSERT_BEFORE.find((id) => map.getLayer(id));
  map.addLayer(
    {
      id: LAYER_ID,
      type: "raster",
      source: SOURCE_ID,
      paint: {
        "raster-resampling": "nearest",
        "raster-fade-duration": 0,
      },
    },
    beforeId,
  );

  const hillshade = map.getStyle().layers.find((layer) => layer.type === "hillshade");
  if (hillshade && beforeId) {
    map.moveLayer(hillshade.id, beforeId);
  }

  return {
    ...info,
    setVisible: (visible) =>
      map.setLayoutProperty(LAYER_ID, "visibility", visible ? "visible" : "none"),
    isVisible: () => map.getLayoutProperty(LAYER_ID, "visibility") !== "none",
  };
}

async function loadTileManifest(manifestUrl: string) {
  const response = await fetch(manifestUrl, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to load snow manifest: ${response.status} ${manifestUrl}`);
  }
  // Validated before any value reaches the map, so a poisoned manifest cannot
  // choose the browser's request destinations (audit F6).
  return validateTileManifest(await response.json(), manifestUrl, window.location.href);
}

function addTilePreview(
  map: Map,
  manifest: SnowTileManifest,
  tileUrls: string[],
): SnowOverlay {
  map.addSource(SOURCE_ID, {
    type: "raster",
    tiles: tileUrls,
    tileSize: 256,
    minzoom: manifest.minzoom,
    maxzoom: manifest.maxzoom,
    bounds: manifest.bounds,
  });
  const coverage =
    manifest.requestedSourceTileCount &&
    manifest.sourceTileCount < manifest.requestedSourceTileCount
      ? `${manifest.sourceTileCount}/${manifest.requestedSourceTileCount} source tiles`
      : `${manifest.sourceTileCount} source tiles`;
  return finishOverlay(map, {
    date: manifest.asOfDate,
    // The control already renders the AS-OF date, so don't repeat it here; the
    // notice tooltip carries the "newest valid observation, up to 14 days back"
    // explanation in full.
    summary: coverage,
    title: manifest.notice,
    bounds: manifest.bounds,
  });
}

/** Take the snow layer and its source off the map, if they are there. */
export function removeSnowOverlay(map: Map): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Load the published XYZ snapshot, or return null if there isn't a usable one.
 *
 * There is deliberately no fallback. An archived sample used to be shown here
 * when the live snapshot was unavailable, which meant a months-old raster could
 * be read as today's conditions - a real hazard for the mountaineering
 * decisions this app is meant to support (spec section 5.4). Saying nothing is
 * the honest answer, and the caller renders that state explicitly.
 *
 * Any existing overlay comes off *before* the new manifest is fetched, so
 * selecting a historical date can never leave the previous date's raster on
 * screen under the new date's label. A failed swap therefore shows no snow at
 * all, which is the honest outcome and the one the same section 5.4 argument
 * demands: the wrong date is as misleading here as the wrong age.
 */
export async function addSnowOverlay(
  map: Map,
  manifestUrl: string,
): Promise<SnowOverlay | null> {
  removeSnowOverlay(map);
  try {
    const { manifest, tileUrls } = await loadTileManifest(manifestUrl);
    return addTilePreview(map, manifest, tileUrls);
  } catch (error) {
    // A rejected manifest is a louder event than a missing one: it means the
    // published metadata is malformed or has been tampered with.
    if (error instanceof ManifestError) {
      console.error("Snow manifest rejected by validation", error);
    } else {
      console.warn("Snow snapshot unavailable", error);
    }
    return null;
  }
}
