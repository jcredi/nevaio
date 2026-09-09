import type { IControl } from "maplibre-gl";
import type { SnowOverlay } from "../map/snowOverlay";

// Colors must match pipeline/src/nevaio_pipeline/tiles.py's _FRESHNESS_COLORS (spec section 5.2,
// "Sky to Indigo", revised 2026-09-06) - there is no shared source between
// the Python pipeline and this frontend, so keep the two in sync by hand.
const FRESHNESS_TIERS: { color: string; label: string }[] = [
  { color: "#38BDF8", label: "0-3d" },
  { color: "#5185ED", label: "4-7d" },
  { color: "#6957CE", label: "8-14d" },
  { color: "#713A9C", label: "15-30d" },
];

/** Explains the two independent visual channels from spec section 5.2. */
function buildLegend(): HTMLElement {
  const legend = document.createElement("div");
  legend.className = "snow-ctrl__legend";

  const coverageLabel = document.createElement("span");
  coverageLabel.className = "snow-ctrl__legend-label";
  coverageLabel.textContent = "Opacity = snow coverage";

  const coverageBar = document.createElement("div");
  coverageBar.className = "snow-ctrl__opacity-bar";
  coverageBar.title = "Opacity encodes snow-cover percentage, 0-100%";

  const coverageScale = document.createElement("div");
  coverageScale.className = "snow-ctrl__legend-scale";
  const scaleMin = document.createElement("span");
  scaleMin.textContent = "0%";
  const scaleMax = document.createElement("span");
  scaleMax.textContent = "100%";
  coverageScale.append(scaleMin, scaleMax);

  // "Freshness" reads ambiguously as "fresh snow" (new snowfall) rather than
  // "how recent the observation is" - spell out "observation age" instead.
  const freshnessLabel = document.createElement("span");
  freshnessLabel.className = "snow-ctrl__legend-label";
  freshnessLabel.textContent = "Color = observation age";

  const swatches = document.createElement("div");
  swatches.className = "snow-ctrl__swatches";
  for (const tier of FRESHNESS_TIERS) {
    const swatch = document.createElement("div");
    swatch.className = "snow-ctrl__swatch";

    const chip = document.createElement("span");
    chip.className = "snow-ctrl__swatch-chip";
    chip.style.backgroundColor = tier.color;

    const text = document.createElement("span");
    text.textContent = tier.label;

    swatch.append(chip, text);
    swatches.append(swatch);
  }

  legend.append(coverageLabel, coverageBar, coverageScale, freshnessLabel, swatches);
  return legend;
}

function formatProductDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? iso
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

/** Snow layer on/off, plus the product currently being shown. */
export class SnowControl implements IControl {
  private container!: HTMLElement;

  constructor(private readonly overlay: SnowOverlay) {}

  onAdd(): HTMLElement {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group snow-ctrl";

    const toggle = document.createElement("label");
    toggle.className = "snow-ctrl__toggle";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "snow-ctrl__toggle-input";
    checkbox.checked = this.overlay.isVisible();
    checkbox.addEventListener("change", () => this.overlay.setVisible(checkbox.checked));

    // Visual switch track/thumb, styled from the (visually hidden but still
    // focusable/clickable, per the wrapping <label>) checkbox above via the
    // CSS adjacent-sibling selector - no separate click handler needed.
    const switchTrack = document.createElement("span");
    switchTrack.className = "snow-ctrl__switch";
    switchTrack.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = "Snow cover";

    toggle.append(checkbox, switchTrack, label);

    const metaLine = document.createElement("p");
    metaLine.className = "snow-ctrl__meta";
    metaLine.textContent = `${formatProductDate(this.overlay.date)} · ${this.overlay.summary}`;
    metaLine.title = this.overlay.title;

    this.container.append(toggle, metaLine);

    // The live publication was unavailable or failed validation, so what is on
    // screen is the checked-in reconnaissance sample: one tile, months old.
    // Say so plainly rather than letting it pass as today's snow (audit F6).
    if (this.overlay.isSample) {
      const warning = document.createElement("p");
      warning.className = "snow-ctrl__warning";
      warning.textContent = "Live data unavailable - showing an old sample tile";
      warning.title =
        "The published snapshot could not be loaded or did not pass validation. " +
        "This is a single archived tile, not current snow cover.";
      metaLine.after(warning);
    }

    this.container.append(buildLegend());
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}
