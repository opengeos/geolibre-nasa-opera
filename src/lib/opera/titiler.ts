/**
 * titiler-cmr client.
 *
 * titiler-cmr (https://github.com/developmentseed/titiler-cmr) renders map tiles
 * directly from CMR queries. Crucially, it handles Earthdata authentication and
 * Cloud-Optimized GeoTIFF reads **server-side**, so this plugin needs no
 * Earthdata credentials in the browser: it just requests a `tilejson.json` and
 * hands the returned XYZ tile template to GeoLibre.
 *
 * Default endpoint is the hosted staging service used by leafmap's
 * `113_titiler_cmr` notebook. It is a staging/demo deployment with no SLA; for
 * production, self-host titiler-cmr and override the endpoint in the panel.
 */

import type { BBox, TitilerBackend } from "./types";

export const DEFAULT_TITILER_CMR_ENDPOINT =
  "https://staging.openveda.cloud/api/titiler-cmr";

export interface TileJsonParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Reader backend; OPERA products use "rasterio". */
  backend: TitilerBackend;
  /** Temporal filter "start/end" (RFC3339) to isolate a granule or window. */
  datetime?: string;
  /**
   * Pin the result to a single granule by its CMR GranuleUR (exact match).
   * Used to render exactly the granules the user selected, rather than every
   * granule in a temporal window.
   */
  granuleUr?: string;
  /** Band token(s) to render. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /** Min,max stretch, e.g. "0,4". */
  rescale?: string;
  /** Named titiler colormap, e.g. "viridis". */
  colormapName?: string;
  /**
   * Explicit colormap as a JSON string mapping class value -> [R,G,B,A]. When
   * set, it takes precedence over `rescale`/`colormapName` (used for
   * categorical layers like DSWx water classification).
   */
  colormap?: string;
  /**
   * rio-tiler band-math expression computed on the fly, e.g. `10*log10(b1)` for
   * dB. Bands are referenced as `b1`, `b2`, ... in the order of `bands`/`assets`
   * (sent with `asset_as_band=true`). Overrides plain band rendering.
   */
  expression?: string;
}

export interface TileJson {
  tiles: string[];
  bounds?: number[];
  minzoom?: number;
  maxzoom?: number;
}

/** TileMatrixSet id used for the XYZ tile grid. */
const TILE_MATRIX_SET = "WebMercatorQuad";

/**
 * Apply a band-math `expression` to a query. titiler evaluates expressions over
 * bands named `b1`, `b2`, ... so `asset_as_band=true` is sent alongside it to
 * map each requested asset onto a band. No-op when `expression` is blank.
 */
function applyExpression(query: URLSearchParams, expression?: string): void {
  const expr = expression?.trim();
  if (!expr) return;
  query.set("expression", expr);
  query.set("asset_as_band", "true");
}

/**
 * Build the titiler-cmr `tilejson.json` request URL (current API).
 *
 * Path: `{endpoint}/{backend}/WebMercatorQuad/tilejson.json` (backend is a path
 * segment). Query params for the rasterio backend:
 * `collection_concept_id`, `assets` (repeatable), `assets_regex`, `temporal`,
 * `rescale`, `colormap_name`.
 *
 * Note: the older leafmap-style names (`concept_id`, `bands`, `bands_regex`,
 * `datetime` on `{endpoint}/WebMercatorQuad/tilejson.json`) still work but only
 * via a 301 redirect, so we target the canonical form directly. Verified live
 * against the hosted staging endpoint.
 */
export function buildTileJsonUrl(params: TileJsonParams): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  query.set("collection_concept_id", params.conceptId);
  if (params.granuleUr) query.set("granule_ur", params.granuleUr);
  if (params.datetime) query.set("temporal", params.datetime);
  for (const band of params.bands ?? []) query.append("assets", band);
  if (params.bandsRegex) query.set("assets_regex", params.bandsRegex);
  applyExpression(query, params.expression);
  // An explicit categorical colormap wins over a min/max stretch; sending both
  // would rescale the class values before indexing the colormap.
  if (params.colormap) {
    query.set("colormap", params.colormap);
  } else {
    if (params.rescale) query.set("rescale", params.rescale);
    if (params.colormapName) query.set("colormap_name", params.colormapName);
  }

  return `${base}/${params.backend}/${TILE_MATRIX_SET}/tilejson.json?${query.toString()}`;
}

/**
 * Read the tile pixel size from a returned XYZ tile template's `tilesize` query
 * param (titiler-cmr defaults to 512), falling back to 256.
 */
export function tileSizeFromTemplate(template: string): number {
  const match = template.match(/[?&]tilesize=(\d+)/);
  return match ? parseInt(match[1], 10) : 256;
}

/** Parameters for a titiler-cmr `/point` pixel-value query. */
export interface PointQueryParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Reader backend; OPERA products use "rasterio". */
  backend: TitilerBackend;
  /** Longitude of the query point (EPSG:4326). */
  lon: number;
  /** Latitude of the query point (EPSG:4326). */
  lat: number;
  /** Pin the query to a single granule by its CMR GranuleUR (exact match). */
  granuleUr?: string;
  /** Temporal filter "start/end" (RFC3339) to isolate a granule or window. */
  datetime?: string;
  /** Band token(s) to read. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /** rio-tiler band-math expression (bands as `b1`, `b2`, ...); see TileJsonParams. */
  expression?: string;
}

/** Pixel values for one asset (granule file) at the queried point. */
export interface PointAsset {
  /** Source asset / granule file name. */
  name: string;
  /** Per-band values at the point; `null` marks nodata/outside coverage. */
  values: (number | null)[];
  /** Band identifiers, aligned with {@link values}. */
  bandNames: string[];
  /** Human-readable band descriptions, when titiler-cmr provides them. */
  bandDescriptions?: string[];
}

/** Result of {@link fetchPoint}: the queried coordinate plus per-asset values. */
export interface PointResult {
  /** Queried `[lon, lat]` echoed back by titiler-cmr. */
  coordinates: [number, number];
  /** One entry per matching granule asset. */
  assets: PointAsset[];
}

/**
 * Build a titiler-cmr `/point/{lon},{lat}` request URL.
 *
 * Path: `{endpoint}/{backend}/point/{lon},{lat}` (lon first). Reuses the same
 * CMR query params as the tile request (`collection_concept_id`, `granule_ur`,
 * `temporal`, `assets`, `assets_regex`) so a click reads exactly the
 * granule/band being displayed. Verified live against the staging endpoint.
 */
export function buildPointUrl(params: PointQueryParams): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  query.set("collection_concept_id", params.conceptId);
  if (params.granuleUr) query.set("granule_ur", params.granuleUr);
  if (params.datetime) query.set("temporal", params.datetime);
  for (const band of params.bands ?? []) query.append("assets", band);
  if (params.bandsRegex) query.set("assets_regex", params.bandsRegex);
  applyExpression(query, params.expression);
  return `${base}/${params.backend}/point/${params.lon},${params.lat}?${query.toString()}`;
}

/** Fetch a point pixel-value document from titiler-cmr. */
export async function fetchPoint(url: string): Promise<PointResult> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`titiler-cmr point request failed (${res.status})`);
  }
  const json = (await res.json()) as {
    coordinates: [number, number];
    assets?: Array<{
      name: string;
      values: (number | null)[];
      band_names: string[];
      band_descriptions?: string[] | null;
    }>;
  };
  return {
    coordinates: json.coordinates,
    assets: (json.assets ?? []).map((asset) => ({
      name: asset.name,
      values: asset.values,
      bandNames: asset.band_names,
      bandDescriptions: asset.band_descriptions ?? undefined,
    })),
  };
}

/** Parameters for a titiler-cmr `/statistics` zonal-stats query. */
export interface StatisticsQueryParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Reader backend; OPERA products use "rasterio". */
  backend: TitilerBackend;
  /** Pin the query to a single granule by its CMR GranuleUR (exact match). */
  granuleUr?: string;
  /** Temporal filter "start/end" (RFC3339) to isolate a granule or window. */
  datetime?: string;
  /** Band token(s) to summarize. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /**
   * Request a per-class histogram (`categorical=true`) instead of binned. For
   * discrete products (DSWx water classes, DIST status) this yields exact
   * pixel counts per class, the basis for class areas.
   */
  categorical?: boolean;
  /**
   * Number of histogram bins for continuous bands (`histogram_bins`). Ignored
   * when {@link categorical} is set. titiler-cmr defaults to 10; a higher value
   * gives a smoother distribution for choosing a rescale.
   */
  histogramBins?: number;
  /** rio-tiler band-math expression (bands as `b1`, `b2`, ...); see TileJsonParams. */
  expression?: string;
}

/** Per-band statistics returned by titiler-cmr `/statistics`. */
export interface BandStatistics {
  min: number;
  max: number;
  mean: number;
  std: number;
  median?: number;
  /** Coverage-weighted pixel count within the AOI. */
  count: number;
  /** Unmasked pixel count within the AOI. */
  validPixels?: number;
  /** Percentage of AOI pixels that are valid (not nodata/masked). */
  validPercent?: number;
  /**
   * `[counts, edges]`. In categorical mode `edges` are the actual class values,
   * so `counts[i]` is the pixel count for class `edges[i]`.
   */
  histogram?: [number[], number[]];
  /** 2nd-percentile value (lower bound for a suggested rescale). */
  percentile2?: number;
  /** 98th-percentile value (upper bound for a suggested rescale). */
  percentile98?: number;
  /** Band description from the source asset, when available. */
  description?: string;
}

/** Result of {@link fetchStatistics}: per-band statistics keyed by band name. */
export interface StatisticsResult {
  bands: Record<string, BandStatistics>;
}

/**
 * Build a titiler-cmr `/statistics` request URL.
 *
 * Path: `{endpoint}/{backend}/statistics` (POST a GeoJSON Feature as the AOI).
 * Reuses the same CMR query params as the tile request, plus optional
 * `categorical`. Verified live against the staging endpoint.
 */
export function buildStatisticsUrl(params: StatisticsQueryParams): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  query.set("collection_concept_id", params.conceptId);
  if (params.granuleUr) query.set("granule_ur", params.granuleUr);
  if (params.datetime) query.set("temporal", params.datetime);
  for (const band of params.bands ?? []) query.append("assets", band);
  if (params.bandsRegex) query.set("assets_regex", params.bandsRegex);
  applyExpression(query, params.expression);
  if (params.categorical) {
    query.set("categorical", "true");
  } else if (params.histogramBins) {
    query.set("histogram_bins", String(params.histogramBins));
  }
  return `${base}/${params.backend}/statistics?${query.toString()}`;
}

/** Coerce an unknown JSON value to a finite number, or NaN. */
function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** Coerce to a finite number, or undefined when absent/non-finite. */
function toOptNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * POST a GeoJSON AOI to titiler-cmr `/statistics` and parse the per-band stats.
 *
 * `feature` is a GeoJSON Feature (or FeatureCollection); titiler-cmr echoes it
 * back with `properties.statistics` keyed by band name (e.g. `b1`).
 */
export async function fetchStatistics(
  url: string,
  feature: unknown,
): Promise<StatisticsResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(feature),
  });
  if (!res.ok) {
    throw new Error(`titiler-cmr statistics request failed (${res.status})`);
  }
  const json = (await res.json()) as {
    properties?: { statistics?: Record<string, Record<string, unknown>> };
  };
  const raw = json.properties?.statistics ?? {};
  const bands: Record<string, BandStatistics> = {};
  for (const [name, s] of Object.entries(raw)) {
    bands[name] = {
      min: toNum(s.min),
      max: toNum(s.max),
      mean: toNum(s.mean),
      std: toNum(s.std),
      median: toOptNum(s.median),
      count: toNum(s.count),
      validPixels: toOptNum(s.valid_pixels),
      validPercent: toOptNum(s.valid_percent),
      histogram: Array.isArray(s.histogram)
        ? (s.histogram as [number[], number[]])
        : undefined,
      percentile2: toOptNum(s.percentile_2),
      percentile98: toOptNum(s.percentile_98),
      description:
        typeof s.description === "string" ? s.description : undefined,
    };
  }
  return { bands };
}

/** Fetch a TileJSON document from titiler-cmr. */
export async function fetchTileJson(url: string): Promise<TileJson> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`titiler-cmr tilejson request failed (${res.status})`);
  }
  const json = (await res.json()) as TileJson;
  if (!json.tiles || json.tiles.length === 0) {
    throw new Error("titiler-cmr returned no tiles for this query");
  }
  return json;
}

/**
 * Build a `datetime` filter that isolates a single granule by narrowing to its
 * temporal range (titiler-cmr mosaics every granule matching the query).
 */
export function granuleDatetime(
  begin?: string,
  end?: string,
): string | undefined {
  if (!begin && !end) return undefined;
  const start = begin ?? end!;
  const stop = end ?? begin!;
  return `${start}/${stop}`;
}

/** Normalize TileJSON bounds to a `[w, s, e, n]` tuple when present. */
export function tileJsonBounds(json: TileJson): BBox | undefined {
  if (json.bounds && json.bounds.length === 4) {
    const [w, s, e, n] = json.bounds;
    return [w, s, e, n];
  }
  return undefined;
}
