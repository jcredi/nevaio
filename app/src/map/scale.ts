/**
 * The live map's scale in metres per CSS pixel.
 *
 * Measured from the map itself rather than derived from `getZoom()`, so no
 * part of the app has to encode whether a renderer counts zoom in 256 px or
 * 512 px tiles - and so the number stays right if the projection ever changes.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import { distanceMeters } from "../objects/selection.ts";

/** Long enough to be insensitive to unproject rounding, short enough to be local. */
const SAMPLE_PIXELS = 64;

export function metersPerPixel(map: MapLibreMap): number {
  const centre = map.project(map.getCenter());
  const left = map.unproject([centre.x, centre.y]);
  const right = map.unproject([centre.x + SAMPLE_PIXELS, centre.y]);
  return (
    distanceMeters(
      { longitude: left.lng, latitude: left.lat },
      { longitude: right.lng, latitude: right.lat },
    ) / SAMPLE_PIXELS
  );
}
