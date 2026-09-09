---
title: OPERA GeoAgent
icon: lucide/message-square
---

# The OPERA GeoAgent

The plugin embeds the
[`maplibre-gl-geoagent`](https://github.com/opengeos/maplibre-gl-geoagent)
MapLibre control and registers OPERA tools on top of it, similar to how the
QGIS NASA OPERA plugin launches the OpenGeoAgent panel. The GeoAgent sits on its
own map button, so the search workflow and the chat assistant stay open
independently.

Providers: OpenAI Responses, OpenAI Chat, Anthropic, Google Gemini, Amazon
Bedrock, and any OpenAI-compatible endpoint. Provider settings and keys are
handled in the GeoAgent panel.

## Registered tools

| Tool | What it does |
| --- | --- |
| `get_opera_context` | List supported products, current settings, and the latest search results. |
| `search_opera_granules` | Search NASA CMR and populate the results table plus footprint layer. |
| `display_opera_granules` | Render selected search results as titiler-cmr raster layers. |
| `search_and_display_opera` | Search and immediately display the first matching granules. |
| `detect_opera_change_between_dates` | Find nearest before/after granules, display both, and compute AOI change statistics. |
| `titiler_cmr_tilejson` | Build TileJSON from arbitrary `rasterio` or `xarray` backend parameters. |
| `titiler_cmr_point_query` | Sample raster pixels or xarray variables at a lon/lat point. |
| `titiler_cmr_statistics` | Backend-aware AOI statistics from a bbox or GeoJSON geometry. |
| `titiler_cmr_timeseries_tilejson` | Time-indexed TileJSON for temporal workflows. |
| `map_disaster_event` | Run the standard disaster workflow from a hazard, a place or AOI, and event dates. |
| `map_disaster_context` | Overture buildings and transportation plus WorldPop population for any AOI. |
| `sentinel2_event_imagery` | Least-cloudy Sentinel-2 L2A true-color scene for the event window. |
| `derive_flood_benchmark` | Vectorize observed DSWx water into a locked flood extent. |
| `overture_in_flood` | Count flooded buildings and clip transportation centerlines to the extent. |
| `population_in_flood` | WorldPop modeled residential population inside the flood extent. |
| `news_impact_search` | Quantified impact figures with source URLs and dates. |
| `build_one_pager` | Assemble the print-ready HTML summary. |

## Prompts that drive it

```text
Search and display one OPERA DSWx-HLS surface water granule for bbox
-121.8,38.4,-121.2,38.8 from 2024-02-01 to 2024-02-29. Use band B01_WTR.
```

```text
Show RTC-S1 VV backscatter near Sacramento for February 2024 and display the
first two scenes in gray.
```

```text
Detect DSWx-HLS surface water change for bbox -121.8,38.4,-121.2,38.8 between
2024-02-01 and 2024-03-01. Use band B01_WTR and a 10 day search window.
```

```text
Use titiler_cmr_statistics with the rasterio backend to compute a categorical
histogram for the displayed DSWx B01_WTR layer over the current AOI.
```

```text
Map the flood in Valencia Region, Spain from 2024-10-27 to 2024-11-05.
```

## Hazard-specific source policy

When the user does not name sources, `map_disaster_event` applies a
deterministic policy per hazard.

`FLOODS`{ .tag }
:   Grouped pre- and post-event OPERA and Sentinel-2 layers, all Overture
    buildings and typed transportation in the AOI, highlighted flooded buildings
    and affected roads, and open-access WorldPop exposure.

`WILDFIRES`{ .tag }
:   The matching NASA Disasters event group from NASA Earthdata GIS first, then
    FEDS perimeters, NASA burn-severity products, and OPERA DIST. When a
    time-filtered FEDS perimeter exists, the latest perimeter per fire becomes
    the exposure boundary and Overture and WorldPop queries narrow to it.

If a perimeter or exposure service is unavailable, the workflow reports that
limitation rather than labeling general context as impact.

## Credentials

!!! warning "This is a browser-side agent"

    Provider SDKs run in the page and talk to the model provider directly. Keys
    are stored in `sessionStorage` under the `geolibre.nasa-opera.geoagent`
    prefix after the user commits them. Use it in trusted local or internal
    deployments, or put a backend proxy in front of provider credentials for
    anything public.

JavaScript execution is available for local MapLibre tasks; destructive
layer-removal tools start disabled and can be enabled in the GeoAgent
permission toggles.

The OpenAI key can optionally be baked into the build from `OPENAI_API_KEY` so
demo users never see a key prompt. That ships the key to every browser that
loads the app, so keep it to controlled deployments. See
[Install](install.md#optional-bundling-an-llm-key).
