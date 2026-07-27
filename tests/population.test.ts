import { describe, expect, it, vi } from "vitest";
import type { GeoFeatureCollection } from "../src/lib/opera/geometry";
import {
  fetchWorldPopPopulation,
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

  it("builds a transparent, styled population image URL", () => {
    const url = new URL(worldPopImageUrl([-1, 2, 3, 4]));

    expect(url.searchParams.get("bbox")).toBe("-1,2,3,4");
    expect(url.searchParams.get("format")).toBe("png32");
    expect(url.searchParams.get("transparent")).toBe("true");
    expect(url.searchParams.get("time")).toBe(String(Date.UTC(2020, 0, 1)));
    expect(url.searchParams.get("renderingRule")).toContain("Colormap");
  });
});
