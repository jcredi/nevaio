/**
 * Guard the narrow-screen layout against the search bar returning underneath
 * MapLibre's top-right navigation controls, against the object panel covering
 * the bottom-left snow control, and against the route planner's half-planned
 * strip landing on the AS-OF date pill. This is an emulator baseline, not
 * a replacement for real-handset checks of safe areas, the virtual keyboard,
 * and touch interaction.
 *
 * Usage: npm run check-mobile-layout (with npm run dev already running)
 *        NEVAIO_URL=https://nevaio.netlify.app npm run check-mobile-layout
 */
import { chromium } from "playwright";

const URL = process.env.NEVAIO_URL ?? "http://127.0.0.1:5173";
// Not the 44px ideal: this is a secondary control in a deliberately compact
// UI, and 32 is what the pill can be without crowding the search bar above it.
// It exists to catch the pill silently collapsing back to its 26px label size
// while still being a picker.
const MIN_TOUCH_TARGET = 32;

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
    // The AS-OF date appears only once a snow manifest has loaded and may
    // never appear at all (no published snapshot, or none reachable from
    // here). Wait for it, but treat its absence as a state to skip rather
    // than a failure - this script guards layout, not data availability.
    await page.waitForSelector(".snow-date:not([hidden])", { timeout: 10_000 }).catch(() => {});

    const layout = await page.evaluate(() => {
      const search = document.querySelector(".search-bar")?.getBoundingClientRect();
      const controls = document
        .querySelector(".maplibregl-ctrl-top-right")
        ?.getBoundingClientRect();
      if (!search || !controls) throw new Error("Expected mobile controls were not rendered");
      // The AS-OF date sits directly under the search bar and grows when the
      // catalogue turns it into a picker; it is absent when no snow snapshot
      // loaded at all, which is a legitimate state rather than a failure.
      const dateElement = document.querySelector(".snow-date");
      const date = dateElement?.hidden ? undefined : dateElement?.getBoundingClientRect();
      return {
        search: { left: search.left, right: search.right, bottom: search.bottom },
        controls: { left: controls.left, right: controls.right },
        date: date && {
          left: date.left,
          right: date.right,
          top: date.top,
          height: date.height,
          interactive: dateElement.classList.contains("snow-date--interactive"),
        },
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

    // The date pill became a real control with the historical picker, so it
    // now has to earn its space: clear of the search bar above it, inside the
    // screen, and big enough to hit with a thumb.
    if (layout.date) {
      const { date } = layout;
      if (date.top < layout.search.bottom) {
        throw new Error(
          `${name}: the AS-OF date (top ${date.top}px) is under the search bar ` +
            `(bottom ${layout.search.bottom}px)`,
        );
      }
      if (date.left < 0 || date.right > layout.viewportWidth) {
        throw new Error(
          `${name}: the AS-OF date (${date.left}-${date.right}px) is off a ` +
            `${layout.viewportWidth}px screen`,
        );
      }
      if (date.interactive && date.height < MIN_TOUCH_TARGET) {
        throw new Error(
          `${name}: the AS-OF date picker is ${date.height}px tall, under the ` +
            `${MIN_TOUCH_TARGET}px touch minimum`,
        );
      }
      console.log(
        `${name}: AS-OF date ${date.left}-${date.right}px, ${date.height}px tall` +
          `${date.interactive ? " (picker)" : " (label)"}`,
      );
    }

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
    // Wait for the panel to reach its FINAL height before measuring anything.
    // The snow history section fills asynchronously - it fetches a slot map
    // and a ranged read from R2 - so a panel measured while it still says
    // "Loading history..." is shorter than the one the user ends up looking
    // at. Measuring too early is how a real overlap slipped through: the
    // chart landed after the check had already passed. A settled panel is
    // one showing a chart, or an explicit terminal message.
    await page.waitForFunction(
      () => {
        const history = document.querySelector(".object-history");
        if (!history) return false;
        if (history.querySelector(".object-history__chart svg")) return true;
        const status = history.querySelector(".object-history__status, .object-history__note");
        return Boolean(status && !status.hidden && !/Loading history/.test(status.textContent ?? ""));
      },
      null,
      { timeout: 30_000 },
    );
    // The snow control eases into its lifted position; measure after that.
    await page.waitForTimeout(600);

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

    // The route planner's half-planned strip (spec section 8.2) sits at the
    // top, and everything at the top of this app has collided with something
    // else at least once. It only exists when a routing provider is
    // configured, so its absence is a state to skip - the same treatment the
    // AS-OF date pill gets above. Run this leg with a VITE_GEOAPIFY_API_KEY set
    // (any non-empty value: the strip appears on selection, before any
    // request is made) to exercise it.
    const startButton = page.locator(".object-panel__action--start");
    if (await startButton.count()) {
      await startButton.first().click();
      await page.waitForSelector(".route-prompt:not([hidden])", { timeout: 5_000 });
      const withPrompt = await page.evaluate(() => {
        const prompt = document.querySelector(".route-prompt")?.getBoundingClientRect();
        const dateElement = document.querySelector(".snow-date");
        const date = dateElement?.hidden ? null : dateElement?.getBoundingClientRect();
        const search = document.querySelector(".search-bar")?.getBoundingClientRect();
        if (!prompt || !search) throw new Error("Expected the route prompt to be open");
        return {
          prompt: { top: prompt.top, bottom: prompt.bottom, left: prompt.left, right: prompt.right },
          blockerBottom: Math.max(search.bottom, date ? date.bottom : 0),
          blocker: date ? "AS-OF date" : "search bar",
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      if (withPrompt.prompt.top < withPrompt.blockerBottom) {
        throw new Error(
          `${name}: the route prompt (top ${withPrompt.prompt.top}px) is under the ` +
            `${withPrompt.blocker} (bottom ${withPrompt.blockerBottom}px)`,
        );
      }
      if (withPrompt.prompt.left < 0 || withPrompt.prompt.right > withPrompt.viewportWidth) {
        throw new Error(
          `${name}: the route prompt (${withPrompt.prompt.left}-${withPrompt.prompt.right}px) ` +
            `leaves a ${withPrompt.viewportWidth}px screen`,
        );
      }
      if (withPrompt.documentWidth > withPrompt.viewportWidth) {
        throw new Error(`${name}: horizontal overflow with the route prompt open`);
      }
      console.log(
        `${name}: route prompt ${Math.round(withPrompt.prompt.top)}-` +
          `${Math.round(withPrompt.prompt.bottom)}px, clears the ${withPrompt.blocker} ` +
          `at ${Math.round(withPrompt.blockerBottom)}px`,
      );
    } else {
      console.log(`${name}: route prompt skipped (no routing provider configured)`);
    }

    await page.close();
  }
} finally {
  await browser.close();
}
