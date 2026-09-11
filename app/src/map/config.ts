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

// The static OSM object index (spec amendment v1.11) - the panel's identity
// contract, and later the key for each object's snow history. The MapTiler
// basemap is visual context only; docs/research/maptiler-outdoor-objects.md
// measures why its rendered features cannot play this role.
//
// Today this is a small committed fixture in public/objects/, built from real
// OSM objects around Monte Rosa, Gran San Bernardo, Chamonix and Solda so the
// selection prototype can be exercised for real. When the pipeline publishes a
// spatially scoped shard, point VITE_OBJECT_INDEX_URL at it: the R2 bucket
// host is already in the CSP's connect-src, so no _headers change is needed
// for that host - any other host would need one.
export const objectIndexUrl =
  import.meta.env.VITE_OBJECT_INDEX_URL || "/objects/index.json";

// Approximate Alps + Italian Apennines bounding box (west, south, east,
// north), used only to bias place-search results (spec section 6.1) toward
// the MVP geographic scope - not a hard filter, so exact correctness here
// doesn't matter.
export const searchBiasBounds: [number, number, number, number] = [5, 40, 16, 48];
