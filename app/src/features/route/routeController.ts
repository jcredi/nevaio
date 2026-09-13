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
import { DEFAULT_SPACING_METERS, pointAtDistance, resampleAlongRoute } from "./routeProfile.ts";
import { SnowDataClient } from "./snowDataClient.ts";
import { summariseSnow } from "./snowSummary.ts";

export type { RouteRole };

type Endpoints = { start: ObjectRecord | null; destination: ObjectRecord | null };

export type RouteControllerHooks = {
  /** Close the object panel and its highlight - the route panel is taking the sheet. */
  closeObjectPanel: () => void;
  /** Re-word the object panel's route buttons as the plan fills in. */
  setRouteLabels: (labels: { start: string; destination: string }) => void;
  /**
   * The snow data pyramid for the AS-OF date currently on the map, or null.
   *
   * A getter, not a value: the AS-OF date can change after this controller is
   * built, and a historical run that predates the data pyramid genuinely has
   * none. Sampling another date's snow against this date's map would be the
   * exact confusion spec section 5.4 exists to prevent, so the answer is read
   * fresh each time a route is calculated.
   */
  snowDataSource: () => { url: string; zoom: number } | null;
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
      if (start.id === destination.id) {
        // Refused here rather than sent: the provider returns a valid
        // zero-length route for this, which renders as "0 m" and an empty
        // chart. Spending a request to display nothing useful helps nobody.
        this.coordinates = [];
        this.layer.clearRoute();
        this.panel.showSamePoint(start.name);
        return;
      }
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
      void this.sampleSnow(route.coordinates, token);
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
   * Sample snow along the route and hand the summary to the panel.
   *
   * Deliberately *after* the route is already on screen and not awaited by it:
   * the distance, profile and disclaimer are useful immediately, and snow
   * sampling pulls one or more tiles over the network. A slow or missing snow
   * layer must never hold back the rest of the answer.
   */
  private async sampleSnow(coordinates: readonly [number, number][], token: number): Promise<void> {
    const source = this.hooks.snowDataSource();
    if (source === null) {
      this.panel.showSnowUnavailable(
        "Snow along the route is not available for this date.",
      );
      return;
    }

    this.panel.showSnowPending();
    // The same even ground spacing everything else in this feature uses, so a
    // count of samples converts to a distance (spec section 8.3's rule that
    // analysis must not depend on zoom).
    const { samples, spacingMeters } = resampleAlongRoute(coordinates, DEFAULT_SPACING_METERS);
    try {
      const client = new SnowDataClient(source.url, source.zoom);
      const cells = await client.sample(samples);
      if (token !== this.token) return;
      this.panel.showSnow(summariseSnow(cells), spacingMeters);
    } catch (error) {
      if (token !== this.token) return;
      console.error("Snow sampling failed", error);
      // Unknown, never "no snow".
      this.panel.showSnowUnavailable("Snow along the route could not be read.");
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
