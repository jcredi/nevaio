/**
 * Place search against MapTiler's Geocoding API.
 *
 * Replaces the public OSMF Nominatim endpoint (audit F11, spec amendment
 * v1.9): that endpoint's usage policy prohibits client-side autocomplete
 * outright and caps the whole application at one request per second, which a
 * per-browser debounce cannot enforce. MapTiler permits typeahead use, and the
 * key is the one the basemap already uses, so there is no new credential and
 * no new origin in the deployed CSP.
 *
 * Results are still OpenStreetMap-derived - features carry their raw OSM tags,
 * which is what the section 4.2 mountaineering object classes and the search
 * bar's icons are built on - so the "OSM-native" reason behind the original
 * Nominatim choice is preserved. MapTiler and OSM attribution is already
 * required and present for the basemap.
 */
import { searchBiasBounds } from "../../map/config";
import {
  parseGeocodeResponse,
  RESULT_LIMIT,
  type GeocodeResult,
} from "./geocodeResult";

export type { GeocodeBounds, GeocodeResult } from "./geocodeResult";
export { parseGeocodeResponse, toGeocodeResult } from "./geocodeResult";

const ENDPOINT = "https://api.maptiler.com/geocoding";

const API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

/**
 * Feature classes worth showing a hiker. MapTiler's default set is dominated
 * by streets and addresses, which pushed peaks and huts off the list entirely
 * ("Ortles" returned four streets named Via Ortles and no mountain).
 */
const PLACE_TYPES = [
  "poi",
  "place",
  "municipality",
  "municipal_district",
  "locality",
  "neighbourhood",
  "joint_municipality",
  "county",
  "region",
].join(",");

/**
 * Search for places by name, biased toward - not restricted to - the MVP's
 * Alps+Apennines area (spec section 6.1).
 */
export async function geocode(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<GeocodeResult[]> {
  const [west, south, east, north] = searchBiasBounds;
  const url = new URL(`${ENDPOINT}/${encodeURIComponent(query)}.json`);
  url.searchParams.set("key", API_KEY);
  url.searchParams.set("limit", String(RESULT_LIMIT));
  url.searchParams.set("language", "en");
  url.searchParams.set("types", PLACE_TYPES);
  url.searchParams.set("bbox", `${west},${south},${east},${north}`);
  url.searchParams.set("proximity", `${(west + east) / 2},${(south + north) / 2}`);

  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Place search failed: ${response.status}`);
  }
  return parseGeocodeResponse(await response.json());
}
