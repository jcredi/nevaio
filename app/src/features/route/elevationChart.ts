/**
 * The route elevation profile's DOM/SVG layer (spec sections 8.4-8.5).
 *
 * All the decisions that could mislead someone - where the y-axis starts, what
 * the gridlines say, how ascent is summed - live in `elevationChartLayout.ts`
 * and `elevationProfile.ts` and are asserted by `npm test`. This module only
 * turns computed geometry into elements and wires the pointer.
 *
 * Hand-rolled inline SVG, no charting library (spec section 15 item 8, and the
 * CSP allowlist does not permit an arbitrary chart CDN). Built with
 * `document.createElementNS`, never `innerHTML`, matching `historyChart.ts`.
 *
 * **Spec section 8.5 is a core MVP requirement, not a nicety**: moving a finger
 * or pointer along the profile must identify the corresponding place on the
 * route and move a marker there. That is what `onScrub` is for - the chart
 * reports a distance along the route and the elevation there, and the caller
 * (`routeController.ts`) moves the map's cursor dot. The chart deliberately
 * knows nothing about the map.
 *
 * Touch handling detail worth keeping: the SVG sets `touch-action: none` (in
 * `style.css`) and captures the pointer, because without it a drag along the
 * profile scrolls the panel instead of scrubbing, which on a phone makes the
 * interaction unusable rather than merely awkward.
 */
import {
  DEFAULT_ELEVATION_CHART_CONFIG,
  buildElevationChartLayout,
  distanceForX,
  xForDistance,
  type ElevationChartLayout,
} from "./elevationChartLayout.ts";
import {
  elevationAtDistance,
  elevationStats,
  formatElevation,
  type ElevationPoint,
} from "./elevationProfile.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function path(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

/** Distance for the readout: metres under 1 km, one decimal of a km above. */
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export type ScrubHandler = (position: { distanceMeters: number; elevationMeters: number } | null) => void;

export class ElevationChart {
  readonly element: HTMLElement;

  private readonly readout: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly cursorLine: SVGLineElement;
  private readonly cursorDot: SVGCircleElement;
  private readonly layout: ElevationChartLayout;
  private readonly profile: readonly ElevationPoint[];
  /**
   * The route's own lowest and highest point, for the resting readout. NOT the
   * chart's axis floor/ceiling: those are rounded outward to land on round
   * gridline numbers, so showing them would tell the user this route reaches
   * 3,500 m when it tops out at 3,275 m. The axis may round; a number presented
   * as a fact may not.
   */
  private readonly restingLabel: string;
  private onScrub: ScrubHandler | null = null;

  /**
   * Returns null when the profile cannot be drawn - fewer than two points.
   * A null chart is the caller's cue to say the profile is unavailable, never
   * to draw an empty box that reads as flat ground.
   */
  static create(profile: readonly ElevationPoint[]): ElevationChart | null {
    const layout = buildElevationChartLayout(profile, DEFAULT_ELEVATION_CHART_CONFIG);
    if (layout === null) return null;
    return new ElevationChart(profile, layout);
  }

  private constructor(profile: readonly ElevationPoint[], layout: ElevationChartLayout) {
    this.profile = profile;
    this.layout = layout;
    const stats = elevationStats(profile);
    this.restingLabel = stats
      ? `${Math.round(stats.minMeters)}\u2013${formatElevation(stats.maxMeters)}`
      : "";

    this.element = el("div", "route-elevation");
    const header = el("div", "route-elevation__header");
    header.append(el("h3", "route-elevation__title", "Elevation"));
    this.readout = el("span", "route-elevation__readout");
    header.append(this.readout);

    this.svg = svgEl("svg", {
      class: "route-elevation__svg",
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: "100%",
      // Height is fixed in CSS; the viewBox does the scaling.
      role: "img",
      // The real range, not the rounded axis - a screen reader gets the same
      // fact the sighted readout shows.
      "aria-label": stats
        ? `Elevation profile, ${Math.round(stats.minMeters)} to ${Math.round(stats.maxMeters)} metres`
        : "Elevation profile",
    });

    for (const line of layout.yGridLines) {
      this.svg.append(
        svgEl("line", {
          class: "route-elevation__grid",
          x1: layout.plotLeft,
          x2: layout.plotLeft + layout.plotWidth,
          y1: line.y,
          y2: line.y,
        }),
      );
      this.svg.append(
        Object.assign(
          svgEl("text", {
            class: "route-elevation__axis-label",
            x: layout.plotLeft - 4,
            y: line.y + 3,
            "text-anchor": "end",
          }),
          { textContent: line.label },
        ),
      );
    }

    this.svg.append(svgEl("path", { class: "route-elevation__area", d: `${path(layout.areaPoints)} Z` }));
    this.svg.append(svgEl("path", { class: "route-elevation__line", d: path(layout.points) }));

    for (const tick of layout.xAxisTicks) {
      const anchor =
        tick.x <= layout.plotLeft + 1 ? "start" : tick.x >= layout.plotLeft + layout.plotWidth - 1 ? "end" : "middle";
      this.svg.append(
        Object.assign(
          svgEl("text", {
            class: "route-elevation__axis-label",
            x: tick.x,
            y: layout.height - 5,
            "text-anchor": anchor,
          }),
          { textContent: tick.label },
        ),
      );
    }

    this.cursorLine = svgEl("line", {
      class: "route-elevation__cursor-line",
      y1: layout.plotTop,
      y2: layout.plotTop + layout.plotHeight,
      x1: layout.plotLeft,
      x2: layout.plotLeft,
      visibility: "hidden",
    });
    this.cursorDot = svgEl("circle", {
      class: "route-elevation__cursor-dot",
      r: 3.5,
      cx: layout.plotLeft,
      cy: layout.plotTop,
      visibility: "hidden",
    });
    this.svg.append(this.cursorLine, this.cursorDot);

    this.element.append(header, this.svg);
    this.attachPointer();
    this.clearCursor();
  }

  /** Called as the user scrubs; null when the pointer leaves. */
  setScrubHandler(handler: ScrubHandler): void {
    this.onScrub = handler;
  }

  private attachPointer(): void {
    const move = (event: PointerEvent) => {
      const rect = this.svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      // Client pixels -> viewBox units. The SVG scales to the panel width, so
      // this ratio is the only place screen size enters; every number the
      // caller receives is in ground metres.
      const viewBoxX = ((event.clientX - rect.left) / rect.width) * this.layout.width;
      this.showAt(distanceForX(this.layout, viewBoxX));
    };

    this.svg.addEventListener("pointerdown", (event) => {
      // Capture so a drag that wanders off the chart keeps scrubbing rather
      // than stopping dead, which is the common case on a small screen.
      this.svg.setPointerCapture(event.pointerId);
      move(event);
    });
    this.svg.addEventListener("pointermove", (event) => {
      // Only track a press on touch; hover is the natural gesture with a mouse.
      if (event.pointerType !== "touch" || event.buttons > 0) move(event);
    });
    this.svg.addEventListener("pointerup", (event) => {
      this.svg.releasePointerCapture(event.pointerId);
      this.clearCursor();
    });
    this.svg.addEventListener("pointercancel", () => this.clearCursor());
    this.svg.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") this.clearCursor();
    });
  }

  private showAt(distanceMeters: number): void {
    const elevation = elevationAtDistance(this.profile, this.profile[0].distanceMeters + distanceMeters);
    if (elevation === null) return;

    const x = xForDistance(this.layout, distanceMeters);
    const span = this.layout.ceilingMeters - this.layout.floorMeters;
    const y =
      this.layout.plotTop +
      (1 - (elevation - this.layout.floorMeters) / span) * this.layout.plotHeight;

    this.cursorLine.setAttribute("x1", String(x));
    this.cursorLine.setAttribute("x2", String(x));
    this.cursorLine.setAttribute("visibility", "visible");
    this.cursorDot.setAttribute("cx", String(x));
    this.cursorDot.setAttribute("cy", String(y));
    this.cursorDot.setAttribute("visibility", "visible");

    this.readout.textContent = `${formatElevation(elevation)} at ${formatDistance(distanceMeters)}`;
    this.onScrub?.({ distanceMeters, elevationMeters: elevation });
  }

  private clearCursor(): void {
    this.cursorLine.setAttribute("visibility", "hidden");
    this.cursorDot.setAttribute("visibility", "hidden");
    // The resting readout is the route's own real span, so the header is never
    // an empty strip waiting to be touched - and never claims a height the
    // route does not reach. See `restingLabel`.
    this.readout.textContent = this.restingLabel;
    this.onScrub?.(null);
  }
}
