/**
 * Mark the object the app believes you selected.
 *
 * This is a safety feature, not decoration. The selection rule matches a tap
 * to the nearest index record, and the index's coordinate is not always where
 * the basemap drew a label - so the user must be able to see *which* point
 * the panel is talking about and disagree with it.
 */
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import type { ObjectRecord } from "./objectIndexSchema.ts";

const SOURCE_ID = "selected-object";
const HALO_LAYER_ID = "selected-object-halo";
const DOT_LAYER_ID = "selected-object-dot";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export class SelectionHighlight {
  constructor(private readonly map: MapLibreMap) {
    map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: HALO_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": 14,
        "circle-color": "#0ea5e9",
        "circle-opacity": 0.18,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#0ea5e9",
        "circle-stroke-opacity": 0.5,
      },
    });
    map.addLayer({
      id: DOT_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": 4,
        "circle-color": "#0ea5e9",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  show(record: ObjectRecord): void {
    this.source().setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [record.longitude, record.latitude] },
          properties: { id: record.id },
        },
      ],
    });
  }

  clear(): void {
    this.source().setData(EMPTY);
  }

  private source(): GeoJSONSource {
    return this.map.getSource(SOURCE_ID) as GeoJSONSource;
  }
}
