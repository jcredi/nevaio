/**
 * Shape and classification of place-search results, independent of the network.
 *
 * Split from geocode.ts so it can be unit-tested under plain Node (it imports
 * no Vite config and touches no `import.meta.env`), matching the same
 * core-independent-of-I/O convention the Python pipeline follows.
 *
 * Everything here treats the response as untrusted: a geocoder reply chooses
 * where the map flies to, so a value that cannot do that safely is dropped
 * rather than passed on (audit F11).
 */

/** Highest number of results kept, whatever the service sends back. */
export const RESULT_LIMIT = 6;

/** Bounds as named edges: the old south/north/west/east tuple invited mix-ups. */
export type GeocodeBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName: string;
  /** OSM tag value, e.g. "peak", "alpine_hut", "village". */
  type: string;
  /** OSM tag key/top-level group, e.g. "natural", "tourism", "place". */
  category: string;
  bounds: GeocodeBounds;
};

/**
 * OSM tag keys that carry the "what kind of thing is this" signal, in the
 * order the search bar's icon rules care about.
 */
const CLASSIFYING_TAGS = ["natural", "tourism", "amenity", "highway", "place", "historic"];

type MapTilerFeature = {
  place_name?: unknown;
  text?: unknown;
  center?: unknown;
  bbox?: unknown;
  place_type?: unknown;
  properties?: {
    feature_tags?: Record<string, unknown>;
    place_designation?: unknown;
    kind?: unknown;
  };
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLonLat(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [lon, lat] = value;
  return finite(lon) && finite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

/**
 * Classify a feature the way the OSM-tag-based icon rules expect.
 *
 * POI features expose their raw OSM tags; administrative results do not, so
 * they fall back to MapTiler's own place vocabulary under a "place" category,
 * matching how Nominatim reported towns and villages.
 */
function classify(feature: MapTilerFeature): { category: string; type: string } {
  const tags = feature.properties?.feature_tags ?? {};
  for (const key of CLASSIFYING_TAGS) {
    const value = tags[key];
    if (typeof value === "string" && value.length > 0 && value !== "yes") {
      return { category: key, type: value };
    }
  }
  const designation = feature.properties?.place_designation;
  if (typeof designation === "string" && designation.length > 0) {
    return { category: "place", type: designation };
  }
  const placeType = Array.isArray(feature.place_type) ? feature.place_type[0] : undefined;
  return {
    category: "place",
    type: typeof placeType === "string" && placeType.length > 0 ? placeType : "place",
  };
}

/**
 * Convert one response feature, or null if it is unusable.
 *
 * Malformed entries are dropped rather than thrown on: one bad feature should
 * not empty an otherwise good result list, and a response that cannot move
 * the map must never be able to send it somewhere non-finite.
 */
export function toGeocodeResult(feature: unknown): GeocodeResult | null {
  if (typeof feature !== "object" || feature === null) return null;
  const candidate = feature as MapTilerFeature;

  if (!isLonLat(candidate.center)) return null;
  const [lon, lat] = candidate.center;

  const displayName =
    typeof candidate.place_name === "string" && candidate.place_name.length > 0
      ? candidate.place_name
      : typeof candidate.text === "string" && candidate.text.length > 0
        ? candidate.text
        : null;
  if (displayName === null) return null;

  // A point feature's bbox is degenerate, and MapTiler may omit it entirely;
  // in both cases the search bar's fixed close-in zoom is the right behavior.
  let bounds: GeocodeBounds = { west: lon, south: lat, east: lon, north: lat };
  const bbox = candidate.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(finite)) {
    const [west, south, east, north] = bbox as [number, number, number, number];
    if (west <= east && south <= north && west >= -180 && east <= 180 && south >= -90 && north <= 90) {
      bounds = { west, south, east, north };
    }
  }

  return { lat, lon, displayName: displayName.slice(0, 300), ...classify(candidate), bounds };
}

/** Parse a whole response body, keeping only usable features. */
export function parseGeocodeResponse(body: unknown): GeocodeResult[] {
  if (typeof body !== "object" || body === null) return [];
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  return features
    .slice(0, RESULT_LIMIT)
    .map(toGeocodeResult)
    .filter((result): result is GeocodeResult => result !== null);
}
