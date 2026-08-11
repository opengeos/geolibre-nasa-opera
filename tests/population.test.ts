import { describe, expect, it, vi } from "vitest";
import type { GeoFeatureCollection } from "../src/lib/opera/geometry";
import {
  fetchWorldPopPopulation,
  WORLDPOP_ARCGIS_STATS_ENDPOINT,
  WORLDPOP_STATS_ENDPOINT,
  worldPopImageUrl,
} from "../src/lib/opera/population";

const area: GeoFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
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
      },
    },
  ],
};

function signedRingArea(ring: number[][]): number {
  return ring.reduce((sum, current, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + current[0] * next[1] - next[0] * current[1];
  }, 0);
}

describe("WorldPop", () => {
  it("posts a Polygon to the WorldPop v2 population endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "pending",
            task_id: "task-1",
            check_url: "/v2/tasks/task-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "success",
            result: { total_population: 1234.5 },
          }),
          { status: 200 },
        ),
      );

    const result = await fetchWorldPopPopulation(area, {
      fetchImpl: fetchImpl as never,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      totalPopulation: 1234.5,
      year: 2020,
      dataset: "worldpop-global2",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WORLDPOP_STATS_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      geojson: area.features[0].geometry,
      year: 2020,
      resolution: "100m",
    });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://api.worldpop.org/v2/tasks/task-1",
    );
  });

  it("polls a task when the initial response is asynchronous", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "success",
            result: { total_population: 42 },
          }),
          { status: 200 },
        ),
      );
    const sleep = vi.fn(async () => undefined);

    const result = await fetchWorldPopPopulation(area, {
      fetchImpl: fetchImpl as never,
      sleep,
    });

    expect(result.totalPopulation).toBe(42);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://api.worldpop.org/v2/tasks/task-1",
    );
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("accepts valid JSON followed by WorldPop server warning markup", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ status: "created", taskid: "task-warning" })}<br><b>Warning</b>: server diagnostic`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ status: "finished", total_population: 73 })}<br>warning`,
          { status: 200 },
        ),
      );

    const result = await fetchWorldPopPopulation(area, {
      fetchImpl: fetchImpl as never,
      sleep: async () => undefined,
    });

    expect(result.totalPopulation).toBe(73);
  });

  it("normalizes malformed extracted JSON errors", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"status": invalid}<br>warning', { status: 200 }),
    );

    await expect(
      fetchWorldPopPopulation(area, {
        fetchImpl: fetchImpl as never,
        arcGisEndpoint: false,
      }),
    ).rejects.toThrow("WorldPop returned invalid JSON.");
  });

  it("sums per-feature totals returned for a multi-polygon flood extent", async () => {
    const multiArea: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        area.features[0],
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [2, 0],
                [3, 0],
                [3, 1],
                [2, 1],
                [2, 0],
              ],
            ],
          },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            data: [{ total_population: 120.5 }, { total_population: 79.5 }],
          }),
          { status: 200 },
        ),
    );

    const result = await fetchWorldPopPopulation(multiArea, {
      fetchImpl: fetchImpl as never,
    });

    expect(result.totalPopulation).toBe(200);
    const request = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as Record<string, { type: string; coordinates: unknown[] }>;
    expect(request.geojson.type).toBe("MultiPolygon");
    expect(request.geojson.coordinates).toHaveLength(2);
  });

  it("repairs self-intersecting flood polygons before submission", async () => {
    const selfIntersectingArea: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [2, 2],
                [0, 2],
                [2, 0],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            result: { total_population: 50 },
          }),
          { status: 200 },
        ),
    );

    await fetchWorldPopPopulation(selfIntersectingArea, {
      fetchImpl: fetchImpl as never,
    });

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as Record<string, { type: string; coordinates: unknown[] }>;
    expect(request.geojson.type).toBe("MultiPolygon");
    expect(request.geojson.coordinates).toHaveLength(2);
  });

  it("separates vertices shared by exterior and interior rings", async () => {
    const touchingHoleArea: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [4, 0],
                [4, 4],
                [0, 4],
                [0, 0],
              ],
              [
                [0, 0],
                [1, 2],
                [2, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            result: { total_population: 50 },
          }),
          { status: 200 },
        ),
    );

    await fetchWorldPopPopulation(touchingHoleArea, {
      fetchImpl: fetchImpl as never,
    });

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as Record<string, { type: string; coordinates: number[][][] }>;
    expect(request.geojson.type).toBe("Polygon");
    expect(request.geojson.coordinates).toHaveLength(2);
    const vertices = request.geojson.coordinates.flatMap((ring) =>
      ring.slice(0, -1).map(([x, y]) => `${x},${y}`),
    );
    expect(new Set(vertices).size).toBe(vertices.length);
  });

  it("promotes a ring nested inside a hole to a separate shell", async () => {
    const nestedArea: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [6, 0],
                [6, 6],
                [0, 6],
                [0, 0],
              ],
              [
                [1, 1],
                [1, 5],
                [5, 5],
                [5, 1],
                [1, 1],
              ],
              [
                [2, 2],
                [4, 2],
                [4, 4],
                [2, 4],
                [2, 2],
              ],
            ],
          },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            result: { total_population: 50 },
          }),
          { status: 200 },
        ),
    );

    await fetchWorldPopPopulation(nestedArea, {
      fetchImpl: fetchImpl as never,
    });

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as Record<string, { type: string; coordinates: number[][][][] }>;
    expect(request.geojson.type).toBe("MultiPolygon");
    expect(request.geojson.coordinates).toHaveLength(2);
    expect(
      request.geojson.coordinates.map((polygon) => polygon.length).sort(),
    ).toEqual([1, 2]);
  });

  it("removes a redundant shell nested in another water feature", async () => {
    const nestedShells: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        area.features[0],
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0.2, 0.2],
                [0.8, 0.2],
                [0.8, 0.8],
                [0.2, 0.8],
                [0.2, 0.2],
              ],
            ],
          },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            result: { total_population: 50 },
          }),
          { status: 200 },
        ),
    );

    await fetchWorldPopPopulation(nestedShells, {
      fetchImpl: fetchImpl as never,
    });

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as Record<string, { type: string; coordinates: number[][][] }>;
    expect(request.geojson.type).toBe("Polygon");
    const originalCoordinates = (
      area.features[0].geometry as {
        coordinates: number[][][];
      }
    ).coordinates;
    expect(request.geojson.coordinates).toEqual(originalCoordinates);
  });

  it("aborts a stalled WorldPop request", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    await expect(
      fetchWorldPopPopulation(area, {
        fetchImpl: fetchImpl as never,
        requestTimeoutMs: 5,
        arcGisEndpoint: false,
      }),
    ).rejects.toThrow("WorldPop request timed out after 1 seconds.");
  });

  it("falls back to ArcGIS polygon statistics", async () => {
    const polygonWithHoleAndMultiPolygon: GeoFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [4, 0],
                [4, 4],
                [0, 4],
                [0, 0],
              ],
              [
                [1, 1],
                [1, 2],
                [2, 2],
                [2, 1],
                [1, 1],
              ],
            ],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [
                [
                  [10, 10],
                  [12, 10],
                  [12, 12],
                  [10, 12],
                  [10, 10],
                ],
              ],
            ],
          },
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("legacy service unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statistics: [{ sum: 384.9889950079895 }] }),
          { status: 200 },
        ),
      );

    const result = await fetchWorldPopPopulation(
      polygonWithHoleAndMultiPolygon,
      {
        fetchImpl: fetchImpl as never,
      },
    );

    expect(result).toMatchObject({
      totalPopulation: 384.9889950079895,
      source: expect.stringContaining("ArcGIS ImageServer"),
    });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe(WORLDPOP_ARCGIS_STATS_ENDPOINT);
    expect(init?.method).toBe("POST");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("geometryType")).toBe("esriGeometryPolygon");
    expect(form.get("time")).toBe(String(Date.UTC(2020, 0, 1)));
    const geometry = JSON.parse(form.get("geometry") ?? "{}") as {
      rings: number[][][];
      spatialReference: { wkid: number };
    };
    expect(geometry).toMatchObject({
      spatialReference: { wkid: 4326 },
    });
    expect(geometry.rings).toHaveLength(3);
    expect(signedRingArea(geometry.rings[0])).toBeLessThan(0);
    expect(signedRingArea(geometry.rings[1])).toBeGreaterThan(0);
    expect(signedRingArea(geometry.rings[2])).toBeLessThan(0);
  });

  it("builds a transparent, styled population image URL", () => {
    const url = new URL(worldPopImageUrl([-1, 2, 3, 4]));

    expect(url.searchParams.get("bbox")).toBe("-1,2,3,4");
    expect(url.searchParams.get("format")).toBe("png32");
    expect(url.searchParams.get("transparent")).toBe("true");
    expect(url.searchParams.get("time")).toBe(String(Date.UTC(2020, 0, 1)));
    expect(url.searchParams.get("renderingRule")).toContain("Colormap");
  });
});
