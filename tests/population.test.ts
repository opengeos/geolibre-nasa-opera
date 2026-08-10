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
  it("posts a synchronous polygon statistics request", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "finished",
            data: { total_population: 1234.5 },
          }),
          { status: 200 },
        ),
    );

    const result = await fetchWorldPopPopulation(area, {
      fetchImpl: fetchImpl as never,
    });

    expect(result).toMatchObject({
      totalPopulation: 1234.5,
      year: 2020,
      dataset: "wpgppop",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WORLDPOP_STATS_ENDPOINT);
    expect(init?.method).toBe("POST");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("dataset")).toBe("wpgppop");
    expect(form.get("year")).toBe("2020");
    expect(JSON.parse(form.get("geojson") ?? "{}")).toEqual(area);
  });

  it("polls a task when the initial response is asynchronous", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ taskid: "task-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "finished", total_population: 42 }),
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
      "https://api.worldpop.org/v1/tasks/task-1",
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
