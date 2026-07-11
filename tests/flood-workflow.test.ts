import { describe, expect, it, vi } from "vitest";
import {
  buildingsInFlood,
  pointInGeometry,
  pointInRing,
  waterAreaKm2,
  waterBBox,
  type GeoFeatureCollection,
  type PolygonGeometry,
} from "../src/lib/opera/geometry";
import {
  isLockedBenchmark,
  lockBenchmark,
  normalizeWater,
  summarizeBenchmark,
} from "../src/lib/opera/benchmark";
import {
  buildOverpassQuery,
  overpassToFeatureCollection,
  fetchOsmBuildings,
} from "../src/lib/opera/buildings";
import { resolveNewsProxyEndpoint, searchNews } from "../src/lib/opera/news";
import { bboxWidthKm, buildOnePagerHtml, scaleBar } from "../src/lib/opera/one-pager";

// A 1x1 degree square around [0,0].
const square: PolygonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

const waterFC: GeoFeatureCollection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: square, properties: {} }],
};

function buildingAt(lon: number, lat: number): GeoFeatureCollection["features"][number] {
  const d = 0.001;
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon - d, lat - d],
          [lon + d, lat - d],
          [lon + d, lat + d],
          [lon - d, lat + d],
          [lon - d, lat - d],
        ],
      ],
    },
    properties: {},
  };
}

describe("geometry", () => {
  it("point-in-ring / point-in-geometry", () => {
    expect(pointInRing([0.5, 0.5], square.coordinates[0])).toBe(true);
    expect(pointInRing([2, 2], square.coordinates[0])).toBe(false);
    expect(pointInGeometry([0.5, 0.5], square)).toBe(true);
    expect(pointInGeometry([1.5, 0.5], square)).toBe(false);
  });

  it("waterBBox and waterAreaKm2", () => {
    expect(waterBBox(waterFC)).toEqual([0, 0, 1, 1]);
    // ~111km x ~111km near the equator -> ~12000 km².
    const area = waterAreaKm2(waterFC);
    expect(area).toBeGreaterThan(11000);
    expect(area).toBeLessThan(13000);
  });

  it("buildingsInFlood counts only buildings whose centroid is inside", () => {
    const buildings: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [buildingAt(0.5, 0.5), buildingAt(0.9, 0.1), buildingAt(2, 2)],
    };
    const result = buildingsInFlood(buildings, waterFC, { computeArea: true });
    expect(result.total).toBe(3);
    expect(result.floodedCount).toBe(2);
    expect(result.fraction).toBeCloseTo(2 / 3, 5);
    expect(result.floodedAreaKm2).toBeGreaterThan(0);
  });
});

describe("benchmark", () => {
  it("normalizeWater accepts geometry, feature, and collection", () => {
    expect(normalizeWater(square).features).toHaveLength(1);
    expect(
      normalizeWater({ type: "Feature", geometry: square, properties: {} }).features,
    ).toHaveLength(1);
    expect(normalizeWater(waterFC).features).toHaveLength(1);
  });

  it("normalizeWater rejects non-polygon input", () => {
    expect(() => normalizeWater({ type: "Point", coordinates: [0, 0] })).toThrow();
    expect(() => normalizeWater("nope")).toThrow();
  });

  it("lockBenchmark derives bbox + area and summarizes", () => {
    const locked = lockBenchmark(waterFC, {
      event: { name: "Test Flood", location: "Nowhere", date: "2024-10-29" },
      lockedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(locked.bbox).toEqual([0, 0, 1, 1]);
    expect(locked.areaKm2).toBeGreaterThan(11000);
    expect(locked.render.fillColor).toBeTruthy();
    expect(isLockedBenchmark(locked)).toBe(true);

    const summary = summarizeBenchmark(locked);
    expect(summary.event.name).toBe("Test Flood");
    expect(summary.featureCount).toBe(1);
  });

  it("isLockedBenchmark rejects junk", () => {
    expect(isLockedBenchmark(null)).toBe(false);
    expect(isLockedBenchmark({ id: "x" })).toBe(false);
  });
});

describe("buildings / Overpass", () => {
  it("builds a bbox query in (s,w,n,e) order", () => {
    const q = buildOverpassQuery([-1, -2, 3, 4]);
    expect(q).toContain("(-2,-1,4,3)");
    expect(q).toContain('way["building"]');
  });

  it("parses out-geom ways to closed polygons", () => {
    const fc = overpassToFeatureCollection({
      elements: [
        {
          type: "way",
          id: 42,
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
          ],
          tags: { building: "yes" },
        },
        { type: "node", id: 1 },
      ],
    });
    expect(fc.features).toHaveLength(1);
    const ring = (fc.features[0].geometry as PolygonGeometry).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
    expect(fc.features[0].properties?.osmId).toBe("way/42");
  });

  it("fetchOsmBuildings uses the injected fetch and first endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ elements: [] }), { status: 200 }),
    );
    const fc = await fetchOsmBuildings([0, 0, 1, 1], { fetchImpl: fetchImpl as never });
    expect(fc.features).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("news", () => {
  it("resolveNewsProxyEndpoint honors an override and strips trailing slash", () => {
    expect(resolveNewsProxyEndpoint("https://news.example.com/")).toBe(
      "https://news.example.com",
    );
  });

  it("searchNews throws when no endpoint is configured", async () => {
    await expect(searchNews("x", { endpoint: "" })).rejects.toThrow(/not configured/i);
  });

  it("searchNews normalizes Tavily results", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answer: "Summary",
          results: [
            {
              title: "Deaths rise",
              url: "https://www.reuters.com/world/x",
              content: "224 people died",
              published_date: "2024-11-01",
            },
            { title: "no url" },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await searchNews("Valencia flood deaths", {
      endpoint: "https://news.example.com",
      fetchImpl: fetchImpl as never,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      publisher: "reuters.com",
      sourceUrl: "https://www.reuters.com/world/x",
    });
    expect(out.answer).toBe("Summary");
  });
});

describe("one-pager", () => {
  it("bboxWidthKm and scaleBar produce sane values", () => {
    expect(bboxWidthKm([0, 0, 1, 0])).toBeGreaterThan(100);
    const bar = scaleBar([0, 0, 1, 1]);
    expect(bar.km).toBeGreaterThan(0);
    expect(bar.pct).toBeGreaterThan(0);
    expect(bar.pct).toBeLessThanOrEqual(90);
  });

  it("builds a self-contained HTML doc with impacts and citations", () => {
    const html = buildOnePagerHtml({
      title: "Valencia DANA: OPERA flood assessment",
      event: { name: "Valencia DANA", location: "Valencia, Spain", date: "2024-10-29" },
      narrative: "Heavy rain caused severe urban flooding.",
      benchmark: { bbox: [-0.5, 39.3, -0.2, 39.6], areaKm2: 42.5, render: { label: "Flood water" } },
      buildings: { floodedCount: 1200, total: 8000, fraction: 0.15, source: "OSM" },
      impacts: [
        {
          claim: "Fatalities",
          value: "224",
          sourceUrl: "https://www.reuters.com/x",
          publisher: "reuters.com",
          date: "2024-11-01",
        },
      ],
      generatedAt: "2026-07-11",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Valencia DANA");
    expect(html).toContain("https://www.reuters.com/x");
    expect(html).toContain("1,200"); // building count formatted
    expect(html).toContain("window.print()");
  });

  it("escapes HTML in untrusted narrative/impacts", () => {
    const html = buildOnePagerHtml({
      title: "T",
      event: { name: "E" },
      narrative: "<script>alert(1)</script>",
      benchmark: { bbox: [0, 0, 1, 1], areaKm2: 1, render: {} },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
