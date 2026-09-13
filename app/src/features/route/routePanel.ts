/**
 * The route bottom sheet (spec section 8.3): what the app knows about the
 * route it just calculated, and what it does not know yet.
 *
 * It is the second of Nevaio's two bottom sheets, so it registers with
 * `map/bottomSheet.ts` exactly as the object panel does and the snow control
 * lifts clear of whichever is open.
 *
 * Plain DOM and `textContent` only, never `innerHTML` (spec section 15 item
 * 8), the same rule the object panel follows: an endpoint's name comes from
 * the OSM object index and must never be able to become markup.
 *
 * **Two deliberate omissions, both about not overstating what we have:**
 *
 *  - **No walking time.** The provider returns a `time`, and it is not shown.
 *    It is a pedestrian estimate computed on flat-ground pace, and this app's
 *    whole subject is alpine terrain where ascent, not distance, sets the
 *    time. A number that says "2 h 10" for a route with 1,400 m of climbing is
 *    not a rough estimate, it is wrong in the direction that gets people
 *    caught out after dark - precisely the kind of harm spec section 8.6's
 *    disclaimer exists for. Once elevation is trusted here, an ascent-aware
 *    estimate could be offered honestly; until then there is nothing to show.
 *  - **Ascent and descent are rounded to 10 m**, and a route that barely
 *    climbs reads "flat" rather than "7 m". The underlying measurement varies
 *    by about 3% across sampling choices (measured 2026-09-13), so a figure
 *    like "437 m" would claim a precision it does not have. `formatAscent`
 *    owns that rule.
 *
 * The elevation profile itself arrives with the route and is drawn by
 * `elevationChart.ts`; when the provider returns none, the panel says so rather
 * than drawing an empty box that would read as flat ground.
 *
 * The disclaimer (spec section 8.6) is not a footnote here: it is rendered
 * with every calculated route, and it is not dismissible.
 */
import { BottomSheetHeight } from "../../map/bottomSheet.ts";
import { DESTINATION_COLOR, START_COLOR } from "./routeLayer.ts";
import { ElevationChart, type ScrubHandler } from "./elevationChart.ts";
import { elevationStats, formatAscent } from "./elevationProfile.ts";
import { QUALITY_LABELS, SnowDataState } from "./snowDataTile.ts";
import { snowHeadline, type SnowSummary } from "./snowSummary.ts";
import type { ValidatedRoute } from "./directionsSchema.ts";

export type RouteEndpointNames = { start: string; destination: string };

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Metres for a short walk, kilometres to one decimal beyond that. One decimal
 * and no more: the underlying geometry is a routing engine's interpretation
 * of OSM paths, and a second decimal would imply a precision it does not
 * have.
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export class RoutePanel {
  readonly element: HTMLElement;

  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly body: HTMLElement;
  private readonly sheetHeight: BottomSheetHeight;
  /** Where the snow section is rendered, once sampling finishes. */
  private snowHost: HTMLElement | null = null;
  private onClosed: (() => void) | null = null;
  private onScrub: ScrubHandler | null = null;

  constructor() {
    this.element = element("section", "route-panel");
    this.element.hidden = true;
    this.element.setAttribute("aria-live", "polite");
    this.element.setAttribute("aria-label", "Planned route");

    const header = element("div", "route-panel__header");
    const heading = element("div", "route-panel__heading");
    this.title = element("h2", "route-panel__title");
    this.subtitle = element("p", "route-panel__subtitle");
    heading.append(this.title, this.subtitle);

    const close = element("button", "route-panel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Clear route");
    close.addEventListener("click", () => this.onClosed?.());

    header.append(heading, close);
    this.body = element("div", "route-panel__body");
    this.element.append(header, this.body);
    this.sheetHeight = new BottomSheetHeight(this.element);
  }

  /** Called when the user clears the route. */
  setCloseHandler(handler: () => void): void {
    this.onClosed = handler;
  }

  /**
   * Called as the user scrubs the elevation profile, with a distance along the
   * route and the elevation there, or null when they let go (spec section 8.5).
   * The panel passes it straight to whichever chart is currently rendered, so
   * the caller registers once rather than on every route.
   */
  setScrubHandler(handler: ScrubHandler): void {
    this.onScrub = handler;
  }

  /**
   * Both ends are the same object. Refused before any request is made: the
   * provider answers it perfectly happily with a valid zero-length route, which
   * renders as "0 m" and an empty chart - technically correct and useless. It
   * is almost always a mis-tap, so the panel says which object it is and leaves
   * the plan in place for the user to change one end.
   */
  showSamePoint(name: string): void {
    this.renderHeader({ start: name, destination: name });
    this.body.replaceChildren(
      element(
        "p",
        "route-panel__note",
        `Start and destination are both ${name}. Pick a different object for one end.`,
      ),
    );
    this.reveal();
  }

  showCalculating(names: RouteEndpointNames): void {
    this.renderHeader(names);
    this.body.replaceChildren(element("p", "route-panel__note", "Calculating a walking route…"));
    this.reveal();
  }

  /**
   * The provider answered, in-band, that it cannot connect these two points on
   * foot. That is a real answer about the path network, not a failure of this
   * app, and it is worth saying which is which - OSM coverage is the usual
   * cause, and spec section 8.6 already tells the user routes depend on it.
   */
  showNoRoute(names: RouteEndpointNames): void {
    this.renderHeader(names);
    this.body.replaceChildren(
      element(
        "p",
        "route-panel__note",
        "No walking route connects these two points. The routing provider found no path " +
          "network between them - often because the paths are not mapped in OpenStreetMap, " +
          "not because no way exists on the ground.",
      ),
    );
    this.reveal();
  }

  /**
   * A genuine failure: unreachable provider, rejected token, malformed reply.
   * `detail` comes from a thrown `DirectionsError`, whose messages are written
   * as sentence fragments for logs, so it is capitalised into a sentence here
   * rather than every throw site having to know it will be shown to a person.
   */
  showError(names: RouteEndpointNames, detail: string): void {
    this.renderHeader(names);
    const sentence = detail.charAt(0).toUpperCase() + detail.slice(1);
    this.body.replaceChildren(
      element("p", "route-panel__note", `The route could not be calculated. ${sentence}`),
    );
    this.reveal();
  }

  showRoute(names: RouteEndpointNames, route: ValidatedRoute): void {
    this.renderHeader(names);

    const profile = route.elevationProfile;
    const summary = profile ? elevationStats(profile) : null;

    const stats = element("dl", "route-panel__stats");
    stats.append(...statEntry("Distance", formatDistance(route.distanceMeters)));
    if (summary) {
      stats.append(
        ...statEntry(
          "Ascent / descent",
          `${formatAscent(summary.ascentMeters)} / ${formatAscent(summary.descentMeters)}`,
        ),
      );
    } else {
      // Absent, and said so - never a silent gap a reader fills in with an
      // assumption, and never a zero.
      stats.append(...statEntry("Ascent / descent", "Not available"));
    }

    const children: HTMLElement[] = [stats];

    const chart = profile ? ElevationChart.create(profile) : null;
    if (chart) {
      if (this.onScrub) chart.setScrubHandler(this.onScrub);
      children.push(chart.element);
    } else {
      children.push(
        element(
          "p",
          "route-panel__pending",
          "No elevation profile was returned for this route.",
        ),
      );
    }

    this.snowHost = element("div", "route-panel__snow");
    children.push(this.snowHost);

    children.push(
      element(
        "p",
        "route-panel__disclaimer",
        "This route is generated from OpenStreetMap paths by a general walking router. " +
          "It is a planning aid, not a guarantee of safety, accessibility or suitability - " +
          "verify it independently before setting out.",
      ),
    );

    this.body.replaceChildren(...children);
    this.reveal();
  }

  close(): void {
    this.element.hidden = true;
    this.snowHost = null;
    this.sheetHeight.release();
  }

  /** Snow sampling is in flight; say so rather than leaving a blank strip. */
  showSnowPending(): void {
    if (!this.snowHost) return;
    this.snowHost.replaceChildren(
      element("p", "route-panel__pending", "Checking snow along this route\u2026"),
    );
  }

  /**
   * Why there is no snow along this route - never silence, and never zeroes.
   * The commonest reason by far is an AS-OF date whose run predates the data
   * pyramid, which is a real answer about *our data*, not about the mountain.
   */
  showSnowUnavailable(reason: string): void {
    if (!this.snowHost) return;
    this.snowHost.replaceChildren(element("p", "route-panel__pending", reason));
  }

  /**
   * Snow along the route (spec section 8.4), with freshness and quality beside
   * it rather than tucked away - spec section 15 item 11 makes that a firm
   * requirement, strengthened from "where practical" on 2026-09-11.
   *
   * Every figure here comes from `summariseSnow`, which divides by observed
   * samples rather than total ones; this method's job is to make the coverage
   * behind them visible too, so a confident-looking percentage can always be
   * weighed against how much of the route it rests on.
   */
  showSnow(summary: SnowSummary, spacingMeters: number): void {
    if (!this.snowHost) return;

    const section = element("div", "route-elevation");
    const header = element("div", "route-elevation__header");
    header.append(element("h3", "route-elevation__title", "Snow"));
    section.append(header);

    const headline = snowHeadline(summary);
    if (headline) {
      section.append(element("p", "route-panel__snow-headline", headline));
    } else {
      section.append(
        element(
          "p",
          "route-panel__pending",
          summary.observedSamples === 0
            ? "No usable snow observation anywhere along this route."
            : "Too little of this route was observed to summarise snow cover.",
        ),
      );
    }

    const stats = element("dl", "route-panel__stats");
    if (summary.meanCoverPercent !== null) {
      stats.append(...statEntry("Mean cover", `${Math.round(summary.meanCoverPercent)}%`));
    }
    if (summary.longestSnowRun > 0) {
      // Samples are evenly spaced in ground metres (`routeProfile.ts`), which
      // is what lets a count of samples become a distance at all.
      const meters = summary.longestSnowRun * spacingMeters;
      stats.append(...statEntry("Longest snow stretch", formatDistance(meters)));
    }
    stats.append(
      ...statEntry("Route observed", `${Math.round(summary.coverage * 100)}%`),
    );
    if (summary.maxAgeDays !== null) {
      stats.append(
        ...statEntry(
          "Oldest observation",
          summary.maxAgeDays === 0 ? "Today" : `${summary.maxAgeDays} days old`,
        ),
      );
    }
    if (summary.worstQuality !== null) {
      stats.append(...statEntry("Lowest quality", QUALITY_LABELS[summary.worstQuality] ?? "Unknown"));
    }
    section.append(stats);

    // What the unobserved part of the route actually was, so "70% observed"
    // is never left as a bare number.
    const gaps: string[] = [];
    for (const [state, label] of [
      [SnowDataState.Cloud, "cloud"],
      [SnowDataState.Water, "water"],
      [SnowDataState.Stale, "stale"],
      [SnowDataState.NoData, "no data"],
    ] as const) {
      const count = summary.stateCounts[state];
      if (count > 0) gaps.push(`${label} ${Math.round((count / summary.totalSamples) * 100)}%`);
    }
    if (gaps.length > 0) {
      section.append(element("p", "route-panel__pending", `Unobserved: ${gaps.join(", ")}.`));
    }

    this.snowHost.replaceChildren(section);
  }

  /**
   * The two endpoints, each next to the colour it is drawn in on the map. The
   * swatches are the whole reason the endpoints are legible without HTML
   * markers - `routeLayer.ts` explains why there are none - so they are part
   * of the contract with that module, not decoration.
   */
  private renderHeader(names: RouteEndpointNames): void {
    this.title.textContent = "Route";
    this.subtitle.replaceChildren(
      endpointChip(START_COLOR, names.start),
      endpointChip(DESTINATION_COLOR, names.destination),
    );
  }

  private reveal(): void {
    this.element.hidden = false;
    this.sheetHeight.track();
  }
}

function endpointChip(color: string, name: string): HTMLElement {
  const chip = element("span", "route-panel__endpoint");
  const swatch = element("span", "route-panel__swatch");
  swatch.style.backgroundColor = color;
  chip.append(swatch, element("span", "route-panel__endpoint-name", name));
  return chip;
}

function statEntry(label: string, value: string): [HTMLElement, HTMLElement] {
  return [
    element("dt", "route-panel__stat-label", label),
    element("dd", "route-panel__stat-value", value),
  ];
}
