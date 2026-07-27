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
export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}
export interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: Position[][];
}
export type LinearGeometry = LineStringGeometry | MultiLineStringGeometry;

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
export type WaterInput = AreaGeometry | GeoFeature | GeoFeatureCollection;

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
export function pointInGeometry(
  point: Position,
  geometry: AreaGeometry,
): boolean {
  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) =>
      pointInPolygon(point, polygon),
    );
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
      ? [
          Math.min(box[0], b[0]),
          Math.min(box[1], b[1]),
          Math.max(box[2], b[2]),
          Math.max(box[3], b[3]),
        ]
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
  const mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
  const mPerDegLon = mPerDegLat * Math.cos(meanLat * DEG_TO_RAD);
  let area2 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    area2 +=
      xj * mPerDegLon * (yi * mPerDegLat) - xi * mPerDegLon * (yj * mPerDegLat);
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
    (sum, polygon) =>
      sum + geometryAreaKm2({ type: "Polygon", coordinates: polygon }),
    0,
  );
}

/** Total area (km²) of every polygon in a water input. */
export function waterAreaKm2(water: WaterInput): number {
  return areaGeometries(water).reduce(
    (sum, geom) => sum + geometryAreaKm2(geom),
    0,
  );
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

function overtureFeatureKey(feature: GeoFeature, index: number): string {
  const properties = feature.properties ?? {};
  for (const key of ["_overture_id", "id", "@id", "osmId"]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") {
      return `${key}:${value}`;
    }
  }
  return `feature:${index}`;
}

/**
 * Collapse repeated Overture MVT feature fragments to one representative
 * feature per stable Overture id. The largest polygon fragment is retained.
 */
export function dedupeOvertureFeatures(
  collection: GeoFeatureCollection,
): GeoFeatureCollection {
  const byId = new Map<string, GeoFeature>();
  const areaById = new Map<string, number>();
  collection.features.forEach((feature, index) => {
    const key = overtureFeatureKey(feature, index);
    const geometry = feature.geometry as { type?: string };
    const area =
      geometry.type === "Polygon" || geometry.type === "MultiPolygon"
        ? geometryAreaKm2(feature.geometry as AreaGeometry)
        : 0;
    if (!byId.has(key) || area > (areaById.get(key) ?? 0)) {
      byId.set(key, feature);
      areaById.set(key, area);
    }
  });
  return { type: "FeatureCollection", features: [...byId.values()] };
}

function interpolate(a: Position, b: Position, t: number): Position {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function cross(a: Position, b: Position): number {
  return a[0] * b[1] - a[1] * b[0];
}

function segmentIntersectionT(
  start: Position,
  end: Position,
  edgeStart: Position,
  edgeEnd: Position,
): number | null {
  const segment: Position = [end[0] - start[0], end[1] - start[1]];
  const edge: Position = [edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1]];
  const denominator = cross(segment, edge);
  if (Math.abs(denominator) < 1e-12) return null;
  const offset: Position = [edgeStart[0] - start[0], edgeStart[1] - start[1]];
  const t = cross(offset, edge) / denominator;
  const u = cross(offset, segment) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return Math.max(0, Math.min(1, t));
}

function boundaryIntersections(
  start: Position,
  end: Position,
  water: WaterInput,
): number[] {
  const values = [0, 1];
  for (const geometry of areaGeometries(water)) {
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let index = 1; index < ring.length; index += 1) {
          const t = segmentIntersectionT(
            start,
            end,
            ring[index - 1],
            ring[index],
          );
          if (t !== null) values.push(t);
        }
      }
    }
  }
  values.sort((a, b) => a - b);
  return values.filter(
    (value, index) => index === 0 || Math.abs(value - values[index - 1]) > 1e-9,
  );
}

/** Great-circle distance between two longitude/latitude positions in km. */
export function distanceKm(a: Position, b: Position): number {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const deltaLat = (b[1] - a[1]) * DEG_TO_RAD;
  const deltaLon = (b[0] - a[0]) * DEG_TO_RAD;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const normalized = Math.max(0, Math.min(1, haversine));
  return (
    (2 *
      EARTH_RADIUS_M *
      Math.atan2(Math.sqrt(normalized), Math.sqrt(1 - normalized))) /
    1000
  );
}

function clippedLineParts(
  coordinates: Position[],
  water: WaterInput,
): { parts: Position[][]; lengthKm: number } {
  const parts: Position[][] = [];
  let lengthKm = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const intersections = boundaryIntersections(start, end, water);
    for (let part = 1; part < intersections.length; part += 1) {
      const from = interpolate(start, end, intersections[part - 1]);
      const to = interpolate(start, end, intersections[part]);
      const midpoint = interpolate(from, to, 0.5);
      if (!pointInWater(midpoint, water)) continue;
      parts.push([from, to]);
      lengthKm += distanceKm(from, to);
    }
  }
  return { parts, lengthKm };
}

export interface TransportationInFloodResult {
  /** Unique Overture transportation segments tested. */
  total: number;
  /** Unique segments with some length inside the flood extent. */
  impactedCount: number;
  /** Total transportation centerline length inside the flood extent. */
  impactedLengthKm: number;
  /** Impacted counts grouped by the Overture subtype property. */
  bySubtype: Record<string, number>;
  /** Transportation centerlines clipped to the flood extent. */
  impactedFeatures: GeoFeature[];
}

/**
 * Clip Overture transportation centerlines to a flood polygon and summarize
 * the unique impacted segments.
 */
export function transportationInFlood(
  transportation: GeoFeatureCollection,
  water: WaterInput,
  options: { allowedSubtypes?: readonly string[] } = {},
): TransportationInFloodResult {
  const allowedSubtypes = options.allowedSubtypes
    ? new Set(options.allowedSubtypes)
    : null;
  const testedIds = new Set<string>();
  const impactedIds = new Set<string>();
  const subtypeIds = new Map<string, Set<string>>();
  const impactedFeatures: GeoFeature[] = [];
  let impactedLengthKm = 0;

  transportation.features.forEach((feature, index) => {
    const subtype =
      typeof feature.properties?.subtype === "string"
        ? feature.properties.subtype
        : "other";
    if (allowedSubtypes && !allowedSubtypes.has(subtype)) return;
    const geometry = feature.geometry as LinearGeometry;
    if (
      geometry?.type !== "LineString" &&
      geometry?.type !== "MultiLineString"
    ) {
      return;
    }
    const key = overtureFeatureKey(feature, index);
    testedIds.add(key);
    const lines =
      geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.coordinates;
    const parts: Position[][] = [];
    let featureLengthKm = 0;
    for (const line of lines) {
      const clipped = clippedLineParts(line, water);
      parts.push(...clipped.parts);
      featureLengthKm += clipped.lengthKm;
    }
    if (parts.length === 0) return;

    impactedIds.add(key);
    impactedLengthKm += featureLengthKm;
    const ids = subtypeIds.get(subtype) ?? new Set<string>();
    ids.add(key);
    subtypeIds.set(subtype, ids);
    impactedFeatures.push({
      type: "Feature",
      properties: {
        ...(feature.properties ?? {}),
        impact_length_km: featureLengthKm,
      },
      geometry:
        parts.length === 1
          ? { type: "LineString", coordinates: parts[0] }
          : { type: "MultiLineString", coordinates: parts },
    });
  });

  return {
    total: testedIds.size,
    impactedCount: impactedIds.size,
    impactedLengthKm,
    bySubtype: Object.fromEntries(
      [...subtypeIds].map(([subtype, ids]) => [subtype, ids.size]),
    ),
    impactedFeatures,
  };
}
