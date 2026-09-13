/**
 * The route planner's state machine (spec section 8), kept out of `main.ts`.
 *
 * There are four states and the whole feature is the transitions between them:
 *
 *   empty      - nothing picked; the object panel shows two route buttons
 *   half       - one endpoint picked; `RoutePrompt` says which is still needed
 *   calculating- both picked; one request in flight
 *   settled    - a route, a "no route" answer, or an error, in `RoutePanel`
 *
 * Two rules hold it together and both exist to keep the bottom of a phone
 * screen sane, where every one of this app's layout bugs has been:
 *
 *  1. **Only one bottom sheet is open at a time.** The object panel is the
 *     picking surface; the route panel is the result. Opening one closes the
 *     other. `map/bottomSheet.ts` would cope with both being open, but the
 *     user would not.
 *  2. **The route survives what does not concern it.** Changing the AS-OF date
 *     or closing the object panel leaves the route alone; only an explicit
 *     clear removes it. A route is work the user did.
 *
 * Endpoints are `ObjectRecord`s from Nevaio's own index, never a geocoder's
 * coordinates - the same identity contract the object panel enforces (spec
 * amendment v1.11). A searched place reaches here only after
 * `resolveSelection` has matched it to a real index record, so the name shown
 * beside the route is the name of the thing the app actually routed to.
 */
import type { ObjectRecord } from "../objects/objectIndexSchema.ts";
import type { RouteRole } from "../objects/panel.ts";
import { DirectionsError, NoRouteError, fetchWalkingRoute } from "./directions.ts";
import { RouteLayer } from "./routeLayer.ts";
import { RoutePanel } from "./routePanel.ts";
import { RoutePrompt } from "./routePrompt.ts";
import { pointAtDistance } from "./routeProfile.ts";

export type { RouteRole };

type Endpoints = { start: ObjectRecord | null; destination: ObjectRecord | null };

export type RouteControllerHooks = {
  /** Close the object panel and its highlight - the route panel is taking the sheet. */
  closeObjectPanel: () => void;
  /** Re-word the object panel's route buttons as the plan fills in. */
  setRouteLabels: (labels: { start: string; destination: string }) => void;
};

export class RouteController {
  private endpoints: Endpoints = { start: null, destination: null };
  /** The geometry the profile's distances refer to, for spec section 8.5. */
  private coordinates: readonly [number, number][] = [];
  /** Guards against a superseded request settling over a newer one. */
  private token = 0;
  private inFlight: AbortController | null = null;

  constructor(
    private readonly layer: RouteLayer,
    private readonly panel: RoutePanel,
    private readonly prompt: RoutePrompt,
    private readonly hooks: RouteControllerHooks,
  ) {
    this.panel.setCloseHandler(() => this.clear());
    this.prompt.setCancelHandler(() => this.clear());
    // Spec section 8.5, a core MVP requirement: a finger moved along the
    // profile identifies the corresponding place on the route and moves a
    // marker there. Registered once - the panel hands it to whichever chart it
    // renders - and the chart itself never learns that a map exists.
    this.panel.setScrubHandler((position) => {
      if (position === null || this.coordinates.length < 2) {
        this.layer.setCursor(null);
        return;
      }
      this.layer.setCursor(pointAtDistance(this.coordinates, position.distanceMeters));
    });
    this.refreshLabels();
  }

  /** The object panel nominated a selected object as one end of the route. */
  choose(record: ObjectRecord, role: RouteRole): void {
    this.endpoints = { ...this.endpoints, [role]: record };
    this.layer.setEndpoints(this.endpoints.start, this.endpoints.destination);
    this.refreshLabels();

    const { start, destination } = this.endpoints;
    if (start && destination) {
      this.prompt.hide();
      this.hooks.closeObjectPanel();
      void this.calculate(start, destination);
      return;
    }
    // Half-planned: the object panel stays open as the picking surface, and
    // the strip carries the state instead of a sheet. Any route drawn from an
    // earlier plan goes now - the line no longer matches the endpoints.
    this.coordinates = [];
    this.layer.clearRoute();
    this.panel.close();
    const chosen = start ?? destination;
    this.prompt.show(chosen!.name, start ? "destination" : "start");
  }

  /** Discard the whole plan. The only thing that removes a calculated route. */
  clear(): void {
    this.token += 1;
    this.inFlight?.abort();
    this.inFlight = null;
    this.endpoints = { start: null, destination: null };
    this.coordinates = [];
    this.layer.clear();
    this.panel.close();
    this.prompt.hide();
    this.refreshLabels();
  }

  private async calculate(start: ObjectRecord, destination: ObjectRecord): Promise<void> {
    const token = ++this.token;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const names = { start: start.name, destination: destination.name };
    this.panel.showCalculating(names);

    try {
      const route = await fetchWalkingRoute(start, destination, { signal: controller.signal });
      if (token !== this.token) return;
      this.coordinates = route.coordinates;
      this.layer.setRoute(route.coordinates);
      this.panel.showRoute(names, route);
    } catch (error) {
      if (token !== this.token) return;
      // An abort means this request was superseded or cleared; the state that
      // replaced it already owns the panel.
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.coordinates = [];
      this.layer.clearRoute();
      if (error instanceof NoRouteError) {
        this.panel.showNoRoute(names);
      } else if (error instanceof DirectionsError) {
        this.panel.showError(names, error.message);
      } else {
        // Nothing else should reach here; report it rather than swallow it.
        console.error("Routing failed", error);
        this.panel.showError(names, "An unexpected error occurred.");
      }
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /**
   * "Start here" while nothing is chosen, "Change start" once something is -
   * so a user who mis-taps can see that pressing it again replaces rather
   * than adds, which is what it does.
   */
  private refreshLabels(): void {
    this.hooks.setRouteLabels({
      start: this.endpoints.start ? "Change start" : "Start here",
      destination: this.endpoints.destination ? "Change destination" : "End here",
    });
  }
}
