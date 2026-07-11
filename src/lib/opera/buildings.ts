/**
 * Ancillary building footprints from OpenStreetMap via the public Overpass API.
 *
 * Overpass is CORS-enabled (`Access-Control-Allow-Origin: *`), so the browser
 * can query it directly with no proxy. We request `out geom;` so each building
 * way carries its inline node geometry, then convert ways to GeoJSON Polygon
 * features. Complex multipolygon relations are skipped for v1 (ways cover the
 * large majority of building footprints), which keeps the parse simple and the
 * exposure estimate close enough for a headline figure.
 *
 * DOM/MapLibre-free so it stays unit-testable.
 */

import type { GeoFeature, GeoFeatureCollection, Position } from "./geometry";
import type { BBox } from "./types";

/** Public Overpass mirrors, tried in order. */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Hard cap on returned buildings so a dense-city AOI cannot explode memory. */
export const MAX_BUILDINGS = 20000;

interface OverpassNodeGeom {
  lat: number;
  lon: number;
}
interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  geometry?: OverpassNodeGeom[];
  tags?: Record<string, string>;
}
interface OverpassResponse {
  elements?: OverpassElement[];
}

/** Build the Overpass QL query for buildings within a `[w, s, e, n]` bbox. */
export function buildOverpassQuery(bbox: BBox, timeoutSec = 25): string {
  const [w, s, e, n] = bbox;
  // Overpass bbox order is (south, west, north, east).
  const box = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:${timeoutSec}];(way["building"]${box};);out geom;`;
}

function closeRing(coords: Position[]): Position[] {
  if (coords.length < 3) return coords;
  const [fx, fy] = coords[0];
  const [lx, ly] = coords[coords.length - 1];
  if (fx !== lx || fy !== ly) return [...coords, [fx, fy]];
  return coords;
}

/** Convert an Overpass `out geom` response into a Polygon FeatureCollection. */
export function overpassToFeatureCollection(
  data: OverpassResponse,
): GeoFeatureCollection {
  const features: GeoFeature[] = [];
  for (const element of data.elements ?? []) {
    if (element.type !== "way" || !element.geometry || element.geometry.length < 3) {
      continue;
    }
    const ring = closeRing(
      element.geometry.map((node): Position => [node.lon, node.lat]),
    );
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        osmId: `way/${element.id}`,
        name: element.tags?.name,
        building: element.tags?.building,
      },
    });
    if (features.length >= MAX_BUILDINGS) break;
  }
  return { type: "FeatureCollection", features };
}

export interface FetchBuildingsOptions {
  /** Abort/timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Endpoints to try, in order. Defaults to {@link OVERPASS_ENDPOINTS}. */
  endpoints?: string[];
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch OSM building footprints within a bbox as a GeoJSON FeatureCollection.
 * Tries each Overpass mirror until one succeeds; throws when all fail.
 */
export async function fetchOsmBuildings(
  bbox: BBox,
  options: FetchBuildingsOptions = {},
): Promise<GeoFeatureCollection> {
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS;
  const doFetch = options.fetchImpl ?? fetch;
  const query = buildOverpassQuery(bbox);
  let lastError: unknown;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Overpass responded ${response.status}`);
      }
      const data = (await response.json()) as OverpassResponse;
      return overpassToFeatureCollection(data);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `Failed to fetch OSM buildings: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
