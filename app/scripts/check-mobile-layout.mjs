/**
 * Guard the narrow-screen layout against the search bar returning underneath
 * MapLibre's top-right navigation controls, and against the object panel
 * covering the bottom-left snow control. This is an emulator baseline, not
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

    // Open the object panel on a known indexed object (Dufourspitze) and
    // re-check: the panel is a bottom sheet, and the snow control has to lift
    // clear of it rather than disappear behind it.
    await page.waitForFunction(() => window.map?.isStyleLoaded(), null, { timeout: 30_000 });
    await page.evaluate(() =>
      window.map.jumpTo({ center: [7.866757, 45.936924], zoom: 15 }),
    );
    await page.waitForTimeout(600);
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
    await page.waitForSelector(".object-panel:not([hidden])", { timeout: 5_000 });
    // The snow control eases into its lifted position; measure after that.
    await page.waitForTimeout(400);

    const withPanel = await page.evaluate(() => {
      const panel = document.querySelector(".object-panel")?.getBoundingClientRect();
      const snow = document.querySelector(".maplibregl-ctrl-bottom-left")?.getBoundingClientRect();
      const search = document.querySelector(".search-bar")?.getBoundingClientRect();
      if (!panel || !snow || !search) throw new Error("Expected the object panel to be open");
      return {
        panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right },
        snowBottom: snow.bottom,
        searchBottom: search.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });

    if (withPanel.documentWidth > withPanel.viewportWidth) {
      throw new Error(
        `${name}: horizontal overflow with the object panel open ` +
          `(${withPanel.documentWidth}px > ${withPanel.viewportWidth}px)`,
      );
    }
    if (withPanel.panel.left < 0 || withPanel.panel.right > withPanel.viewportWidth) {
      throw new Error(
        `${name}: object panel (${withPanel.panel.left}-${withPanel.panel.right}px) leaves the viewport`,
      );
    }
    if (withPanel.panel.top < withPanel.searchBottom) {
      throw new Error(`${name}: object panel overlaps the search bar`);
    }
    // Half a pixel of tolerance: the panel publishes a rounded height.
    if (withPanel.snowBottom > withPanel.panel.top + 0.5) {
      throw new Error(
        `${name}: snow control (bottom ${withPanel.snowBottom}px) is behind the ` +
          `object panel (top ${withPanel.panel.top}px)`,
      );
    }
    console.log(
      `${name}: object panel ${Math.round(withPanel.panel.top)}-${Math.round(withPanel.panel.bottom)}px, ` +
        `snow control clears it at ${Math.round(withPanel.snowBottom)}px`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
