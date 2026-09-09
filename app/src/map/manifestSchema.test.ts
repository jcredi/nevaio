/**
 * Tests for the snow metadata validation added by audit F6.
 *
 * Run with `npm test` (Node runs the TypeScript directly, so these need no
 * bundler, browser or map). Each rejection case is a thing a poisoned or
 * corrupted manifest could otherwise have made the browser do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ManifestError,
  validateImageMeta,
  validateTileManifest,
} from "./manifestSchema.ts";

const PAGE = "https://nevaio.netlify.app/";
const MANIFEST_URL = "https://pub-example.r2.dev/latest.json";
const RUN_ID = "20260909T193729Z";

/** The shape nevaio_pipeline.render really publishes, trimmed to what matters here. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    mode: "asof-window",
    asOfDate: "2026-09-09",
    asOfWindowDays: 31,
    minzoom: 8,
    maxzoom: 11,
    bounds: [4.25, 36.95, 17.75, 47.85],
    tileCount: 979,
    requestedSourceTileCount: 58,
    sourceTileCount: 58,
    notice: "Each pixel shows the newest valid GFSC observation.",
    tiles: [`https://pub-example.r2.dev/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`],
    ...overrides,
  };
}

function rejects(document: unknown, pattern: RegExp, url = MANIFEST_URL): void {
  assert.throws(() => validateTileManifest(document, url, PAGE), (error: unknown) => {
    assert.ok(error instanceof ManifestError, `expected ManifestError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("validateTileManifest", () => {
  it("accepts the real published manifest and resolves its tile URLs", () => {
    const { manifest: validated, tileUrls } = validateTileManifest(
      manifest(),
      MANIFEST_URL,
      PAGE,
    );

    assert.equal(validated.runId, RUN_ID);
    assert.equal(validated.minzoom, 8);
    assert.deepEqual(tileUrls, [
      `https://pub-example.r2.dev/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`,
    ]);
  });

  it("accepts a relative template beside a locally served manifest", () => {
    const { tileUrls } = validateTileManifest(
      manifest({ tiles: [`runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`] }),
      "/snow/latest.json",
      "http://127.0.0.1:5173/",
    );

    assert.deepEqual(tileUrls, [
      `http://127.0.0.1:5173/snow/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`,
    ]);
  });

  it("refuses a tile template pointing at another origin", () => {
    rejects(
      manifest({ tiles: [`https://evil.example/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`] }),
      /points at https:\/\/evil\.example/,
    );
  });

  it("refuses a protocol-relative template, which changes host silently", () => {
    rejects(
      manifest({ tiles: [`//evil.example/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`] }),
      /points at https:\/\/evil\.example/,
    );
  });

  it("refuses a template that escapes the run directory", () => {
    rejects(
      manifest({ tiles: ["../../../etc/tiles/{z}/{x}/{y}.png"] }),
      /path is \/etc\/tiles/,
    );
  });

  it("refuses a template for a different run than the manifest names", () => {
    rejects(
      manifest({ tiles: ["https://pub-example.r2.dev/runs/20200101T000000Z/tiles/{z}/{x}/{y}.png"] }),
      /expected \/runs\/20260909T193729Z/,
    );
  });

  it("refuses embedded credentials", () => {
    rejects(
      manifest({
        tiles: [`https://user:pass@pub-example.r2.dev/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`],
      }),
      /must not embed credentials/,
    );
  });

  it("refuses a query string or fragment", () => {
    rejects(
      manifest({ tiles: [`https://pub-example.r2.dev/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png?spy=1`] }),
      /must not carry a query string or fragment/,
    );
  });

  it("refuses a data: or javascript: template", () => {
    rejects(manifest({ tiles: ["data:image/png;base64,AAAA"] }), /points at|changes the scheme/);
    rejects(manifest({ tiles: ["javascript:alert(1)"] }), /points at|changes the scheme/);
  });

  it("bounds the number and length of tile templates", () => {
    const one = `https://pub-example.r2.dev/runs/${RUN_ID}/tiles/{z}/{x}/{y}.png`;
    rejects(manifest({ tiles: [one, one, one, one, one] }), /over the 4 limit/);
    rejects(
      manifest({ tiles: [`${one}${"a".repeat(600)}`] }),
      /over the 512 limit/,
    );
  });

  it("refuses an empty or non-array tiles field", () => {
    rejects(manifest({ tiles: [] }), /non-empty array/);
    rejects(manifest({ tiles: "everything" }), /non-empty array/);
  });

  it("refuses unsupported schema versions and modes", () => {
    rejects(manifest({ schemaVersion: 2 }), /schemaVersion 2/);
    rejects(manifest({ schemaVersion: "1" }), /schemaVersion 1/);
    rejects(manifest({ mode: "whatever" }), /mode whatever/);
  });

  it("refuses malformed identifiers and dates", () => {
    rejects(manifest({ runId: "../../etc" }), /not a UTC run identifier/);
    rejects(manifest({ asOfDate: "yesterday" }), /not an ISO date/);
  });

  it("refuses out-of-range or inconsistent zooms", () => {
    rejects(manifest({ minzoom: 12, maxzoom: 11 }), /minzoom 12 is above maxzoom 11/);
    rejects(manifest({ maxzoom: 40 }), /maxzoom must be between 0 and 22/);
    rejects(manifest({ minzoom: 8.5 }), /minzoom must be an integer/);
  });

  it("refuses impossible bounds", () => {
    rejects(manifest({ bounds: [17.75, 36.95, 4.25, 47.85] }), /longitudes are not an ordered pair/);
    rejects(manifest({ bounds: [4.25, 36.95, 17.75, 200] }), /latitudes are not an ordered pair/);
    rejects(manifest({ bounds: [4.25, 36.95, 17.75] }), /must be four numbers/);
    rejects(manifest({ bounds: [4.25, 36.95, 17.75, Number.NaN] }), /only finite numbers/);
  });

  it("refuses counts that contradict each other or explode", () => {
    rejects(
      manifest({ sourceTileCount: 60, requestedSourceTileCount: 58 }),
      /sourceTileCount 60 exceeds requestedSourceTileCount 58/,
    );
    rejects(manifest({ tileCount: 5_000_000 }), /tileCount must be between/);
  });

  it("bounds the notice string", () => {
    rejects(manifest({ notice: "x".repeat(2001) }), /over the 2000 limit/);
  });

  it("refuses a document that is not an object", () => {
    rejects("just a string", /must be a JSON object/);
    rejects([manifest()], /must be a JSON object/);
    rejects(null, /must be a JSON object/);
  });
});

describe("validateImageMeta", () => {
  const SIDECAR = "/snow/gfsc_32TPS_20260206.json";

  function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      image: "gfsc_32TPS_20260206.png",
      product: "CLMS_WSI_GFSC_060m_T32TPS_20260206P7D_COMB_V102",
      tile: "32TPS",
      date: "2026-02-06",
      coordinates: [
        [10.29, 46.95],
        [11.75, 46.95],
        [11.75, 45.93],
        [10.29, 45.93],
      ],
      bounds: [10.29, 45.93, 11.75, 46.95],
      ...overrides,
    };
  }

  it("accepts the checked-in sidecar and resolves its image", () => {
    const { imageUrl, meta: validated } = validateImageMeta(meta(), SIDECAR, PAGE);

    assert.equal(imageUrl, "https://nevaio.netlify.app/snow/gfsc_32TPS_20260206.png");
    assert.equal(validated.tile, "32TPS");
  });

  it("refuses an image on another origin or outside the sidecar's directory", () => {
    assert.throws(
      () => validateImageMeta(meta({ image: "https://evil.example/x.png" }), SIDECAR, PAGE),
      ManifestError,
    );
    assert.throws(
      () => validateImageMeta(meta({ image: "notapng.svg" }), SIDECAR, PAGE),
      /not a PNG/,
    );
  });

  it("refuses non-finite or out-of-world corner coordinates", () => {
    assert.throws(
      () => validateImageMeta(meta({ coordinates: [[0, 0], [1, 1], [2, 2], [1e9, 0]] }), SIDECAR, PAGE),
      /outside the real world/,
    );
    assert.throws(
      () => validateImageMeta(meta({ coordinates: [[0, 0], [1, 1], [2, 2], ["x", 0]] }), SIDECAR, PAGE),
      /must be numbers/,
    );
    assert.throws(
      () => validateImageMeta(meta({ coordinates: [[0, 0], [1, 1], [2, 2]] }), SIDECAR, PAGE),
      /four corner pairs/,
    );
  });
});
