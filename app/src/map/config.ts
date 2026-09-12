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

// The static, sharded OSM object index (spec amendment v1.11) - the panel's
// identity contract, and later the key for each object's snow history. The
// MapTiler basemap is visual context only; see
// docs/research/maptiler-outdoor-objects.md for why its rendered features
// cannot play this role.
//
// This URL points at the entry-point document; every shard path inside it is
// resolved against this URL and must stay in its directory, so this one value
// is the whole trust anchor (the same rule the snow manifest uses).
//
// Today it is a fixture in public/object-index/, cut from the real published
// artifact and covering Monte Rosa, Gran San Bernardo, Chamonix and Solda, so
// the selection prototype runs on real records. Point
// VITE_OBJECT_INDEX_URL at the R2 publication to swap it in: the bucket host
// is already in the CSP's connect-src, so no _headers change is needed for
// that host - any other host would need one.
export const objectIndexUrl =
  import.meta.env.VITE_OBJECT_INDEX_URL || "/object-index/object-index.json";

// The per-object GFSC time series (spec section 7.1) - a permanent per-tile
// slot map plus `series/<TILE>/<YYYY-MM>.bin` month files, published beside
// the object index (`docs/plan.md` item 1; `app/src/features/objects/seriesClient.ts`
// is the reader). Unlike `objectIndexUrl` and `snowManifestUrl`, this has
// deliberately **no committed local fixture fallback**: the backfill has not
// run and nothing is published yet, and a checked-in snow-history fixture
// would ship inside `public/` and be indistinguishable from a real reading -
// exactly the hazard documented in `docs/agent-guide.md` for the removed
// offline snow raster. Until this is set, the history section reports the
// series as unavailable rather than showing anything.
export const objectSeriesUrl: string | null = import.meta.env.VITE_OBJECT_SERIES_URL || null;

// Approximate Alps + Italian Apennines bounding box (west, south, east,
// north), used only to bias place-search results (spec section 6.1) toward
// the MVP geographic scope - not a hard filter, so exact correctness here
// doesn't matter.
export const searchBiasBounds: [number, number, number, number] = [5, 40, 16, 48];
