/**
 * The interactive snow-cover history chart (spec section 7.1) - the panel's
 * DOM/SVG layer. All the honesty-critical decisions (which days connect,
 * which are gaps, what a gap is labelled) live in `seriesChartLayout.ts` and
 * are asserted by `npm test`; this module only turns that computed geometry
 * into `<svg>` elements and wires up the preset picker.
 *
 * Hand-rolled inline SVG, no charting library (spec section 15 item 8, and
 * the CSP allowlist does not permit an arbitrary chart CDN). Built with
 * `document.createElementNS`, never `innerHTML` - matching `panel.ts`'s own
 * rule that an index name (or, here, a formatted date) can never become
 * markup.
 *
 * **No offline/sample data**: `seriesBaseUrl === null` (no
 * `VITE_OBJECT_SERIES_URL`, true everywhere until `docs/plan.md` item 1's
 * backfill and publish step runs) is a first-class, honestly-labelled state,
 * not a fallback chart drawn from invented numbers - see `app/src/map/config.ts`.
 */
import type { ObjectRecord } from "./objectIndexSchema.ts";
import {
  QUALITY_TIER_LABELS,
  type SeriesMarkState,
} from "./seriesFormat.ts";
import {
  buildChartLayout,
  DEFAULT_CHART_CONFIG,
  type ChartLayout,
  type DayCell,
} from "./seriesChartLayout.ts";
import { SeriesClient, SeriesLoadError } from "./seriesClient.ts";
import {
  FIXED_PRESETS,
  customRange,
  fixedPresetRange,
  previousYearRange,
  type DateRange,
  type FixedPresetId,
  type PresetId,
} from "./seriesPresets.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const GAP_LABELS: Record<Exclude<SeriesMarkState, "valid">, string> = {
  cloud: "Cloud",
  no_data: "No data",
  stale: "Stale",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * The one-line detail for a mark or a gap tick - spec 7.1's "every mark's
 * details expose product date, source AT, observation age, and quality
 * tier". A gap has no AT/age/quality of its own to show (that is exactly what
 * makes it a gap); a `stale` gap still gets its raw GF and quality, per
 * `object_series.py`'s "kept for detail views, but ... not a mark".
 */
function detailFor(day: DayCell): string {
  const { date, cell } = day;
  if (cell.state === "valid") {
    const quality = cell.quality !== null ? QUALITY_TIER_LABELS[cell.quality] : "unknown";
    return `${formatDate(date)} — ${cell.gf}% snow cover · ${quality} quality · ${cell.ageDays} day(s) old`;
  }
  if (cell.state === "stale" && cell.gf !== null) {
    const quality = cell.quality !== null ? QUALITY_TIER_LABELS[cell.quality] : "unknown";
    return `${formatDate(date)} — Stale (GF ${cell.gf}%, ${quality} quality, but age or quality was not usable)`;
  }
  return `${formatDate(date)} — ${GAP_LABELS[cell.state as Exclude<SeriesMarkState, "valid">]}`;
}

/**
 * The always-visible key: one swatch per state, so "why is there a hole in
 * this line" never depends on remembering a color. Cloud/No data/Stale are
 * named explicitly - spec 7.1's own wording - not implied by a gap alone.
 */
function buildLegend(): HTMLElement {
  const legend = el("ul", "object-history__legend");
  const entries: { swatch: string; label: string }[] = [
    { swatch: "valid", label: "Observed" },
    { swatch: "cloud", label: GAP_LABELS.cloud },
    { swatch: "no_data", label: GAP_LABELS.no_data },
    { swatch: "stale", label: GAP_LABELS.stale },
  ];
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "object-history__legend-item";
    const swatch = document.createElement("span");
    swatch.className = `object-history__swatch object-history__swatch--${entry.swatch}`;
    item.append(swatch, document.createTextNode(entry.label));
    legend.append(item);
  }
  return legend;
}

export type HistorySectionOptions = {
  record: ObjectRecord;
  seriesBaseUrl: string | null;
  /** The map's own AS-OF date (spec section 5.3), anchoring every preset. Null means none is known yet. */
  asOfIso: string | null;
};

/**
 * One selected object's snow history: preset picker, chart, legend, and the
 * tap/hover detail line. Built fresh per `panel.ts` render (the panel already
 * rebuilds its whole body per selection), so this class owns no state beyond
 * one object's own view.
 */
export class ObjectHistorySection {
  readonly element: HTMLElement;

  private readonly client: SeriesClient | null;
  private readonly statusEl: HTMLElement;
  private readonly chartHost: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly controlsEl: HTMLElement;
  private readonly customFields: HTMLElement;
  private readonly compareLabel: HTMLLabelElement;
  private readonly compareCheckbox: HTMLInputElement;
  private readonly startInput: HTMLInputElement;
  private readonly endInput: HTMLInputElement;

  private preset: PresetId = "last30";
  private compare = false;
  private loadToken = 0;

  constructor(private readonly options: HistorySectionOptions) {
    this.element = el("div", "object-history");
    this.element.append(el("p", "object-history__title", "Snow history"));

    if (options.seriesBaseUrl === null) {
      this.client = null;
      this.statusEl = el(
        "p",
        "object-history__note",
        "Not available yet. The per-object GFSC time series is not published, " +
          "so this panel shows no snow values rather than an empty chart.",
      );
      this.controlsEl = el("div", "object-history__controls");
      this.customFields = el("div", "object-history__custom");
      this.compareLabel = document.createElement("label");
      this.compareCheckbox = document.createElement("input");
      this.startInput = document.createElement("input");
      this.endInput = document.createElement("input");
      this.chartHost = el("div", "object-history__chart");
      this.detailEl = el("p", "object-history__detail");
      this.element.append(this.statusEl);
      return;
    }

    this.client = new SeriesClient(options.seriesBaseUrl, window.location.href);

    this.controlsEl = el("div", "object-history__controls");
    this.customFields = el("div", "object-history__custom");
    this.customFields.hidden = true;

    for (const spec of FIXED_PRESETS) {
      const button = el("button", "object-history__preset", spec.label);
      button.type = "button";
      button.dataset.preset = spec.id;
      button.addEventListener("click", () => this.selectPreset(spec.id));
      this.controlsEl.append(button);
    }
    const customButton = el("button", "object-history__preset", "Custom period");
    customButton.type = "button";
    customButton.dataset.preset = "custom";
    customButton.addEventListener("click", () => this.selectPreset("custom"));
    this.controlsEl.append(customButton);

    this.startInput = document.createElement("input");
    this.startInput.type = "date";
    this.startInput.className = "object-history__date";
    this.startInput.setAttribute("aria-label", "Custom period start");
    this.endInput = document.createElement("input");
    this.endInput.type = "date";
    this.endInput.className = "object-history__date";
    this.endInput.setAttribute("aria-label", "Custom period end");
    const applyCustom = el("button", "object-history__apply", "Show");
    applyCustom.type = "button";
    applyCustom.addEventListener("click", () => this.applyCustomRange());
    this.customFields.append(this.startInput, el("span", "object-history__to", "to"), this.endInput, applyCustom);

    this.compareCheckbox = document.createElement("input");
    this.compareCheckbox.type = "checkbox";
    this.compareCheckbox.className = "object-history__compare-input";
    this.compareCheckbox.addEventListener("change", () => {
      this.compare = this.compareCheckbox.checked;
      void this.load();
    });
    this.compareLabel = document.createElement("label");
    this.compareLabel.className = "object-history__compare";
    this.compareLabel.append(
      this.compareCheckbox,
      document.createTextNode(" Compare to previous year"),
    );

    this.chartHost = el("div", "object-history__chart");
    this.statusEl = el("p", "object-history__status", "Loading history…");
    this.detailEl = el(
      "p",
      "object-history__detail",
      "Tap or focus a point on the chart for its details.",
    );

    this.element.append(
      this.controlsEl,
      this.customFields,
      this.compareLabel,
      this.chartHost,
      this.statusEl,
      buildLegend(),
      this.detailEl,
    );

    this.setActivePresetButton();
    void this.load();
  }

  private setActivePresetButton(): void {
    for (const button of this.controlsEl.querySelectorAll<HTMLButtonElement>(".object-history__preset")) {
      button.classList.toggle("object-history__preset--active", button.dataset.preset === this.preset);
    }
    this.customFields.hidden = this.preset !== "custom";
  }

  private selectPreset(preset: PresetId): void {
    this.preset = preset;
    this.setActivePresetButton();
    if (preset !== "custom") void this.load();
  }

  private applyCustomRange(): void {
    if (this.startInput.value && this.endInput.value) void this.load();
  }

  private currentRange(): DateRange | null {
    const { asOfIso } = this.options;
    if (this.preset === "custom") {
      if (!this.startInput.value || !this.endInput.value) return null;
      try {
        return customRange(this.startInput.value, this.endInput.value);
      } catch {
        return null;
      }
    }
    if (asOfIso === null) return null;
    return fixedPresetRange(this.preset as FixedPresetId, asOfIso);
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const range = this.currentRange();
    if (!this.client || !range) {
      this.statusEl.textContent =
        this.options.asOfIso === null
          ? "No AS-OF date is available yet to anchor the history."
          : "Choose a valid custom period.";
      this.statusEl.hidden = false;
      this.chartHost.replaceChildren();
      return;
    }

    this.statusEl.textContent = "Loading history…";
    this.statusEl.hidden = false;
    this.chartHost.replaceChildren();

    try {
      const days = await this.client.loadRange(
        this.options.record.tile,
        this.options.record.id,
        range.start,
        range.end,
      );
      let compareDays: DayCell[] | null = null;
      if (this.compare) {
        const previous = previousYearRange(range);
        compareDays = await this.client.loadRange(
          this.options.record.tile,
          this.options.record.id,
          previous.start,
          previous.end,
        );
      }
      if (token !== this.loadToken) return; // superseded by a later preset/range change

      const hasAnyMark = days.some((d) => d.cell.state === "valid");
      this.statusEl.hidden = hasAnyMark || Boolean(compareDays?.some((d) => d.cell.state === "valid"));
      if (!this.statusEl.hidden) {
        this.statusEl.textContent = "No usable observations in this period.";
      }
      this.renderChart(days, compareDays);
    } catch (error) {
      if (token !== this.loadToken) return;
      const message = error instanceof SeriesLoadError ? error.message : String(error);
      this.statusEl.hidden = false;
      this.statusEl.textContent = "Snow history could not be loaded.";
      console.error("Object history load failed", message);
      this.chartHost.replaceChildren();
    }
  }

  private renderChart(days: DayCell[], compareDays: DayCell[] | null): void {
    const layout = buildChartLayout(days, DEFAULT_CHART_CONFIG);
    const compareLayout = compareDays ? buildChartLayout(compareDays, DEFAULT_CHART_CONFIG) : null;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: "100%",
      height: layout.height,
      role: "img",
      "aria-label": "Snow cover history chart",
    });

    for (const grid of layout.yGridLines) {
      svg.append(
        svgEl("line", {
          x1: layout.plotLeft,
          x2: layout.plotLeft + layout.plotWidth,
          y1: grid.y,
          y2: grid.y,
          class: "object-history__gridline",
        }),
      );
      const label = svgEl("text", {
        x: layout.plotLeft - 4,
        y: grid.y,
        class: "object-history__axis-label",
        "text-anchor": "end",
        "dominant-baseline": "middle",
      });
      label.textContent = grid.label;
      svg.append(label);
    }

    for (const tick of layout.xAxisTicks) {
      const label = svgEl("text", {
        x: tick.x,
        y: layout.gapTickY + 14,
        class: "object-history__axis-label",
        "text-anchor": "middle",
      });
      label.textContent = tick.label;
      svg.append(label);
    }

    if (compareLayout && compareDays) {
      this.renderSeries(svg, compareLayout, compareDays, "object-history__prior-year");
    }
    this.renderSeries(svg, layout, days, "object-history__current-year");

    this.chartHost.replaceChildren(svg);
  }

  /** Draw one series (segments, points, gap ticks) with a given CSS class for its color. */
  private renderSeries(svg: SVGSVGElement, layout: ChartLayout, days: DayCell[], cssClass: string): void {
    for (const segment of layout.segments) {
      if (segment.points.length < 2) continue;
      const d = segment.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      svg.append(svgEl("path", { d, class: `object-history__line ${cssClass}` }));
    }

    for (const point of layout.points) {
      const circle = svgEl("circle", {
        cx: point.x,
        cy: point.y,
        r: 2.75,
        class: `object-history__point ${cssClass}`,
        tabindex: "0",
        role: "img",
      });
      const day = days.find((d) => d.date === point.date);
      const detail = day ? detailFor(day) : `${point.date} — ${point.gf}%`;
      circle.setAttribute("aria-label", detail);
      const circleTitle = svgEl("title");
      circleTitle.textContent = detail;
      circle.append(circleTitle);
      circle.addEventListener("pointerenter", () => this.showDetail(detail));
      circle.addEventListener("focus", () => this.showDetail(detail));
      circle.addEventListener("click", () => this.showDetail(detail));
      svg.append(circle);
    }

    for (const tick of layout.gapTicks) {
      const mark = svgEl("rect", {
        x: tick.x - 1.5,
        y: layout.gapTickY,
        width: 3,
        height: 5,
        class: `object-history__gap object-history__gap--${tick.state} ${cssClass}`,
        tabindex: "0",
        role: "img",
      });
      const day = days.find((d) => d.date === tick.date);
      const detail = day ? detailFor(day) : `${tick.date} — ${GAP_LABELS[tick.state]}`;
      mark.setAttribute("aria-label", detail);
      const markTitle = svgEl("title");
      markTitle.textContent = detail;
      mark.append(markTitle);
      mark.addEventListener("pointerenter", () => this.showDetail(detail));
      mark.addEventListener("focus", () => this.showDetail(detail));
      mark.addEventListener("click", () => this.showDetail(detail));
      svg.append(mark);
    }
  }

  private showDetail(text: string): void {
    this.detailEl.textContent = text;
  }
}
