import { describe, expect, it, vi } from "vitest";
import {
  defaultAuthoritativeSources,
  discoverNasaDisasterEvent,
  fetchVisibleWebMapLayers,
  latestFedsPerimeters,
  normalizeDisasterHazard,
  rankNasaDisasterItems,
} from "../src/lib/opera/disaster-sources";

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

    const event = await discoverNasaDisasterEvent(
      {
        hazard: "wildfire",
        place: "Colorado",
        start: "2026-06-19",
        end: "2026-07-23",
      },
      fetcher,
    );

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
});
