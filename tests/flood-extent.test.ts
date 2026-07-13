import { describe, expect, it } from "vitest";
import {
  chooseZoom,
  traceMaskRings,
  maskToFeatureCollection,
} from "../src/lib/opera/flood-extent";
import { pointInWater, waterAreaKm2 } from "../src/lib/opera/geometry";

/** Build a width×height binary mask, water where `fn(x,y)` is true. */
function makeMask(
  width: number,
  height: number,
  fn: (x: number, y: number) => boolean,
): Uint8Array {
  const m = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) m[y * width + x] = fn(x, y) ? 1 : 0;
  }
  return m;
}

describe("traceMaskRings", () => {
  it("traces a single solid block into one closed rectangular ring", () => {
    const mask = makeMask(6, 6, (x, y) => x >= 1 && x <= 3 && y >= 1 && y <= 3);
    const rings = traceMaskRings(mask, 6, 6);
    expect(rings).toHaveLength(1);
    const ring = rings[0];
    // closed
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // collinear-reduced rectangle: 4 corners + closing point
    expect(ring).toHaveLength(5);
    const corners = ring.slice(0, 4).map(([x, y]) => `${x},${y}`).sort();
    expect(corners).toEqual(["1,1", "1,4", "4,1", "4,4"]);
  });

  it("returns two rings for two disjoint blocks", () => {
    const mask = makeMask(10, 5, (x, y) => (x >= 1 && x <= 2 || x >= 6 && x <= 7) && y >= 1 && y <= 3);
    expect(traceMaskRings(mask, 10, 5)).toHaveLength(2);
  });

  it("returns outer + hole rings for a block with a dry hole", () => {
    const mask = makeMask(9, 9, (x, y) => {
      const inBlock = x >= 1 && x <= 7 && y >= 1 && y <= 7;
      const inHole = x >= 3 && x <= 5 && y >= 3 && y <= 5;
      return inBlock && !inHole;
    });
    expect(traceMaskRings(mask, 9, 9)).toHaveLength(2);
  });
});

describe("maskToFeatureCollection", () => {
  const zoom = 12;
  const originPx = 2000 * 256; // arbitrary tile origin at this zoom
  const originPy = 1500 * 256;

  it("projects a block into a single valid polygon feature", () => {
    const mask = makeMask(60, 60, (x, y) => x >= 5 && x <= 45 && y >= 5 && y <= 45);
    const fc = maskToFeatureCollection(mask, 60, 60, { zoom, originPx, originPy });
    expect(fc.features).toHaveLength(1);
    const geom = fc.features[0].geometry as { type: string; coordinates: number[][][] };
    expect(geom.type).toBe("Polygon");
    // exterior ring closed
    const ext = geom.coordinates[0];
    expect(ext[0]).toEqual(ext[ext.length - 1]);
    // non-trivial real-world area
    expect(waterAreaKm2(fc)).toBeGreaterThan(0.5);
  });

  it("keeps a dry hole so points inside it are not counted as water", () => {
    const mask = makeMask(60, 60, (x, y) => {
      const inBlock = x >= 5 && x <= 55 && y >= 5 && y <= 55;
      const inHole = x >= 20 && x <= 40 && y >= 20 && y <= 40;
      return inBlock && !inHole;
    });
    const fc = maskToFeatureCollection(mask, 60, 60, { zoom, originPx, originPy });
    expect(fc.features).toHaveLength(1);
    const coords = (fc.features[0].geometry as { coordinates: number[][][] }).coordinates;
    expect(coords.length).toBe(2); // exterior + one hole

    // A point in the block (but outside the hole) is water; a point in the hole is not.
    const [exterior] = coords;
    const lons = exterior.map((p) => p[0]);
    const lats = exterior.map((p) => p[1]);
    const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    // center sits inside the hole -> not water
    expect(pointInWater([cLon, cLat], fc)).toBe(false);
    // a point near the exterior edge (well outside the hole) -> water
    const edgeLon = Math.min(...lons) + (Math.max(...lons) - Math.min(...lons)) * 0.08;
    expect(pointInWater([edgeLon, cLat], fc)).toBe(true);
  });
});

describe("chooseZoom", () => {
  it("keeps tile coverage within the requested budget", () => {
    const bbox: [number, number, number, number] = [-0.45, 39.35, -0.32, 39.45];
    const z = chooseZoom(bbox, 6);
    expect(z).toBeGreaterThan(8);
    expect(z).toBeLessThanOrEqual(16);
  });
});
