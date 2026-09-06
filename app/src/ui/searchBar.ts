import maplibregl, { type Map } from "maplibre-gl";
import { parseCoordinates } from "../search/coordinates";
import { geocode, type GeocodeResult } from "../search/nominatim";

type SearchResult =
  | ({ kind: "place" } & GeocodeResult)
  | { kind: "coordinate"; lat: number; lon: number };

const DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 3;

function formatCoordinate(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function resultLabel(result: SearchResult): string {
  if (result.kind === "coordinate") {
    return `Go to ${formatCoordinate(result.lat, result.lon)}`;
  }
  return result.displayName;
}

/**
 * Zoom level from a result's bounding-box span, rather than a hardcoded
 * per-OSM-type table - a tight bbox (a peak, a hut) zooms in close, a wide
 * one (a town, a valley) zooms out further, and it works for any OSM
 * class/type Nominatim returns without needing to enumerate them.
 */
function zoomForBoundingBox([south, north, west, east]: [number, number, number, number]): number {
  const span = Math.max(north - south, east - west);
  if (span <= 0.005) return 15;
  if (span <= 0.02) return 14;
  if (span <= 0.05) return 13;
  if (span <= 0.2) return 12;
  if (span <= 0.5) return 11;
  if (span <= 1) return 10;
  if (span <= 3) return 9;
  return 8.3;
}

/** Floating search bar for place/coordinate search (spec section 6.1). */
export function createSearchBar(map: Map): HTMLElement {
  const container = document.createElement("div");
  container.className = "search-bar";

  const inputRow = document.createElement("div");
  inputRow.className = "search-bar__input-row";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "search-bar__input";
  input.placeholder = "Search places or coordinates";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search places or coordinates");

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "search-bar__clear";
  clearButton.setAttribute("aria-label", "Clear search");
  clearButton.textContent = "×";
  clearButton.hidden = true;

  inputRow.append(input, clearButton);

  const resultsList = document.createElement("ul");
  resultsList.className = "search-bar__results";
  resultsList.hidden = true;

  container.append(inputRow, resultsList);

  let marker: maplibregl.Marker | null = null;
  let results: SearchResult[] = [];
  let highlightedIndex = -1;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let abortController: AbortController | undefined;

  function showMessage(text: string): void {
    resultsList.innerHTML = "";
    resultsList.hidden = false;
    const item = document.createElement("li");
    item.className = "search-bar__message";
    item.textContent = text;
    resultsList.append(item);
  }

  function renderResults(): void {
    resultsList.innerHTML = "";
    if (results.length === 0) {
      resultsList.hidden = true;
      return;
    }
    results.forEach((result, index) => {
      const item = document.createElement("li");
      item.className = "search-bar__result";
      item.classList.toggle("search-bar__result--active", index === highlightedIndex);
      item.textContent = resultLabel(result);
      // mousedown, not click: fires before a touch/click would otherwise
      // blur the input and let closeDropdown() race it.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        select(result);
      });
      resultsList.append(item);
    });
    resultsList.hidden = false;
  }

  function closeDropdown(): void {
    results = [];
    highlightedIndex = -1;
    resultsList.hidden = true;
    resultsList.innerHTML = "";
  }

  function select(result: SearchResult): void {
    const center: [number, number] = [result.lon, result.lat];
    const zoom =
      result.kind === "place" ? zoomForBoundingBox(result.boundingbox) : 14;
    map.flyTo({ center, zoom });

    if (!marker) {
      marker = new maplibregl.Marker().setLngLat(center).addTo(map);
    } else {
      marker.setLngLat(center);
    }

    input.value =
      result.kind === "coordinate"
        ? formatCoordinate(result.lat, result.lon)
        : result.displayName;
    clearButton.hidden = false;
    closeDropdown();
    input.blur();
  }

  function removeMarker(): void {
    marker?.remove();
    marker = null;
  }

  async function runSearch(query: string): Promise<void> {
    abortController?.abort();
    abortController = new AbortController();
    try {
      const hits = await geocode(query, { signal: abortController.signal });
      results = hits.map((hit) => ({ kind: "place", ...hit }));
      highlightedIndex = -1;
      if (results.length === 0) {
        showMessage("No results");
      } else {
        renderResults();
      }
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        return;
      }
      console.error("Place search failed", error);
      showMessage("Search unavailable");
    }
  }

  function handleInput(): void {
    const value = input.value.trim();
    clearButton.hidden = value.length === 0;
    clearTimeout(debounceTimer);

    if (value.length === 0) {
      closeDropdown();
      removeMarker();
      return;
    }

    const coordinates = parseCoordinates(value);
    if (coordinates) {
      results = [{ kind: "coordinate", ...coordinates }];
      highlightedIndex = -1;
      renderResults();
      return;
    }

    if (value.length < MIN_QUERY_LENGTH) {
      closeDropdown();
      return;
    }

    debounceTimer = setTimeout(() => runSearch(value), DEBOUNCE_MS);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      highlightedIndex = (highlightedIndex + delta + results.length) % results.length;
      renderResults();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (results.length > 0) {
        select(results[highlightedIndex >= 0 ? highlightedIndex : 0]);
        return;
      }
      const value = input.value.trim();
      clearTimeout(debounceTimer);
      const coordinates = parseCoordinates(value);
      if (coordinates) {
        select({ kind: "coordinate", ...coordinates });
      } else if (value.length >= MIN_QUERY_LENGTH) {
        runSearch(value).then(() => {
          if (results.length > 0) select(results[0]);
        });
      }
      return;
    }
    if (event.key === "Escape") {
      closeDropdown();
      input.blur();
    }
  }

  input.addEventListener("input", handleInput);
  input.addEventListener("keydown", handleKeydown);
  clearButton.addEventListener("click", () => {
    input.value = "";
    clearButton.hidden = true;
    closeDropdown();
    removeMarker();
    input.focus();
  });

  return container;
}
