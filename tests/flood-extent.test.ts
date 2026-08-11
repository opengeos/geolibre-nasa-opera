import { describe, expect, it } from "vitest";
import {
  chooseZoom,
  downsampleBinaryMask,
  deriveFloodExtent,
  traceMaskRings,
  maskToFeatureCollection,
  splitRepeatedRingVertices,
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
    const corners = ring
      .slice(0, 4)
      .map(([x, y]) => `${x},${y}`)
      .sort();
    expect(corners).toEqual(["1,1", "1,4", "4,1", "4,4"]);
  });

  it("returns two rings for two disjoint blocks", () => {
    const mask = makeMask(
      10,
      5,
      (x, y) => ((x >= 1 && x <= 2) || (x >= 6 && x <= 7)) && y >= 1 && y <= 3,
    );
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

  it("splits a ring that revisits a diagonal pinch point", () => {
    const rings = splitRepeatedRingVertices([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
      [-2, 0],
      [-2, -2],
      [0, -2],
      [0, 0],
    ]);

    expect(rings).toHaveLength(2);
    expect(rings.every((ring) => ring.length === 5)).toBe(true);
    expect(
      rings.every(
        (ring) =>
          new Set(ring.slice(0, -1).map(([x, y]) => `${x},${y}`)).size ===
          ring.length - 1,
      ),
    ).toBe(true);
  });
});

describe("downsampleBinaryMask", () => {
  it("retains water when aggregating partial edge cells", () => {
    const mask = makeMask(
      7,
      5,
      (x, y) => (x === 3 && y === 1) || (x === 6 && y === 4),
    );

    const sampled = downsampleBinaryMask(mask, 7, 5, 4);

    expect(sampled).toMatchObject({ width: 2, height: 2, scale: 4 });
    expect(Array.from(sampled.mask)).toEqual([1, 0, 0, 1]);
  });
});

describe("maskToFeatureCollection", () => {
  const zoom = 12;
  const originPx = 2000 * 256; // arbitrary tile origin at this zoom
  const originPy = 1500 * 256;

  it("projects a block into a single valid polygon feature", () => {
    const mask = makeMask(
      60,
      60,
      (x, y) => x >= 5 && x <= 45 && y >= 5 && y <= 45,
    );
    const fc = maskToFeatureCollection(mask, 60, 60, {
      zoom,
      originPx,
      originPy,
    });
    expect(fc.features).toHaveLength(1);
    const geom = fc.features[0].geometry as {
      type: string;
      coordinates: number[][][];
    };
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
    const fc = maskToFeatureCollection(mask, 60, 60, {
      zoom,
      originPx,
      originPy,
    });
    expect(fc.features).toHaveLength(1);
    const coords = (fc.features[0].geometry as { coordinates: number[][][] })
      .coordinates;
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
    const edgeLon =
      Math.min(...lons) + (Math.max(...lons) - Math.min(...lons)) * 0.08;
    expect(pointInWater([edgeLon, cLat], fc)).toBe(true);
  });

  it("promotes water nested inside a dry hole to a separate polygon", () => {
    const mask = makeMask(15, 15, (x, y) => {
      const inOuter = x >= 1 && x <= 13 && y >= 1 && y <= 13;
      const inHole = x >= 3 && x <= 11 && y >= 3 && y <= 11;
      const inIsland = x >= 5 && x <= 9 && y >= 5 && y <= 9;
      return inOuter && (!inHole || inIsland);
    });

    const fc = maskToFeatureCollection(mask, 15, 15, {
      zoom,
      originPx,
      originPy,
      minAreaKm2: 0,
    });

    expect(fc.features).toHaveLength(2);
    const ringCounts = fc.features
      .map(
        (feature) =>
          (feature.geometry as { coordinates: number[][][] }).coordinates
            .length,
      )
      .sort();
    expect(ringCounts).toEqual([1, 2]);
  });
});

describe("chooseZoom", () => {
  it("keeps tile coverage within the requested budget", () => {
    const bbox: [number, number, number, number] = [-0.45, 39.35, -0.32, 39.45];
    const z = chooseZoom(bbox, 6);
    expect(z).toBeGreaterThan(8);
    expect(z).toBeLessThanOrEqual(16);
  });

  it("keeps world-scale polar bounds finite", async () => {
    const urls: string[] = [];
    const result = await deriveFloodExtent(
      [-180, -90, 180, 90],
      ["https://tiles.example/{z}/{x}/{y}.png"],
      {
        loadTile: async (url) => {
          urls.push(url);
          return null;
        },
      },
    );

    expect(result.features).toEqual([]);
    expect(urls).toHaveLength(16);
    expect(
      urls.every((url) =>
        /^https:\/\/tiles\.example\/2\/[0-3]\/[0-3]\.png$/.test(url),
      ),
    ).toBe(true);
  });

  it("rejects non-finite bounds before allocating a mask", async () => {
    await expect(
      deriveFloodExtent(
        [-1, -1, Number.POSITIVE_INFINITY, 1],
        ["https://tiles.example/{z}/{x}/{y}.png"],
      ),
    ).rejects.toThrow(/finite bbox/);
  });

  it("clips opaque source tiles to the requested bbox", async () => {
    const bbox: [number, number, number, number] = [
      -0.527, 39.232, -0.176, 39.54,
    ];
    const result = await deriveFloodExtent(
      bbox,
      ["https://tiles.example/{z}/{x}/{y}.png"],
      {
        loadTile: async () => {
          const data = new Uint8ClampedArray(256 * 256 * 4);
          for (let index = 3; index < data.length; index += 4) {
            data[index] = 255;
          }
          return { data, width: 256, height: 256 };
        },
      },
    );
    const coordinates = result.features.flatMap((feature) =>
      (
        feature.geometry as {
          coordinates: number[][][];
        }
      ).coordinates.flat(),
    );

    expect(coordinates.length).toBeGreaterThan(0);
    expect(
      coordinates.every(
        ([longitude, latitude]) =>
          longitude >= bbox[0] - 0.001 &&
          longitude <= bbox[2] + 0.001 &&
          latitude >= bbox[1] - 0.001 &&
          latitude <= bbox[3] + 0.001,
      ),
    ).toBe(true);
  });
});
