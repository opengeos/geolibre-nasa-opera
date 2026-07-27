import type { BBox } from "./types";

const DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_AOI_SPAN_DEGREES = 0.1;

interface NominatimResult {
  boundingbox?: unknown;
  category?: unknown;
  type?: unknown;
  importance?: unknown;
  display_name?: unknown;
}

export interface GeocodedPlace {
  bbox: BBox;
  displayName: string;
}

export interface GeocodePlaceOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

function normalizedQuery(place: string): {
  query: string;
  prefersRegion: boolean;
} {
  const prefersRegion = /\bregion\b/i.test(place);
  const query = place
    .replace(/\bregion\s+of\s+/gi, "")
    .replace(/\bregion\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { query: query || place.trim(), prefersRegion };
}

function parseBounds(value: unknown): BBox | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const [south, north, west, east] = value.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return undefined;
  if (west >= east || south >= north) return undefined;
  if (west < -180 || east > 180 || south < -90 || north > 90) return undefined;
  return [west, south, east, north];
}

function bboxArea(bbox: BBox): number {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

function expandSmallBounds(bbox: BBox): BBox {
  const [west, south, east, north] = bbox;
  const lonPad = Math.max(0, MIN_AOI_SPAN_DEGREES - (east - west)) / 2;
  const latPad = Math.max(0, MIN_AOI_SPAN_DEGREES - (north - south)) / 2;
  return [
    Math.max(-180, west - lonPad),
    Math.max(-85, south - latPad),
    Math.min(180, east + lonPad),
    Math.min(85, north + latPad),
  ];
}

function resultScore(
  result: NominatimResult,
  bbox: BBox,
  prefersRegion: boolean,
): number {
  const importance = Number(result.importance);
  let score = Number.isFinite(importance) ? importance : 0;
  if (result.category === "boundary" && result.type === "administrative") {
    score += 5;
  }
  if (prefersRegion) {
    const area = bboxArea(bbox);
    score += Math.log10(area + 1) * 2;
    if (area < 0.01) score -= 10;
  }
  return score;
}

/**
 * Resolve a named place to a bounded disaster-analysis AOI using public
 * Nominatim search results.
 */
export async function geocodePlaceBounds(
  place: string,
  opts: GeocodePlaceOptions = {},
): Promise<GeocodedPlace> {
  const { query, prefersRegion } = normalizedQuery(place);
  if (!query) throw new Error("Provide a place name.");

  const url = new URL(opts.endpoint ?? DEFAULT_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "8");
  const response = await (opts.fetchImpl ?? fetch)(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Place search failed (${response.status}).`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("Place search returned an invalid response.");
  }
  const candidates = payload
    .map((result) => {
      const item = result as NominatimResult;
      const bbox = parseBounds(item.boundingbox);
      return bbox
        ? { item, bbox, score: resultScore(item, bbox, prefersRegion) }
        : undefined;
    })
    .filter(
      (
        candidate,
      ): candidate is {
        item: NominatimResult;
        bbox: BBox;
        score: number;
      } => candidate !== undefined,
    )
    .sort((a, b) => b.score - a.score);
  const match = candidates[0];
  if (!match) throw new Error(`No map bounds found for "${place}".`);

  return {
    bbox: expandSmallBounds(match.bbox),
    displayName:
      typeof match.item.display_name === "string"
        ? match.item.display_name
        : place,
  };
}
