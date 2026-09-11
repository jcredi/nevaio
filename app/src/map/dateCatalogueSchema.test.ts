/**
 * Tests for the AS-OF date catalogue validator (spec section 5.3).
 *
 * Run with `npm test` (Node runs the TypeScript directly, so these need no
 * bundler, browser or map). Each rejection case is either something a poisoned
 * catalogue could otherwise have made the browser do, or a disagreement
 * between the catalogue and its own manifest keys that would show the user a
 * date the pipeline never published.
 *
 * The cases mirror pipeline/tests/test_catalogue.py and the publisher-side
 * `validate_date_catalogue`; when one side's rules change, both move.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DateCatalogueError,
  MAX_CATALOGUE_BYTES,
  dateCatalogueUrlFor,
  validateDateCatalogue,
} from "./dateCatalogueSchema.ts";

const PAGE = "https://nevaio.netlify.app/";
const CATALOGUE_URL = "https://pub-example.r2.dev/dates.json";

function entry(asOfDate: string, runId: string): Record<string, unknown> {
  return { asOfDate, runId, manifest: `asof-${asOfDate}-${runId}.json` };
}

/** The shape nevaio_pipeline.catalogue really publishes. */
function catalogue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "asof-date-catalogue",
    generatedAt: "2026-09-11T04:41:07+00:00",
    maxDates: 31,
    dates: [
      entry("2026-09-11", "20260911T043500Z"),
      entry("2026-09-10", "20260910T043500Z"),
    ],
    ...overrides,
  };
}

function accepts(document: unknown, url = CATALOGUE_URL) {
  return validateDateCatalogue(JSON.stringify(document), url, PAGE);
}

function rejects(document: unknown, pattern: RegExp, url = CATALOGUE_URL): void {
  const text = typeof document === "string" ? document : JSON.stringify(document);
  assert.throws(
    () => validateDateCatalogue(text, url, PAGE),
    (error: unknown) => {
      assert.ok(error instanceof DateCatalogueError, `expected DateCatalogueError, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe("dateCatalogueUrlFor", () => {
  it("places the catalogue beside the manifest, whatever the manifest URL is", () => {
    assert.equal(
      dateCatalogueUrlFor("https://pub-example.r2.dev/latest.json", PAGE),
      "https://pub-example.r2.dev/dates.json",
    );
    // The local preview layout, where both objects sit under /snow/.
    assert.equal(dateCatalogueUrlFor("/snow/latest.json", PAGE), `${PAGE}snow/dates.json`);
  });
});

describe("validateDateCatalogue", () => {
  it("accepts a real catalogue and resolves each manifest against its own URL", () => {
    const result = accepts(catalogue());
    assert.equal(result.maxDates, 31);
    assert.deepEqual(
      result.dates.map((date) => date.manifestUrl),
      [
        "https://pub-example.r2.dev/asof-2026-09-11-20260911T043500Z.json",
        "https://pub-example.r2.dev/asof-2026-09-10-20260910T043500Z.json",
      ],
    );
  });

  it("accepts an empty catalogue, which says nothing is available", () => {
    // This must not be confused with a missing catalogue: it is a publisher
    // actively reporting that no date can be offered, and the caller has to
    // honour that rather than quietly showing the latest map.
    assert.deepEqual(accepts(catalogue({ dates: [] })).dates, []);
  });

  it("rejects a manifest key that would leave the catalogue's own directory", () => {
    for (const manifest of [
      "https://evil.example/asof-2026-09-11-20260911T043500Z.json",
      "../asof-2026-09-11-20260911T043500Z.json",
      "nested/asof-2026-09-11-20260911T043500Z.json",
      "/asof-2026-09-11-20260911T043500Z.json",
    ]) {
      rejects(
        catalogue({ dates: [{ ...entry("2026-09-11", "20260911T043500Z"), manifest }] }),
        /manifest/,
      );
    }
  });

  it("keeps a manifest in the directory of a catalogue that is not at the root", () => {
    const result = accepts(catalogue(), "https://pub-example.r2.dev/snow/dates.json");
    assert.equal(
      result.dates[0].manifestUrl,
      "https://pub-example.r2.dev/snow/asof-2026-09-11-20260911T043500Z.json",
    );
  });

  it("re-derives the manifest key rather than trusting it", () => {
    rejects(
      catalogue({
        dates: [
          { asOfDate: "2026-09-11", runId: "20260911T043500Z", manifest: "asof-2026-09-10-20260911T043500Z.json" },
        ],
      }),
      /expected asof-2026-09-11-20260911T043500Z\.json/,
    );
  });

  it("rejects unknown or missing fields at both levels", () => {
    rejects(catalogue({ extra: true }), /catalogue has fields/);
    rejects(
      catalogue({ dates: [{ ...entry("2026-09-11", "20260911T043500Z"), extra: 1 }] }),
      /dates\[0\] has fields/,
    );
    const { maxDates: _dropped, ...missing } = catalogue();
    rejects(missing, /catalogue has fields/);
  });

  it("rejects a wrong schema version or kind", () => {
    rejects(catalogue({ schemaVersion: 2 }), /schemaVersion 2/);
    rejects(catalogue({ kind: "tile-manifest" }), /kind tile-manifest/);
  });

  it("requires generatedAt to be an explicit UTC timestamp", () => {
    // A local-time value would be read as UTC and silently misdate the
    // catalogue, so an absent or non-zero offset is a rejection, not a guess.
    for (const generatedAt of ["2026-09-11T04:41:07", "2026-09-11T04:41:07+02:00", "yesterday", ""]) {
      rejects(catalogue({ generatedAt }), /generatedAt/);
    }
    assert.ok(accepts(catalogue({ generatedAt: "2026-09-11T04:41:07Z" })));
    assert.ok(accepts(catalogue({ generatedAt: "2026-09-11T04:41:07.512+00:00" })));
  });

  it("rejects dates that are not real, ordered, newest first, and unique", () => {
    rejects(catalogue({ dates: [entry("2026-02-30", "20260911T043500Z")] }), /not a real date/);
    rejects(catalogue({ dates: [entry("11-09-2026", "20260911T043500Z")] }), /not an ISO date/);
    rejects(
      catalogue({
        dates: [entry("2026-09-10", "20260910T043500Z"), entry("2026-09-11", "20260911T043500Z")],
      }),
      /newest first/,
    );
    rejects(
      catalogue({
        dates: [entry("2026-09-11", "20260911T043500Z"), entry("2026-09-11", "20260910T043500Z")],
      }),
      /newest first/,
    );
  });

  it("rejects one run backing two dates", () => {
    rejects(
      catalogue({
        dates: [entry("2026-09-11", "20260911T043500Z"), entry("2026-09-10", "20260911T043500Z")],
      }),
      /backs more than one catalogue date/,
    );
  });

  it("rejects a run identifier that is not a UTC run stamp", () => {
    rejects(
      catalogue({
        dates: [{ asOfDate: "2026-09-11", runId: "latest", manifest: "asof-2026-09-11-latest.json" }],
      }),
      /runId is not a UTC run identifier/,
    );
  });

  it("holds the catalogue to its own declared window", () => {
    rejects(
      catalogue({
        maxDates: 1,
        dates: [entry("2026-09-11", "20260911T043500Z"), entry("2026-09-10", "20260910T043500Z")],
      }),
      /over its own window of 1/,
    );
    // Inside the window by count, but spanning more calendar days than it
    // claims to retain - the archive cannot actually hold both ends.
    rejects(
      catalogue({
        maxDates: 3,
        dates: [entry("2026-09-11", "20260911T043500Z"), entry("2026-09-01", "20260901T043500Z")],
      }),
      /spans more than its retention window/,
    );
  });

  it("rejects a document that is empty, oversized, or not JSON", () => {
    rejects("", /0 bytes/);
    rejects("{not json", /not valid JSON/);
    rejects("[]", /catalogue must be a JSON object/);
    const padded = JSON.stringify(catalogue({ generatedAt: "2026-09-11T04:41:07Z" })).padEnd(
      MAX_CATALOGUE_BYTES + 1,
      " ",
    );
    rejects(padded, /outside the 1-16384 limit/);
  });
});
