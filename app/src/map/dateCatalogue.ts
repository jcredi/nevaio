import {
  DateCatalogueError,
  dateCatalogueUrlFor,
  validateDateCatalogue,
  type CatalogueEntry,
  type DateCatalogue,
} from "./dateCatalogueSchema";

export type { CatalogueEntry, DateCatalogue };

/**
 * Fetch and validate the AS-OF date catalogue, or return null if there is no
 * usable one.
 *
 * Null is not an error state for the app: it means no historical dates are on
 * offer, and the date display stays the non-interactive label it has always
 * been. It must never mean "offer the picker anyway and hope" - the catalogue
 * is the only authority on which dates exist (spec section 5.3).
 *
 * Fetched `no-cache` for the same reason `latest.json` is: the object is
 * rewritten by every publication and is served with `no-cache, max-age=0`, so
 * a revalidated copy is the point.
 */
export async function loadDateCatalogue(
  manifestUrl: string,
  pageUrl: string,
): Promise<DateCatalogue | null> {
  const catalogueUrl = dateCatalogueUrlFor(manifestUrl, pageUrl);
  try {
    const response = await fetch(catalogueUrl, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Failed to load date catalogue: ${response.status} ${catalogueUrl}`);
    }
    return validateDateCatalogue(await response.text(), catalogueUrl, pageUrl);
  } catch (error) {
    // A rejected catalogue is louder than a missing one: it means the
    // published metadata is malformed or has been tampered with. Same split as
    // the snow manifest.
    if (error instanceof DateCatalogueError) {
      console.error("Date catalogue rejected by validation", error);
    } else {
      console.warn("Date catalogue unavailable", error);
    }
    return null;
  }
}
