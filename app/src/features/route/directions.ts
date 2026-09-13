/**
 * The network boundary for A-to-B hiking routes (spec section 8.1): one request
 * to the Geoapify Routing API in `hike` mode, validated by `directionsSchema.ts`
 * before any value reaches the map.
 *
 * **Why Geoapify**, decided 2026-09-13 - the full comparison and the two
 * rejected predecessors are in `docs/research/routing-and-dem-options.md`:
 *
 *  - *Not OpenRouteService*: its staff state a key must not be delivered to a
 *    browser, and it offers no domain restriction. An app with no backend
 *    (spec section 11) cannot use it.
 *  - *Not Mapbox*: it began asking for payment details at signup, against a
 *    feature budgeted at zero (spec section 15 item 9).
 *  - Geoapify needs no card, documents its keys as restrictable by allowed
 *    origin / HTTP referrer / CORS - the mechanism that makes MapTiler's key
 *    safe in a public bundle - and permits free-plan commercial use in writing.
 *
 * `hike` is the mode, not `walk`: Geoapify describes it as using "hiking trails
 * and higher difficulty trails", where `walk` is a pavement-oriented pedestrian
 * profile. That difference is the whole reason this app routes at all. It is
 * still a general router over OSM ways, though, and knows nothing about
 * seasonal closure, snow, or whether a marked path is currently passable -
 * spec section 8.6 requires the app to say so, and `routePanel.ts` does.
 *
 * **Attribution is mandatory on the free plan**: a "Powered by Geoapify" credit,
 * alongside the OpenStreetMap attribution the app already carries. It is added
 * to the map's attribution control in `main.ts`. Do not remove it while this
 * provider is in use.
 *
 * This module holds the key and the `fetch`, exactly as `../search/geocode.ts`
 * does for place search, so everything below it stays pure and Node-testable.
 */
import { geoapifyApiKey } from "../../map/config";
import {
  DirectionsError,
  MAX_ROUTE_SPAN_METERS,
  NoRouteError,
  RouteTooLongError,
  formatWaypoint,
  routeSpanMeters,
  validateDirectionsResponse,
  type ValidatedRoute,
} from "./directionsSchema.ts";

export { DirectionsError, NoRouteError, RouteTooLongError, type ValidatedRoute };

const ENDPOINT = "https://api.geoapify.com/v1/routing";

/**
 * Bound the response before it is parsed. A long alpine route's geometry is
 * tens of kilobytes of JSON; a megabyte means something is wrong with the
 * response, not with the route. `directionsSchema.ts` bounds the decoded
 * geometry too - this bounds the bytes, which is the cheaper check.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type RoutePoint = { longitude: number; latitude: number };

/** Whether routing can be offered at all - see `geoapifyApiKey` in `map/config.ts`. */
export function routingIsConfigured(): boolean {
  return geoapifyApiKey !== null;
}

/**
 * Fetch one hiking route from `start` to `destination`.
 *
 * Throws `NoRouteError` when the provider cannot connect the two points on foot
 * - a real answer to show the user - and `DirectionsError` for everything else,
 * including a missing key, a transport failure, and an HTTP error.
 */
export async function fetchWalkingRoute(
  start: RoutePoint,
  destination: RoutePoint,
  options: { signal?: AbortSignal } = {},
): Promise<ValidatedRoute> {
  if (geoapifyApiKey === null) {
    // Callers are expected to check `routingIsConfigured()` and never offer the
    // control at all; this is the backstop, and it names the missing variable
    // rather than surfacing an opaque 401 from the provider.
    throw new DirectionsError("VITE_GEOAPIFY_API_KEY is not set, so routing is unavailable");
  }

  // Refused before the request, not after: the provider caps a regular call at
  // MAX_ROUTE_SPAN_METERS of straight-line distance and reports the breach as a
  // plain HTTP 400, which is indistinguishable from any other bad request
  // without string-matching its prose. Checking here spends no credit and,
  // more importantly, lets the panel say something true - see
  // `RouteTooLongError`.
  const span = routeSpanMeters(start, destination);
  if (span > MAX_ROUTE_SPAN_METERS) throw new RouteTooLongError(span);

  const url = new URL(ENDPOINT);
  url.searchParams.set("waypoints", `${formatWaypoint(start)}|${formatWaypoint(destination)}`);
  url.searchParams.set("mode", "hike");
  // Metres, explicitly. `directionsSchema.ts` then *verifies* that the reply
  // says metres rather than assuming it: asking and checking are two different
  // things, and a miles figure read as metres is plausible on screen.
  url.searchParams.set("units", "metric");
  // No `details=elevation` yet. Geoapify can return a per-point elevation
  // profile, which is why it was chosen over Stadia - but it does not name its
  // global DEM source, so the elevation is to be smoke-tested against known
  // summit heights before anything is built on it (docs/plan.md item 2).
  url.searchParams.set("apiKey", geoapifyApiKey);

  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (error) {
    // An abort is the caller superseding its own request; let it through
    // untouched so the caller can ignore it rather than showing an error.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DirectionsError(`could not reach the routing provider: ${String(error)}`);
  }

  if (response.status === 401 || response.status === 403) {
    // The overwhelmingly likely cause is the key: revoked, or restricted to an
    // origin this build is not served from.
    throw new DirectionsError(
      `the routing provider rejected this app's API key (HTTP ${response.status})`,
    );
  }
  if (response.status === 429) {
    throw new DirectionsError("the routing provider's rate limit was reached - try again shortly");
  }
  if (response.status === 400) {
    // Measured 2026-09-13, against the live API: a 400 is the provider
    // rejecting the *request*, not reporting that no path exists. The one cause
    // this app can actually trigger is an over-long route, and that is now
    // caught before the request - so anything reaching here is unexpected, and
    // the honest thing is to surface what the provider actually said rather
    // than assert a cause. Genuine "nothing connects these points" arrives as
    // an empty feature list instead, and `directionsSchema.ts` owns it.
    //
    // Not reported as "no route": an earlier version did, which would have told
    // someone routing across a valley that no path existed when the real answer
    // was that they had asked for too much.
    throw new DirectionsError(providerMessage(await safeText(response)));
  }
  if (!response.ok) {
    throw new DirectionsError(`routing request failed: HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new DirectionsError(`routing response declares ${declared} bytes, over the limit`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new DirectionsError(`routing response is ${body.byteLength} bytes, over the limit`);
  }

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new DirectionsError(`routing response is not valid JSON: ${String(error)}`);
  }
  return validateDirectionsResponse(document);
}

/** Read an error body without letting that read throw. */
async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return "";
  }
}

/**
 * The provider's own explanation, pulled out of its `{statusCode, error,
 * message}` error body, for cases where this app has nothing better to say
 * than what the provider said. Falls back to a generic sentence rather than
 * dumping a raw body into the UI.
 */
function providerMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const message = (parsed as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0 && message.length <= 300) {
        return `the routing provider rejected the request: ${message}`;
      }
    }
  } catch {
    // Not JSON; fall through to the generic message.
  }
  return "the routing provider rejected the request";
}
