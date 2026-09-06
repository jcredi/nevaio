export type Coordinates = { lat: number; lon: number };

// Decimal-degree "lat, lon" or "lat lon", optionally signed, e.g.
// "45.832, 7.281" or "-13.05 -72.5". No DMS support - not required by
// spec section 6.1.
const COORDINATE_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Parses a "lat, lon" style query. Returns null if it doesn't match or is out of range. */
export function parseCoordinates(input: string): Coordinates | null {
  const match = COORDINATE_PATTERN.exec(input);
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return { lat, lon };
}
