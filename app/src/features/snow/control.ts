import type { IControl } from "maplibre-gl";
import type { SnowOverlay } from "./overlay";

// Colors must match pipeline/src/nevaio_pipeline/tiles.py's _FRESHNESS_COLORS (spec section 5.2,
// "Sky to Indigo", revised 2026-09-06) - there is no shared source between
// the Python pipeline and this frontend, so keep the two in sync by hand.
const FRESHNESS_TIERS: { color: string; label: string }[] = [
  { color: "#38BDF8", label: "0-3d" },
  { color: "#5185ED", label: "4-7d" },
  { color: "#6957CE", label: "8-14d" },
  { color: "#713A9C", label: "15-30d" },
];

/** Explains the two independent visual channels from spec section 5.2 on demand. */
function buildLegend(): HTMLElement {
  const legend = document.createElement("section");
  legend.className = "snow-ctrl__legend";
  legend.setAttribute("aria-label", "How to read the snow layer");

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

/**
 * Compact snow layer control, kept beside the map rather than above it.
 *
 * The AS-OF date is not rendered here - it lives in `SnowDateControl`, under
 * the search bar, because selecting a historical date replaces the overlay and
 * the date display has to outlive that swap.
 */
export class SnowControl implements IControl {
  private container!: HTMLElement;

  constructor(private overlay: SnowOverlay | null) {}

  /**
   * Point the control at a different overlay, or at none.
   *
   * Selecting a historical date builds a new overlay object, so the toggle has
   * to be rebound or it would keep driving a layer that is no longer on the
   * map. Rendered from scratch rather than patched: there are only two shapes,
   * and reconciling them by hand is how a control ends up claiming a layer
   * exists when it does not.
   */
  setOverlay(overlay: SnowOverlay | null): void {
    this.overlay = overlay;
    if (this.container) this.render();
  }

  onAdd(): HTMLElement {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl snow-ctrl";
    this.render();
    return this.container;
  }

  private render(): void {
    this.container.replaceChildren();

    // No published snapshot loaded, or it failed validation. Say so and stop:
    // no toggle for a layer that isn't there, and no legend explaining an
    // encoding nothing on screen uses. Showing an archived sample here instead
    // would risk a months-old raster being read as today's conditions.
    if (!this.overlay) {
      const warning = document.createElement("p");
      warning.className = "snow-ctrl__warning";
      warning.textContent = "Snow data unavailable";
      warning.title =
        "The published snapshot could not be loaded or did not pass validation. " +
        "No snow data is being shown.";

      this.container.append(warning);
      return;
    }

    // Bound to a local so the narrowing above survives into the change
    // listener's closure, which reads this.overlay after onAdd has returned.
    const overlay = this.overlay;

    const toggle = document.createElement("label");
    toggle.className = "snow-ctrl__toggle";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "snow-ctrl__toggle-input";
    checkbox.checked = overlay.isVisible();
    checkbox.addEventListener("change", () => overlay.setVisible(checkbox.checked));

    // Visual switch track/thumb, styled from the (visually hidden but still
    // focusable/clickable, per the wrapping <label>) checkbox above via the
    // CSS adjacent-sibling selector - no separate click handler needed.
    const switchTrack = document.createElement("span");
    switchTrack.className = "snow-ctrl__switch";
    switchTrack.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = "Snow cover";

    toggle.append(checkbox, switchTrack, label);

    const legend = buildLegend();
    legend.hidden = true;

    const info = document.createElement("button");
    info.type = "button";
    info.className = "snow-ctrl__info";
    info.textContent = "i";
    info.setAttribute("aria-label", "How to read the snow layer");
    info.setAttribute("aria-expanded", "false");
    info.addEventListener("click", () => {
      legend.hidden = !legend.hidden;
      info.setAttribute("aria-expanded", String(!legend.hidden));
    });

    this.container.append(toggle, info, legend);
  }

  onRemove(): void {
    this.container.remove();
  }
}
