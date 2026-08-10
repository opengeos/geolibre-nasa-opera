import { afterEach, describe, expect, it, vi } from "vitest";
import { OperaControl } from "../src/lib/core/OperaControl";
import type {
  GeoLibreOvertureQuery,
  GeoLibreOvertureQueryResult,
} from "../src/lib/geolibre/host-api";
import type { GeoFeatureCollection } from "../src/lib/opera/geometry";

const water: GeoFeatureCollection = {
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

function building(
  id: string,
  longitude: number,
  latitude: number,
): GeoFeatureCollection["features"][number] {
  const delta = 0.01;
  return {
    type: "Feature",
    properties: { _overture_id: id },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [longitude - delta, latitude - delta],
          [longitude + delta, latitude - delta],
          [longitude + delta, latitude + delta],
          [longitude - delta, latitude + delta],
          [longitude - delta, latitude - delta],
        ],
      ],
    },
  };
}

function queryResult(
  theme: "buildings" | "transportation",
  sourceLayer: string,
  data: GeoFeatureCollection,
): GeoLibreOvertureQueryResult {
  return {
    data,
    release: "2026-07-22.0",
    theme,
    sourceLayer,
    zoom: 12,
    tilesRead: 1,
    matchedFeatureCount: data.features.length,
    truncated: false,
  };
}

function mapStub() {
  const container = document.createElement("div");
  const sources = new Map<string, unknown>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    getContainer: () => container,
    on: vi.fn(),
    off: vi.fn(),
    getBounds: () => ({
      getWest: () => 0,
      getSouth: () => 0,
      getEast: () => 1,
      getNorth: () => 1,
    }),
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string, source: unknown) => sources.set(id, source)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    getLayer: vi.fn((id: string) => layers.get(id)),
    addLayer: vi.fn((layer: Record<string, unknown>) => {
      layers.set(String(layer.id), layer);
    }),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    moveLayer: vi.fn(),
    getCanvas: () => ({ style: {} }),
    queryRenderedFeatures: vi.fn(() => []),
  };
  return { map, layers };
}

describe("disaster impact control", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calculates Overture building and transportation flood exposure", async () => {
    const addGeoJsonLayer = vi.fn();
    const activatePlugin = vi.fn(() => true);
    const queryOvertureFeatures = vi.fn(async (query: GeoLibreOvertureQuery) =>
      query.theme === "buildings"
        ? queryResult("buildings", "building", {
            type: "FeatureCollection",
            features: [building("inside", 0.5, 0.5), building("outside", 2, 2)],
          })
        : queryResult("transportation", "segment", {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {
                  _overture_id: "road-1",
                  subtype: "road",
                },
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
                properties: {
                  _overture_id: "ferry-1",
                  subtype: "water",
                },
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [-10, 0.5],
                    [10, 0.5],
                  ],
                },
              },
            ],
          }),
    );
    const control = new OperaControl({
      addGeoJsonLayer,
      activatePlugin,
      queryOvertureFeatures,
    });
    control.lockBenchmarkFromGeoJson(water, { name: "Test flood" });

    const result = await control.overtureInFloodForAgent({
      bbox: [-2, -1, 3, 2],
      addLayers: true,
      computeBuildingArea: true,
    });

    expect(result.ok).toBe(true);
    expect(result.release).toBe("2026-07-22.0");
    expect(result.buildings).toMatchObject({
      total: 2,
      floodedCount: 1,
      fraction: 0.5,
    });
    expect(result.buildings.floodedAreaKm2).toBeGreaterThan(0);
    expect(result.transportation.impactedSegmentCount).toBe(1);
    expect(result.transportation.candidateSegments).toBe(1);
    expect(result.transportation.bySubtype).toEqual({ road: 1 });
    expect(result.transportation.impactedLengthKm).toBeGreaterThan(110);
    expect(activatePlugin).toHaveBeenCalledWith(
      "maplibre-gl-overture-maps",
      expect.objectContaining({
        inspect: true,
        themes: expect.objectContaining({
          buildings: expect.objectContaining({
            layers: expect.objectContaining({
              building: expect.objectContaining({ visible: false }),
            }),
          }),
          transportation: expect.objectContaining({
            layers: expect.objectContaining({
              segment: expect.objectContaining({ visible: false }),
            }),
          }),
        }),
      }),
    );
    expect(queryOvertureFeatures).toHaveBeenCalledTimes(2);
    expect(queryOvertureFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "buildings",
        bbox: [-2, -1, 3, 2],
      }),
    );
    expect(queryOvertureFeatures).toHaveBeenCalledWith(
      expect.not.objectContaining({
        filterGeometry: expect.anything(),
      }),
    );
    expect(addGeoJsonLayer).toHaveBeenCalledTimes(6);
  });

  it("does not report partial Overture exposure when a query is truncated", async () => {
    const queryOvertureFeatures = vi.fn(
      async (query: GeoLibreOvertureQuery) => {
        if (query.theme !== "buildings" && query.theme !== "transportation") {
          throw new Error("Unexpected theme.");
        }
        return {
          ...queryResult(query.theme, query.sourceLayer, {
            type: "FeatureCollection",
            features: [],
          }),
          truncated: query.theme === "buildings",
        };
      },
    );
    const control = new OperaControl({ queryOvertureFeatures });
    control.lockBenchmarkFromGeoJson(water, { name: "Test flood" });

    const result = await control.overtureInFloodForAgent();

    expect(result.ok).toBe(false);
    expect(result.status).toMatch(/feature limit/i);
    expect(result.buildings.floodedCount).toBe(0);
  });

  it("calculates WorldPop exposure for a locked flood", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "finished",
              data: { total_population: 12345.6 },
            }),
            { status: 200 },
          ),
      ),
    );
    const control = new OperaControl();
    control.lockBenchmarkFromGeoJson(water, { name: "Test flood" });

    const result = await control.populationInFloodForAgent({
      addLayer: false,
    });

    expect(result).toMatchObject({
      ok: true,
      totalPopulation: 12345.6,
      year: 2020,
    });
    expect(result.status).toContain("modeled residential population");
  });

  it("keeps the WorldPop map layer when exposure statistics fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("statistics unavailable");
      }),
    );
    const registerLayer = vi.fn();
    const control = new OperaControl({ registerLayer });
    const { map, layers } = mapStub();
    control.renderDocked(document.createElement("div"), map as never);
    control.lockBenchmarkFromGeoJson(water, { name: "Test flood" });

    const result = await control.populationInFloodForAgent({
      addLayer: true,
    });

    expect(result).toMatchObject({
      ok: false,
      layerId: "opera-impact-worldpop",
    });
    expect(result.status).toContain("Added the WorldPop 2020 population layer");
    expect(layers.has("opera-impact-worldpop-raster")).toBe(true);
    expect(registerLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "opera-impact-worldpop",
        metadata: expect.objectContaining({
          sourceKind: "worldpop-population",
        }),
      }),
    );
    control.teardownDocked();
  });

  it("registers styled impact layers with the GeoLibre host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "finished",
              data: { total_population: 500 },
            }),
            { status: 200 },
          ),
      ),
    );
    const registerLayer = vi.fn();
    const addLayerGroup = vi.fn(() => "overture-group");
    const queryOvertureFeatures = vi.fn(async (query: GeoLibreOvertureQuery) =>
      query.theme === "buildings"
        ? queryResult("buildings", "building", {
            type: "FeatureCollection",
            features: [building("inside", 0.5, 0.5)],
          })
        : queryResult("transportation", "segment", {
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
            ],
          }),
    );
    const control = new OperaControl({
      registerLayer,
      unregisterLayer: vi.fn(),
      addLayerGroup,
      removeLayerGroup: vi.fn(),
      queryOvertureFeatures,
    });
    const { map, layers } = mapStub();
    control.renderDocked(document.createElement("div"), map as never);
    control.lockBenchmarkFromGeoJson(water, { name: "Styled flood" });

    await control.overtureInFloodForAgent();
    await control.populationInFloodForAgent();

    expect(layers.get("opera-impact-overture-buildings-fill")?.paint).toEqual({
      "fill-color": "#dc2626",
      "fill-opacity": 0.68,
    });
    expect(
      layers.get("opera-impact-overture-transportation-line")?.paint,
    ).toEqual({
      "line-color": "#f97316",
      "line-opacity": 0.92,
      "line-width": 3,
    });
    expect(layers.get("opera-context-overture-road-line")?.paint).toEqual({
      "line-color": "#475569",
      "line-opacity": 0.5,
      "line-width": 1.2,
    });
    expect(layers.get("opera-impact-worldpop-raster")?.paint).toEqual({
      "raster-opacity": 0.55,
      "raster-resampling": "linear",
    });
    expect(registerLayer.mock.calls.map(([layer]) => layer.id)).toEqual([
      "opera-context-overture-buildings",
      "opera-context-overture-road",
      "opera-impact-overture-buildings",
      "opera-impact-overture-transportation",
      "opera-impact-worldpop",
    ]);
    expect(addLayerGroup).toHaveBeenCalledWith(
      "Overture exposure - Styled flood",
      [
        "opera-context-overture-buildings",
        "opera-context-overture-road",
        "opera-impact-overture-buildings",
        "opera-impact-overture-transportation",
      ],
    );
    control.teardownDocked();
  });

  it("adds open Sentinel-2 event imagery as a host raster layer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/stac/v1/search")) {
          return new Response(
            JSON.stringify({
              features: [
                {
                  id: "S2_TEST",
                  collection: "sentinel-2-l2a",
                  bbox: [0, 0, 1, 1],
                  properties: {
                    datetime: "2024-11-02T10:00:00Z",
                    "eo:cloud_cover": 3,
                  },
                  assets: {
                    tilejson: {
                      href: "https://tiles.example/sentinel-2.json",
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            tiles: ["https://tiles.example/{z}/{x}/{y}.png"],
            bounds: [0, 0, 1, 1],
            minzoom: 0,
            maxzoom: 14,
          }),
          { status: 200 },
        );
      }),
    );
    const registerLayer = vi.fn();
    const control = new OperaControl({ registerLayer });
    control.lockBenchmarkFromGeoJson(water, { name: "Imagery flood" });

    const result = await control.sentinel2ImageryForAgent({
      start: "2024-10-29",
      end: "2024-11-05",
      opacity: 0.8,
    });

    expect(result).toMatchObject({
      ok: true,
      itemId: "S2_TEST",
      cloudCover: 3,
      layerId: "sentinel-2-S2-TEST",
    });
    expect(registerLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sentinel-2-S2-TEST",
        opacity: 0.8,
        source: expect.objectContaining({
          attribution:
            "Copernicus Sentinel-2 data via Microsoft Planetary Computer",
        }),
        metadata: expect.objectContaining({
          sourceKind: "sentinel-2-event-imagery",
          itemId: "S2_TEST",
        }),
      }),
    );
  });

  it("groups automatic pre-event Sentinel-2 imagery separately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/stac/v1/search")) {
          return new Response(
            JSON.stringify({
              features: [
                {
                  id: "S2_PRE",
                  bbox: [0, 0, 1, 1],
                  properties: {
                    datetime: "2024-10-20T10:00:00Z",
                    "eo:cloud_cover": 2,
                  },
                  assets: {
                    tilejson: {
                      href: "https://tiles.example/sentinel-2-pre.json",
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            tiles: ["https://tiles.example/{z}/{x}/{y}.png"],
            bounds: [0, 0, 1, 1],
          }),
          { status: 200 },
        );
      }),
    );
    const addLayerGroup = vi.fn(() => "sentinel-pre-group");
    const registerLayer = vi.fn();
    const control = new OperaControl({ addLayerGroup, registerLayer });

    const result = await control.sentinel2ImageryForAgent({
      bbox: [0, 0, 1, 1],
      start: "2024-09-27",
      end: "2024-10-26",
      period: "pre-event",
      eventName: "Valencia flood",
    });

    expect(result.layerId).toBe("sentinel-2-pre-event-S2-PRE");
    expect(addLayerGroup).toHaveBeenCalledWith(
      "Pre-event Sentinel-2 - Valencia flood",
      ["sentinel-2-pre-event-S2-PRE"],
    );
    expect(registerLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sentinel-2-pre-event-S2-PRE",
        metadata: expect.objectContaining({ period: "pre-event" }),
      }),
    );
  });

  it("runs the full flood workflow from place and dates", async () => {
    const addLayerGroup = vi.fn((name: string) => `group-${name}`);
    const geocodePlace = vi.fn(async () => ({
      bbox: [-0.95, 39.1, -0.05, 39.8] as [number, number, number, number],
      displayName: "Valencia Region, Spain",
    }));
    const control = new OperaControl({ addLayerGroup, geocodePlace });
    vi.spyOn(control, "searchForAgent").mockResolvedValue({
      ok: true,
      status: "Found pre-event OPERA.",
      product: "OPERA_L3_DSWX-HLS_V1",
      granules: [{ id: "PRE", bands: ["B01_WTR"], linkCount: 1 }],
    });
    vi.spyOn(control, "displayForAgent").mockResolvedValue({
      ok: true,
      status: "Displayed pre-event OPERA.",
      product: "OPERA_L3_DSWX-HLS_V1",
      granules: [],
      displayedLayerIds: ["opera-pre"],
      selectedGranuleIds: ["PRE"],
    });
    vi.spyOn(control, "deriveFloodBenchmarkForAgent").mockResolvedValue({
      ok: true,
      status: "Derived flood.",
      dswxLayerIds: ["opera-post"],
      granulesUsed: 1,
    });
    vi.spyOn(control, "sentinel2ImageryForAgent").mockImplementation(
      async (params) => ({
        ok: true,
        status: `Added ${params.period}.`,
        provider: "Sentinel-2",
        layerId: `sentinel-${params.period}`,
      }),
    );
    vi.spyOn(control, "overtureInFloodForAgent").mockResolvedValue({
      ok: true,
      status: "Mapped Overture exposure.",
      contextPluginActivated: true,
      layerIds: ["buildings", "roads"],
      buildings: {
        total: 10,
        floodedCount: 2,
        fraction: 0.2,
        source: "Overture Maps",
      },
      transportation: {
        candidateSegments: 5,
        impactedSegmentCount: 1,
        impactedLengthKm: 2,
        bySubtype: { road: 1 },
        source: "Overture Maps roads",
      },
    });
    vi.spyOn(control, "populationInFloodForAgent").mockResolvedValue({
      ok: true,
      status: "Mapped population.",
      totalPopulation: 100,
      year: 2020,
      source: "WorldPop",
    });
    vi.spyOn(control, "buildOnePagerForAgent").mockResolvedValue({
      ok: true,
      status: "One-pager ready and downloaded.",
      filename: "opera-one-pager-valencia-region-spain-flood.html",
    });

    const result = await control.mapDisasterEventForAgent({
      hazard: "flood",
      place: "Valencia Region, Spain",
      start: "2024-10-27",
      end: "2024-11-05",
    });

    expect(result.ok).toBe(true);
    expect(result.bbox).toEqual([-0.95, 39.1, -0.05, 39.8]);
    expect(geocodePlace).toHaveBeenCalledWith("Valencia Region, Spain");
    expect(result.windows).toEqual({
      preEvent: { start: "2024-09-27", end: "2024-10-26" },
      event: { start: "2024-10-27", end: "2024-11-05" },
      postEvent: { start: "2024-11-05", end: "2024-11-19" },
    });
    expect(control.deriveFloodBenchmarkForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "2024-10-27",
        end: "2024-11-05",
        place: "Valencia Region, Spain",
      }),
    );
    expect(control.searchForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        bbox: [-0.95, 39.1, -0.05, 39.8],
        addFootprints: false,
        fitBounds: false,
      }),
    );
    expect(control.displayForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        clipBounds: [-0.95, 39.1, -0.05, 39.8],
        fitBounds: false,
      }),
    );
    expect(control.sentinel2ImageryForAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        period: "pre-event",
        start: "2024-09-27",
        end: "2024-10-26",
      }),
    );
    expect(control.sentinel2ImageryForAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        period: "post-event",
        start: "2024-11-05",
        end: "2024-11-19",
      }),
    );
    expect(control.overtureInFloodForAgent).toHaveBeenCalledWith({
      bbox: [-0.95, 39.1, -0.05, 39.8],
      addLayers: true,
      computeBuildingArea: true,
      maxFeatures: 250_000,
    });
    expect(control.buildOnePagerForAgent).toHaveBeenCalledWith({
      buildings: {
        floodedCount: 2,
        total: 10,
        fraction: 0.2,
        floodedAreaKm2: undefined,
        source: "Overture Maps",
      },
      population: {
        totalPopulation: 100,
        year: 2020,
        source: "WorldPop",
      },
      transportation: {
        impactedSegmentCount: 1,
        impactedLengthKm: 2,
        source: "Overture Maps roads",
      },
      download: true,
    });
    expect(
      vi.mocked(control.populationInFloodForAgent).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(control.buildOnePagerForAgent).mock.invocationCallOrder[0],
    );
    expect(result.onePager).toMatchObject({
      ok: true,
      filename: "opera-one-pager-valencia-region-spain-flood.html",
    });
    expect(result.status).toContain("one-pager was downloaded");
    expect(addLayerGroup).toHaveBeenCalledWith(
      "Pre-event OPERA - Valencia Region, Spain flood",
      ["opera-pre"],
    );
    expect(addLayerGroup).toHaveBeenCalledWith(
      "Post-event OPERA - Valencia Region, Spain flood",
      ["opera-post"],
    );
  });

  it("uses a user-drawn AOI before supplied or geocoded bounds", async () => {
    const drawnAoi: [number, number, number, number] = [
      -0.72, 39.2, -0.18, 39.62,
    ];
    const geocodePlace = vi.fn(async () => ({
      bbox: [-2, 38, 1, 41] as [number, number, number, number],
      displayName: "Valencia Region, Spain",
    }));
    const control = new OperaControl({ geocodePlace });
    control.setState({ agentAoiBBox: drawnAoi });
    vi.spyOn(control, "mapDisasterContextForAgent").mockResolvedValue({
      ok: true,
      status: "Mapped context.",
      hazard: "wildfire",
      bbox: drawnAoi,
      overtureContextActivated: true,
    });
    vi.spyOn(control, "sentinel2ImageryForAgent").mockImplementation(
      async () => ({
        ok: true,
        status: "Added imagery.",
        provider: "Sentinel-2",
      }),
    );

    const result = await control.mapDisasterEventForAgent({
      hazard: "wildfire",
      place: "Valencia Region, Spain",
      bbox: [-1.5, 38, 0.7, 40.8],
      start: "2024-10-27",
      end: "2024-11-05",
    });

    expect(result.bbox).toEqual(drawnAoi);
    expect(geocodePlace).not.toHaveBeenCalled();
    expect(control.mapDisasterContextForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ bbox: drawnAoi }),
    );
  });

  it("uses the default NASA FEDS extent for wildfire exposure", async () => {
    const registerLayer = vi.fn();
    const geocodePlace = vi.fn(async () => ({
      bbox: [-109.1, 37, -102, 41] as [number, number, number, number],
      displayName: "Colorado, United States",
    }));
    const discoverDisasterEvent = vi.fn(async () => ({
      groupId: "colorado-fire-group",
      title: "Colorado Fires July 2026",
      portalUrl:
        "https://gis.earthdata.nasa.gov/portal/home/group.html?id=colorado-fire-group",
      items: [
        {
          id: "feds-web-map",
          title: "Fire Events Data Suite (FEDS) Web Map",
          type: "Web Map",
          portalUrl:
            "https://gis.earthdata.nasa.gov/portal/home/item.html?id=feds-web-map",
          tags: ["NASA", "Wildfire"],
        },
      ],
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              operationalLayers: [
                {
                  title: "FEDS Fire Perimeters",
                  url: "https://example.com/feds/MapServer",
                  layerType: "ArcGISMapServiceLayer",
                },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { fireid: 59297, t: 100 },
                  geometry: water.features[0].geometry,
                },
              ],
            }),
          ),
        ),
    );
    const fitBounds = vi.fn();
    const control = new OperaControl({
      registerLayer,
      geocodePlace,
      discoverDisasterEvent,
      fitBounds,
    });
    const { map } = mapStub();
    control.renderDocked(document.createElement("div"), map as never);
    vi.spyOn(control, "sentinel2ImageryForAgent").mockResolvedValue({
      ok: true,
      status: "Added imagery.",
      provider: "Sentinel-2",
    });
    vi.spyOn(control, "overtureInFloodForAgent").mockResolvedValue({
      ok: true,
      status: "Calculated wildfire exposure.",
      contextPluginActivated: true,
      layerIds: ["buildings", "roads"],
      buildings: {
        total: 10,
        floodedCount: 2,
        fraction: 0.2,
        source: "Overture Maps",
      },
      transportation: {
        candidateSegments: 4,
        impactedSegmentCount: 1,
        impactedLengthKm: 3,
        bySubtype: { road: 1 },
        source: "Overture Maps roads",
      },
    });
    vi.spyOn(control, "populationInFloodForAgent").mockResolvedValue({
      ok: true,
      status: "Calculated population exposure.",
      totalPopulation: 500,
      year: 2020,
      source: "WorldPop",
    });

    const result = await control.mapDisasterEventForAgent({
      hazard: "fire",
      place: "Colorado",
      start: "2026-06-19",
      end: "2026-07-23",
    });

    expect(result.ok).toBe(true);
    expect(result.hazard).toBe("wildfire");
    expect(result.nasaEvent?.groupId).toBe("colorado-fire-group");
    expect(result.sources?.slice(0, 3).map((source) => source.id)).toEqual([
      "nasa-feds",
      "burn-severity",
      "opera-dist",
    ]);
    expect(result.authoritativeLayerIds).toHaveLength(2);
    expect(result.bbox).toEqual([0, 0, 1, 1]);
    expect(control.overtureInFloodForAgent).toHaveBeenCalledWith({
      addLayers: true,
      computeBuildingArea: true,
      maxFeatures: 250_000,
    });
    expect(result.status).toContain("calculated exposure");
    expect(fitBounds).toHaveBeenLastCalledWith([0, 0, 1, 1]);
  });
});
