import { searchBiasBounds } from "../map/config";

export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName: string;
  type: string;
  class: string;
  boundingbox: [number, number, number, number]; // south, north, west, east
};

type NominatimResponseItem = {
  lat: string;
  lon: string;
  display_name: string;
  type: string;
  class: string;
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
    class: item.class,
    boundingbox: item.boundingbox.map(Number) as [number, number, number, number],
  }));
}
