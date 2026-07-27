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
    expect(result.transportation.impactedLengthKm).toBeGreaterThan(110);
    expect(activatePlugin).toHaveBeenCalledWith(
      "maplibre-gl-overture-maps",
      expect.objectContaining({ inspect: true }),
    );
    expect(queryOvertureFeatures).toHaveBeenCalledTimes(2);
    expect(addGeoJsonLayer).toHaveBeenCalledTimes(3);
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
    expect(layers.get("opera-impact-worldpop-raster")?.paint).toEqual({
      "raster-opacity": 0.55,
      "raster-resampling": "linear",
    });
    expect(registerLayer.mock.calls.map(([layer]) => layer.id)).toEqual([
      "opera-impact-overture-buildings",
      "opera-impact-overture-transportation",
      "opera-impact-worldpop",
    ]);
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
});
