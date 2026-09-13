/**
 * The route planner's state machine (spec section 8), kept out of `main.ts`.
 *
 * There are four states and the whole feature is the transitions between them:
 *
 *   empty      - nothing picked; the planner shows two empty fields
 *   half       - one endpoint picked; the planner shows which end is still open
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
 * **Endpoints are `RouteEndpoint`s, which is looser than it used to be.** They
 * were `ObjectRecord`s - index records only - because the object panel was the
 * only way to name one. Since 2026-09-13 the planner (`routePlanner.ts`) can
 * also take a typed place name, a pasted coordinate, or a tap on open ground,
 * none of which is an indexed object, and refusing those would have meant
 * refusing to route to any col or car park the index does not carry.
 *
 * The identity contract that replaced it is narrower but still real: *snow
 * history* is still only ever shown for a true index record, because that is
 * the only kind of endpoint an object slot map can be found for. An
 * `ObjectRecord` satisfies `RouteEndpoint` structurally, so the object panel's
 * route buttons pass one through unchanged and lose nothing.
 */
import type { RouteRole } from "../objects/panel.ts";
import { DirectionsError, NoRouteError, fetchWalkingRoute } from "./directions.ts";
import { RouteLayer } from "./routeLayer.ts";
import { RoutePanel } from "./routePanel.ts";
import type { PlannerPoint, PlannerRole } from "./routePlanner.ts";
import { DEFAULT_SPACING_METERS, pointAtDistance, resampleAlongRoute } from "./routeProfile.ts";
import { SnowDataClient } from "./snowDataClient.ts";
import { summariseSnow } from "./snowSummary.ts";

export type { RouteRole };

/**
 * One end of a route: enough to route to it and to name it on screen.
 *
 * `ObjectRecord` is structurally assignable to this, which is the point - the
 * object panel keeps handing over index records and this file never has to
 * know the difference.
 */
export type RouteEndpoint = PlannerPoint;

/**
 * Whether both ends are effectively the same place.
 *
 * Identity alone is not enough now that endpoints can come from three sources:
 * the same summit reached by tapping it and by typing its name carries two
 * different ids, and asking the provider to route between them wastes a call
 * to render "0 m". A metre of separation is far below anything walkable and
 * well above floating-point noise in a coordinate round-trip.
 */
const SAME_PLACE_DEGREES = 1e-5;

function samePlace(a: RouteEndpoint, b: RouteEndpoint): boolean {
  if (a.id === b.id) return true;
  return (
    Math.abs(a.longitude - b.longitude) < SAME_PLACE_DEGREES &&
    Math.abs(a.latitude - b.latitude) < SAME_PLACE_DEGREES
  );
}

type Endpoints = { start: RouteEndpoint | null; destination: RouteEndpoint | null };

export type RouteControllerHooks = {
  /** Close the object panel and its highlight - the route panel is taking the sheet. */
  closeObjectPanel: () => void;
  /** Re-word the object panel's route buttons as the plan fills in. */
  setRouteLabels: (labels: { start: string; destination: string }) => void;
  /**
   * The snow data pyramid for the AS-OF date currently on the map.
   *
   * A getter, not a value: the AS-OF date can change after this controller is
   * built, and a historical run that predates the data pyramid genuinely has
   * none. Sampling another date's snow against this date's map would be the
   * exact confusion spec section 5.4 exists to prevent, so the answer is read
   * fresh each time a route is calculated.
   *
   * Unavailability carries its own reason rather than being a bare null,
   * because the two causes need different words: a *historical* date is the
   * designed behaviour and the user can act on it by moving to the latest
   * date, whereas the latest date having no pyramid is a fault on our side
   * and must not be described as if it were normal. One value rather than two
   * hooks, so the reason cannot disagree with the availability.
   */
  snowDataSource: () => SnowDataAvailability;
  /**
   * The plan changed. The planner mirrors this rather than tracking its own
   * fields, so the object panel's buttons, a map pick and a typed name all
   * end up shown the same way.
   */
  onEndpointsChanged: (start: RouteEndpoint | null, destination: RouteEndpoint | null) => void;
};

export type SnowDataAvailability =
  | { available: true; url: string; zoom: number }
  | { available: false; reason: string };

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
    private readonly hooks: RouteControllerHooks,
  ) {
    this.panel.setCloseHandler(() => this.clear());
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
  choose(record: RouteEndpoint, role: RouteRole): void {
    this.setEndpoint(role, record);
  }

  /**
   * Set or clear one end, from wherever it came - the planner's fields, a map
   * pick, or the object panel's buttons. The single entry point for every
   * change to the plan, so all three routes through the UI behave identically.
   */
  setEndpoint(role: PlannerRole, point: RouteEndpoint | null): void {
    this.endpoints = { ...this.endpoints, [role]: point };
    this.layer.setEndpoints(this.endpoints.start, this.endpoints.destination);
    this.refreshLabels();
    this.hooks.onEndpointsChanged(this.endpoints.start, this.endpoints.destination);

    const { start, destination } = this.endpoints;
    if (start && destination) {
      this.hooks.closeObjectPanel();
      if (samePlace(start, destination)) {
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
    // Half-planned, or emptied. Any route drawn from an earlier plan goes now:
    // the line no longer matches the endpoints it was calculated between.
    this.token += 1;
    this.inFlight?.abort();
    this.inFlight = null;
    this.coordinates = [];
    this.layer.clearRoute();
    this.panel.close();
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
    this.refreshLabels();
    this.hooks.onEndpointsChanged(null, null);
  }

  private async calculate(start: RouteEndpoint, destination: RouteEndpoint): Promise<void> {
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
    if (!source.available) {
      this.panel.showSnowUnavailable(source.reason);
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
