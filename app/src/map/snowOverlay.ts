import type { Map } from "maplibre-gl";

/** Sidecar written by recon/make_overlay.py alongside the fallback PNG. */
export type SnowImageMeta = {
  image: string;
  product: string;
  tile: string;
  date: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  bounds: [number, number, number, number];
};

/** AS-OF snapshot manifest published atomically by pipeline.preview. */
export type SnowTileManifest = {
  schemaVersion: number;
  runId: string;
  mode: "asof-window";
  asOfDate: string;
  /** Product dates composed per spec section 9.2; 31 covers its 30-day ceiling. */
  asOfWindowDays?: number;
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  sourceTileCount: number;
  requestedSourceTileCount?: number;
  missingSourceTiles?: string[];
  sourceProductTotal?: number;
  tileCount: number;
  notice: string;
};

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

function resolveTemplate(template: string, manifestUrl: string): string {
  const placeholders = ["z", "x", "y"].map(
    (key) => [`{${key}}`, `__${key.toUpperCase()}__`],
  );
  let protectedTemplate = template;
  for (const [token, placeholder] of placeholders) {
    protectedTemplate = protectedTemplate.replaceAll(token, placeholder);
  }
  let resolved = new URL(
    protectedTemplate,
    new URL(manifestUrl, window.location.href),
  ).href;
  for (const [token, placeholder] of placeholders) {
    resolved = resolved.replaceAll(placeholder, token);
  }
  return resolved;
}

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

async function loadTileManifest(manifestUrl: string): Promise<SnowTileManifest> {
  const response = await fetch(manifestUrl, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to load snow manifest: ${response.status} ${manifestUrl}`);
  }
  const manifest: SnowTileManifest = await response.json();
  if (manifest.schemaVersion !== 1 || !manifest.tiles?.length) {
    throw new Error(`Unsupported snow manifest: ${manifestUrl}`);
  }
  return manifest;
}

function addTilePreview(
  map: Map,
  manifest: SnowTileManifest,
  manifestUrl: string,
): SnowOverlay {
  map.addSource(SOURCE_ID, {
    type: "raster",
    tiles: manifest.tiles.map((template) => resolveTemplate(template, manifestUrl)),
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

async function addImageFallback(map: Map, sidecarUrl: string): Promise<SnowOverlay> {
  const response = await fetch(sidecarUrl);
  if (!response.ok) {
    throw new Error(`Failed to load fallback snow metadata: ${response.status} ${sidecarUrl}`);
  }
  const meta: SnowImageMeta = await response.json();
  const imageUrl = new URL(meta.image, new URL(sidecarUrl, window.location.href)).href;
  map.addSource(SOURCE_ID, {
    type: "image",
    url: imageUrl,
    coordinates: meta.coordinates,
  });
  return finishOverlay(map, {
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
  let manifest: SnowTileManifest;
  try {
    manifest = await loadTileManifest(manifestUrl);
  } catch (error) {
    console.warn("Snow preview unavailable; using the checked-in sample", error);
    return addImageFallback(map, fallbackSidecarUrl);
  }
  return addTilePreview(map, manifest, manifestUrl);
}
