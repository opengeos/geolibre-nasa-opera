/**
 * The "locked benchmark" — a human-QAed flood water-extent map that the science
 * team authors offline and imports as the authoritative ground truth. Once
 * locked it becomes the spatial boundary the AI agent operates within: the agent
 * must not recompute or override it, only intersect ancillary data against it.
 *
 * This module is DOM/MapLibre-free so it can be unit-tested: it normalizes an
 * imported GeoJSON (Feature / FeatureCollection / bare geometry) into a stable
 * {@link LockedBenchmark}, and provides a type guard for restoring one from
 * saved project state.
 */

import {
  areaGeometries,
  waterAreaKm2,
  waterBBox,
  type GeoFeature,
  type GeoFeatureCollection,
} from "./geometry";
import type { BBox } from "./types";

/** Event metadata shown on the one-pager and given to the agent. */
export interface BenchmarkEvent {
  /** Event name, e.g. "Valencia DANA flooding". */
  name: string;
  /** Event date or range, e.g. "2024-10-29". */
  date?: string;
  /** Place, e.g. "Valencia, Spain". */
  location?: string;
}

/** Rendering + legend hints carried from the QA process. */
export interface BenchmarkRender {
  /** Legend title, e.g. "Flood water extent". */
  label?: string;
  /** "min,max" stretch used when the benchmark is a COG. */
  rescale?: string;
  /** Named colormap for a COG benchmark. */
  colormapName?: string;
  /** Fill color for a vector water polygon (hex). */
  fillColor?: string;
  /** Human-readable legend classes for a categorical benchmark. */
  classes?: Array<{ label: string; color: string }>;
}

/** The authoritative, human-QAed flood extent locked into the plugin. */
export interface LockedBenchmark {
  /** Stable id for this benchmark instance. */
  id: string;
  /** Water extent, always normalized to a FeatureCollection of polygons. */
  water: GeoFeatureCollection;
  /** `[w, s, e, n]` extent of the water polygons (the agent's AOI boundary). */
  bbox: BBox;
  /** Optional COG URL if the benchmark also ships a raster. */
  cogUrl?: string;
  /** Rendering + legend hints. */
  render: BenchmarkRender;
  /** Event metadata. */
  event: BenchmarkEvent;
  /** Flooded area in km² (from the water polygons). */
  areaKm2: number;
  /** ISO timestamp captured when the benchmark was locked. */
  lockedAt: string;
}

/** Compact benchmark summary exposed to the agent via context. */
export interface BenchmarkSummary {
  id: string;
  event: BenchmarkEvent;
  bbox: BBox;
  areaKm2: number;
  featureCount: number;
  render: BenchmarkRender;
  lockedAt: string;
}

const DEFAULT_WATER_FILL = "#2b7fff";

function isFeatureCollection(value: unknown): value is GeoFeatureCollection {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "FeatureCollection" &&
    Array.isArray((value as GeoFeatureCollection).features)
  );
}

function isFeature(value: unknown): value is GeoFeature {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "Feature"
  );
}

function isAreaGeometryType(value: unknown): boolean {
  const t = (value as { type?: string })?.type;
  return t === "Polygon" || t === "MultiPolygon";
}

/**
 * Normalize any imported GeoJSON into a polygon-only FeatureCollection. Throws a
 * descriptive Error when the input carries no Polygon/MultiPolygon geometry.
 */
export function normalizeWater(raw: unknown): GeoFeatureCollection {
  let features: GeoFeature[];
  if (isFeatureCollection(raw)) {
    features = raw.features;
  } else if (isFeature(raw)) {
    features = [raw];
  } else if (isAreaGeometryType(raw)) {
    features = [{ type: "Feature", geometry: raw, properties: {} }];
  } else {
    throw new Error(
      "Benchmark file must be GeoJSON: a Polygon/MultiPolygon, a Feature, or a FeatureCollection.",
    );
  }
  const polygons = features.filter((f) => isAreaGeometryType(f?.geometry));
  if (polygons.length === 0) {
    throw new Error("Benchmark GeoJSON contains no Polygon/MultiPolygon water geometry.");
  }
  return { type: "FeatureCollection", features: polygons };
}

/** Options accepted when locking a benchmark from an imported file. */
export interface LockBenchmarkOptions {
  event: BenchmarkEvent;
  render?: BenchmarkRender;
  cogUrl?: string;
  /** Stable id; a time-seeded default is used when omitted. */
  id?: string;
  /** ISO timestamp; supplied by the caller so this module stays clock-free. */
  lockedAt: string;
}

/**
 * Build a {@link LockedBenchmark} from imported GeoJSON + metadata. The water is
 * normalized, the bbox and area are derived from it, and a default water fill is
 * applied when none is supplied.
 */
export function lockBenchmark(
  rawGeoJson: unknown,
  options: LockBenchmarkOptions,
): LockedBenchmark {
  const water = normalizeWater(rawGeoJson);
  const bbox = waterBBox(water);
  if (!bbox) {
    throw new Error("Could not derive a bounding box from the benchmark water geometry.");
  }
  return {
    id: options.id ?? `benchmark-${options.lockedAt}`,
    water,
    bbox,
    cogUrl: options.cogUrl,
    render: {
      label: options.render?.label ?? "Flood water extent",
      fillColor: options.render?.fillColor ?? DEFAULT_WATER_FILL,
      rescale: options.render?.rescale,
      colormapName: options.render?.colormapName,
      classes: options.render?.classes,
    },
    event: options.event,
    areaKm2: waterAreaKm2(water),
    lockedAt: options.lockedAt,
  };
}

/** Compact summary for the agent context / get_benchmark tool. */
export function summarizeBenchmark(benchmark: LockedBenchmark): BenchmarkSummary {
  return {
    id: benchmark.id,
    event: benchmark.event,
    bbox: benchmark.bbox,
    areaKm2: benchmark.areaKm2,
    featureCount: areaGeometries(benchmark.water).length,
    render: benchmark.render,
    lockedAt: benchmark.lockedAt,
  };
}

/** Type guard for restoring a locked benchmark from saved project state. */
export function isLockedBenchmark(value: unknown): value is LockedBenchmark {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<LockedBenchmark>;
  return (
    typeof b.id === "string" &&
    isFeatureCollection(b.water) &&
    Array.isArray(b.bbox) &&
    b.bbox.length === 4 &&
    typeof b.areaKm2 === "number" &&
    typeof b.lockedAt === "string" &&
    !!b.event &&
    typeof b.event.name === "string"
  );
}
