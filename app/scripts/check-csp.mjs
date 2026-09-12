/**
 * Verify the deployed security headers do not break the real map (audit F5).
 *
 * Serves the built dist/ through a local server that replays public/_headers
 * exactly as Netlify would, then drives MapLibre with a real basemap and the
 * production snow manifest while recording every CSP violation. A blocked
 * glyph, worker or tile request shows up here instead of in production.
 *
 * Usage:
 *   npm run build && node scripts/check-csp.mjs        # local dist/
 *   NEVAIO_URL=https://nevaio.netlify.app node scripts/check-csp.mjs
 *
 * The local mode cannot exercise the R2 snow legs: the bucket's CORS policy
 * only allows the production origin, so those requests fail on CORS before the
 * CSP is even consulted. That is the bucket behaving correctly - run the
 * NEVAIO_URL mode against the deployment to cover them.
 *
 * Requires VITE_MAPTILER_API_KEY in app/.env (as for any local build) and
 * network access to MapTiler.
 *
 * The production MapTiler key is origin-restricted (audit F9), so it returns
 * 403 from localhost. Put a development key whose allowed origins include
 * http://localhost and http://127.0.0.1 in NEVAIO_DEV_MAPTILER_KEY (or in
 * app/.env as VITE_MAPTILER_API_KEY for local builds) and it is substituted
 * into MapTiler requests for local runs. Spoofing the production origin is not
 * an option: the browser controls the Origin header, which is what MapTiler
 * checks.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../dist/", import.meta.url).pathname;
const HEADERS_FILE = new URL("../public/_headers", import.meta.url).pathname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Parse the `/*` block of a Netlify _headers file into name/value pairs. */
async function loadHeaders() {
  const lines = (await readFile(HEADERS_FILE, "utf8")).split("\n");
  const headers = [];
  let inGlobal = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inGlobal = line.trim() === "/*";
      continue;
    }
    const match = inGlobal && line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (match) headers.push([match[1], match[2].trim()]);
  }
  if (!headers.some(([name]) => name === "Content-Security-Policy")) {
    throw new Error("no Content-Security-Policy found in the /* block");
  }
  return headers;
}

const headers = await loadHeaders();

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0]));
  if (path.includes("..")) {
    res.writeHead(400).end();
    return;
  }
  try {
    const file = path === "/" ? "index.html" : path.slice(1);
    const body = await readFile(join(DIST, file));
    for (const [name, value] of headers) res.setHeader(name, value);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.writeHead(200).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
let origin = process.env.NEVAIO_URL;
const DEPLOYED = Boolean(origin);
if (DEPLOYED) {
  console.log(`testing the deployed origin ${origin} (its own live headers)`);
} else {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log("testing local dist/ with public/_headers replayed");
  console.log("  (snow/R2 legs are skipped locally: bucket CORS allows only production)");
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const devKey = process.env.NEVAIO_DEV_MAPTILER_KEY;
if (!DEPLOYED && devKey) {
  console.log("  using NEVAIO_DEV_MAPTILER_KEY for MapTiler requests");
  // Applies to worker-issued fetches too, which page.route() cannot see.
  await page.route(/^https:\/\/api\.maptiler\.com\//, (route) =>
    route.continue({ url: route.request().url().replace(/([?&]key=)[^&]*/, `$1${devKey}`) }),
  );
}

const violations = [];
const pageErrors = [];
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations.push({
      directive: event.effectiveDirective,
      blocked: event.blockedURI,
    });
  });
});
page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("requestfailed", (r) => {
  const failure = r.failure()?.errorText ?? "";
  if (/blocked/i.test(failure)) violations.push(`${failure} ${r.url()}`);
});

const responses = [];
page.on("response", (r) => responses.push({ url: r.url(), status: r.status() }));

// The production bundle deliberately exposes no map handle, so this asserts on
// the traffic the map actually generates: a basemap style, vector tiles and
// glyphs from MapTiler, plus the snow manifest, PNG tiles and the OSM object
// index from R2. Anything the CSP blocks simply never appears here.
//
// The object index leg is deployed-only for the same reason the snow legs are,
// but by a subtler route: the bucket's CORS policy does allow the fixed local
// Vite origins (`npm run dev` on :5173 fetches the index fine), yet this
// script serves the built `dist/` on an *ephemeral* port, which no origin
// allowlist can name. Measured 2026-09-12 - it failed as `TypeError: Failed
// to fetch` before being marked deployed-only. Don't "fix" that by widening
// the bucket's AllowedOrigins to a wildcard.
const EXPECTED = [
  ["MapTiler style", /^https:\/\/api\.maptiler\.com\/maps\/outdoor\/style\.json/, false],
  ["MapTiler tiles", /^https:\/\/api\.maptiler\.com\/.*\.(pbf|png|webp|json)/, false],
  ["MapTiler glyphs", /^https:\/\/api\.maptiler\.com\/fonts\//, false],
  ["place search", /^https:\/\/api\.maptiler\.com\/geocoding\//, false],
  ["snow manifest", /\/latest\.json/, true],
  ["snow tiles", /\/runs\/.*\/tiles\/.*\.png/, true],
  ["object index", /\/object-index\/object-index\.json/, true],
].filter(([, , deployedOnly]) => DEPLOYED || !deployedOnly);

let failed = false;
try {
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30_000 });
  await page.waitForSelector(".snow-ctrl", { timeout: 30_000 });
  // Give the style, glyph, vector-tile and snow-tile fetches time to settle.
  for (let i = 0; i < 40; i += 1) {
    const done = EXPECTED.every(([, pattern]) =>
      responses.some((r) => pattern.test(r.url) && r.status < 400),
    );
    if (done) break;
    await page.waitForTimeout(500);
  }
  // Exercise the search bar too: it is the other outbound request path.
  await page.fill(".search-bar__input", "Bolzano");
  await page.waitForTimeout(2500);

  const reported = await page.evaluate(() => window.__cspViolations);
  for (const v of reported) violations.push(`${v.directive} blocked ${v.blocked}`);

  for (const [label, pattern] of EXPECTED) {
    const hit = responses.find((r) => pattern.test(r.url) && r.status < 400);
    if (hit) {
      console.log(`  ok   ${label}`);
    } else {
      console.error(`  FAIL ${label}: no successful response under the deployed CSP`);
      failed = true;
    }
  }
} catch (error) {
  console.error("FAIL:", error.message);
  failed = true;
}

if (violations.length) {
  failed = true;
  console.error(`FAIL: ${violations.length} CSP violation(s):`);
  for (const v of new Set(violations)) console.error("  ", v);
} else {
  console.log("no CSP violations");
}
// Locally, an R2 request blocked by the bucket's production-only CORS policy is
// the expected outcome, not a finding; anything else still gets surfaced.
const noisy = DEPLOYED ? pageErrors : pageErrors.filter((e) => !/CORS policy|net::ERR_FAILED/.test(e));
if (noisy.length) {
  console.error("page errors (review, not all are CSP):");
  for (const e of new Set(noisy)) console.error("  ", e.slice(0, 300));
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
