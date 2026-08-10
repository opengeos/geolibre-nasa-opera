import type { BBox } from "./types";
import type { GeoFeature, GeoFeatureCollection } from "./geometry";

const PORTAL = "https://gis.earthdata.nasa.gov/portal";
const SHARING = `${PORTAL}/sharing/rest`;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type DisasterSourceRole =
  | "hazard"
  | "change"
  | "context"
  | "exposure"
  | "confirmed-impact";

export interface AuthoritativeDisasterSource {
  id: string;
  name: string;
  authority: string;
  role: DisasterSourceRole;
  description: string;
}

export interface NasaDisasterItem {
  id: string;
  title: string;
  type: string;
  url?: string;
  portalUrl: string;
  tags: string[];
  extent?: BBox;
}

export interface NasaDisasterEvent {
  groupId: string;
  title: string;
  portalUrl: string;
  items: NasaDisasterItem[];
}

export interface ArcGisOperationalLayer {
  title: string;
  url: string;
  layerType: string;
  visible: boolean;
}

interface ArcGisSearchResponse<T> {
  results?: T[];
}

interface ArcGisGroup {
  id?: string;
  title?: string;
}

interface ArcGisItem {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  tags?: unknown[];
  extent?: unknown;
}

interface ArcGisLayerNode {
  title?: string;
  url?: string;
  layerType?: string;
  visibility?: boolean;
  layers?: ArcGisLayerNode[];
}

const COMMON_SOURCES: AuthoritativeDisasterSource[] = [
  {
    id: "nasa-disasters",
    name: "NASA Disasters Mapping Portal",
    authority: "NASA Earth Science",
    role: "hazard",
    description:
      "Event-specific, curated Earth-observation products and hazard layers.",
  },
  {
    id: "sentinel-2",
    name: "Copernicus Sentinel-2",
    authority: "European Union Copernicus Programme",
    role: "context",
    description:
      "Pre-event and post-event optical context selected by date and cloud cover.",
  },
  {
    id: "overture",
    name: "Overture Maps buildings and transportation",
    authority: "Overture Maps Foundation",
    role: "exposure",
    description:
      "Building and road exposure intersected with an observed hazard extent.",
  },
  {
    id: "worldpop",
    name: "WorldPop modeled population",
    authority: "WorldPop, University of Southampton",
    role: "exposure",
    description:
      "Modeled residential population intersected with an observed hazard extent.",
  },
  {
    id: "official-news",
    name: "Official situation reports and attributable news",
    authority: "Government agencies and named news publishers",
    role: "confirmed-impact",
    description:
      "Confirmed impacts, always kept separate from satellite-observed hazard and modeled exposure.",
  },
];

const HAZARD_SOURCES: Record<string, AuthoritativeDisasterSource[]> = {
  flood: [
    {
      id: "opera-dswx",
      name: "OPERA DSWx",
      authority: "NASA OPERA",
      role: "hazard",
      description: "Satellite-observed surface water for the event period.",
    },
  ],
  wildfire: [
    {
      id: "nasa-feds",
      name: "Fire Events Data Suite fire perimeters",
      authority: "NASA Earth Information System",
      role: "hazard",
      description:
        "Time-enabled satellite-derived fire perimeter progression and latest perimeter.",
    },
    {
      id: "burn-severity",
      name: "NBR, dNBR, and slope exceedance products",
      authority: "NASA Disasters Program",
      role: "change",
      description: "Event-specific burn and post-fire hazard indicators.",
    },
    {
      id: "opera-dist",
      name: "OPERA DIST-ALERT-HLS",
      authority: "NASA OPERA",
      role: "change",
      description:
        "Vegetation disturbance alerts for corroborating fire-related change.",
    },
  ],
  earthquake: [
    {
      id: "usgs-earthquake",
      name: "USGS earthquake and ShakeMap products",
      authority: "U.S. Geological Survey",
      role: "hazard",
      description:
        "Authoritative event geometry, shaking intensity, and ground-failure products.",
    },
    {
      id: "opera-displacement",
      name: "OPERA displacement products",
      authority: "NASA OPERA",
      role: "change",
      description: "Satellite-observed surface displacement when available.",
    },
  ],
  storm: [
    {
      id: "noaa-nhc",
      name: "NOAA/NHC storm products",
      authority: "NOAA National Hurricane Center",
      role: "hazard",
      description:
        "Official track, cone, wind, and storm-surge products where applicable.",
    },
    {
      id: "opera-dswx",
      name: "OPERA DSWx",
      authority: "NASA OPERA",
      role: "change",
      description:
        "Satellite-observed surface water associated with the storm.",
    },
  ],
  landslide: [
    {
      id: "nasa-lhasa",
      name: "NASA landslide products",
      authority: "NASA Goddard Space Flight Center",
      role: "hazard",
      description:
        "NASA landslide nowcasts or event-specific slope-change products when available.",
    },
  ],
  volcano: [
    {
      id: "usgs-volcano",
      name: "USGS volcano observatory products",
      authority: "U.S. Geological Survey",
      role: "hazard",
      description: "Official volcano alerts and mapped hazard observations.",
    },
  ],
};

/** Normalize common user terms to one deterministic hazard policy key. */
export function normalizeDisasterHazard(hazard: string): string {
  const value = hazard.trim().toLowerCase();
  if (/fire|wildfire|bushfire/.test(value)) return "wildfire";
  if (/flood|inundation/.test(value)) return "flood";
  if (/hurricane|typhoon|cyclone|storm/.test(value)) return "storm";
  if (/earthquake|seismic/.test(value)) return "earthquake";
  if (/landslide|mudslide|debris flow/.test(value)) return "landslide";
  if (/volcan|eruption/.test(value)) return "volcano";
  return value || "disaster";
}

/** Return the ordered default sources for a disaster type. */
export function defaultAuthoritativeSources(
  hazard: string,
): AuthoritativeDisasterSource[] {
  const normalized = normalizeDisasterHazard(hazard);
  const hazardSources = Object.prototype.hasOwnProperty.call(
    HAZARD_SOURCES,
    normalized,
  )
    ? HAZARD_SOURCES[normalized]
    : [];
  return [...hazardSources, ...COMMON_SOURCES];
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(
        new Error(
          `NASA disaster request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
        ),
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function groupMatchesEvent(
  group: ArcGisGroup,
  params: { hazard: string; place: string; start: string; end: string },
): boolean {
  if (!group.id || !group.title) return false;
  const title = group.title.toLowerCase();
  const placeTokens = params.place
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const placeMatches = placeTokens.some((token) => title.includes(token));
  const normalized = normalizeDisasterHazard(params.hazard);
  const hazardPattern =
    normalized === "wildfire"
      ? /\b(?:fire|fires|wildfire|wildfires|burn)\b/
      : normalized === "earthquake"
        ? /\b(?:earthquake|quake|seismic)\b/
        : normalized === "storm"
          ? /\b(?:storm|hurricane|typhoon|cyclone)\b/
          : normalized === "landslide"
            ? /\b(?:landslide|mudslide|debris flow)\b/
            : normalized === "volcano"
              ? /\b(?:volcano|volcanic|eruption)\b/
              : new RegExp(`\\b${escapeRegExp(normalized)}\\b`);
  const yearsInTitle = title.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const requestedYears = new Set([
    params.start.slice(0, 4),
    params.end.slice(0, 4),
  ]);
  const yearMatches =
    yearsInTitle.length === 0 ||
    yearsInTitle.some((year) => requestedYears.has(year));
  return placeMatches && hazardPattern.test(title) && yearMatches;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function eventSearchQueries(
  hazard: string,
  place: string,
  start: string,
  end: string,
): string[] {
  const normalized = normalizeDisasterHazard(hazard);
  const hazardTerm = normalized === "wildfire" ? "fires" : normalized;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  const startMonth = startDate.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const endMonth = endDate.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const years = [
    ...new Set([endDate.getUTCFullYear(), startDate.getUTCFullYear()]),
  ];
  return [
    `${place} ${hazardTerm} ${endMonth} ${endDate.getUTCFullYear()}`,
    ...(startMonth === endMonth
      ? []
      : [`${place} ${hazardTerm} ${startMonth} ${startDate.getUTCFullYear()}`]),
    ...years.map((year) => `${place} ${hazardTerm} ${year}`),
    `${place} ${hazardTerm}`,
  ];
}

/** Discover the best matching curated NASA Disasters event group and its items. */
export async function discoverNasaDisasterEvent(
  params: { hazard: string; place: string; start: string; end: string },
  fetcher: typeof fetch = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<NasaDisasterEvent | null> {
  let group: ArcGisGroup | undefined;
  let lastError: unknown;
  let completedSearch = false;
  for (const query of eventSearchQueries(
    params.hazard,
    params.place,
    params.start,
    params.end,
  )) {
    try {
      const groupsUrl = `${SHARING}/community/groups?f=json&num=20&q=${encodeURIComponent(query)}`;
      const groupsResponse = await fetchWithTimeout(
        fetcher,
        groupsUrl,
        requestTimeoutMs,
      );
      if (!groupsResponse.ok) {
        throw new Error(`NASA event search failed (${groupsResponse.status}).`);
      }
      completedSearch = true;
      const groups =
        (await groupsResponse.json()) as ArcGisSearchResponse<ArcGisGroup>;
      group = groups.results?.find((candidate) =>
        groupMatchesEvent(candidate, params),
      );
      if (group) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!group && !completedSearch && lastError) throw lastError;
  if (!group?.id || !group.title) return null;

  const itemsUrl = `${SHARING}/content/groups/${encodeURIComponent(group.id)}/search?f=json&num=100&sortField=added&sortOrder=desc`;
  const itemsResponse = await fetchWithTimeout(
    fetcher,
    itemsUrl,
    requestTimeoutMs,
  );
  if (!itemsResponse.ok)
    throw new Error(`NASA event catalog failed (${itemsResponse.status}).`);
  const payload =
    (await itemsResponse.json()) as ArcGisSearchResponse<ArcGisItem>;
  const items = (payload.results ?? [])
    .filter(
      (
        item,
      ): item is ArcGisItem & { id: string; title: string; type: string } =>
        Boolean(item.id && item.title && item.type),
    )
    .map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      url: item.url || undefined,
      portalUrl: `${PORTAL}/home/item.html?id=${encodeURIComponent(item.id)}`,
      tags: (item.tags ?? []).filter(
        (tag): tag is string => typeof tag === "string" && tag.length > 0,
      ),
      extent: parseArcGisExtent(item.extent),
    }));
  return {
    groupId: group.id,
    title: group.title,
    portalUrl: `${PORTAL}/home/group.html?id=${encodeURIComponent(group.id)}#content`,
    items,
  };
}

function parseArcGisExtent(value: unknown): BBox | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lower = value[0];
  const upper = value[1];
  if (!Array.isArray(lower) || !Array.isArray(upper)) return undefined;
  const bbox = [
    Number(lower[0]),
    Number(lower[1]),
    Number(upper[0]),
    Number(upper[1]),
  ] as BBox;
  return bbox.every(Number.isFinite) ? bbox : undefined;
}

/** Rank event catalog items for the normalized hazard policy. */
export function rankNasaDisasterItems(
  hazard: string,
  items: NasaDisasterItem[],
): NasaDisasterItem[] {
  const normalized = normalizeDisasterHazard(hazard);
  const terms =
    normalized === "wildfire"
      ? [
          "fire events data suite",
          "dnbr",
          "burn",
          "nbr",
          "dist-alert",
          "disturbance",
          "true color",
        ]
      : normalized === "flood"
        ? ["dswx", "surface water", "flood", "true color"]
        : [normalized, "hazard", "damage", "true color"];
  const score = (item: NasaDisasterItem): number => {
    const text = `${item.title} ${item.tags.join(" ")}`.toLowerCase();
    const firstMatch = terms.findIndex((term) => text.includes(term));
    const termScore = firstMatch < 0 ? 0 : 100 - firstMatch * 8;
    return termScore + (item.type === "Web Map" ? 20 : 0);
  };
  return [...items]
    .filter((item) => {
      const text = `${item.title} ${item.tags.join(" ")}`.toLowerCase();
      return terms.some((term) => text.includes(term));
    })
    .sort((a, b) => score(b) - score(a));
}

/** Fetch and flatten visible operational layers from an ArcGIS Web Map item. */
export async function fetchVisibleWebMapLayers(
  itemId: string,
  fetcher: typeof fetch = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ArcGisOperationalLayer[]> {
  const response = await fetchWithTimeout(
    fetcher,
    `${SHARING}/content/items/${encodeURIComponent(itemId)}/data?f=json`,
    requestTimeoutMs,
  );
  if (!response.ok)
    throw new Error(`NASA Web Map ${itemId} failed (${response.status}).`);
  const data = (await response.json()) as {
    operationalLayers?: ArcGisLayerNode[];
  };
  const flattened: ArcGisOperationalLayer[] = [];
  const visit = (nodes: ArcGisLayerNode[], parentVisible: boolean): void => {
    for (const node of nodes) {
      const visible = parentVisible && node.visibility !== false;
      if (node.layers?.length) visit(node.layers, visible);
      if (visible && node.url && node.layerType) {
        flattened.push({
          title: node.title?.trim() || "NASA disaster layer",
          url: node.url,
          layerType: node.layerType,
          visible,
        });
      }
    }
  };
  visit(data.operationalLayers ?? [], true);
  return flattened;
}

/** Query a time-enabled ArcGIS feature/map layer as bounded GeoJSON. */
export async function queryArcGisGeoJson(
  serviceUrl: string,
  bbox: BBox,
  start: string,
  end: string,
  fetcher: typeof fetch = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<GeoFeatureCollection> {
  const layerUrl = /\/(Feature|Map)Server\/\d+$/i.test(serviceUrl)
    ? serviceUrl
    : `${serviceUrl.replace(/\/$/, "")}/0`;
  const params = new URLSearchParams({
    f: "geojson",
    where: "1=1",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    time: `${Date.parse(`${start}T00:00:00Z`)},${Date.parse(`${end}T23:59:59Z`)}`,
  });
  const response = await fetchWithTimeout(
    fetcher,
    `${layerUrl}/query?${params.toString()}`,
    requestTimeoutMs,
  );
  if (!response.ok)
    throw new Error(`ArcGIS hazard query failed (${response.status}).`);
  const data = (await response.json()) as GeoFeatureCollection & {
    error?: { message?: string };
    exceededTransferLimit?: boolean;
  };
  if (data.error)
    throw new Error(data.error.message || "ArcGIS hazard query failed.");
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("ArcGIS hazard query did not return GeoJSON.");
  }
  if (data.exceededTransferLimit) {
    throw new Error(
      "ArcGIS hazard query was truncated; narrow the AOI or use a paginated service query.",
    );
  }
  return data;
}

function fedsObservationTime(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return Date.parse(value);
}

/** Keep the most recent observation for each FEDS fire id. */
export function latestFedsPerimeters(
  data: GeoFeatureCollection,
): GeoFeatureCollection {
  const latest = new Map<string, GeoFeature>();
  for (const feature of data.features) {
    const properties = feature.properties ?? {};
    const id = String(properties.fireid ?? properties.primarykey ?? "unknown");
    const time = fedsObservationTime(properties.t);
    const previous = latest.get(id);
    const previousTime = fedsObservationTime(previous?.properties?.t);
    if (
      !previous ||
      (Number.isFinite(time) &&
        (!Number.isFinite(previousTime) || time >= previousTime))
    ) {
      latest.set(id, feature);
    }
  }
  return { type: "FeatureCollection", features: [...latest.values()] };
}

/** Build a MapLibre raster tile template for an ArcGIS map or image service. */
export function arcGisExportTileUrl(serviceUrl: string): string {
  const base = serviceUrl.replace(/\/$/, "");
  const endpoint = /ImageServer$/i.test(base) ? "exportImage" : "export";
  return `${base}/${endpoint}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`;
}
