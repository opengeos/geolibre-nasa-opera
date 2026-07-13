/**
 * Derive an approximate flood-water extent polygon from OPERA DSWx tiles.
 *
 * The constrained one-pager workflow normally uses a human-QAed benchmark as the
 * authoritative flood extent. For the "just give space + time" flow there is no
 * benchmark, so this module vectorizes the OPERA DSWx **observed** open + partial
 * surface water into a polygon the rest of the pipeline (building exposure,
 * one-pager map) can use. The result is explicitly OPERA-derived, not QAed.
 *
 * Method (no dependencies): fetch the DSWx **water-only** raster tiles that cover
 * the AOI (open/partial water opaque, everything else transparent), stitch them
 * into one RGBA image, threshold to a binary water mask, trace the mask boundary
 * into rings with a marching-squares-style edge walk, project the ring node
 * coordinates from Web Mercator pixels back to lon/lat, and simplify.
 */

import type {
  GeoFeature,
  GeoFeatureCollection,
  Position,
} from "./geometry";
import type { BBox } from "./types";

const TILE = 256;

// ---------------------------------------------------------------------------
// Web Mercator helpers (XYZ / WebMercatorQuad).
// ---------------------------------------------------------------------------

/** Global pixel coordinate (at `zoom`) for a lon/lat. */
function lonLatToPixel(lon: number, lat: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y =
    (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** Inverse of {@link lonLatToPixel}. */
function pixelToLonLat(px: number, py: number, zoom: number): Position {
  const scale = TILE * 2 ** zoom;
  const lon = (px / scale) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (py / scale);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

/**
 * Pick the largest zoom whose tile coverage of `bbox` stays within
 * `maxTilesAcross` tiles on the longer side, so the stitched image is bounded.
 */
export function chooseZoom(bbox: BBox, maxTilesAcross = 6): number {
  const [w, s, e, n] = bbox;
  for (let z = 16; z >= 0; z--) {
    const [x0] = lonLatToPixel(w, n, z);
    const [x1] = lonLatToPixel(e, s, z);
    const [, y0] = lonLatToPixel(w, n, z);
    const [, y1] = lonLatToPixel(e, s, z);
    const across = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / TILE;
    if (across <= maxTilesAcross) return z;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Pure mask → rings vectorizer (marching-squares edge tracing).
// ---------------------------------------------------------------------------

/** A ring in mask-node coordinates (integer grid nodes). */
export type NodeRing = Array<[number, number]>;

type Edge = { sx: number; sy: number; ex: number; ey: number };

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Trace the boundary of the truthy cells of a `width`×`height` binary mask into
 * closed rings expressed in node coordinates (0..width, 0..height). Outer
 * boundaries and holes both come back as rings; winding is normalized later.
 *
 * `mask[y * width + x]` is truthy where the cell is water.
 */
export function traceMaskRings(
  mask: ArrayLike<number | boolean>,
  width: number,
  height: number,
): NodeRing[] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && Boolean(mask[y * width + x]);

  // Emit boundary edges so that following them keeps the water cell on a
  // consistent side; an isolated cell yields one clockwise loop (y-down).
  const edgesByStart = new Map<string, Edge[]>();
  const addEdge = (sx: number, sy: number, ex: number, ey: number): void => {
    const list = edgesByStart.get(key(sx, sy));
    const edge = { sx, sy, ex, ey };
    if (list) list.push(edge);
    else edgesByStart.set(key(sx, sy), [edge]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y); // top → right
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // right → down
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1); // bottom → left
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y); // left → up
    }
  }

  const used = new Set<Edge>();
  const rings: NodeRing[] = [];

  // Clockwise ordering of unit directions in y-down space, used to disambiguate
  // shared nodes (diagonal pinch points) by taking the tightest right turn.
  const cwIndex = (dx: number, dy: number): number => {
    if (dx === 1 && dy === 0) return 0; // right
    if (dx === 0 && dy === 1) return 1; // down
    if (dx === -1 && dy === 0) return 2; // left
    return 3; // up
  };

  for (const [, list] of edgesByStart) {
    for (const start of list) {
      if (used.has(start)) continue;
      const ring: NodeRing = [[start.sx, start.sy]];
      let edge = start;
      do {
        used.add(edge);
        ring.push([edge.ex, edge.ey]);
        const candidates = (edgesByStart.get(key(edge.ex, edge.ey)) ?? []).filter(
          (c) => !used.has(c),
        );
        if (candidates.length === 0) break;
        if (candidates.length === 1) {
          edge = candidates[0];
        } else {
          // Prefer the tightest clockwise continuation from the incoming heading.
          const inDir = cwIndex(edge.ex - edge.sx, edge.ey - edge.sy);
          edge = candidates.slice().sort((a, b) => {
            const da = (cwIndex(a.ex - a.sx, a.ey - a.sy) - inDir + 4) % 4;
            const db = (cwIndex(b.ex - b.sx, b.ey - b.sy) - inDir + 4) % 4;
            return da - db;
          })[0];
        }
      } while (edge !== start && !used.has(edge));
      if (edge === start) ring.push([start.sx, start.sy]);
      if (ring.length >= 4) rings.push(dropCollinear(ring));
    }
  }
  return rings;
}

/** Remove interior points that are collinear with their neighbours. */
function dropCollinear(ring: NodeRing): NodeRing {
  const pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
    pts.pop();
  }
  const out: NodeRing = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross !== 0) out.push(b);
  }
  if (out.length) out.push([out[0][0], out[0][1]]);
  return out;
}

/** Signed area of a ring (shoelace); >0 is counter-clockwise in lon/lat space. */
function signedArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

/** True when `p` is inside `ring` (ray casting); ring is closed lon/lat. */
function pointInRingLL(p: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Mask → GeoJSON (project + nest holes + enforce RFC 7946 winding).
// ---------------------------------------------------------------------------

export interface MaskToPolygonsOptions {
  /** Zoom of the stitched image the mask was built from. */
  zoom: number;
  /** Global pixel offset (top-left of the stitched image) at `zoom`. */
  originPx: number;
  originPy: number;
  /** Mask-node → stitched-pixel scale (downsample factor; default 1). */
  scale?: number;
  /** Drop rings whose |area| in km² is below this (default 0.01). */
  minAreaKm2?: number;
}

/**
 * Convert a binary water mask into a GeoJSON `FeatureCollection` of polygons in
 * lon/lat, with dry-land holes nested into their containing water polygon and
 * winding normalized (exterior CCW, holes CW).
 */
export function maskToFeatureCollection(
  mask: ArrayLike<number | boolean>,
  width: number,
  height: number,
  opts: MaskToPolygonsOptions,
): GeoFeatureCollection {
  const scale = opts.scale ?? 1;
  const project = (nx: number, ny: number): Position =>
    pixelToLonLat(
      opts.originPx + nx * scale,
      opts.originPy + ny * scale,
      opts.zoom,
    );

  const rings = traceMaskRings(mask, width, height)
    .map((r) => r.map(([nx, ny]) => project(nx, ny)))
    .filter((r) => r.length >= 4);

  // Split into outer rings and holes by even-odd containment, then assemble.
  type R = { ring: Position[]; area: number; abs: number };
  const items: R[] = rings.map((ring) => {
    const area = signedArea(ring);
    return { ring, area, abs: Math.abs(area) };
  });
  items.sort((a, b) => b.abs - a.abs); // largest first

  const outers: { ring: Position[]; holes: Position[][] }[] = [];
  for (const it of items) {
    // A ring is a hole if a representative vertex sits inside an existing outer.
    const probe = it.ring[0];
    const container = outers.find((o) => pointInRingLL(probe, o.ring));
    if (container && !outers.some((o) => o.ring === it.ring)) {
      container.holes.push(it.ring);
    } else {
      outers.push({ ring: it.ring, holes: [] });
    }
  }

  const minAreaKm2 = opts.minAreaKm2 ?? 0.01;
  const features: GeoFeature[] = [];
  for (const o of outers) {
    if (ringAreaKm2(o.ring) < minAreaKm2) continue;
    const exterior = ensureWinding(o.ring, true); // CCW
    const holes = o.holes.map((h) => ensureWinding(h, false)); // CW
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [exterior, ...holes] },
      properties: { source: "OPERA DSWx (observed water)" },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Force a ring to the requested winding (ccw = exterior). */
function ensureWinding(ring: Position[], ccw: boolean): Position[] {
  const area = signedArea(ring);
  const isCcw = area > 0;
  return isCcw === ccw ? ring : ring.slice().reverse();
}

/** Approximate ring area in km² via an equirectangular projection at mean lat. */
function ringAreaKm2(ring: Position[]): number {
  const meanLat =
    ring.reduce((s, p) => s + p[1], 0) / Math.max(ring.length, 1);
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((meanLat * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * mPerDegLon;
    const y1 = ring[i][1] * mPerDegLat;
    const x2 = ring[i + 1][0] * mPerDegLon;
    const y2 = ring[i + 1][1] * mPerDegLat;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Browser IO: fetch + stitch DSWx water-only tiles, then vectorize.
// ---------------------------------------------------------------------------

/** A decoded RGBA raster. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DeriveFloodExtentOptions {
  /** Max tiles across the longer side (bounds work); default 4. */
  maxTilesAcross?: number;
  /** Alpha (0–255) above which a pixel counts as water; default 8. */
  alphaThreshold?: number;
  /** Downsample factor for the mask grid; default 1 (full tile resolution). */
  scale?: number;
  /** Minimum polygon area to keep, km²; default 0.02. */
  minAreaKm2?: number;
  /** Concurrent tile fetches; default 8. */
  concurrency?: number;
  /** Injectable tile loader (testing / Node). Must return RGBA for a tile URL. */
  loadTile?: (url: string) => Promise<RgbaImage | null>;
  /** Injectable fetch (unused by the default browser loader). */
  fetchImpl?: typeof fetch;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/**
 * Fetch the DSWx water-only tiles covering `bbox`, stitch them, and vectorize
 * the observed-water mask into a lon/lat `FeatureCollection`. `tileTemplates`
 * are XYZ URL templates (`{z}/{x}/{y}`) that render water opaque and everything
 * else transparent — pass tiles built with the DSWx water-only colormap.
 */
export async function deriveFloodExtent(
  bbox: BBox,
  tileTemplates: string[],
  opts: DeriveFloodExtentOptions = {},
): Promise<GeoFeatureCollection> {
  const [w, s, e, n] = bbox;
  const zoom = chooseZoom(bbox, opts.maxTilesAcross ?? 4);
  const [gx0, gy0] = lonLatToPixel(w, n, zoom); // top-left global pixel
  const [gx1, gy1] = lonLatToPixel(e, s, zoom); // bottom-right global pixel
  const tx0 = Math.floor(gx0 / TILE);
  const ty0 = Math.floor(gy0 / TILE);
  const tx1 = Math.floor(gx1 / TILE);
  const ty1 = Math.floor(gy1 / TILE);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const stitchW = cols * TILE;
  const stitchH = rows * TILE;
  const originPx = tx0 * TILE;
  const originPy = ty0 * TILE;

  const load = opts.loadTile ?? defaultTileLoader;
  const mask = new Uint8Array(stitchW * stitchH);
  const alphaMin = opts.alphaThreshold ?? 8;

  // One task per (tile, template); union (OR) all observed water into the mask.
  const tasks: { tx: number; ty: number; template: string }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      for (const template of tileTemplates) tasks.push({ tx, ty, template });
    }
  }
  await runPool(tasks, opts.concurrency ?? 8, async ({ tx, ty, template }) => {
    const url = template
      .replace("{z}", String(zoom))
      .replace("{x}", String(tx))
      .replace("{y}", String(ty));
    const img = await load(url).catch(() => null);
    if (!img) return;
    const ox = (tx - tx0) * TILE;
    const oy = (ty - ty0) * TILE;
    for (let py = 0; py < Math.min(TILE, img.height); py++) {
      for (let px = 0; px < Math.min(TILE, img.width); px++) {
        const a = img.data[(py * img.width + px) * 4 + 3];
        if (a > alphaMin) mask[(oy + py) * stitchW + (ox + px)] = 1;
      }
    }
  });

  return maskToFeatureCollection(mask, stitchW, stitchH, {
    zoom,
    originPx,
    originPy,
    scale: opts.scale ?? 1,
    minAreaKm2: opts.minAreaKm2 ?? 0.02,
  });
}

/** Default browser tile loader via `createImageBitmap` + `OffscreenCanvas`. */
async function defaultTileLoader(url: string): Promise<RgbaImage | null> {
  const g = globalThis as unknown as {
    fetch?: typeof fetch;
    createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
  };
  if (!g.fetch || !g.createImageBitmap || !g.OffscreenCanvas) return null;
  const resp = await g.fetch(url);
  if (!resp.ok) return null;
  const bmp = await g.createImageBitmap(await resp.blob());
  const canvas = new g.OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data, width, height };
}
