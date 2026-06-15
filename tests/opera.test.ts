import { afterEach, describe, it, expect, vi } from "vitest";
import { getLayerBand } from "../src/lib/opera/cmr";
import { bandRenderDefaults } from "../src/lib/opera/products";
import {
  buildPointUrl,
  buildTileJsonUrl,
  fetchPoint,
  granuleDatetime,
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
