import type { TileJson } from "./titiler";
import type { BBox } from "./types";

export const PLANETARY_COMPUTER_STAC_SEARCH =
  "https://planetarycomputer.microsoft.com/api/stac/v1/search";
export const PLANETARY_COMPUTER_DATA_API =
  "https://planetarycomputer.microsoft.com/api/data/v1";
export const SENTINEL_2_COLLECTION = "sentinel-2-l2a";

interface StacAsset {
  href?: unknown;
}

interface StacItem {
  id?: unknown;
  collection?: unknown;
  bbox?: unknown;
  properties?: {
    datetime?: unknown;
    "eo:cloud_cover"?: unknown;
  };
  assets?: Record<string, StacAsset>;
}

interface StacSearchResponse {
  features?: unknown;
}

export interface Sentinel2SceneSearch {
  bbox: BBox;
  start: string;
  end: string;
  maxCloudCover?: number;
  limit?: number;
}

export interface Sentinel2SceneResult {
  itemId: string;
  datetime: string;
  cloudCover?: number;
  bbox: BBox;
  tilejson: TileJson;
  stacItemUrl: string;
  provider: string;
}

export interface Sentinel2SceneOptions {
  fetchImpl?: typeof fetch;
  searchEndpoint?: string;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function itemBBox(value: unknown): BBox | null {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    !value.slice(0, 4).every((entry) => typeof entry === "number")
  ) {
    return null;
  }
  return [value[0], value[1], value[2], value[3]];
}

function itemCloudCover(item: StacItem): number | undefined {
  const cloudCover = Number(item.properties?.["eo:cloud_cover"]);
  return Number.isFinite(cloudCover) ? cloudCover : undefined;
}

function itemDatetime(item: StacItem): string {
  return typeof item.properties?.datetime === "string"
    ? item.properties.datetime
    : "";
}

function tileJsonUrl(item: StacItem, itemId: string): string {
  const assetUrl = item.assets?.tilejson?.href;
  if (typeof assetUrl === "string" && assetUrl.startsWith("https://")) {
    return assetUrl;
  }
  const url = new URL(`${PLANETARY_COMPUTER_DATA_API}/item/tilejson.json`);
  url.search = new URLSearchParams({
    collection: SENTINEL_2_COLLECTION,
    item: itemId,
    assets: "visual",
    asset_bidx: "visual|1,2,3",
    nodata: "0",
    format: "png",
  }).toString();
  return url.toString();
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Planetary Computer request failed (${response.status} ${response.statusText}).`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Find the least-cloudy Sentinel-2 L2A scene for an event window and retrieve
 * its public Planetary Computer true-color TileJSON.
 */
export async function fetchSentinel2Scene(
  search: Sentinel2SceneSearch,
  options: Sentinel2SceneOptions = {},
): Promise<Sentinel2SceneResult> {
  if (!validDate(search.start) || !validDate(search.end)) {
    throw new Error("Sentinel-2 start and end must use YYYY-MM-DD.");
  }
  if (search.start > search.end) {
    throw new Error("Sentinel-2 start date must not be after the end date.");
  }
  const maxCloudCover = Math.max(0, Math.min(100, search.maxCloudCover ?? 30));
  const limit = Math.max(1, Math.min(100, Math.floor(search.limit ?? 30)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const searchEndpoint =
    options.searchEndpoint ?? PLANETARY_COMPUTER_STAC_SEARCH;
  const response = await fetchJson<StacSearchResponse>(
    fetchImpl,
    searchEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collections: [SENTINEL_2_COLLECTION],
        bbox: search.bbox,
        datetime: `${search.start}T00:00:00Z/${search.end}T23:59:59Z`,
        limit,
        query: {
          "eo:cloud_cover": { lte: maxCloudCover },
        },
      }),
    },
  );
  const items = Array.isArray(response.features)
    ? (response.features as StacItem[])
    : [];
  const candidates = items
    .filter(
      (item) =>
        typeof item.id === "string" &&
        itemBBox(item.bbox) !== null &&
        itemDatetime(item),
    )
    .sort((first, second) => {
      const cloudDifference =
        (itemCloudCover(first) ?? 101) - (itemCloudCover(second) ?? 101);
      if (cloudDifference !== 0) return cloudDifference;
      return itemDatetime(second).localeCompare(itemDatetime(first));
    });
  const item = candidates[0];
  if (!item || typeof item.id !== "string") {
    throw new Error(
      `No Sentinel-2 L2A scene with at most ${maxCloudCover}% cloud cover was found in the event window.`,
    );
  }
  const bbox = itemBBox(item.bbox);
  if (!bbox) throw new Error("Sentinel-2 scene did not include valid bounds.");
  const tilejson = await fetchJson<TileJson>(
    fetchImpl,
    tileJsonUrl(item, item.id),
  );
  if (!Array.isArray(tilejson.tiles) || tilejson.tiles.length === 0) {
    throw new Error("Planetary Computer returned no Sentinel-2 map tiles.");
  }
  return {
    itemId: item.id,
    datetime: itemDatetime(item),
    cloudCover: itemCloudCover(item),
    bbox,
    tilejson,
    stacItemUrl:
      `https://planetarycomputer.microsoft.com/api/stac/v1/collections/` +
      `${SENTINEL_2_COLLECTION}/items/${encodeURIComponent(item.id)}`,
    provider: "Microsoft Planetary Computer / Copernicus Sentinel-2",
  };
}
