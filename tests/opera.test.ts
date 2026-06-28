import { afterEach, describe, it, expect, vi } from "vitest";
import { getLayerBand } from "../src/lib/opera/cmr";
import { bandRenderDefaults, expressionPresets } from "../src/lib/opera/products";
import {
  buildCmrPointUrl,
  buildCmrStatisticsUrl,
  buildCmrTileJsonUrl,
  buildCmrTimeseriesTileJsonUrl,
  buildPointUrl,
  buildStatisticsUrl,
  buildTileJsonUrl,
  fetchPoint,
  fetchStatistics,
  granuleDatetime,
  resolveDefaultTitilerCmrEndpoint,
  tileSizeFromTemplate,
} from "../src/lib/opera/titiler";

describe("getLayerBand", () => {
  it("extracts a DSWx band token", () => {
    expect(
      getLayerBand(
        "https://example.com/OPERA_L3_DSWx-HLS_T10SEH_..._v1.1_B01_WTR.tif",
      ),
    ).toBe("B01_WTR");
  });

  it("extracts SAR polarization tokens", () => {
    expect(getLayerBand("https://example.com/OPERA_..._VV.tif")).toBe("VV");
    expect(getLayerBand("https://example.com/OPERA_..._VH.tif")).toBe("VH");
  });

  it("falls back to the trailing token", () => {
    expect(getLayerBand("https://example.com/foo_bar_mask.tif")).toBe("mask");
  });
});

describe("buildTileJsonUrl", () => {
  it("resolves configurable default titiler-cmr endpoints", () => {
    expect(resolveDefaultTitilerCmrEndpoint(" https://proxy.example/ ")).toBe(
      "https://proxy.example",
    );
  });

  it("builds the canonical rasterio path with modern param names", () => {
    const url = buildTileJsonUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C123-POCLOUD",
      backend: "rasterio",
      datetime: "2016-01-03T00:00:00Z/2016-01-03T23:59:59Z",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z]+",
      rescale: "0,4",
      colormapName: "viridis",
    });
    expect(url).toContain(
      "/api/titiler-cmr/rasterio/WebMercatorQuad/tilejson.json?",
    );
    expect(url).toContain("collection_concept_id=C123-POCLOUD");
    expect(url).toContain("assets=B01_WTR");
    expect(url).toContain("assets_regex=B%5B0-9%5D%7B2%7D_%5BA-Z%5D%2B");
    expect(url).toContain("temporal=");
    expect(url).toContain("rescale=0%2C4");
    expect(url).toContain("colormap_name=viridis");
  });
});

describe("backend-neutral titiler-cmr URL builders", () => {
  it("builds an xarray tilejson URL with variables, group, and sel", () => {
    const url = buildCmrTileJsonUrl({
      endpoint: "https://host/api/titiler-cmr/",
      backend: "xarray",
      conceptId: "C999-POCLOUD",
      variables: ["water_class", "confidence"],
      group: "/science/grids",
      sel: { time: "2024-02-01T00:00:00Z" },
      rescale: ["0,1", "0,100"],
      colormapName: "viridis",
      extraParams: { decode_times: true },
    });

    expect(url).toContain("/xarray/WebMercatorQuad/tilejson.json?");
    expect(url).toContain("collection_concept_id=C999-POCLOUD");
    expect(url).toContain("variables=water_class");
    expect(url).toContain("variables=confidence");
    expect(url).toContain("group=%2Fscience%2Fgrids");
    expect(url).toContain("sel=%7B%22time%22%3A%222024-02-01T00%3A00%3A00Z%22%7D");
    expect(url).toContain("rescale=0%2C1");
    expect(url).toContain("rescale=0%2C100");
    expect(url).toContain("decode_times=true");
  });

  it("builds rasterio point and statistics URLs with pass-through params", () => {
    const point = buildCmrPointUrl({
      endpoint: "https://host/api/titiler-cmr",
      backend: "rasterio",
      conceptId: "C1-X",
      lon: -120,
      lat: 38,
      assets: ["VV"],
      assetsRegex: "VV|VH",
      extraParams: { nodata: 0 },
    });
    const stats = buildCmrStatisticsUrl({
      endpoint: "https://host/api/titiler-cmr",
      backend: "rasterio",
      conceptId: "C1-X",
      assets: ["B01_WTR"],
      categorical: true,
    });

    expect(point).toContain("/rasterio/point/-120,38?");
    expect(point).toContain("assets=VV");
    expect(point).toContain("assets_regex=VV%7CVH");
    expect(point).toContain("nodata=0");
    expect(stats).toContain("/rasterio/statistics?");
    expect(stats).toContain("categorical=true");
  });

  it("builds a timeseries TileJSON URL", () => {
    const url = buildCmrTimeseriesTileJsonUrl({
      endpoint: "https://host/api/titiler-cmr",
      backend: "xarray",
      conceptId: "C2-X",
      variables: ["band1"],
      temporal: "2024-01-01T00:00:00Z/2024-02-01T00:00:00Z",
      step: "P1D",
      temporalMode: "interval",
    });

    expect(url).toContain("/xarray/timeseries/WebMercatorQuad/tilejson.json?");
    expect(url).toContain("variables=band1");
    expect(url).toContain("temporal=");
    expect(url).toContain("step=P1D");
    expect(url).toContain("temporal_mode=interval");
  });
});

describe("expression band math", () => {
  it("adds expression + asset_as_band to tile/point/stats requests", () => {
    const common = {
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C1-X",
      backend: "rasterio" as const,
      bands: ["VV"],
    };
    const tile = buildTileJsonUrl({ ...common, expression: "10*log10(b1)" });
    const point = buildPointUrl({ ...common, lon: 1, lat: 2, expression: "10*log10(b1)" });
    const stats = buildStatisticsUrl({ ...common, expression: "10*log10(b1)" });
    for (const url of [tile, point, stats]) {
      // "10*log10(b1)" url-encoded.
      expect(url).toContain("expression=10*log10%28b1%29");
      expect(url).toContain("asset_as_band=true");
    }
  });

  it("omits expression params when blank or whitespace", () => {
    const url = buildTileJsonUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C1-X",
      backend: "rasterio",
      bands: ["VV"],
      expression: "   ",
    });
    expect(url).not.toContain("expression");
    expect(url).not.toContain("asset_as_band");
  });
});

describe("expressionPresets", () => {
  it("offers a dB preset for RTC-S1 backscatter bands", () => {
    const presets = expressionPresets("OPERA_L2_RTC-S1_V1", "VV");
    expect(presets).toHaveLength(1);
    expect(presets[0].expression).toBe("10*log10(b1)");
  });

  it("offers water-mask presets for DSWx WTR bands", () => {
    const presets = expressionPresets("OPERA_L3_DSWX-HLS_V1", "B01_WTR");
    expect(presets.map((p) => p.expression)).toEqual([
      "where(b1==1,1,0)",
      "where((b1==1)|(b1==2),1,0)",
    ]);
  });

  it("returns no presets for bands without a preset", () => {
    expect(expressionPresets("OPERA_L3_DSWX-HLS_V1", "B10_DEM")).toEqual([]);
    expect(expressionPresets("OPERA_L2_RTC-S1_V1", "B10_DEM")).toEqual([]);
  });
});

describe("bandRenderDefaults", () => {
  it("leaves DSWx water bands blank (built-in categorical colormap)", () => {
    expect(bandRenderDefaults("OPERA_L3_DSWX-HLS_V1", "B01_WTR")).toEqual({
      rescale: "",
      colormapName: "",
    });
  });

  it("suggests a terrain ramp for DEM", () => {
    expect(bandRenderDefaults("OPERA_L3_DSWX-HLS_V1", "B10_DEM")).toEqual({
      rescale: "0,3000",
      colormapName: "terrain",
    });
  });

  it("suggests a grayscale stretch for SAR polarizations", () => {
    expect(bandRenderDefaults("OPERA_L2_RTC-S1_V1", "VV")).toEqual({
      rescale: "0,0.4",
      colormapName: "gray",
    });
  });

  it("returns blanks for an unknown band with no product defaults", () => {
    expect(bandRenderDefaults("OPERA_L3_DSWX-HLS_V1", "B07_LAND")).toEqual({
      rescale: "",
      colormapName: "",
    });
  });
});

describe("buildPointUrl", () => {
  it("builds the rasterio /point path with lon,lat and CMR params", () => {
    const url = buildPointUrl({
      endpoint: "https://host/api/titiler-cmr/",
      conceptId: "C123-POCLOUD",
      backend: "rasterio",
      lon: -120.5,
      lat: 38.5,
      granuleUr: "OPERA_L3_DSWx-HLS_T10SGH_xyz",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z]+",
    });
    // Trailing slash on the endpoint is normalized away.
    expect(url).toContain(
      "https://host/api/titiler-cmr/rasterio/point/-120.5,38.5?",
    );
    expect(url).toContain("collection_concept_id=C123-POCLOUD");
    expect(url).toContain("granule_ur=OPERA_L3_DSWx-HLS_T10SGH_xyz");
    expect(url).toContain("assets=B01_WTR");
    expect(url).toContain("assets_regex=B%5B0-9%5D%7B2%7D_%5BA-Z%5D%2B");
  });

  it("omits optional params when absent", () => {
    const url = buildPointUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C9-X",
      backend: "rasterio",
      lon: 1,
      lat: 2,
    });
    expect(url).toContain("/rasterio/point/1,2?");
    expect(url).not.toContain("granule_ur");
    expect(url).not.toContain("assets=");
    expect(url).not.toContain("temporal");
  });
});

describe("fetchPoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the titiler-cmr point response to camelCase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          coordinates: [-120.5, 38.5],
          assets: [
            {
              name: "OPERA_L3_DSWx-HLS_T10SGH",
              values: [1, null],
              band_names: ["b1", "b2"],
              band_descriptions: ["Water classification (WTR)", null],
            },
          ],
        }),
      })),
    );
    const result = await fetchPoint("https://host/point/1,2");
    expect(result.coordinates).toEqual([-120.5, 38.5]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      name: "OPERA_L3_DSWx-HLS_T10SGH",
      values: [1, null],
      bandNames: ["b1", "b2"],
    });
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    await expect(fetchPoint("https://host/point/1,2")).rejects.toThrow(
      /point request failed \(404\)/,
    );
  });
});

describe("buildStatisticsUrl", () => {
  it("builds the /statistics path with CMR params and categorical flag", () => {
    const url = buildStatisticsUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C123-POCLOUD",
      backend: "rasterio",
      granuleUr: "OPERA_L3_DSWx-HLS_T10SGH_xyz",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z]+",
      categorical: true,
    });
    expect(url).toContain("/rasterio/statistics?");
    expect(url).toContain("collection_concept_id=C123-POCLOUD");
    expect(url).toContain("granule_ur=OPERA_L3_DSWx-HLS_T10SGH_xyz");
    expect(url).toContain("assets=B01_WTR");
    expect(url).toContain("categorical=true");
  });

  it("omits the categorical flag when not requested", () => {
    const url = buildStatisticsUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C9-X",
      backend: "rasterio",
    });
    expect(url).toContain("/rasterio/statistics?");
    expect(url).not.toContain("categorical");
  });

  it("adds histogram_bins for continuous requests", () => {
    const url = buildStatisticsUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C9-X",
      backend: "rasterio",
      histogramBins: 20,
    });
    expect(url).toContain("histogram_bins=20");
  });

  it("prefers categorical over histogram_bins", () => {
    const url = buildStatisticsUrl({
      endpoint: "https://host/api/titiler-cmr",
      conceptId: "C9-X",
      backend: "rasterio",
      categorical: true,
      histogramBins: 20,
    });
    expect(url).toContain("categorical=true");
    expect(url).not.toContain("histogram_bins");
  });
});

describe("fetchStatistics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the AOI and parses per-band statistics", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        type: "Feature",
        properties: {
          statistics: {
            b1: {
              min: 0,
              max: 253,
              mean: 96.86,
              std: 122.95,
              median: 0,
              count: 252729.7,
              valid_pixels: 253512,
              valid_percent: 83.39,
              histogram: [
                [149265, 6396, 817, 12, 97022],
                [0, 1, 2, 252, 253],
              ],
              percentile_2: 0,
              percentile_98: 253,
              description: "B01_WTR_Water classification (WTR)",
            },
          },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const feature = { type: "Feature", geometry: {}, properties: {} };
    const result = await fetchStatistics("https://host/statistics", feature);

    // The AOI feature is sent as the POST body.
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(feature);

    const b1 = result.bands.b1;
    expect(b1).toMatchObject({
      min: 0,
      max: 253,
      mean: 96.86,
      std: 122.95,
      count: 252729.7,
      validPixels: 253512,
      validPercent: 83.39,
      percentile2: 0,
      percentile98: 253,
    });
    expect(b1.histogram).toEqual([
      [149265, 6396, 817, 12, 97022],
      [0, 1, 2, 252, 253],
    ]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })),
    );
    await expect(
      fetchStatistics("https://host/statistics", {}),
    ).rejects.toThrow(/statistics request failed \(422\)/);
  });
});

describe("granuleDatetime", () => {
  it("joins begin and end", () => {
    expect(granuleDatetime("2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z")).toBe(
      "2020-01-01T00:00:00Z/2020-01-02T00:00:00Z",
    );
  });

  it("repeats a single bound", () => {
    expect(granuleDatetime("2020-01-01T00:00:00Z", undefined)).toBe(
      "2020-01-01T00:00:00Z/2020-01-01T00:00:00Z",
    );
  });

  it("returns undefined with no dates", () => {
    expect(granuleDatetime(undefined, undefined)).toBeUndefined();
  });
});

describe("tileSizeFromTemplate", () => {
  it("reads tilesize from the template", () => {
    expect(
      tileSizeFromTemplate("https://h/tiles/{z}/{x}/{y}?assets=B01&tilesize=512"),
    ).toBe(512);
  });

  it("defaults to 256", () => {
    expect(tileSizeFromTemplate("https://h/tiles/{z}/{x}/{y}?assets=B01")).toBe(
      256,
    );
  });
});
