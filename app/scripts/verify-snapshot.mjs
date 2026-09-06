/**
 * Verify a published snow snapshot in a real browser, against the deployed
 * site by default rather than a local dev server.
 *
 * Reports what the served manifest actually says, what the snow control tells
 * the user, and whether every manifest/tile request succeeded - then captures
 * the same regions every time so two runs can be compared directly.
 *
 * The Bergamasque Prealps view is deliberately first: on 2026-08-27 that area
 * rendered as almost solid violet, confirmed against source data as 62.4% real
 * cloud on that day's single newest product. It is the most sensitive view to
 * whether AS-OF fallback is working, and the natural place to look first when
 * a published run seems wrong.
 *
 * Usage: npm run verify -- [outDir]        (defaults to ./shots)
 *        NEVAIO_URL=http://localhost:5173 npm run verify
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = process.argv[2] ?? "shots";
const URL = process.env.NEVAIO_URL ?? "https://nevaio.netlify.app";

const VIEWS = [
  ["1-prealps-cloud-case", { center: [9.6, 45.9], zoom: 11 }],
  ["2-ortles-cevedale", { center: [10.58, 46.48], zoom: 10 }],
  ["3-gran-sasso", { center: [13.56, 42.47], zoom: 10 }],
  ["4-western-alps", { center: [7.0, 45.9], zoom: 9 }],
  ["5-area-overview", { center: [10.5, 45.6], zoom: 8 }],
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});

/** Keep the bucket host out of logs; it adds nothing and gets pasted around. */
const redact = (u) => {
  try {
    const { host, pathname } = new URL(u);
    return `${host.replace(/^[^.]+/, "<bucket>")}${pathname}`;
  } catch {
    return u;
  }
};

const requests = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("r2.dev") || u.includes("latest.json") || u.includes("/tiles/")) {
    requests.push({ status: r.status(), url: u });
  }
});
page.on("console", (m) => m.type() === "error" && console.error("  page error:", m.text()));

await page.goto(URL, { waitUntil: "networkidle" });

// main.ts exposes window.map only in dev builds. Against the deployed site
// there is no camera handle, so verify what can be verified there - the
// manifest actually served, the control text, every request status, and the
// initial view - rather than silently skipping the deployed target entirely.
const canDriveCamera = await page.evaluate(
  () => typeof window.map?.getLayer === "function",
);
if (canDriveCamera) {
  await page.waitForFunction(() => window.map.getLayer("gfsc-snow"), null, {
    timeout: 60_000,
  });
} else {
  console.log("note: window.map unavailable (production build) - initial view only");
  await page.waitForTimeout(6000);
}

// Read back the manifest the deployed bundle actually loaded.
const manifestUrl = requests.find((r) => r.url.endsWith("latest.json"))?.url;
let manifest = null;
if (manifestUrl) {
  manifest = await page.evaluate(async (u) => (await fetch(u, { cache: "no-cache" })).json(), manifestUrl);
  console.log("manifest:", {
    url: redact(manifestUrl),
    runId: manifest.runId,
    mode: manifest.mode,
    asOfDate: manifest.asOfDate,
    asOfWindowDays: manifest.asOfWindowDays,
    sourceTileCount: manifest.sourceTileCount,
    missingSourceTiles: manifest.missingSourceTiles,
    sourceProductTotal: manifest.sourceProductTotal,
    tileCount: manifest.tileCount,
  });
} else {
  console.log("NO r2.dev manifest request seen - the app may be on its local fallback");
}

// What the snow control reports to the user.
const summary = await page.evaluate(() => {
  const el = document.querySelector(".snow-ctrl");
  return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
});
console.log("snow control text:", summary);

if (canDriveCamera) {
  for (const [name, view] of VIEWS) {
    await page.evaluate((v) => window.map.jumpTo(v), view);
    await page.waitForFunction(
      () => window.map.loaded() && window.map.areTilesLoaded(),
      null,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`  ${OUT}/${name}.png`);
  }
} else {
  await page.screenshot({ path: `${OUT}/0-initial-view.png` });
  console.log(`  ${OUT}/0-initial-view.png`);
}

const failures = requests.filter((r) => r.status >= 400);
console.log(
  `\n${requests.length} manifest/tile requests captured, ${failures.length} failed`,
);
for (const f of failures.slice(0, 10)) console.log(`  ${f.status} ${redact(f.url)}`);

await writeFile(`${OUT}/report.json`, JSON.stringify({ manifest, summary, requests }, null, 2));
await browser.close();
