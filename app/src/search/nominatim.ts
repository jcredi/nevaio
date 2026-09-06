import { searchBiasBounds } from "../map/config";

export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName: string;
  /** OSM tag value, e.g. "peak", "alpine_hut", "village". */
  type: string;
  /** OSM tag key/top-level group, e.g. "natural", "tourism", "place". */
  category: string;
  boundingbox: [number, number, number, number]; // south, north, west, east
};

// jsonv2's field is "category" (an older, non-jsonv2 Nominatim response used
// "class" for the same thing) - easy to get wrong since both names are
// plausible and the mistake is silent (TypeScript won't catch a wrong key in
// a parsed JSON response).
type NominatimResponseItem = {
  lat: string;
  lon: string;
  display_name: string;
  type: string;
  category: string;
  boundingbox: [string, string, string, string];
};

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

/**
 * Queries Nominatim's public search endpoint (decided 2026-09-06 - see
 * docs/spec.md section 15 item 5 and docs/worklog.md). Results are biased,
 * not restricted, to the MVP's Alps+Apennines area.
 */
export async function geocode(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<GeocodeResult[]> {
  const [west, south, east, north] = searchBiasBounds;
  const url = new URL(ENDPOINT);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query);
  url.searchParams.set("viewbox", `${west},${north},${east},${south}`);
  url.searchParams.set("bounded", "0");
  url.searchParams.set("limit", "6");
  url.searchParams.set("accept-language", "en");

  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Nominatim search failed: ${response.status}`);
  }
  const items: NominatimResponseItem[] = await response.json();
  return items.map((item) => ({
    lat: Number(item.lat),
    lon: Number(item.lon),
    displayName: item.display_name,
    type: item.type,
    category: item.category,
    boundingbox: item.boundingbox.map(Number) as [number, number, number, number],
  }));
}
