import type { Map } from "maplibre-gl";

import {
  ManifestError,
  validateTileManifest,
  type SnowTileManifest,
} from "./manifestSchema";

export type { SnowTileManifest };

export const SOURCE_ID = "gfsc-snow";
export const LAYER_ID = "gfsc-snow";

// The live layer always keeps `LAYER_ID`: `app/scripts/verify-snapshot.mjs`
// and `screenshot.mjs` both look it up by that literal name. A date change
// therefore demotes the *outgoing* raster to these ids for the length of one
// cross-fade, rather than renaming the incoming one.
const OUTGOING_SOURCE_ID = "gfsc-snow-outgoing";
const OUTGOING_LAYER_ID = "gfsc-snow-outgoing";

/** Cross-fade length for a date change. Long enough not to read as a glitch,
 *  short enough that two dates are never meaningfully "both on screen". */
const FADE_MS = 260;

const INSERT_BEFORE = ["contour_index", "contour", "waterway_river", "water"];

export type SnowOverlay = {
  date: string;
  summary: string;
  title: string;
  bounds: [number, number, number, number];
  setVisible: (visible: boolean) => void;
  isVisible: () => boolean;
  /**
   * The snow *data* pyramid this AS-OF date publishes, or null when it does
   * not (spec section 8.4). Carried on the overlay rather than read from
   * config because it belongs to a specific published run - a historical date
   * that predates the data pyramid genuinely has none, and the route profile
   * must say so rather than sampling another date's snow.
   */
  dataTileUrl: string | null;
  dataTileZoom: number | null;
};

/**
 * Give a raster layer its fade timing.
 *
 * Set after `addLayer` rather than inside the layer's own `paint`: the
 * `-transition` keys are valid style-spec properties and work at runtime, but
 * MapLibre's TypeScript types for a layer specification do not admit them.
 */
function setFadeTransition(map: Map, layerId: string): void {
  map.setPaintProperty(layerId, "raster-opacity-transition", {
    duration: FADE_MS,
    delay: 0,
  });
}

function finishOverlay(
  map: Map,
  info: Pick<SnowOverlay, "date" | "summary" | "title" | "bounds" | "dataTileUrl" | "dataTileZoom">,
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
        // Starts invisible and is faded up by `crossFadeIn` once its tiles are
        // actually on screen; see `addSnowOverlay`.
        "raster-opacity": 0,
      },
    },
    beforeId,
  );
  setFadeTransition(map, LAYER_ID);

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
  dataTileUrl: string | null,
  dataTileZoom: number | null,
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
    dataTileUrl,
    dataTileZoom,
  });
}

/** Take the snow layer and its source off the map, if they are there. */
export function removeSnowOverlay(map: Map): void {
  for (const [layer, source] of [
    [LAYER_ID, SOURCE_ID],
    [OUTGOING_LAYER_ID, OUTGOING_SOURCE_ID],
  ]) {
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(source)) map.removeSource(source);
  }
}

/**
 * Move the currently live raster aside so the incoming one can take `LAYER_ID`
 * while the old is still on screen. The source's tiles are already fetched, so
 * re-adding it under another id is visually a no-op.
 *
 * Returns false when there was nothing live to demote (first load).
 */
function demoteCurrentOverlay(map: Map): boolean {
  const existing = map.getLayer(LAYER_ID);
  if (!existing) return false;
  const sourceSpec = map.getStyle().sources[SOURCE_ID];
  if (!sourceSpec) return false;
  const visibility = map.getLayoutProperty(LAYER_ID, "visibility");
  // Drop any half-finished previous fade before starting another one.
  if (map.getLayer(OUTGOING_LAYER_ID)) map.removeLayer(OUTGOING_LAYER_ID);
  if (map.getSource(OUTGOING_SOURCE_ID)) map.removeSource(OUTGOING_SOURCE_ID);
  map.addSource(OUTGOING_SOURCE_ID, structuredClone(sourceSpec));
  map.addLayer(
    {
      id: OUTGOING_LAYER_ID,
      type: "raster",
      source: OUTGOING_SOURCE_ID,
      layout: { visibility: visibility === "none" ? "none" : "visible" },
      paint: {
        "raster-resampling": "nearest",
        "raster-fade-duration": 0,
        "raster-opacity": 1,
      },
    },
    LAYER_ID,
  );
  setFadeTransition(map, OUTGOING_LAYER_ID);
  map.removeLayer(LAYER_ID);
  map.removeSource(SOURCE_ID);
  return true;
}

/**
 * Resolve once the incoming raster has something to show, or give up quickly.
 *
 * Three signals, whichever comes first, because none is reliable alone:
 * `isSourceLoaded` can stay false indefinitely when a viewport's cells are all
 * 404s (the pipeline publishes only tiles that hold data - see docs/plan.md),
 * `idle` is the honest "everything is drawn" event but never fires while the
 * user keeps panning, and the timeout is the backstop. Measured: waiting on
 * `isSourceLoaded` alone sat at the full timeout on a real date change.
 *
 * Erring short is safe here. The outgoing raster stays at full opacity until
 * this resolves, so a premature resolve costs a slightly less complete first
 * frame of the new date, never a blank map.
 */
function waitForSource(map: Map, sourceId: string, timeoutMs = 700): Promise<void> {
  if (map.isSourceLoaded(sourceId)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      map.off("sourcedata", onData);
      map.off("idle", finish);
      clearTimeout(timer);
      resolve();
    };
    const onData = (event: { sourceId?: string }) => {
      if (event.sourceId !== sourceId) return;
      if (map.getSource(sourceId) && map.isSourceLoaded(sourceId)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    map.on("sourcedata", onData);
    map.once("idle", finish);
  });
}

/** Fade the incoming raster up and the outgoing one out, then drop the outgoing. */
async function crossFadeIn(map: Map, hadPrevious: boolean): Promise<void> {
  await waitForSource(map, SOURCE_ID);
  if (!map.getLayer(LAYER_ID)) return;
  map.setPaintProperty(LAYER_ID, "raster-opacity", 1);
  if (!hadPrevious) return;
  if (map.getLayer(OUTGOING_LAYER_ID)) {
    map.setPaintProperty(OUTGOING_LAYER_ID, "raster-opacity", 0);
  }
  await new Promise((resolve) => setTimeout(resolve, FADE_MS));
  if (map.getLayer(OUTGOING_LAYER_ID)) map.removeLayer(OUTGOING_LAYER_ID);
  if (map.getSource(OUTGOING_SOURCE_ID)) map.removeSource(OUTGOING_SOURCE_ID);
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
 * **A date change cross-fades rather than blinking.** The previous raster now
 * stays on screen while the new manifest is fetched and its tiles load, then
 * the two swap over `FADE_MS`. That reverses the old order, which removed the
 * overlay up front, and the section 5.4 argument that motivated it still
 * holds - so note carefully *why* this is still honest: the caller puts the
 * date display into its loading state (`SnowDateControl.setLoading`) for the
 * whole of this window, so at no point is an old raster paired with a new
 * date's label. That is the property to preserve. If a future change lets the
 * label update before the fade completes, this ordering has to go back.
 *
 * A failed swap still shows no snow at all, which is the honest outcome the
 * same argument demands: the wrong date is as misleading here as the wrong
 * age.
 */
export async function addSnowOverlay(
  map: Map,
  manifestUrl: string,
): Promise<SnowOverlay | null> {
  try {
    // Fetched before anything is torn down, so a slow network no longer shows
    // an empty map for the length of the request.
    const { manifest, tileUrls, dataTileUrl, dataTileZoom } = await loadTileManifest(manifestUrl);
    const hadPrevious = demoteCurrentOverlay(map);
    const overlay = addTilePreview(map, manifest, tileUrls, dataTileUrl, dataTileZoom);
    void crossFadeIn(map, hadPrevious);
    return overlay;
  } catch (error) {
    // Only now is the old raster taken down: it was accurate for its own date
    // right up until this failed.
    removeSnowOverlay(map);
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
