/**
 * The loading boundary for the static OSM object index.
 *
 * Everything provider-specific about *where* the index comes from lives here
 * and nowhere else. Today it is a small local fixture in `public/objects/`;
 * when the pipeline publishes a real shard to R2 the change is the URL in
 * `../map/config.ts` plus whatever the validator must learn - deliberately
 * not a change to the panel or the matching rule.
 *
 * The R2 bucket host is already in `app/public/_headers`' `connect-src`
 * (it serves the snow manifest), so that swap needs no new CSP origin. Any
 * *other* host would.
 */
import { validateObjectIndex, type ObjectIndex } from "./objectIndexSchema.ts";

/**
 * A shard far bigger than this is a pipeline mistake, not something to parse
 * on a phone. The whole Alps+Italy build is 45 MB (worklog 2026-09-11) and is
 * explicitly not shippable as one download.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export class ObjectIndexLoadError extends Error {}

export async function loadObjectIndex(
  url: string,
  signal?: AbortSignal,
): Promise<ObjectIndex> {
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: "no-cache" });
  } catch (error) {
    throw new ObjectIndexLoadError(`could not fetch the object index: ${String(error)}`);
  }
  if (!response.ok) {
    throw new ObjectIndexLoadError(`object index request failed: HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    throw new ObjectIndexLoadError(
      `object index is ${declaredLength} bytes, over the ${MAX_BYTES} limit`,
    );
  }

  const body = await response.text();
  if (body.length > MAX_BYTES) {
    throw new ObjectIndexLoadError(`object index is over the ${MAX_BYTES} character limit`);
  }

  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch (error) {
    throw new ObjectIndexLoadError(`object index is not valid JSON: ${String(error)}`);
  }
  return validateObjectIndex(document);
}
