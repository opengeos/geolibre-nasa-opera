import { tool, type JSONValue, type Tool } from "@strands-agents/sdk";
import { z } from "zod";
import type { OperaControl } from "../core/OperaControl";
import type { BBox } from "./types";
import {
  buildCmrPointUrl,
  buildCmrStatisticsUrl,
  buildCmrTileJsonUrl,
  buildCmrTimeseriesTileJsonUrl,
  DEFAULT_TITILER_CMR_ENDPOINT,
  fetchTimeSeriesTileJson,
  fetchTileJson,
  fetchTitilerJson,
} from "./titiler";

export const OPERA_AGENT_SYSTEM_PROMPT = `NASA OPERA domain tools are available for searching and visualizing OPERA satellite products.

Use OPERA tools when the user asks for OPERA, DSWx, RTC-S1, CSLC-S1, DIST, surface water, SAR backscatter, or disturbance data.
- Prefer search_and_display_opera when the user asks to find/show/display OPERA data in one request.
- Use detect_opera_change_between_dates when the user asks to compare two dates, detect change, or create before/after OPERA layers.
- Use analyze_opera_time_series when the user asks for trends, time-series change, repeated observations, or change over time.
- Use export_opera_change_report after change detection when the user asks to export, save, summarize, or download the analysis.
- If the user gives a place but not a bbox, use the current map extent unless you first navigate the map to the place with MapLibre tools.
- For surface water requests, prefer product OPERA_L3_DSWX-HLS_V1 and band B01_WTR unless the user asks for Sentinel-1 DSWx.
- For SAR backscatter, prefer product OPERA_L2_RTC-S1_V1 and band VV unless the user asks for another polarization.
- Keep max_granules small, usually 1-3, unless the user asks for many scenes.
- After displaying OPERA data, summarize product, date range, band, displayed granule count, and any layer ids.

Advanced titiler-cmr tools are also available for backend-aware analysis beyond basic OPERA search/display.
- Use titiler_cmr_tilejson for arbitrary rasterio or xarray TileJSON generation and optional layer registration.
- Use titiler_cmr_point_query for backend-aware pixel/variable sampling.
- Use titiler_cmr_statistics for AOI statistics over bbox or GeoJSON.
- Use titiler_cmr_timeseries_tilejson for time-indexed TileJSON responses.

Constrained flood one-pager workflow. When a benchmark is locked (check get_opera_context or get_benchmark), it is a human-QAed flood water extent and is the AUTHORITATIVE ground truth and spatial boundary. Follow these rules strictly:
- Treat the locked benchmark water polygon as ground truth. Never recompute, redraw, or override it, and do not substitute an OPERA-derived water extent for it.
- Operate only within the benchmark bbox. Frame every spatial answer relative to the flooded area it defines.
- To quantify building exposure, call buildings_in_flood (it intersects the benchmark with OSM buildings). Never invent building counts; report only the numbers the tool returns.
- To gather event impacts, call news_impact_search and report ONLY figures you can attribute to a returned source_url, always with publisher and date. If a figure has no citable source, omit it.
- To show the OPERA-observed flood on the one-pager map, display DSWx (product OPERA_L3_DSWX-HLS_V1, band B01_WTR) for the event dates with water_only=true before calling build_one_pager. water_only hides cloud/ocean/no-data so stacked post-event scenes stay legible; the benchmark remains the authoritative extent.
- To produce the shareable one-pager, call build_one_pager, passing the buildings result and the cited impacts. Pass buildings/impacts exactly as measured; do not fabricate.
- If the user asks for flood analysis but no benchmark is locked, tell them to import and lock a benchmark GeoJSON in the OPERA panel's Benchmark section first.`;

const bboxSchema = z
  .union([z.array(z.number()).length(4), z.string()])
  .optional()
  .describe("Bounding box as [west,south,east,north] or 'west,south,east,north'. Omit to use current map extent.");

const searchSchema = z.object({
  product: z
    .string()
    .optional()
    .describe("OPERA product short_name or label, e.g. OPERA_L3_DSWX-HLS_V1, DSWX-HLS, RTC-S1."),
  bbox: bboxSchema,
  start: z.string().optional().describe("Inclusive start date, YYYY-MM-DD."),
  end: z.string().optional().describe("Inclusive end date, YYYY-MM-DD."),
  count: z.number().int().min(1).max(500).optional(),
});

const displaySchema = z.object({
  granule_ids: z
    .array(z.string())
    .optional()
    .describe("Granule ids from search_opera_granules. Omit to display the first result(s)."),
  max_granules: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max granules to display when granule_ids is omitted."),
  band: z.string().optional().describe("Band/layer token, e.g. B01_WTR, VV, VH, B10_DEM."),
  rescale: z.string().optional().describe("Optional render stretch such as '0,3000'."),
  colormap_name: z.string().optional().describe("Optional titiler named colormap, e.g. terrain, gray, blues."),
  expression: z.string().optional().describe("Optional rio-tiler expression; selected band is b1."),
  water_only: z
    .boolean()
    .optional()
    .describe(
      "DSWx WTR bands only: show open + partial surface water and hide cloud/ocean/no-data. Use when preparing a flood one-pager so stacked scenes stay legible.",
    ),
});

const searchAndDisplaySchema = searchSchema.merge(displaySchema);

const changeDetectionSchema = z.object({
  product: z
    .string()
    .optional()
    .describe("OPERA product short_name or label, e.g. OPERA_L3_DSWX-HLS_V1, DSWX-HLS, RTC-S1."),
  bbox: bboxSchema,
  before_date: z.string().describe("Baseline date, YYYY-MM-DD."),
  after_date: z.string().describe("Comparison date, YYYY-MM-DD."),
  window_days: z
    .number()
    .int()
    .min(0)
    .max(90)
    .optional()
    .describe("Days on each side of each date to search for the nearest granule. Defaults to 7."),
  band: z.string().optional().describe("Band/layer token, e.g. B01_WTR, VV, VH."),
  rescale: z.string().optional().describe("Optional render stretch such as '0,3000'."),
  colormap_name: z.string().optional().describe("Optional titiler named colormap, e.g. gray, blues."),
  expression: z.string().optional().describe("Optional rio-tiler expression; selected band is b1."),
});

const timeSeriesSchema = z.object({
  product: z
    .string()
    .optional()
    .describe("OPERA product short_name or label, e.g. OPERA_L3_DSWX-HLS_V1, DSWX-HLS, RTC-S1."),
  bbox: bboxSchema,
  start: z.string().describe("Inclusive start date, YYYY-MM-DD."),
  end: z.string().describe("Inclusive end date, YYYY-MM-DD."),
  count: z.number().int().min(1).max(100).optional().describe("Max observations to analyze. Defaults to 12."),
  interval_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Optional sampling interval in days. The closest granule per interval is used."),
  band: z.string().optional().describe("Band/layer token, e.g. B01_WTR, VV, VH."),
  rescale: z.string().optional().describe("Optional render stretch such as '0,3000'."),
  colormap_name: z.string().optional().describe("Optional titiler named colormap, e.g. gray, blues."),
  expression: z.string().optional().describe("Optional rio-tiler expression; selected band is b1."),
  display_endpoints: z.boolean().optional().describe("Display the first and last observations as map layers."),
});

const changeReportSchema = z.object({
  format: z.enum(["markdown", "json"]).optional().describe("Report format. Defaults to markdown."),
});

const backendSchema = z.enum(["rasterio", "xarray"]);
const queryValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

const titilerCommonSchema = z.object({
  backend: backendSchema.describe("titiler-cmr backend: rasterio for COG/GeoTIFF, xarray for NetCDF/HDF5/Zarr."),
  collection_concept_id: z.string().describe("CMR collection concept id, e.g. C2021957657-LPCLOUD."),
  endpoint: z.string().optional().describe("titiler-cmr endpoint. Omit to use the OPERA panel endpoint."),
  granule_ur: z.string().optional().describe("Exact CMR GranuleUR to pin the request."),
  temporal: z.string().optional().describe("Temporal filter as RFC3339 instant/range, e.g. 2024-02-01T00:00:00Z/2024-03-01T00:00:00Z."),
  assets: z.array(z.string()).optional().describe("Rasterio asset names, repeated as assets=."),
  assets_regex: z.string().optional().describe("Rasterio asset regex."),
  variables: z.array(z.string()).optional().describe("Xarray variable names, repeated as variables=."),
  group: z.string().optional().describe("Xarray group path."),
  sel: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Xarray dimension selector, object or JSON string."),
  rescale: z.union([z.string(), z.array(z.string())]).optional().describe("One or more rescale values, e.g. '0,1'."),
  colormap_name: z.string().optional(),
  colormap: z.string().optional().describe("Explicit titiler colormap JSON."),
  expression: z.string().optional().describe("Expression using b1, b2, ..."),
  minzoom: z.number().int().optional(),
  maxzoom: z.number().int().optional(),
  extra_params: z.record(z.string(), queryValueSchema).optional().describe("Extra titiler-cmr query parameters passed through as-is."),
});

const titilerTileJsonSchema = titilerCommonSchema.extend({
  name: z.string().optional().describe("Layer name when add_to_map is true."),
  add_to_map: z.boolean().optional().describe("Register the returned TileJSON as a map raster layer."),
  opacity: z.number().min(0).max(1).optional(),
  fit_bounds: z.boolean().optional(),
});

const titilerPointSchema = titilerCommonSchema.extend({
  lon: z.number(),
  lat: z.number(),
});

const titilerStatisticsSchema = titilerCommonSchema.extend({
  bbox: z
    .array(z.number())
    .length(4)
    .optional()
    .describe("AOI bbox [west,south,east,north]. Omit if geojson is provided."),
  geojson: z.unknown().optional().describe("AOI GeoJSON Feature or FeatureCollection."),
  categorical: z.boolean().optional(),
  histogram_bins: z.number().int().min(1).optional(),
});

const titilerTimeseriesSchema = titilerTileJsonSchema.extend({
  step: z.string().optional().describe("ISO-8601 duration step, e.g. P1D, P1W, P1M."),
  temporal_mode: z.enum(["point", "interval"]).optional(),
  add_first_to_map: z.boolean().optional().describe("Register the first returned timeseries TileJSON as a map layer."),
});

const buildingsInFloodSchema = z.object({
  building_source: z
    .enum(["osm"])
    .optional()
    .describe("Ancillary building source. Only 'osm' (OSM/Overpass) is supported."),
  add_layer: z.boolean().optional().describe("Draw the flooded buildings as a map layer."),
  compute_area: z.boolean().optional().describe("Also sum flooded building footprint area (km²)."),
});

const newsImpactSchema = z.object({
  query: z
    .string()
    .describe("News search query, e.g. 'Valencia flood October 2024 deaths damages displaced'."),
  max_results: z.number().int().min(1).max(20).optional(),
});

const impactSchema = z.object({
  claim: z.string().describe("What the figure measures, e.g. 'Fatalities', 'Economic loss'."),
  value: z.string().describe("The figure as text, e.g. '224', '$4.2B'."),
  source_url: z.string().describe("Article URL the figure is cited from (required)."),
  publisher: z.string().optional(),
  date: z.string().optional(),
});

const onePagerSchema = z.object({
  title: z.string().optional(),
  narrative: z.string().optional().describe("Background paragraph describing the event."),
  impacts: z.array(impactSchema).optional().describe("Cited impact figures. Every entry needs a source_url."),
  buildings: z
    .object({
      flooded_count: z.number(),
      total: z.number(),
      fraction: z.number(),
      flooded_area_km2: z.number().optional(),
      source: z.string().optional(),
    })
    .optional()
    .describe("Building-exposure result from buildings_in_flood."),
  map_snapshot_data_url: z
    .string()
    .optional()
    .describe("Optional map PNG data URL. Omit to let the plugin capture the current map."),
  download: z.boolean().optional().describe("Download the HTML (default true)."),
});

type TitilerCommonInput = z.infer<typeof titilerCommonSchema>;

export function createOperaAgentTools(getControl: () => OperaControl | null): Tool[] {
  const controlOrThrow = (): OperaControl => {
    const control = getControl();
    if (!control) {
      throw new Error("NASA OPERA control is not active.");
    }
    return control;
  };

  return [
    tool({
      name: "get_opera_context",
      description:
        "Return supported OPERA products, current OPERA search settings, latest granule results, selected granules, and endpoint.",
      inputSchema: z.object({}),
      callback: () => toJsonValue(controlOrThrow().getAgentContext()),
    }),
    tool({
      name: "search_opera_granules",
      description:
        "Search NASA CMR for OPERA granules. Results also populate the OPERA panel and add footprint layers to the map.",
      inputSchema: searchSchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().searchForAgent({
          product: input.product,
          bbox: input.bbox as BBox | string | undefined,
          start: input.start,
          end: input.end,
          count: input.count,
        })),
    }),
    tool({
      name: "display_opera_granules",
      description:
        "Display selected OPERA granules from the latest search as titiler-cmr raster layers on the map.",
      inputSchema: displaySchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().displayForAgent({
          granuleIds: input.granule_ids,
          maxGranules: input.max_granules,
          band: input.band,
          rescale: input.rescale,
          colormapName: input.colormap_name,
          expression: input.expression,
          waterOnly: input.water_only,
        })),
    }),
    tool({
      name: "search_and_display_opera",
      description:
        "Search NASA CMR for OPERA granules and immediately display the first matching granule(s) as titiler-cmr raster layers.",
      inputSchema: searchAndDisplaySchema,
      callback: async (input) => {
        const control = controlOrThrow();
        const search = await control.searchForAgent({
          product: input.product,
          bbox: input.bbox as BBox | string | undefined,
          start: input.start,
          end: input.end,
          count: input.count,
        });
        if (!search.ok || search.granules.length === 0) {
          return toJsonValue({ search, display: null });
        }
        const display = await control.displayForAgent({
          granuleIds: input.granule_ids,
          maxGranules: input.max_granules,
          band: input.band,
          rescale: input.rescale,
          colormapName: input.colormap_name,
          expression: input.expression,
          waterOnly: input.water_only,
        });
        return toJsonValue({ search, display });
      },
    }),
    tool({
      name: "detect_opera_change_between_dates",
      description:
        "Find the closest OPERA granules around two dates, display before/after layers, and compute AOI change statistics.",
      inputSchema: changeDetectionSchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().detectChangeForAgent({
          product: input.product,
          bbox: input.bbox as BBox | string | undefined,
          beforeDate: input.before_date,
          afterDate: input.after_date,
          windowDays: input.window_days,
          band: input.band,
          rescale: input.rescale,
          colormapName: input.colormap_name,
          expression: input.expression,
        })),
    }),
    tool({
      name: "analyze_opera_time_series",
      description:
        "Analyze AOI statistics across OPERA granules over a date range and return first-to-last trend metrics. Can display first/last layers.",
      inputSchema: timeSeriesSchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().analyzeTimeSeriesForAgent({
          product: input.product,
          bbox: input.bbox as BBox | string | undefined,
          start: input.start,
          end: input.end,
          count: input.count,
          intervalDays: input.interval_days,
          band: input.band,
          rescale: input.rescale,
          colormapName: input.colormap_name,
          expression: input.expression,
          displayEndpoints: input.display_endpoints,
        })),
    }),
    tool({
      name: "export_opera_change_report",
      description:
        "Return a Markdown or JSON report for the latest OPERA change detection result.",
      inputSchema: changeReportSchema,
      callback: (input) =>
        toJsonValue(controlOrThrow().exportChangeReportForAgent({
          format: input.format,
        })),
    }),
    tool({
      name: "titiler_cmr_tilejson",
      description:
        "Generate a titiler-cmr TileJSON using either rasterio or xarray backend. Optionally registers it as a raster layer on the map.",
      inputSchema: titilerTileJsonSchema,
      callback: async (input) => {
        const control = controlOrThrow();
        const url = buildCmrTileJsonUrl(commonParams(control, input));
        const tilejson = await fetchTileJson(url);
        const layer =
          input.add_to_map || input.add_to_map === undefined
            ? control.registerTileJsonForAgent({
                name:
                  input.name ??
                  `titiler-cmr ${input.backend} ${input.collection_concept_id}`,
                tilejson,
                opacity: input.opacity,
                fitBounds: input.fit_bounds,
                metadata: {
                  sourceKind: "titiler-cmr-advanced",
                  backend: input.backend,
                  collectionConceptId: input.collection_concept_id,
                  url,
                },
              })
            : null;
        return toJsonValue({
          ok: true,
          url,
          backend: input.backend,
          tileCount: tilejson.tiles.length,
          bounds: tilejson.bounds,
          minzoom: tilejson.minzoom,
          maxzoom: tilejson.maxzoom,
          layer,
        });
      },
    }),
    tool({
      name: "titiler_cmr_point_query",
      description:
        "Sample pixel values or xarray variables at a lon/lat point using titiler-cmr rasterio or xarray backend.",
      inputSchema: titilerPointSchema,
      callback: async (input) => {
        const control = controlOrThrow();
        const url = buildCmrPointUrl({
          ...commonParams(control, input),
          lon: input.lon,
          lat: input.lat,
        });
        const result = await fetchTitilerJson(url);
        return toJsonValue({ ok: true, url, result });
      },
    }),
    tool({
      name: "titiler_cmr_statistics",
      description:
        "Compute titiler-cmr rasterio or xarray statistics over a bbox or supplied GeoJSON AOI.",
      inputSchema: titilerStatisticsSchema,
      callback: async (input) => {
        const control = controlOrThrow();
        const feature = input.geojson ?? (input.bbox ? bboxFeature(input.bbox) : null);
        if (!feature) {
          throw new Error("Provide bbox or geojson for titiler_cmr_statistics.");
        }
        const url = buildCmrStatisticsUrl({
          ...commonParams(control, input),
          categorical: input.categorical,
          histogramBins: input.histogram_bins,
        });
        const result = await fetchTitilerJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(feature),
        });
        return toJsonValue({ ok: true, url, result });
      },
    }),
    tool({
      name: "titiler_cmr_timeseries_tilejson",
      description:
        "Request a titiler-cmr timeseries TileJSON using rasterio or xarray backend. Can register the first returned timestep as a map layer.",
      inputSchema: titilerTimeseriesSchema,
      callback: async (input) => {
        const control = controlOrThrow();
        const url = buildCmrTimeseriesTileJsonUrl({
          ...commonParams(control, input),
          step: input.step,
          temporalMode: input.temporal_mode,
        });
        const series = await fetchTimeSeriesTileJson(url);
        const entries = Object.entries(series);
        const first = entries[0];
        const layer =
          input.add_first_to_map && first
            ? control.registerTileJsonForAgent({
                name:
                  input.name ??
                  `titiler-cmr ${input.backend} timeseries ${first[0]}`,
                tilejson: first[1],
                opacity: input.opacity,
                fitBounds: input.fit_bounds,
                metadata: {
                  sourceKind: "titiler-cmr-timeseries",
                  backend: input.backend,
                  collectionConceptId: input.collection_concept_id,
                  timestep: first[0],
                  url,
                },
              })
            : null;
        return toJsonValue({
          ok: true,
          url,
          backend: input.backend,
          timesteps: entries.map(([key, tilejson]) => ({
            key,
            tileCount: tilejson.tiles?.length ?? 0,
            bounds: tilejson.bounds,
          })),
          layer,
        });
      },
    }),
    tool({
      name: "get_benchmark",
      description:
        "Return the locked human-QAed flood benchmark (the authoritative boundary), or a prompt to import one if none is locked.",
      inputSchema: z.object({}),
      callback: () => toJsonValue(controlOrThrow().getBenchmarkForAgent()),
    }),
    tool({
      name: "buildings_in_flood",
      description:
        "Intersect the locked benchmark flood water polygon with OSM building footprints (Overpass) to quantify building exposure within the flooded area. Requires a locked benchmark.",
      inputSchema: buildingsInFloodSchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().buildingsInFloodForAgent({
          buildingSource: input.building_source,
          addLayer: input.add_layer,
          computeArea: input.compute_area,
        })),
    }),
    tool({
      name: "news_impact_search",
      description:
        "Search reputable news for quantified financial/societal/public-safety impact figures. Returns results with source_url, publisher, and date so every figure is citable.",
      inputSchema: newsImpactSchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().newsImpactSearchForAgent({
          query: input.query,
          maxResults: input.max_results,
        })),
    }),
    tool({
      name: "build_one_pager",
      description:
        "Assemble a self-contained HTML one-pager for the locked benchmark: map snapshot + legend/scale bar + building exposure + cited impacts + narrative, then download it. Requires a locked benchmark.",
      inputSchema: onePagerSchema,
      callback: async (input) =>
        toJsonValue(await controlOrThrow().buildOnePagerForAgent({
          title: input.title,
          narrative: input.narrative,
          impacts: input.impacts?.map((i) => ({
            claim: i.claim,
            value: i.value,
            sourceUrl: i.source_url,
            publisher: i.publisher,
            date: i.date,
          })),
          buildings: input.buildings
            ? {
                floodedCount: input.buildings.flooded_count,
                total: input.buildings.total,
                fraction: input.buildings.fraction,
                floodedAreaKm2: input.buildings.flooded_area_km2,
                source: input.buildings.source,
              }
            : undefined,
          mapSnapshotDataUrl: input.map_snapshot_data_url,
          download: input.download,
        })),
    }),
  ];
}

function endpointFor(control: OperaControl, endpoint?: string): string {
  return endpoint?.trim() || control.getAgentContext().endpoint || DEFAULT_TITILER_CMR_ENDPOINT;
}

function commonParams(control: OperaControl, input: TitilerCommonInput) {
  return {
    endpoint: endpointFor(control, input.endpoint),
    backend: input.backend,
    conceptId: input.collection_concept_id,
    granuleUr: input.granule_ur,
    temporal: input.temporal,
    assets: input.assets,
    assetsRegex: input.assets_regex,
    variables: input.variables,
    group: input.group,
    sel: input.sel,
    rescale: input.rescale,
    colormapName: input.colormap_name,
    colormap: input.colormap,
    expression: input.expression,
    minzoom: input.minzoom,
    maxzoom: input.maxzoom,
    extraParams: input.extra_params,
  };
}

function bboxFeature(bbox: number[]): unknown {
  const [w, s, e, n] = bbox;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  };
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}
