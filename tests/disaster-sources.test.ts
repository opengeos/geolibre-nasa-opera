import { describe, expect, it, vi } from "vitest";
import {
  arcGisExportTileUrl,
  defaultAuthoritativeSources,
  discoverNasaDisasterEvent,
  fetchVisibleWebMapLayers,
  latestFedsPerimeters,
  normalizeDisasterHazard,
  queryArcGisGeoJson,
  rankNasaDisasterItems,
} from "../src/lib/opera/disaster-sources";

const eventParams = {
  hazard: "wildfire",
  place: "Colorado",
  start: "2026-06-19",
  end: "2026-07-23",
};

describe("authoritative disaster sources", () => {
  it("normalizes wildfire terms and orders hazard observations before exposure", () => {
    expect(normalizeDisasterHazard("Colorado fires")).toBe("wildfire");
    const sources = defaultAuthoritativeSources("fire");
    expect(sources.slice(0, 3).map((source) => source.id)).toEqual([
      "nasa-feds",
      "burn-severity",
      "opera-dist",
    ]);
    expect(
      sources.findIndex((source) => source.id === "overture"),
    ).toBeGreaterThan(2);
    expect(
      sources.findIndex((source) => source.id === "worldpop"),
    ).toBeGreaterThan(2);
  });

  it("does not read inherited hazard source keys", () => {
    const sources = defaultAuthoritativeSources("toString");
    expect(sources[0]?.id).toBe("nasa-disasters");
  });

  it("discovers a NASA event group from place, hazard, and dates", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "group-1", title: "Colorado Fires July 2026" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "feds-map",
                title: "Fire Events Data Suite for Colorado",
                type: "Web Map",
                tags: ["NASA", "Wildfire"],
                extent: [
                  [-107.7, 38.04],
                  [-107.5, 38.18],
                ],
              },
            ],
          }),
        ),
      );

    const event = await discoverNasaDisasterEvent(eventParams, fetcher);

    expect(event).toMatchObject({
      groupId: "group-1",
      title: "Colorado Fires July 2026",
    });
    expect(event?.items[0]).toMatchObject({
      id: "feds-map",
      type: "Web Map",
      extent: [-107.7, 38.04, -107.5, 38.18],
    });
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "Colorado%20fires%20July%202026",
    );
  });

  it("continues fallback searches after a transient failure", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "group-1", title: "Colorado Fires 2026" }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));

    const event = await discoverNasaDisasterEvent(eventParams, fetcher);
    expect(event?.groupId).toBe("group-1");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("skips unrelated search results before selecting a relevant group", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "wrong", title: "Colorado Fires 2025" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: "right", title: "Colorado Fires June 2026" }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));

    const event = await discoverNasaDisasterEvent(eventParams, fetcher);
    expect(event?.groupId).toBe("right");
  });

  it("reports a NASA search failure when every fallback request fails", async () => {
    const fetcher = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    );
    await expect(
      discoverNasaDisasterEvent(eventParams, fetcher),
    ).rejects.toThrow("NASA event search failed (503)");
  });

  it("ranks FEDS ahead of wildfire change and optical products", () => {
    const ranked = rankNasaDisasterItems("wildfire", [
      {
        id: "optical",
        title: "True Color for the fire",
        type: "Web Map",
        portalUrl: "https://example.com/optical",
        tags: [],
      },
      {
        id: "dist",
        title: "OPERA DIST-ALERT-HLS disturbance",
        type: "Web Map",
        portalUrl: "https://example.com/dist",
        tags: [],
      },
      {
        id: "feds",
        title: "Fire Events Data Suite (FEDS)",
        type: "Web Map",
        portalUrl: "https://example.com/feds",
        tags: [],
      },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["feds", "dist", "optical"]);
  });

  it("does not retain an unmatched Web Map solely because of its type", () => {
    const ranked = rankNasaDisasterItems("wildfire", [
      {
        id: "unrelated",
        title: "Administrative boundaries",
        type: "Web Map",
        portalUrl: "https://example.com/unrelated",
        tags: [],
      },
    ]);
    expect(ranked).toEqual([]);
  });

  it("respects nested ArcGIS Web Map visibility", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            operationalLayers: [
              {
                title: "Hidden group",
                visibility: false,
                layers: [
                  {
                    title: "Child marked visible",
                    visibility: true,
                    url: "https://example.com/hidden/MapServer",
                    layerType: "ArcGISMapServiceLayer",
                  },
                ],
              },
              {
                title: "Visible group",
                layers: [
                  {
                    title: "Visible child",
                    url: "https://example.com/visible/MapServer",
                    layerType: "ArcGISMapServiceLayer",
                  },
                  {
                    title: "Hidden child",
                    visibility: false,
                    url: "https://example.com/child/MapServer",
                    layerType: "ArcGISMapServiceLayer",
                  },
                ],
              },
            ],
          }),
        ),
    );

    const layers = await fetchVisibleWebMapLayers("web-map", fetcher);
    expect(layers.map((layer) => layer.title)).toEqual(["Visible child"]);
  });

  it("keeps the latest FEDS perimeter for each fire", () => {
    const result = latestFedsPerimeters({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null, properties: { fireid: 10, t: 100 } },
        { type: "Feature", geometry: null, properties: { fireid: 10, t: 200 } },
        { type: "Feature", geometry: null, properties: { fireid: 11, t: 150 } },
      ],
    });
    expect(result.features).toHaveLength(2);
    expect(result.features.map((feature) => feature.properties?.t)).toEqual([
      200, 150,
    ]);
  });

  it("compares both ISO and numeric FEDS observation times", () => {
    const result = latestFedsPerimeters({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: null,
          properties: { fireid: 10, t: "2026-07-21T12:00:00Z" },
        },
        {
          type: "Feature",
          geometry: null,
          properties: { fireid: 10, t: "2026-07-22T12:00:00Z" },
        },
        {
          type: "Feature",
          geometry: null,
          properties: { fireid: 11, t: "not-a-date" },
        },
        {
          type: "Feature",
          geometry: null,
          properties: { fireid: 11, t: 200 },
        },
      ],
    });
    expect(result.features.map((feature) => feature.properties?.t)).toEqual([
      "2026-07-22T12:00:00Z",
      200,
    ]);
  });

  it("builds ArcGIS export URLs for map and image services", () => {
    expect(arcGisExportTileUrl("https://example.com/a/MapServer")).toContain(
      "/export?",
    );
    expect(arcGisExportTileUrl("https://example.com/a/ImageServer")).toContain(
      "/exportImage?",
    );
  });

  it("builds a bounded ArcGIS GeoJSON query", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ type: "FeatureCollection", features: [] }),
        ),
    );
    await queryArcGisGeoJson(
      "https://example.com/a/FeatureServer",
      [-1, 2, 3, 4],
      "2026-06-19",
      "2026-07-23",
      fetcher,
    );
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/a/FeatureServer/0/query");
    expect(url.searchParams.get("geometry")).toBe("-1,2,3,4");
    expect(url.searchParams.get("f")).toBe("geojson");
  });

  it("rejects truncated ArcGIS GeoJSON instead of undercounting exposure", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "FeatureCollection",
            features: [],
            exceededTransferLimit: true,
          }),
        ),
    );
    await expect(
      queryArcGisGeoJson(
        "https://example.com/a/FeatureServer/0",
        [-1, 2, 3, 4],
        "2026-06-19",
        "2026-07-23",
        fetcher,
      ),
    ).rejects.toThrow("truncated");
  });

  it("times out stalled NASA disaster requests", async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    await expect(
      fetchVisibleWebMapLayers("web-map", fetcher, 5),
    ).rejects.toThrow("timed out");
  });
});
