import type { Map } from "maplibre-gl";

import {
  ManifestError,
  validateImageMeta,
  validateTileManifest,
  type SnowImageMeta,
  type SnowTileManifest,
} from "./manifestSchema";

export type { SnowImageMeta, SnowTileManifest };

export const SOURCE_ID = "gfsc-snow";
export const LAYER_ID = "gfsc-snow";

const INSERT_BEFORE = ["contour_index", "contour", "waterway_river", "water"];

export type SnowOverlay = {
  date: string;
  summary: string;
  title: string;
  bounds: [number, number, number, number];
  /**
   * True when this is the checked-in reconnaissance sample rather than a live
   * publication. The audit (F6) asked for this to be visible: silently showing
   * a months-old single-tile sample as if it were today's snow is worse than
   * saying the data is unavailable.
   */
  isSample: boolean;
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
};

function finishOverlay(
  map: Map,
  info: Pick<SnowOverlay, "date" | "summary" | "title" | "bounds" | "isSample">,
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
    isSample: false,
    date: manifest.asOfDate,
    // The control already renders the AS-OF date, so don't repeat it here; the
    // notice tooltip carries the "newest valid observation, up to 14 days back"
    // explanation in full.
    summary: coverage,
    title: manifest.notice,
    bounds: manifest.bounds,
  });
}

async function addImageFallback(map: Map, sidecarUrl: string): Promise<SnowOverlay> {
  const response = await fetch(sidecarUrl);
  if (!response.ok) {
    throw new Error(`Failed to load fallback snow metadata: ${response.status} ${sidecarUrl}`);
  }
  const { meta, imageUrl } = validateImageMeta(
    await response.json(),
    sidecarUrl,
    window.location.href,
  );
  map.addSource(SOURCE_ID, {
    type: "image",
    url: imageUrl,
    coordinates: meta.coordinates,
  });
  return finishOverlay(map, {
    isSample: true,
    date: meta.date,
    summary: `sample tile ${meta.tile}`,
    title: meta.product,
    bounds: meta.bounds,
  });
}

/** Load the R2/local XYZ preview, falling back to the checked-in sample tile. */
export async function addSnowOverlay(
  map: Map,
  manifestUrl: string,
  fallbackSidecarUrl: string,
): Promise<SnowOverlay> {
  let validated: Awaited<ReturnType<typeof loadTileManifest>>;
  try {
    validated = await loadTileManifest(manifestUrl);
  } catch (error) {
    // A rejected manifest is a louder event than a missing one: it means the
    // published metadata is malformed or has been tampered with.
    if (error instanceof ManifestError) {
      console.error("Snow manifest rejected by validation", error);
    } else {
      console.warn("Snow preview unavailable; using the checked-in sample", error);
    }
    return addImageFallback(map, fallbackSidecarUrl);
  }
  return addTilePreview(map, validated.manifest, validated.tileUrls);
}
