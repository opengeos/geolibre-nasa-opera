import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildingsInFlood,
  dedupeOvertureFeatures,
  pointInGeometry,
  pointInRing,
  transportationInFlood,
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
import {
  bboxWidthKm,
  buildOnePagerHtml,
  scaleBar,
} from "../src/lib/opera/one-pager";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

function buildingAt(
  lon: number,
  lat: number,
): GeoFeatureCollection["features"][number] {
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

  it("deduplicates Overture fragments by stable feature id", () => {
    const small = buildingAt(0.5, 0.5);
    const large = buildingAt(0.5, 0.5);
    (small.properties ??= {})._overture_id = "building-1";
    (large.properties ??= {})._overture_id = "building-1";
    const coordinates = (large.geometry as PolygonGeometry).coordinates[0];
    coordinates[0] = [0.4, 0.4];
    coordinates[1] = [0.6, 0.4];
    coordinates[2] = [0.6, 0.6];
    coordinates[3] = [0.4, 0.6];
    coordinates[4] = [0.4, 0.4];

    const result = dedupeOvertureFeatures({
      type: "FeatureCollection",
      features: [small, large],
    });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toBe(large);
  });

  it("clips transportation centerlines to the flood extent", () => {
    const transportation: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { _overture_id: "road-1", subtype: "road" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-0.5, 0.5],
              [1.5, 0.5],
            ],
          },
        },
        {
          type: "Feature",
          properties: { _overture_id: "rail-1", subtype: "rail" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-0.5, 2],
              [1.5, 2],
            ],
          },
        },
      ],
    };

    const result = transportationInFlood(transportation, waterFC);

    expect(result.total).toBe(2);
    expect(result.impactedCount).toBe(1);
    expect(result.bySubtype).toEqual({ road: 1 });
    expect(result.impactedLengthKm).toBeGreaterThan(110);
    expect(result.impactedLengthKm).toBeLessThan(112);
    expect(result.impactedFeatures).toHaveLength(1);
  });

  it("can restrict impact clipping to roads and exclude ferry artifacts", () => {
    const transportation: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { _overture_id: "road-1", subtype: "road" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-0.5, 0.5],
              [1.5, 0.5],
            ],
          },
        },
        {
          type: "Feature",
          properties: { _overture_id: "ferry-1", subtype: "water" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-10, 0.5],
              [10, 0.5],
            ],
          },
        },
      ],
    };

    const result = transportationInFlood(transportation, waterFC, {
      allowedSubtypes: ["road"],
    });

    expect(result.total).toBe(1);
    expect(result.impactedCount).toBe(1);
    expect(result.bySubtype).toEqual({ road: 1 });
    expect(result.impactedFeatures[0].properties?.subtype).toBe("road");
  });
});

describe("benchmark", () => {
  it("normalizeWater accepts geometry, feature, and collection", () => {
    expect(normalizeWater(square).features).toHaveLength(1);
    expect(
      normalizeWater({ type: "Feature", geometry: square, properties: {} })
        .features,
    ).toHaveLength(1);
    expect(normalizeWater(waterFC).features).toHaveLength(1);
  });

  it("normalizeWater rejects non-polygon input", () => {
    expect(() =>
      normalizeWater({ type: "Point", coordinates: [0, 0] }),
    ).toThrow();
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
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ elements: [] }), { status: 200 }),
    );
    const fc = await fetchOsmBuildings([0, 0, 1, 1], {
      fetchImpl: fetchImpl as never,
    });
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

  it("reads the Docker runtime news endpoint", () => {
    vi.stubGlobal("__GEOLIBRE_DEPLOYMENT_ENV__", {
      GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT: "/ai/",
    });

    expect(resolveNewsProxyEndpoint()).toBe("/ai");
  });

  it("supports the legacy Docker runtime news endpoint key", () => {
    vi.stubGlobal("__GEOLIBRE_DEPLOYMENT_ENV__", {
      VITE_NASA_OPERA_NEWS_PROXY_ENDPOINT: "/legacy-ai/",
    });

    expect(resolveNewsProxyEndpoint()).toBe("/legacy-ai");
  });

  it("searchNews throws when no endpoint is configured", async () => {
    await expect(searchNews("x", { endpoint: "" })).rejects.toThrow(
      /not configured/i,
    );
  });

  it("searchNews normalizes GPT web search results", async () => {
    const fetchImpl = vi.fn(
      async () =>
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
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://news.example.com/search",
      expect.any(Object),
    );
  });

  it("uses the managed GeoLibre GPT messages route instead of /ai/search", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("gpt-5.6-luna");
      expect(body.tools).toContainEqual(
        expect.objectContaining({ type: "web_search_20250305" }),
      );
      return Response.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answer: "Flooding affected central Nepal.",
              results: [
                {
                  title: "Official flood update",
                  url: "https://example.gov.np/flood-update",
                  content: "Flooding affected Rasuwa.",
                  published_date: "2026-08-26",
                },
              ],
            }),
          },
        ],
      });
    });

    const out = await searchNews("Nepal floods August 2026", {
      endpoint: "/ai",
      topic: "general",
      fetchImpl: fetchImpl as never,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/ai/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    expect(out.results[0]?.publisher).toBe("example.gov.np");
  });

  it("allows enough time for GPT web search to complete", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
          setTimeout(
            () =>
              resolve(
                Response.json({
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ answer: "", results: [] }),
                    },
                  ],
                }),
              ),
            20_000,
          );
        }),
    );

    const pending = searchNews("Nepal floods August 2026", {
      endpoint: "https://geolibre.example.com/ai",
      topic: "general",
      fetchImpl: fetchImpl as never,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toMatchObject({ results: [] });
  });

  it("uses GPT native web search directly in a configured local build", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("gpt-5.6-luna");
      expect(body.tools).toContainEqual(
        expect.objectContaining({ type: "web_search_20250305" }),
      );
      return Response.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answer: "One current flood",
              results: [
                {
                  title: "Flood report",
                  url: "https://example.com/flood",
                  content: "A current flood was reported.",
                  published_date: "2026-08-24",
                },
              ],
            }),
          },
        ],
      });
    });
    const out = await searchNews("current US disasters", {
      endpoint: "",
      topic: "news",
      gptApiKey: "local-test-key",
      gptBaseUrl: "https://cli.example.com/v1",
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cli.example.com/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    expect(out.results[0]?.sourceUrl).toBe("https://example.com/flood");
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
      event: {
        name: "Valencia DANA",
        location: "Valencia, Spain",
        date: "2024-10-29",
      },
      narrative: "Heavy rain caused severe urban flooding.",
      benchmark: {
        bbox: [-0.5, 39.3, -0.2, 39.6],
        areaKm2: 42.5,
        render: { label: "Flood water" },
      },
      buildings: {
        floodedCount: 1200,
        total: 8000,
        fraction: 0.15,
        source: "OSM",
      },
      population: { totalPopulation: 125000, year: 2020, source: "WorldPop" },
      transportation: {
        impactedSegmentCount: 220,
        impactedLengthKm: 32.4,
        source: "Overture Maps",
      },
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
    expect(html).toContain("125,000");
    expect(html).toContain("32.4 km");
    expect(html).toContain("window.print()");
    expect(html).toContain("https://assets.geolibre.app/images/jpl-logo.webp");
    expect(html).toContain("https://assets.geolibre.app/images/opera-logo.webp");
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

  it("exports an editable report with the live project in GeoLibre map-only mode", () => {
    const html = buildOnePagerHtml({
      title: "Interactive assessment",
      event: { name: "Event", location: "AOI" },
      narrative: "Editable background.",
      benchmark: { bbox: [-1, 38, 0, 39], areaKm2: 10, render: {} },
      geoLibreProject: {
        name: "water-</script>",
        mapView: { center: [-0.5, 38.5], zoom: 8 },
        layers: [{ id: "overture-derived", name: "Saved Overture buildings" }],
        plugins: {
          activePluginIds: ["maplibre-layer-control", "maplibre-gl-overture-maps"],
        },
      },
    });

    expect(html).toContain('id="assessment-map"');
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('id="overview-map"');
    expect(html).toContain(
      "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    );
    expect(html).toContain(".replace(/\\+/g,'-').replace(/\\//g,'_')");
    expect(html).not.toContain("https://tile.openstreetmap.org/");
    expect(html).toContain("https://web.geolibre.app/?maponly&amp;embed=1&amp;welcome=0");
    expect(html).toContain("maplibre-gl@6.3.0");
    expect(html).not.toContain("maplibre-gl@5.14.0");
    expect(html).toContain("window.location.protocol === 'file:'");
    expect(html).toContain("#geolibreProject=");
    expect(html).toContain("geolibre:load-project");
    expect(html).toContain("layer.visible = false");
    expect(html).toContain("sentinel-2-event-imagery");
    expect(html).toContain("project.preferences.map.projection = 'mercator'");
    expect(html).toContain("project.mapView.pitch = 0");
    expect(html).toContain("project.mapView.bearing = 0");
    expect(html).not.toContain('id="expand-button"');
    expect(html).not.toContain('id="layer-panel"');
    expect(html).not.toContain('"maplibre-gl-overture-maps"');
    expect(html).toContain("Saved Overture buildings");
    expect(html).not.toContain('<div class="scalebar">');
    expect(html).toContain("expert validation before use for decision-making");
    expect(html).not.toContain("water-</script>");
    expect(html).toContain("water-\\u003c/script\\u003e");
  });
});
