import unkinkPolygon from "@turf/unkink-polygon";
import type { Feature, Polygon, Position } from "geojson";
import type { GeoFeatureCollection } from "./geometry";
import type { BBox } from "./types";

export const WORLDPOP_STATS_ENDPOINT = "https://api.worldpop.org/v2/population";
export const WORLDPOP_IMAGE_ENDPOINT =
  "https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Total_Population_100m/ImageServer/exportImage";
export const WORLDPOP_DATASET = "worldpop-global2";
export const WORLDPOP_LATEST_YEAR = 2020;

export interface WorldPopPopulationResult {
  totalPopulation: number;
  year: number;
  dataset: string;
  source: string;
}

export interface WorldPopPopulationOptions {
  year?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Maximum duration of each WorldPop HTTP request. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type WorldPopResponse = {
  status?: string;
  task_id?: string;
  taskid?: string;
  check_url?: string;
  error?: unknown;
  message?: string;
  data?: unknown;
  result?: unknown;
  total_population?: unknown;
};

const UNIQUE_VERTEX_OFFSET_DEGREES = 1e-8;

function uniquePolygonVertices(
  coordinates: Polygon["coordinates"],
): Polygon["coordinates"] {
  const seen = new Set<string>();
  return coordinates.map((ring) => {
    const vertices = ring.slice(0, -1);
    const unique = vertices.map(([x, y], index) => {
      let candidate: [number, number] = [x, y];
      let candidateKey = `${candidate[0]},${candidate[1]}`;
      if (seen.has(candidateKey)) {
        const previous =
          vertices[(index - 1 + vertices.length) % vertices.length];
        const next = vertices[(index + 1) % vertices.length];
        const targetX = (previous[0] + next[0]) / 2;
        const targetY = (previous[1] + next[1]) / 2;
        const dx = targetX - x;
        const dy = targetY - y;
        const length = Math.hypot(dx, dy);
        const unitX = length > 0 ? dx / length : 1;
        const unitY = length > 0 ? dy / length : 1;
        let offset = UNIQUE_VERTEX_OFFSET_DEGREES;
        do {
          candidate = [x + unitX * offset, y + unitY * offset];
          candidateKey = `${candidate[0]},${candidate[1]}`;
          offset += UNIQUE_VERTEX_OFFSET_DEGREES;
        } while (seen.has(candidateKey));
      }
      seen.add(candidateKey);
      return candidate;
    });
    return [...unique, [...unique[0]]];
  });
}

function pointInRing(
  point: Position,
  ring: Polygon["coordinates"][number],
): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 2; index < ring.length - 1; ) {
    const [x, y] = ring[index];
    const [previousX, priorY] = ring[previous];
    if (
      y > point[1] !== priorY > point[1] &&
      point[0] < ((previousX - x) * (point[1] - y)) / (priorY - y) + x
    ) {
      inside = !inside;
    }
    previous = index;
    index += 1;
  }
  return inside;
}

function repairRing(
  ring: Polygon["coordinates"][number],
): Polygon["coordinates"][number][] {
  const feature: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
  return unkinkPolygon(feature).features.map(
    (repaired) => repaired.geometry.coordinates[0],
  );
}

function ringArea(ring: Polygon["coordinates"][number]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area +=
      ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return Math.abs(area / 2);
}

function assembleRingHierarchy(
  rings: Polygon["coordinates"][number][],
): Polygon["coordinates"][] {
  const items = rings
    .map((ring) => ({ ring, area: ringArea(ring), parent: -1, depth: 0 }))
    .sort((left, right) => right.area - left.area);
  for (let index = 0; index < items.length; index += 1) {
    let parentArea = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < index; candidate += 1) {
      if (
        items[candidate].area < parentArea &&
        items[index].ring
          .slice(0, -1)
          .some((point) => pointInRing(point, items[candidate].ring))
      ) {
        items[index].parent = candidate;
        parentArea = items[candidate].area;
      }
    }
    if (items[index].parent >= 0) {
      items[index].depth = items[items[index].parent].depth + 1;
    }
  }

  const polygons: Polygon["coordinates"][] = [];
  const shellByItem = new Map<number, Polygon["coordinates"]>();
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].depth % 2 === 0) {
      const polygon = [items[index].ring];
      polygons.push(polygon);
      shellByItem.set(index, polygon);
      continue;
    }
    const shell = shellByItem.get(items[index].parent);
    if (shell) shell.push(items[index].ring);
  }
  return polygons;
}

function repairPolygon(
  coordinates: Polygon["coordinates"],
): Polygon["coordinates"][] {
  const unique = uniquePolygonVertices(coordinates);
  return assembleRingHierarchy(unique.flatMap((ring) => repairRing(ring)));
}

function removeNestedShells(
  polygons: Polygon["coordinates"][],
): Polygon["coordinates"][] {
  const unique = new Map<string, Polygon["coordinates"]>();
  for (const polygon of polygons) {
    unique.set(JSON.stringify(polygon[0]), polygon);
  }
  const sorted = [...unique.values()].sort(
    (left, right) => ringArea(right[0]) - ringArea(left[0]),
  );
  const kept: Polygon["coordinates"][] = [];
  for (const polygon of sorted) {
    const container = kept.find((candidate) =>
      polygon[0]
        .slice(0, -1)
        .every((point) => pointInRing(point, candidate[0])),
    );
    const insideContainerHole = container
      ?.slice(1)
      .some((hole) =>
        polygon[0].slice(0, -1).every((point) => pointInRing(point, hole)),
      );
    if (!container || insideContainerHole) kept.push(polygon);
  }
  return kept;
}

function numericTotal(value: unknown): number | null {
  if (Array.isArray(value)) {
    const totals = value
      .map((entry) => numericTotal(entry))
      .filter((entry): entry is number => entry !== null);
    return totals.length > 0
      ? totals.reduce((sum, entry) => sum + entry, 0)
      : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = Number(record.total_population);
  if (Number.isFinite(direct)) return direct;
  for (const key of ["data", "result", "summary", "statistics"]) {
    const nested = numericTotal(record[key]);
    if (nested !== null) return nested;
  }
  return null;
}

function responseError(response: WorldPopResponse): string | null {
  const status = response.status?.toLowerCase();
  if (status === "failed" || status === "failure" || status === "error") {
    return typeof response.error === "string"
      ? response.error
      : (response.message ?? "WorldPop task failed.");
  }
  return null;
}

function worldPopGeometry(water: GeoFeatureCollection): {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
} {
  const polygons: Polygon["coordinates"][] = [];
  const addPolygon = (coordinates: Polygon["coordinates"]) => {
    polygons.push(...repairPolygon(coordinates));
  };

  for (const feature of water.features) {
    if (!feature.geometry || typeof feature.geometry !== "object") continue;
    const geometry = feature.geometry as {
      type?: unknown;
      coordinates?: unknown;
    };
    if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
      addPolygon(geometry.coordinates as Polygon["coordinates"]);
    } else if (
      geometry.type === "MultiPolygon" &&
      Array.isArray(geometry.coordinates)
    ) {
      for (const coordinates of geometry.coordinates) {
        addPolygon(coordinates);
      }
    }
  }
  if (polygons.length === 0) {
    throw new Error(
      "WorldPop requires a Polygon or MultiPolygon flood extent.",
    );
  }
  const unnested = removeNestedShells(polygons);
  return unnested.length === 1
    ? { type: "Polygon", coordinates: unnested[0] }
    : { type: "MultiPolygon", coordinates: unnested };
}

async function readResponse(response: Response): Promise<WorldPopResponse> {
  if (!response.ok) {
    throw new Error(
      `WorldPop request failed (${response.status} ${response.statusText}).`,
    );
  }
  const body = (await response.json()) as WorldPopResponse;
  const error = responseError(body);
  if (error) throw new Error(error);
  return body;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(
        new Error(
          `WorldPop request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
        ),
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sum WorldPop population within a flood polygon using the public WorldPop API.
 */
export async function fetchWorldPopPopulation(
  water: GeoFeatureCollection,
  options: WorldPopPopulationOptions = {},
): Promise<WorldPopPopulationResult> {
  const year = options.year ?? WORLDPOP_LATEST_YEAR;
  if (!Number.isInteger(year) || year < 2015 || year > WORLDPOP_LATEST_YEAR) {
    throw new Error(
      `WorldPop year must be an integer from 2015 through ${WORLDPOP_LATEST_YEAR}.`,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? WORLDPOP_STATS_ENDPOINT;
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
  const geometry = worldPopGeometry(water);
  let payload = await readResponse(
    await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geojson: geometry,
          year,
          resolution: "100m",
        }),
      },
      requestTimeoutMs,
    ),
  );
  let total = numericTotal(payload);
  const taskId = payload.task_id ?? payload.taskid;
  if (total === null && taskId) {
    const maxPolls = options.maxPolls ?? 60;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const endpointUrl = new URL(endpoint);
    const taskUrl = new URL(
      `${endpointUrl.pathname.replace(/\/population\/?$/, "")}/tasks/${encodeURIComponent(taskId)}`,
      endpointUrl.origin,
    ).toString();
    for (let poll = 0; poll < maxPolls && total === null; poll += 1) {
      await sleep(pollIntervalMs);
      payload = await readResponse(
        await fetchWithTimeout(fetchImpl, taskUrl, undefined, requestTimeoutMs),
      );
      total = numericTotal(payload);
    }
  }
  if (total === null) {
    throw new Error("WorldPop did not return a population total.");
  }
  return {
    totalPopulation: total,
    year,
    dataset: WORLDPOP_DATASET,
    source: "WorldPop Global 2 Population Data",
  };
}

/**
 * Build a styled WorldPop 100 m population image URL for a map image source.
 */
export function worldPopImageUrl(
  bbox: BBox,
  year = WORLDPOP_LATEST_YEAR,
  size = 1200,
): string {
  const renderRule = {
    rasterFunction: "Colormap",
    rasterFunctionArguments: {
      Colormap: [
        [1, 255, 255, 204],
        [2, 255, 237, 160],
        [3, 254, 217, 118],
        [4, 254, 178, 76],
        [5, 253, 141, 60],
        [6, 252, 78, 42],
        [7, 227, 26, 28],
        [8, 177, 0, 38],
      ],
      Raster: {
        rasterFunction: "Remap",
        rasterFunctionArguments: {
          InputRanges: [
            1, 5, 5, 25, 25, 100, 100, 250, 250, 1000, 1000, 2500, 2500, 10000,
            10000, 100000000,
          ],
          OutputValues: [1, 2, 3, 4, 5, 6, 7, 8],
          Raster: "$$",
        },
        outputPixelType: "U8",
      },
    },
  };
  const url = new URL(WORLDPOP_IMAGE_ENDPOINT);
  url.search = new URLSearchParams({
    bbox: bbox.join(","),
    bboxSR: "4326",
    imageSR: "4326",
    size: `${size},${size}`,
    format: "png32",
    transparent: "true",
    f: "image",
    time: String(Date.UTC(year, 0, 1)),
    renderingRule: JSON.stringify(renderRule),
  }).toString();
  return url.toString();
}
