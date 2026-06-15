import { describe, it, expect } from "vitest";
import { getLayerBand } from "../src/lib/opera/cmr";
import { bandRenderDefaults } from "../src/lib/opera/products";
import {
  buildTileJsonUrl,
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
