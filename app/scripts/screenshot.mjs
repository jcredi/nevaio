/**
 * Screenshot the running dev server at a few real viewing scales.
 *
 * This exists for the "first real snow tile" milestone: the questions it
 * answers - does the overlay line up with the basemap, and does 60 m look
 * reasonable at hiking zooms - can only be settled by looking.
 *
 * Usage: npm run dev, then `npm run shot -- [outDir]`
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "screenshots";
const URL = process.env.NEVAIO_URL ?? "http://localhost:5173";

const VIEWS = [
  ["1-whole-tile", { center: [11.02, 46.44], zoom: 8.7 }],
  ["2-ortles-massif", { center: [10.58, 46.48], zoom: 11 }],
  ["3-solda-valley", { center: [10.6, 46.51], zoom: 13.5 }],
  ["4-ortles-massif-snow-off", { center: [10.58, 46.48], zoom: 11 }, { snow: false }],
  ["5-solda-valley-linear", { center: [10.6, 46.51], zoom: 13.5 }, { resampling: "linear" }],
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
page.on("console", (m) => m.type() === "error" && console.error("  page error:", m.text()));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.map?.getLayer("gfsc-snow"), null, { timeout: 30_000 });

for (const [name, view, opts = {}] of VIEWS) {
  await page.evaluate(
    ([view, opts]) => {
      const map = window.map;
      // Drive the real checkbox rather than the layer, so the control itself
      // is under test and the screenshot shows its true state.
      const checkbox = document.querySelector(".snow-ctrl__toggle input");
      const wanted = opts.snow !== false;
      if (checkbox.checked !== wanted) checkbox.click();
      map.setPaintProperty("gfsc-snow", "raster-resampling", opts.resampling ?? "nearest");
      map.jumpTo(view);
    },
    [view, opts],
  );
  await page.waitForFunction(() => window.map.loaded() && window.map.areTilesLoaded(), null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600); // let label/glyph fetches settle
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${OUT}/${name}.png`);
}

await browser.close();
