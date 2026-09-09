const apiKey = import.meta.env.VITE_MAPTILER_API_KEY;

if (!apiKey) {
  throw new Error(
    "VITE_MAPTILER_API_KEY is not set - copy app/.env.example to app/.env and add a MapTiler API key.",
  );
}

export const styleUrl = `https://api.maptiler.com/maps/outdoor/style.json?key=${apiKey}`;

// Western Alps, with the Italian Apennines reachable by panning south. Zoom
// is 8.3, just above the snow tile pyramid's PREVIEW_MIN_ZOOM (8, in
// pipeline/src/nevaio_pipeline/config.py) - below that the snow layer cannot render at all, which
// undercut MVP success criterion 1 (see docs/worklog.md, 2026-09-06).
export const initialView = {
  center: [8.5, 45.3] as [number, number],
  zoom: 8.3,
};

// Production points this at R2 with VITE_SNOW_MANIFEST_URL. A locally rendered
// preview uses /snow/latest.json. When neither exists there is deliberately no
// fallback: the snow control reports the data as unavailable instead of showing
// an archived raster that could be mistaken for current conditions.
export const snowManifestUrl =
  import.meta.env.VITE_SNOW_MANIFEST_URL || "/snow/latest.json";

// Approximate Alps + Italian Apennines bounding box (west, south, east,
// north), used only to bias place-search results (spec section 6.1) toward
// the MVP geographic scope - not a hard filter, so exact correctness here
// doesn't matter.
export const searchBiasBounds: [number, number, number, number] = [5, 40, 16, 48];
