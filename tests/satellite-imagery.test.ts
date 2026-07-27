import { describe, expect, it, vi } from "vitest";
import {
  fetchSentinel2Scene,
  PLANETARY_COMPUTER_STAC_SEARCH,
} from "../src/lib/opera/satellite-imagery";

describe("Sentinel-2 event imagery", () => {
  it("selects the least-cloudy Planetary Computer scene", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === PLANETARY_COMPUTER_STAC_SEARCH) {
        return new Response(
          JSON.stringify({
            type: "FeatureCollection",
            features: [
              {
                id: "cloudy",
                collection: "sentinel-2-l2a",
                bbox: [0, 0, 1, 1],
                properties: {
                  datetime: "2024-11-01T10:00:00Z",
                  "eo:cloud_cover": 20,
                },
                assets: {
                  tilejson: { href: "https://tiles.example/cloudy" },
                },
              },
              {
                id: "clear",
                collection: "sentinel-2-l2a",
                bbox: [0, 0, 1, 1],
                properties: {
                  datetime: "2024-11-02T10:00:00Z",
                  "eo:cloud_cover": 4.5,
                },
                assets: {
                  tilejson: { href: "https://tiles.example/clear" },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      expect(url).toBe("https://tiles.example/clear");
      expect(init?.headers).toMatchObject({ Accept: "application/json" });
      return new Response(
        JSON.stringify({
          tiles: ["https://tiles.example/{z}/{x}/{y}.png"],
          bounds: [0, 0, 1, 1],
        }),
        { status: 200 },
      );
    });

    const result = await fetchSentinel2Scene(
      {
        bbox: [0, 0, 1, 1],
        start: "2024-10-29",
        end: "2024-11-05",
        maxCloudCover: 30,
      },
      { fetchImpl: fetchImpl as never },
    );

    expect(result).toMatchObject({
      itemId: "clear",
      datetime: "2024-11-02T10:00:00Z",
      cloudCover: 4.5,
      provider: "Microsoft Planetary Computer / Copernicus Sentinel-2",
    });
    const searchBody = JSON.parse(
      String(fetchImpl.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(searchBody).toMatchObject({
      collections: ["sentinel-2-l2a"],
      bbox: [0, 0, 1, 1],
      query: { "eo:cloud_cover": { lte: 30 } },
    });
  });

  it("reports when no suitable scene exists", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ features: [] }), { status: 200 }),
    );

    await expect(
      fetchSentinel2Scene(
        {
          bbox: [0, 0, 1, 1],
          start: "2024-10-29",
          end: "2024-11-05",
          maxCloudCover: 10,
        },
        { fetchImpl: fetchImpl as never },
      ),
    ).rejects.toThrow(/No Sentinel-2 L2A scene/i);
  });
});
