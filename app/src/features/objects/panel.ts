/**
 * The object information panel (spec section 7).
 *
 * Shows the identity of the selected OSM object and, below it, the snow
 * history chart (spec section 7.1, `historyChart.ts`). The chart is honest
 * about what it does not have: with no `VITE_OBJECT_SERIES_URL` configured
 * (true everywhere today - `docs/plan.md` item 1's backfill has not run) it
 * shows a plain "not available yet" note rather than an empty or invented
 * chart, the same posture the missing-overlay behaviour and spec section 5.4
 * already require of the map layer.
 *
 * No UI framework (spec section 15 item 8): plain DOM, and every text node is
 * set with `textContent`, never `innerHTML`, so an index name cannot become
 * markup.
 *
 * Layout note: the panel is a bottom sheet in every viewport, and it registers
 * its laid-out height with `map/bottomSheet.ts` so the bottom-left snow control
 * lifts clear of it instead of being covered. The search bar and the snow
 * control have collided twice before; that module is the one coupling point,
 * and it is shared with the route panel (spec section 8), which is the other
 * bottom sheet.
 */
import type { ObjectRecord } from "./objectIndexSchema.ts";
import type { Selection } from "./selection.ts";
import { ObjectHistorySection } from "./historyChart.ts";
import { BottomSheetHeight } from "../../map/bottomSheet.ts";

/** How each selectable class is named to the user, with its map-ish glyph. */
const KIND_LABELS: Record<ObjectRecord["kind"], { label: string; icon: string }> = {
  peak: { label: "Peak", icon: "▲" },
  hut: { label: "Hut / refuge", icon: "⌂" },
  saddle: { label: "Pass / saddle", icon: "⌣" },
  shelter: { label: "Shelter", icon: "⛰" },
  parking: { label: "Parking", icon: "P" },
  settlement: { label: "Settlement", icon: "●" },
};

/** State of the index load, so a tap can say why it found nothing. */
export type IndexStatus = "loading" | "ready" | "unavailable";

/** Which end of a route a selected object is being nominated for (spec section 8.2). */
export type RouteRole = "start" | "destination";

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

function formatCoordinates(record: ObjectRecord): string {
  const lat = `${Math.abs(record.latitude).toFixed(5)}° ${record.latitude >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(record.longitude).toFixed(5)}° ${record.longitude >= 0 ? "E" : "W"}`;
  return `${lat}, ${lon}`;
}

/** Kind, elevation, and coordinates on one line - the owner's compacting request. */
function formatSubtitle(record: ObjectRecord): string {
  const kind = KIND_LABELS[record.kind].label;
  const parts = [kind];
  if (record.elevationMeters !== null) parts.push(`${Math.round(record.elevationMeters)} m`);
  parts.push(formatCoordinates(record));
  return parts.join(" · ");
}

export class ObjectPanel {
  readonly element: HTMLElement;

  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  /** Publishes this sheet's height so the snow control clears it. */
  private readonly sheetHeight: BottomSheetHeight;
  private onChoose: ((record: ObjectRecord) => void) | null = null;
  private onClosed: (() => void) | null = null;
  private onRoute: ((record: ObjectRecord, role: RouteRole) => void) | null = null;
  private routeLabels: { start: string; destination: string } | null = null;

  /**
   * `seriesBaseUrl` is `objectSeriesUrl` from `app/src/map/config.ts`, read
   * once by `main.ts` and injected here - the same pattern `objectIndexUrl`
   * and `snowManifestUrl` already follow, so this module still imports no
   * config and stays as easy to reason about as the rest of the objects
   * feature. `getAsOfIso` is a getter rather than a value because the map's
   * AS-OF date (spec section 5.3) can change after the panel is built, and
   * every chart preset is anchored on whatever it is *at render time*.
   */
  constructor(
    private readonly seriesBaseUrl: string | null,
    private readonly getAsOfIso: () => string | null,
  ) {
    this.element = element("section", "object-panel");
    this.element.hidden = true;
    this.element.setAttribute("aria-live", "polite");
    this.element.setAttribute("aria-label", "Selected map object");

    const header = element("div", "object-panel__header");
    const heading = element("div", "object-panel__heading");
    this.title = element("h2", "object-panel__title");
    this.subtitle = element("p", "object-panel__subtitle");
    heading.append(this.title, this.subtitle);

    const close = element("button", "object-panel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close object panel");
    close.addEventListener("click", () => {
      this.close();
      this.onClosed?.();
    });

    header.append(heading, close);
    this.body = element("div", "object-panel__body");
    this.element.append(header, this.body);
    this.sheetHeight = new BottomSheetHeight(this.element);
  }


  setChoiceHandler(handler: (record: ObjectRecord) => void): void {
    this.onChoose = handler;
  }

  /** Called when the user dismisses the panel. */
  setCloseHandler(handler: () => void): void {
    this.onClosed = handler;
  }

  /**
   * Offer the selected object as a route endpoint (spec section 8.2: "the
   * preferred interaction is selection of OSM objects or searched places").
   *
   * Never called means no buttons are rendered at all, which is how an
   * unconfigured routing provider surfaces: no `VITE_GEOAPIFY_API_KEY`, no route
   * actions, rather than a control that fails when pressed. `labels` lets the
   * route controller re-word the buttons as the plan fills in - "Start here"
   * becomes "Change start" once a start exists - so the panel never has to
   * know the route state itself.
   */
  setRouteHandler(
    handler: (record: ObjectRecord, role: RouteRole) => void,
    labels: { start: string; destination: string },
  ): void {
    this.onRoute = handler;
    this.routeLabels = labels;
  }

  /** Re-word the route buttons; a no-op until `setRouteHandler` has been called. */
  setRouteLabels(labels: { start: string; destination: string }): void {
    if (this.routeLabels) this.routeLabels = labels;
  }

  close(): void {
    this.element.hidden = true;
    this.sheetHeight.release();
  }

  /**
   * Render the outcome of one tap.
   *
   * `indexStatus` matters: "found nothing" and "the index has not loaded" and
   * "the index failed to load" are three different answers, and conflating
   * them would let a broken deployment look like empty ground.
   */
  present(selection: Selection, indexStatus: IndexStatus): void {
    // The scale floor is answered first: at a world view it is true whatever
    // the index is doing, and "loading" would be a misleading answer.
    if (selection.status === "zoom-in") {
      this.renderNotice(
        "Zoom in to select",
        "At this scale one tap covers several named objects, so nothing is selected. " +
          "Zoom in and tap again.",
      );
      return;
    }
    if (indexStatus !== "ready") {
      this.renderNotice(
        indexStatus === "loading" ? "Loading map objects…" : "Map objects unavailable",
        indexStatus === "loading"
          ? "The object index is still downloading. Try again in a moment."
          : "The object index could not be loaded, so nothing on the map is selectable right now.",
      );
      return;
    }

    switch (selection.status) {
      case "selected":
        this.renderRecord(selection.record);
        return;
      case "ambiguous":
        this.renderChoices(selection.candidates.map((candidate) => candidate.record));
        return;
      case "empty":
        // Tapping open ground is the common case; say nothing.
        this.close();
        return;
    }
  }

  private renderNotice(title: string, detail: string): void {
    this.title.textContent = title;
    this.subtitle.textContent = "";
    this.body.replaceChildren(element("p", "object-panel__note", detail));
    this.reveal();
  }

  private renderChoices(records: ObjectRecord[]): void {
    this.title.textContent = "Which one?";
    this.subtitle.textContent = `${records.length} objects are equally close to that tap`;

    const list = element("ul", "object-panel__choices");
    for (const record of records) {
      const item = document.createElement("li");
      const button = element("button", "object-panel__choice");
      button.type = "button";
      button.append(
        element("span", "object-panel__choice-icon", KIND_LABELS[record.kind].icon),
        element("span", "object-panel__choice-name", record.name),
        element(
          "span",
          "object-panel__choice-kind",
          record.elevationMeters === null
            ? KIND_LABELS[record.kind].label
            : `${KIND_LABELS[record.kind].label} · ${Math.round(record.elevationMeters)} m`,
        ),
      );
      button.addEventListener("click", () => {
        this.renderRecord(record);
        this.onChoose?.(record);
      });
      item.append(button);
      list.append(item);
    }
    this.body.replaceChildren(list);
    this.reveal();
  }

  private renderRecord(record: ObjectRecord): void {
    this.title.textContent = record.name;
    // Kind, elevation, and coordinates share one line (owner's compacting
    // request) - "Coordinates" as a heading was redundant with the content,
    // and the raw OSM id stays the identity source in code (it is still what
    // a snow-history lookup keys on) without being shown in the panel.
    this.subtitle.textContent = formatSubtitle(record);

    const history = new ObjectHistorySection({
      record,
      seriesBaseUrl: this.seriesBaseUrl,
      asOfIso: this.getAsOfIso(),
    });

    const children: HTMLElement[] = [];
    const actions = this.routeActions(record);
    if (actions) children.push(actions);
    children.push(history.element);
    this.body.replaceChildren(...children);
    this.reveal();
  }

  /** The two route-endpoint buttons, or null when routing is not on offer. */
  private routeActions(record: ObjectRecord): HTMLElement | null {
    const handler = this.onRoute;
    const labels = this.routeLabels;
    if (!handler || !labels) return null;

    const row = element("div", "object-panel__actions");
    for (const role of ["start", "destination"] as const) {
      const button = element("button", `object-panel__action object-panel__action--${role}`);
      button.type = "button";
      button.append(
        element("span", "object-panel__action-swatch"),
        element("span", "object-panel__action-label", labels[role]),
      );
      button.addEventListener("click", () => handler(record, role));
      row.append(button);
    }
    return row;
  }

  private reveal(): void {
    this.element.hidden = false;
    // The panel keeps growing after this point: the snow history section is
    // filled asynchronously, so measuring once here would capture the height
    // of a panel that still says "Loading history...". That stale value is
    // what let a real chart push the panel up over the snow control on a
    // 320px viewport - caught by `npm run check-mobile-layout`, which is
    // exactly what that check exists for. `BottomSheetHeight` tracks the
    // element rather than the moment.
    this.sheetHeight.track();
  }
}
