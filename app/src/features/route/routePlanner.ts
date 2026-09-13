/**
 * The A-to-B planning surface (spec section 8.1): two fields, a map-pick mode,
 * and the button that opens them.
 *
 * **Why this exists.** Routing used to be reachable only by selecting an object
 * and pressing "Start here" in its panel, which meant a route could only ever
 * join two *indexed* objects, and only if you could find both by tapping. The
 * owner's report on 2026-09-13 was that this was "currently inconvenient". A
 * route has two ends and they should both be visible and editable at once,
 * which is what a two-field form gives and a sequence of modal taps does not.
 *
 * **Three ways to fill an end, because they fail in different places.** Typing
 * finds a named place anywhere; picking on the map reaches the unnamed col or
 * the car park that no geocoder knows; and the object panel's existing buttons
 * still work, because an indexed object is the only kind of endpoint with snow
 * history behind it. Coordinates pasted into the field are accepted too, via
 * the same `parseCoordinates` the search bar uses - it costs one call and it is
 * how a hiker shares a meeting point.
 *
 * **This component decides nothing about routing.** It collects two points and
 * hands them over; `routeController.ts` owns what happens next, including the
 * same-point refusal and every error message. That split is what keeps the
 * controller testable without a DOM and this file free of network code.
 *
 * Plain DOM and `textContent`, never `innerHTML` - a place name arriving from
 * the geocoder is untrusted text and this is where it would land.
 */
import { parseCoordinates } from "../search/coordinates";
import { geocode, type GeocodeResult } from "../search/geocode";
import { icon } from "./routeIcons";

export type PlannerRole = "start" | "destination";

/** What the planner needs to describe one end of a route. */
export type PlannerPoint = {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
};

export type RoutePlannerHooks = {
  /** One end was set, or cleared when `point` is null. */
  onSet: (role: PlannerRole, point: PlannerPoint | null) => void;
  /** Enter (or leave, when null) "next map tap fills this end" mode. */
  onPickOnMap: (role: PlannerRole | null) => void;
  /** The planner was dismissed; the controller discards any half-made plan. */
  onClose: () => void;
};

/** How long to wait after a keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 250;

const PLACEHOLDER: Record<PlannerRole, string> = {
  start: "Choose starting point",
  destination: "Choose destination",
};

const BADGE: Record<PlannerRole, string> = { start: "A", destination: "B" };

function labelled(tag: "button", className: string, label: string): HTMLButtonElement {
  const node = document.createElement(tag);
  node.type = "button";
  node.className = className;
  node.setAttribute("aria-label", label);
  node.title = label;
  return node;
}

/**
 * The round button that opens the planner.
 *
 * Exported separately from the panel because it lives somewhere else on screen
 * - bottom right, where a thumb reaches it - and because it must exist even
 * when the planner has never been opened.
 */
export function createRouteButton(onClick: () => void): HTMLButtonElement {
  const fab = labelled("button", "route-fab", "Plan a route");
  fab.append(icon("directions"));
  fab.addEventListener("click", onClick);
  return fab;
}

type Row = {
  /** The field and its own suggestion list, so each list sits under its field. */
  element: HTMLElement;
  input: HTMLInputElement;
  pick: HTMLButtonElement;
  suggestions: HTMLElement;
};

export class RoutePlanner {
  readonly element: HTMLElement;

  private readonly rows: Record<PlannerRole, Row>;
  private readonly points: Record<PlannerRole, PlannerPoint | null> = {
    start: null,
    destination: null,
  };
  private picking: PlannerRole | null = null;
  private opened = false;
  /** Per-role, so two fields searching at once cannot cancel each other. */
  private searches: Record<PlannerRole, { timer: number; controller: AbortController } | null> = {
    start: null,
    destination: null,
  };

  constructor(private readonly hooks: RoutePlannerHooks) {
    this.element = document.createElement("div");
    this.element.className = "route-planner";
    this.element.hidden = true;

    const header = document.createElement("div");
    header.className = "route-planner__header";
    const title = document.createElement("h2");
    title.className = "route-planner__title";
    title.textContent = "Plan a route";
    const close = labelled("button", "route-planner__close", "Close route planner");
    close.append(icon("close"));
    close.addEventListener("click", () => {
      this.close();
      this.hooks.onClose();
    });
    header.append(title, close);

    this.rows = {
      start: this.buildRow("start"),
      destination: this.buildRow("destination"),
    };

    const fields = document.createElement("div");
    fields.className = "route-planner__fields";
    fields.append(this.rows.start.element, this.rows.destination.element);

    const swap = labelled("button", "route-planner__swap", "Swap start and destination");
    swap.append(icon("swap"));
    swap.addEventListener("click", () => this.swap());

    const body = document.createElement("div");
    body.className = "route-planner__body";
    body.append(fields, swap);

    this.element.append(header, body);
  }

  isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    this.opened = true;
    this.element.hidden = false;
    // Focus whichever end is still missing, so opening the planner puts the
    // cursor where the work is rather than always at the top.
    const empty = this.points.start === null ? "start" : this.points.destination === null ? "destination" : null;
    if (empty) this.rows[empty].input.focus();
  }

  close(): void {
    this.opened = false;
    this.element.hidden = true;
    this.setPicking(null);
    for (const role of ["start", "destination"] as const) this.clearSuggestions(role);
  }

  /**
   * Reflect an endpoint the controller now holds.
   *
   * The controller is the single source of truth for what the route is made
   * of - the object panel can set an endpoint without the planner being open
   * at all - so the planner renders what it is told rather than trusting its
   * own inputs.
   */
  setEndpoint(role: PlannerRole, point: PlannerPoint | null): void {
    this.points[role] = point;
    const { input } = this.rows[role];
    input.value = point?.name ?? "";
    this.clearSuggestions(role);
  }

  /** Show which end the next map tap will fill, or none. */
  setPicking(role: PlannerRole | null): void {
    this.picking = role;
    for (const key of ["start", "destination"] as const) {
      const active = this.picking === key;
      this.rows[key].pick.classList.toggle("route-planner__pick--active", active);
      this.rows[key].pick.setAttribute("aria-pressed", String(active));
    }
    this.element.classList.toggle("route-planner--picking", role !== null);
  }

  private swap(): void {
    const { start, destination } = this.points;
    // Announced through the hooks rather than mutated locally, so the
    // controller recalculates exactly as it would for any other change.
    this.hooks.onSet("start", destination);
    this.hooks.onSet("destination", start);
  }

  private buildRow(role: PlannerRole): Row {
    const field = document.createElement("div");
    field.className = "route-planner__field";
    const row = document.createElement("div");
    row.className = "route-planner__row";

    const badge = document.createElement("span");
    badge.className = `route-planner__badge route-planner__badge--${role}`;
    badge.textContent = BADGE[role];
    badge.setAttribute("aria-hidden", "true");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "route-planner__input";
    input.placeholder = PLACEHOLDER[role];
    input.setAttribute("aria-label", PLACEHOLDER[role]);
    input.autocomplete = "off";
    input.spellcheck = false;

    const pick = labelled("button", "route-planner__pick", `Pick ${role === "start" ? "starting point" : "destination"} on the map`);
    pick.append(icon("pin"));
    pick.setAttribute("aria-pressed", "false");

    const suggestions = document.createElement("ul");
    suggestions.className = "route-planner__suggestions";
    suggestions.hidden = true;

    pick.addEventListener("click", () => {
      const next = this.picking === role ? null : role;
      this.setPicking(next);
      this.hooks.onPickOnMap(next);
    });

    input.addEventListener("input", () => this.onQueryChanged(role));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitFirstSuggestion(role);
      }
    });

    row.append(badge, input, pick);
    field.append(row, suggestions);
    return { element: field, input, pick, suggestions };
  }

  private clearSuggestions(role: PlannerRole): void {
    const { suggestions } = this.rows[role];
    suggestions.replaceChildren();
    suggestions.hidden = true;
    const pending = this.searches[role];
    if (pending) {
      window.clearTimeout(pending.timer);
      pending.controller.abort();
      this.searches[role] = null;
    }
  }

  private onQueryChanged(role: PlannerRole): void {
    const query = this.rows[role].input.value.trim();
    this.clearSuggestions(role);

    // An endpoint the user has begun retyping is no longer set. Told to the
    // controller immediately so a stale route cannot outlive the text that
    // produced it.
    if (this.points[role] !== null) this.hooks.onSet(role, null);

    if (query.length < 2) return;

    // A pasted coordinate pair needs no network round trip, and is how a
    // meeting point usually arrives - shared out of another app.
    const coordinates = parseCoordinates(query);
    if (coordinates) {
      this.renderSuggestions(role, [
        {
          id: `coord:${coordinates.lat},${coordinates.lon}`,
          name: `${coordinates.lat.toFixed(5)}, ${coordinates.lon.toFixed(5)}`,
          latitude: coordinates.lat,
          longitude: coordinates.lon,
        },
      ]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void this.runSearch(role, query, controller);
    }, SEARCH_DEBOUNCE_MS);
    this.searches[role] = { timer, controller };
  }

  private async runSearch(role: PlannerRole, query: string, controller: AbortController): Promise<void> {
    let results: GeocodeResult[];
    try {
      results = await geocode(query, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      // A failed lookup is reported in the list rather than thrown away: an
      // empty dropdown reads as "no such place", which is a different claim.
      console.error("Route endpoint search failed", error);
      this.renderMessage(role, "Place search is unavailable right now.");
      return;
    }
    if (controller.signal.aborted || this.searches[role]?.controller !== controller) return;
    if (results.length === 0) {
      this.renderMessage(role, "No places match that name.");
      return;
    }
    this.renderSuggestions(
      role,
      results.map((result) => ({
        id: `geo:${result.lat},${result.lon}`,
        name: result.displayName,
        latitude: result.lat,
        longitude: result.lon,
      })),
    );
  }

  private renderMessage(role: PlannerRole, message: string): void {
    const { suggestions } = this.rows[role];
    const item = document.createElement("li");
    item.className = "route-planner__suggestion route-planner__suggestion--message";
    item.textContent = message;
    suggestions.replaceChildren(item);
    suggestions.hidden = false;
  }

  private renderSuggestions(role: PlannerRole, points: PlannerPoint[]): void {
    const { suggestions } = this.rows[role];
    suggestions.replaceChildren(
      ...points.map((point) => {
        const item = document.createElement("li");
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "route-planner__suggestion";
        choice.textContent = point.name;
        choice.addEventListener("click", () => {
          this.clearSuggestions(role);
          this.hooks.onSet(role, point);
        });
        item.append(choice);
        return item;
      }),
    );
    suggestions.hidden = false;
  }

  private commitFirstSuggestion(role: PlannerRole): void {
    const first = this.rows[role].suggestions.querySelector("button");
    if (first instanceof HTMLButtonElement) first.click();
  }
}
