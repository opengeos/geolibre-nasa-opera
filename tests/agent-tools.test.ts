import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperaAgentTools,
  OPERA_AGENT_SYSTEM_PROMPT,
} from "../src/lib/opera/agent-tools";

describe("OPERA agent tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers OPERA search and display tools", () => {
    const tools = createOperaAgentTools(() => null) as Array<{ name: string }>;

    expect(tools.map((item) => item.name)).toEqual([
      "get_opera_context",
      "search_opera_granules",
      "display_opera_granules",
      "search_and_display_opera",
      "detect_opera_change_between_dates",
      "titiler_cmr_tilejson",
      "titiler_cmr_point_query",
      "titiler_cmr_statistics",
      "titiler_cmr_timeseries_tilejson",
    ]);
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("search_and_display_opera");
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("detect_opera_change_between_dates");
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("OPERA_L3_DSWX-HLS_V1");
  });

  it("forwards search and display inputs to the OPERA control", async () => {
    const control = {
      searchForAgent: vi.fn(async () => ({
        ok: true,
        status: "Found 1 granule(s).",
        product: "OPERA_L3_DSWX-HLS_V1",
        granules: [{ id: "G1", bands: ["B01_WTR"], linkCount: 1 }],
      })),
      displayForAgent: vi.fn(async () => ({
        ok: true,
        status: "Displayed 1 granule(s).",
        product: "OPERA_L3_DSWX-HLS_V1",
        granules: [{ id: "G1", bands: ["B01_WTR"], linkCount: 1 }],
        displayedLayerIds: ["opera-cog-g1-b01-wtr"],
        selectedGranuleIds: ["G1"],
      })),
    };
    const tools = createOperaAgentTools(() => control as never) as Array<{
      name: string;
      _callback: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    await tools
      .find((item) => item.name === "search_and_display_opera")!
      ._callback({
        product: "DSWX-HLS",
        bbox: [-122, 37, -121, 38],
        start: "2024-01-01",
        end: "2024-01-31",
        count: 5,
        max_granules: 1,
        band: "B01_WTR",
      });

    expect(control.searchForAgent).toHaveBeenCalledWith({
      product: "DSWX-HLS",
      bbox: [-122, 37, -121, 38],
      start: "2024-01-01",
      end: "2024-01-31",
      count: 5,
    });
    expect(control.displayForAgent).toHaveBeenCalledWith({
      granuleIds: undefined,
      maxGranules: 1,
      band: "B01_WTR",
      rescale: undefined,
      colormapName: undefined,
      expression: undefined,
    });
  });

  it("forwards change detection inputs to the OPERA control", async () => {
    const control = {
      detectChangeForAgent: vi.fn(async () => ({
        ok: true,
        status: "Change detection complete.",
        product: "OPERA_L3_DSWX-HLS_V1",
        band: "B01_WTR",
        displayedLayerIds: ["before-layer", "after-layer"],
      })),
    };
    const tools = createOperaAgentTools(() => control as never) as Array<{
      name: string;
      _callback: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    const result = await tools
      .find((item) => item.name === "detect_opera_change_between_dates")!
      ._callback({
        product: "DSWX-HLS",
        bbox: [-122, 37, -121, 38],
        before_date: "2024-02-01",
        after_date: "2024-03-01",
        window_days: 5,
        band: "B01_WTR",
        colormap_name: "blues",
      });

    expect(control.detectChangeForAgent).toHaveBeenCalledWith({
      product: "DSWX-HLS",
      bbox: [-122, 37, -121, 38],
      beforeDate: "2024-02-01",
      afterDate: "2024-03-01",
      windowDays: 5,
      band: "B01_WTR",
      rescale: undefined,
      colormapName: "blues",
      expression: undefined,
    });
    expect(result).toMatchObject({
      ok: true,
      displayedLayerIds: ["before-layer", "after-layer"],
    });
  });

  it("fetches advanced titiler-cmr tilejson and registers it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tiles: ["https://tiles.example/{z}/{x}/{y}.png?tilesize=512"],
          bounds: [-122, 37, -121, 38],
          minzoom: 6,
          maxzoom: 14,
        }),
      })),
    );
    const control = {
      getAgentContext: vi.fn(() => ({
        endpoint: "https://host/api/titiler-cmr",
      })),
      registerTileJsonForAgent: vi.fn(() => ({
        ok: true,
        layerId: "layer-1",
        status: "Registered",
      })),
    };
    const tools = createOperaAgentTools(() => control as never) as Array<{
      name: string;
      _callback: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    const result = await tools
      .find((item) => item.name === "titiler_cmr_tilejson")!
      ._callback({
        backend: "xarray",
        collection_concept_id: "C2-X",
        variables: ["water"],
        group: "/science/grids",
        sel: { time: "2024-02-01T00:00:00Z" },
        name: "Xarray water",
        add_to_map: true,
      });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/xarray/WebMercatorQuad/tilejson.json?"),
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(control.registerTileJsonForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Xarray water",
        tilejson: expect.objectContaining({ tiles: expect.any(Array) }),
        metadata: expect.objectContaining({
          sourceKind: "titiler-cmr-advanced",
          backend: "xarray",
        }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      backend: "xarray",
      layer: { ok: true, layerId: "layer-1" },
    });
  });
});
