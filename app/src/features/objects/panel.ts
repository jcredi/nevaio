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
 * Layout note: the panel is a bottom sheet in every viewport, and it publishes
 * its own height as `--object-panel-height` on the document element so the
 * bottom-left snow control lifts clear of it instead of being covered. The
 * search bar and the snow control have collided twice before; this is the one
 * coupling point, kept explicit rather than hard-coded in two places.
 */
import type { ObjectRecord } from "./objectIndexSchema.ts";
import type { Selection } from "./selection.ts";
import { ObjectHistorySection } from "./historyChart.ts";

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

export class ObjectPanel {
  readonly element: HTMLElement;

  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private onChoose: ((record: ObjectRecord) => void) | null = null;
  private onClosed: (() => void) | null = null;

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
  }

  /** Called when the user picks one of an ambiguous tap's candidates. */
  setChoiceHandler(handler: (record: ObjectRecord) => void): void {
    this.onChoose = handler;
  }

  /** Called when the user dismisses the panel. */
  setCloseHandler(handler: () => void): void {
    this.onClosed = handler;
  }

  close(): void {
    this.element.hidden = true;
    document.documentElement.style.setProperty("--object-panel-height", "0px");
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
    const kind = KIND_LABELS[record.kind];
    this.title.textContent = record.name;
    this.subtitle.textContent =
      record.elevationMeters === null
        ? kind.label
        : `${kind.label} · ${Math.round(record.elevationMeters)} m`;

    const facts = element("dl", "object-panel__facts");
    const addFact = (term: string, value: string): void => {
      facts.append(element("dt", "object-panel__term", term));
      facts.append(element("dd", "object-panel__value", value));
    };
    addFact("Coordinates", formatCoordinates(record));
    // The durable identity, shown on purpose: it is what a snow-history
    // lookup will key on, and what makes a wrong match checkable.
    addFact("OSM object", record.id);

    const history = new ObjectHistorySection({
      record,
      seriesBaseUrl: this.seriesBaseUrl,
      asOfIso: this.getAsOfIso(),
    });

    this.body.replaceChildren(facts, history.element);
    this.reveal();
  }

  private reveal(): void {
    this.element.hidden = false;
    // Read back the laid-out height so the snow control can clear it.
    const height = this.element.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--object-panel-height", `${Math.round(height)}px`);
  }
}
