/**
 * Guard the narrow-screen layout against the search bar returning underneath
 * MapLibre's top-right navigation controls. This is an emulator baseline, not
 * a replacement for real-handset checks of safe areas, the virtual keyboard,
 * and touch interaction.
 *
 * Usage: npm run check-mobile-layout (with npm run dev already running)
 *        NEVAIO_URL=https://nevaio.netlify.app npm run check-mobile-layout
 */
import { chromium } from "playwright";

const URL = process.env.NEVAIO_URL ?? "http://127.0.0.1:5173";
const VIEWS = [
  ["small phone", { width: 320, height: 568 }],
  ["standard phone", { width: 390, height: 844 }],
];

const browser = await chromium.launch();
try {
  for (const [name, viewport] of VIEWS) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".search-bar");
    await page.waitForSelector(".maplibregl-ctrl-top-right");

    const layout = await page.evaluate(() => {
      const search = document.querySelector(".search-bar")?.getBoundingClientRect();
      const controls = document
        .querySelector(".maplibregl-ctrl-top-right")
        ?.getBoundingClientRect();
      if (!search || !controls) throw new Error("Expected mobile controls were not rendered");
      return {
        search: { left: search.left, right: search.right },
        controls: { left: controls.left, right: controls.right },
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });

    if (layout.documentWidth > layout.viewportWidth) {
      throw new Error(
        `${name}: horizontal overflow (${layout.documentWidth}px > ${layout.viewportWidth}px)`,
      );
    }
    if (layout.search.right > layout.controls.left) {
      throw new Error(
        `${name}: search bar (${layout.search.left}-${layout.search.right}px) overlaps ` +
          `navigation controls (${layout.controls.left}-${layout.controls.right}px)`,
      );
    }
    console.log(
      `${name}: search ${layout.search.left}-${layout.search.right}px, ` +
        `controls ${layout.controls.left}-${layout.controls.right}px`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
