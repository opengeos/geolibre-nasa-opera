import { describe, expect, it } from "vitest";
import {
  colormapForBand,
  dswxWaterOnlyColormap,
  DSWX_WTR_COLORMAP,
  DSWX_WTR_WATER_ONLY_COLORMAP,
} from "../src/lib/opera/colormaps";

describe("DSWx colormaps", () => {
  it("returns the full class colormap for a DSWx WTR band by default", () => {
    expect(colormapForBand("OPERA_L3_DSWX-HLS_V1", "B01_WTR")).toBe(
      JSON.stringify(DSWX_WTR_COLORMAP),
    );
  });

  it("returns the water-only colormap when waterOnly is set", () => {
    expect(
      colormapForBand("OPERA_L3_DSWX-HLS_V1", "B01_WTR", { waterOnly: true }),
    ).toBe(dswxWaterOnlyColormap());
  });

  it("water-only keeps water classes opaque and hides cloud/ocean/no-data", () => {
    // Open water and partial surface water stay identical to the full colormap.
    expect(DSWX_WTR_WATER_ONLY_COLORMAP["1"]).toEqual(DSWX_WTR_COLORMAP["1"]);
    expect(DSWX_WTR_WATER_ONLY_COLORMAP["2"]).toEqual(DSWX_WTR_COLORMAP["2"]);
    // Cloud (253), ocean-masked (254), and snow/ice (252) become transparent.
    for (const cls of ["252", "253", "254"]) {
      expect(DSWX_WTR_WATER_ONLY_COLORMAP[cls][3]).toBe(0);
      expect(DSWX_WTR_COLORMAP[cls][3]).toBe(255);
    }
  });

  it("water-only flag does not affect non-DSWx bands", () => {
    expect(
      colormapForBand("OPERA_L2_RTC-S1_V1", "VV", { waterOnly: true }),
    ).toBeUndefined();
    expect(colormapForBand("OPERA_L3_DSWX-HLS_V1", undefined)).toBeUndefined();
  });
});
