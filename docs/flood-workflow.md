---
title: Flood one-pager workflow
icon: lucide/waves
---

# From a place and a date range to a one-pager

Floods support a complete exposure workflow because OPERA DSWx can provide a
polygonal observed-water extent. A supervised workflow turns that extent, or a
human-QAed flood map, into interactive analysis layers and a shareable
one-pager.

Order matters here: the extent gates everything after it.

1.  **Fix the flood extent**

    Either let `derive_flood_benchmark` search DSWx-HLS for the AOI and dates
    and vectorize the observed open and partial water, or import a human-QAed
    water-extent GeoJSON (`Polygon` or `MultiPolygon`) in the panel's **Flood
    benchmark** section. Both are locked as the working benchmark and persist
    with the project; the derived one is labeled OPERA-observed, not QAed. A
    sample placeholder lives at `examples/sample-benchmark-valencia.geojson`.

2.  **Measure exposure against it**

    With a benchmark locked, the agent is constrained to it. `overture_in_flood`
    counts flooded buildings through GeoLibre's bounded Overture PMTiles query,
    calculates footprint area, and clips transportation centerlines to the
    polygon. `population_in_flood` returns WorldPop modeled residential
    population inside the extent, falling back to the WorldPop ArcGIS
    ImageServer, and adds a styled 100 m population layer.
    `sentinel2_event_imagery` adds the least-cloudy Sentinel-2 L2A scene in the
    window. `buildings_in_flood` remains an OSM Overpass fallback for hosts
    without Overture queries.

3.  **Publish the one-pager**

    `build_one_pager` assembles the map snapshot with the DSWx layer, flooded
    buildings and benchmark outline, a legend and scale bar, building and road
    exposure, population figures, impact numbers with source URLs and dates, and
    the narrative into one self-contained HTML file that prints cleanly and
    screenshots well.

!!! danger "What stays separate"

    Observed hazard, modeled exposure, and confirmed impacts are never merged.
    Population exposure is exposure, not deaths, evacuations, or displacement.
    Contextual layers are not labeled as impacted without a hazard extent, and
    when a result is truncated or a service is unavailable the workflow reports
    the limitation instead of publishing a partial number.

## Cited impacts

`news_impact_search` returns quantified impact figures with source URLs and
dates through GPT web search, and the agent is instructed to report only
citable numbers. It defaults to a retrospective `general` search so events older
than a few days stay reachable, since a locked benchmark is usually QAed after
the event. Fresh journalistic coverage is still available with
`topic: "news"` and a `days` window.

In a Docker GeoLibre deployment the plugin uses the authenticated, same-origin
`/ai/v1/messages` route, and the proxy injects its server-side credential, so
search credentials never reach the browser. For a standalone deployment, see the
[news Worker](install.md#cloudflare-worker-proxies). Without one,
`news_impact_search` returns a clear "not configured" message and the rest of
the workflow still works.

## Requirements

Overture analysis needs a GeoLibre host that provides `activatePlugin` and
`queryOvertureFeatures`. Queries are bounded by tile and feature limits, and the
agent returns an error instead of reporting partial exposure when a result is
truncated.
