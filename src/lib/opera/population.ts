import type { GeoFeatureCollection } from "./geometry";
import type { BBox } from "./types";

export const WORLDPOP_STATS_ENDPOINT =
  "https://api.worldpop.org/v1/services/stats";
export const WORLDPOP_IMAGE_ENDPOINT =
  "https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Total_Population_100m/ImageServer/exportImage";
export const WORLDPOP_DATASET = "wpgppop";
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
  taskid?: string;
  error?: string;
  message?: string;
  data?: unknown;
  total_population?: unknown;
};

function numericTotal(value: unknown): number | null {
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
  if (status === "failed" || status === "error") {
    return response.error ?? response.message ?? "WorldPop task failed.";
  }
  return null;
}

async function readResponse(response: Response): Promise<WorldPopResponse> {
  if (!response.ok) {
    throw new Error(
      `WorldPop request failed (${response.status} ${response.statusText}).`,
    );
  }
  const text = await response.text();
  let body: WorldPopResponse;
  try {
    body = JSON.parse(text) as WorldPopResponse;
  } catch {
    // The public WorldPop service occasionally appends PHP warning markup to
    // an otherwise valid JSON response. Preserve the valid API payload instead
    // of failing the complete exposure workflow on server-side diagnostics.
    const start = text.indexOf("{");
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index >= 0 && index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (start < 0 || end < 0)
      throw new Error("WorldPop returned invalid JSON.");
    body = JSON.parse(text.slice(start, end)) as WorldPopResponse;
  }
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
  if (!Number.isInteger(year) || year < 2000 || year > WORLDPOP_LATEST_YEAR) {
    throw new Error(
      `WorldPop year must be an integer from 2000 through ${WORLDPOP_LATEST_YEAR}.`,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? WORLDPOP_STATS_ENDPOINT;
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
  const form = new URLSearchParams({
    dataset: WORLDPOP_DATASET,
    year: String(year),
    runasync: "false",
    geojson: JSON.stringify(water),
  });
  let payload = await readResponse(
    await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      },
      requestTimeoutMs,
    ),
  );
  let total = numericTotal(payload);
  const taskId = payload.taskid;
  if (total === null && taskId) {
    const maxPolls = options.maxPolls ?? 30;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const taskUrl = new URL(
      `../tasks/${encodeURIComponent(taskId)}`,
      endpoint,
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
    source: "WorldPop Global Project Population Data",
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
