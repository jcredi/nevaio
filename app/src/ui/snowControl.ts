import type { IControl } from "maplibre-gl";
import type { SnowOverlay } from "../map/snowOverlay";

// Colors must match pipeline/tiles.py's _FRESHNESS_COLORS (spec section 5.2,
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
  coverageLabel.textContent = "Opacity = coverage";

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

  const freshnessLabel = document.createElement("span");
  freshnessLabel.className = "snow-ctrl__legend-label";
  freshnessLabel.textContent = "Color = freshness";

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
    checkbox.checked = this.overlay.isVisible();
    checkbox.addEventListener("change", () => this.overlay.setVisible(checkbox.checked));

    const label = document.createElement("span");
    label.textContent = "Snow cover";

    toggle.append(checkbox, label);

    const metaLine = document.createElement("p");
    metaLine.className = "snow-ctrl__meta";
    metaLine.textContent = `${formatProductDate(this.overlay.date)} · ${this.overlay.summary}`;
    metaLine.title = this.overlay.title;

    this.container.append(toggle, metaLine, buildLegend());
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}
