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
      "analyze_opera_time_series",
      "export_opera_change_report",
      "titiler_cmr_tilejson",
      "titiler_cmr_point_query",
      "titiler_cmr_statistics",
      "titiler_cmr_timeseries_tilejson",
      "get_benchmark",
      "derive_flood_benchmark",
      "buildings_in_flood",
      "news_impact_search",
      "build_one_pager",
    ]);
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("search_and_display_opera");
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("detect_opera_change_between_dates");
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("analyze_opera_time_series");
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("OPERA_L3_DSWX-HLS_V1");
    expect(OPERA_AGENT_SYSTEM_PROMPT).toContain("benchmark");
  });

  it("gates benchmark tools when no control is active", () => {
    const tools = createOperaAgentTools(() => null) as Array<{
      name: string;
      _callback: (input: Record<string, unknown>) => unknown;
    }>;
    const getBenchmark = tools.find((t) => t.name === "get_benchmark")!;
    // With no active control, controlOrThrow throws.
    expect(() => getBenchmark._callback({})).toThrow(/not active/i);
  });

  it("forwards benchmark workflow inputs to the control", async () => {
    const control = {
      getBenchmarkForAgent: vi.fn(() => ({ ok: true, status: "Benchmark locked" })),
      buildingsInFloodForAgent: vi.fn(async () => ({
        ok: true,
        status: "Found 5 building(s) within the flood extent.",
        total: 20,
        floodedCount: 5,
        fraction: 0.25,
        source: "OpenStreetMap (Overpass)",
      })),
      newsImpactSearchForAgent: vi.fn(async () => ({
        ok: true,
        status: "Found 2 news result(s).",
        results: [],
      })),
      buildOnePagerForAgent: vi.fn(async () => ({
        ok: true,
        status: "One-pager ready and downloaded.",
        filename: "opera-one-pager-valencia.html",
      })),
    };
    const tools = createOperaAgentTools(() => control as never) as Array<{
      name: string;
      _callback: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    await tools.find((t) => t.name === "buildings_in_flood")!._callback({
      add_layer: true,
      compute_area: true,
    });
    expect(control.buildingsInFloodForAgent).toHaveBeenCalledWith({
      buildingSource: undefined,
      addLayer: true,
      computeArea: true,
    });

    await tools.find((t) => t.name === "news_impact_search")!._callback({
      query: "Valencia flood deaths",
      max_results: 5,
    });
    expect(control.newsImpactSearchForAgent).toHaveBeenCalledWith({
      query: "Valencia flood deaths",
      maxResults: 5,
    });

    await tools.find((t) => t.name === "build_one_pager")!._callback({
      title: "Valencia DANA",
      impacts: [
        { claim: "Fatalities", value: "224", source_url: "https://example.com/a", date: "2024-11" },
      ],
      buildings: { flooded_count: 5, total: 20, fraction: 0.25 },
    });
    const onePagerArg = control.buildOnePagerForAgent.mock.calls[0][0];
    expect(onePagerArg.title).toBe("Valencia DANA");
    expect(onePagerArg.impacts[0]).toMatchObject({
      claim: "Fatalities",
      value: "224",
      sourceUrl: "https://example.com/a",
    });
    expect(onePagerArg.buildings).toMatchObject({ floodedCount: 5, total: 20 });
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

  it("forwards time-series and report inputs to the OPERA control", async () => {
    const control = {
      analyzeTimeSeriesForAgent: vi.fn(async () => ({
        ok: true,
        status: "Analyzed 2 observations.",
        product: "OPERA_L3_DSWX-HLS_V1",
        band: "B01_WTR",
        observations: [],
        displayedLayerIds: [],
      })),
      exportChangeReportForAgent: vi.fn(() => ({
        ok: true,
        status: "Prepared markdown change report.",
        filename: "opera-change.md",
        format: "markdown",
        content: "# report",
      })),
    };
    const tools = createOperaAgentTools(() => control as never) as Array<{
      name: string;
      _callback: (input: Record<string, unknown>) => Promise<unknown> | unknown;
    }>;

    await tools
      .find((item) => item.name === "analyze_opera_time_series")!
      ._callback({
        product: "DSWX-HLS",
        bbox: [-122, 37, -121, 38],
        start: "2024-01-01",
        end: "2024-03-01",
        count: 4,
        interval_days: 14,
        band: "B01_WTR",
        display_endpoints: true,
      });
    const report = await tools
      .find((item) => item.name === "export_opera_change_report")!
      ._callback({ format: "markdown" });

    expect(control.analyzeTimeSeriesForAgent).toHaveBeenCalledWith({
      product: "DSWX-HLS",
      bbox: [-122, 37, -121, 38],
      start: "2024-01-01",
      end: "2024-03-01",
      count: 4,
      intervalDays: 14,
      band: "B01_WTR",
      rescale: undefined,
      colormapName: undefined,
      expression: undefined,
      displayEndpoints: true,
    });
    expect(control.exportChangeReportForAgent).toHaveBeenCalledWith({
      format: "markdown",
    });
    expect(report).toMatchObject({
      ok: true,
      filename: "opera-change.md",
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
