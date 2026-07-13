/**
 * Minimal, dependency-free planar geometry for the constrained flood workflow.
 *
 * The repo intentionally ships no `@turf`/geometry runtime deps, so this module
 * hand-rolls the few operations the "buildings within the flooded area"
 * intersection needs: ray-casting point-in-polygon, polygon centroid, and a
 * shoelace area (km²) with an equirectangular scale correction at the ring's
 * mean latitude. All functions operate on structural GeoJSON shapes so the data
 * layer stays free of DOM/MapLibre imports and is unit-testable in isolation.
 *
 * Precision note: the building test is centroid-in-polygon. That under-counts
 * buildings whose footprint straddles the flood boundary; it is intentionally
 * simple for v1. A future upgrade can swap in `@turf/boolean-intersects` for
 * exact edge handling.
 */

import type { BBox } from "./types";

/** A `[lon, lat]` position. */
export type Position = [number, number];

/** Structural GeoJSON geometry subset this module understands. */
export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}
export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
}
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface GeoFeature {
  type: "Feature";
  geometry: unknown;
  properties?: Record<string, unknown> | null;
}
export interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

/** Anything a benchmark water extent might be handed to us as. */
export type WaterInput =
  | AreaGeometry
  | GeoFeature
  | GeoFeatureCollection;

/** Ray-casting point-in-ring test (ring is a closed or open coordinate list). */
export function pointInRing(point: Position, ring: Position[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** True when `point` lies inside a Polygon (outer ring minus holes). */
export function pointInPolygon(point: Position, rings: Position[][]): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(point, rings[0])) return false;
  // Exclude holes (interior rings).
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

/** True when `point` lies inside a Polygon or MultiPolygon geometry. */
export function pointInGeometry(point: Position, geometry: AreaGeometry): boolean {
  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

/** Collect every Polygon/MultiPolygon geometry out of a water input. */
export function areaGeometries(water: WaterInput): AreaGeometry[] {
  const out: AreaGeometry[] = [];
  const push = (geom: unknown): void => {
    if (!geom || typeof geom !== "object") return;
    const g = geom as { type?: string };
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      out.push(geom as AreaGeometry);
    }
  };
  if (water.type === "FeatureCollection") {
    for (const feature of water.features) push(feature.geometry);
  } else if (water.type === "Feature") {
    push(water.geometry);
  } else {
    push(water);
  }
  return out;
}

/** True when `point` lies inside any polygon of a water input. */
export function pointInWater(point: Position, water: WaterInput): boolean {
  return areaGeometries(water).some((geom) => pointInGeometry(point, geom));
}

/** Flatten every ring position out of a geometry (for centroid/bbox). */
function collectPositions(geometry: unknown, sink: Position[]): void {
  if (!geometry || typeof geometry !== "object") return;
  const g = geometry as { type?: string; coordinates?: unknown };
  switch (g.type) {
    case "Point":
      sink.push(g.coordinates as Position);
      break;
    case "MultiPoint":
    case "LineString":
      for (const p of (g.coordinates as Position[]) ?? []) sink.push(p);
      break;
    case "MultiLineString":
    case "Polygon":
      for (const ring of (g.coordinates as Position[][]) ?? [])
        for (const p of ring) sink.push(p);
      break;
    case "MultiPolygon":
      for (const poly of (g.coordinates as Position[][][]) ?? [])
        for (const ring of poly) for (const p of ring) sink.push(p);
      break;
    default:
      break;
  }
}

/** Average of a geometry's vertices — a cheap, robust-enough centroid. */
export function centroid(geometry: unknown): Position | null {
  const positions: Position[] = [];
  collectPositions(geometry, positions);
  if (positions.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of positions) {
    sx += x;
    sy += y;
  }
  return [sx / positions.length, sy / positions.length];
}

/** `[w, s, e, n]` bounding box of any GeoJSON geometry, or null if empty. */
export function geometryBBox(geometry: unknown): BBox | null {
  const positions: Position[] = [];
  collectPositions(geometry, positions);
  if (positions.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of positions) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** `[w, s, e, n]` bbox spanning every feature/geometry in a water input. */
export function waterBBox(water: WaterInput): BBox | null {
  const geoms = areaGeometries(water);
  let box: BBox | null = null;
  for (const geom of geoms) {
    const b = geometryBBox(geom);
    if (!b) continue;
    box = box
      ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
      : b;
  }
  return box;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Planar shoelace area of a single ring in km², corrected for longitude
 * convergence by scaling x by cos(mean latitude). Good to a few percent for the
 * small AOIs a flood benchmark covers — enough for an exposure headline figure.
 */
export function ringAreaKm2(ring: Position[]): number {
  if (ring.length < 3) return 0;
  let latSum = 0;
  for (const [, y] of ring) latSum += y;
  const meanLat = latSum / ring.length;
  const mPerDegLat = (EARTH_RADIUS_M * DEG_TO_RAD);
  const mPerDegLon = mPerDegLat * Math.cos(meanLat * DEG_TO_RAD);
  let area2 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    area2 += (xj * mPerDegLon) * (yi * mPerDegLat) - (xi * mPerDegLon) * (yj * mPerDegLat);
  }
  return Math.abs(area2) / 2 / 1_000_000;
}

/** Area (km²) of a Polygon/MultiPolygon (outer rings minus holes). */
export function geometryAreaKm2(geometry: AreaGeometry): number {
  if (geometry.type === "Polygon") {
    const [outer, ...holes] = geometry.coordinates;
    const outerArea = outer ? ringAreaKm2(outer) : 0;
    const holeArea = holes.reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
    return Math.max(0, outerArea - holeArea);
  }
  return geometry.coordinates.reduce(
    (sum, polygon) => sum + geometryAreaKm2({ type: "Polygon", coordinates: polygon }),
    0,
  );
}

/** Total area (km²) of every polygon in a water input. */
export function waterAreaKm2(water: WaterInput): number {
  return areaGeometries(water).reduce((sum, geom) => sum + geometryAreaKm2(geom), 0);
}

/** Result of {@link buildingsInFlood}. */
export interface BuildingsInFloodResult {
  /** Total candidate buildings tested (from the ancillary source). */
  total: number;
  /** Buildings whose centroid falls within the flood water polygon. */
  floodedCount: number;
  /** floodedCount / total, or 0 when total is 0. */
  fraction: number;
  /** Optional summed footprint area (km²) of flooded buildings. */
  floodedAreaKm2?: number;
  /** The flooded building features (for optionally drawing a layer). */
  floodedFeatures: GeoFeature[];
}

/**
 * Tally which buildings fall within a flood water extent by centroid-in-polygon.
 *
 * @param buildings - Building footprints (a GeoJSON FeatureCollection).
 * @param water - The locked benchmark water extent (the boundary).
 * @param opts.computeArea - When true, also sum flooded building footprint km².
 */
export function buildingsInFlood(
  buildings: GeoFeatureCollection,
  water: WaterInput,
  opts: { computeArea?: boolean } = {},
): BuildingsInFloodResult {
  const geoms = areaGeometries(water);
  const flooded: GeoFeature[] = [];
  let floodedAreaKm2 = 0;
  for (const feature of buildings.features) {
    const c = centroid(feature.geometry);
    if (!c) continue;
    const hit = geoms.some((geom) => pointInGeometry(c, geom));
    if (!hit) continue;
    flooded.push(feature);
    if (opts.computeArea) {
      const g = feature.geometry as { type?: string };
      if (g.type === "Polygon" || g.type === "MultiPolygon") {
        floodedAreaKm2 += geometryAreaKm2(feature.geometry as AreaGeometry);
      }
    }
  }
  const total = buildings.features.length;
  return {
    total,
    floodedCount: flooded.length,
    fraction: total > 0 ? flooded.length / total : 0,
    floodedAreaKm2: opts.computeArea ? floodedAreaKm2 : undefined,
    floodedFeatures: flooded,
  };
}
