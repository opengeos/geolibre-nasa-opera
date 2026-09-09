---
title: Disaster workflows
icon: lucide/siren
---

# Mapping a disaster event

`map_disaster_event` works from three things: a hazard, a place or AOI, and the
event dates. It picks the datasets, runs them in a fixed order, and downloads a
single-file interactive HTML assessment at the end. Nobody has to name OPERA,
Sentinel-2, Overture, or WorldPop.

The order never changes: an authoritative hazard observation first, then
corroborating satellite change, then Overture buildings and transportation,
then WorldPop modeled population, then attributable official reports or news.

## Hazard coverage

Each hazard has its own deterministic source policy, applied when the request
does not name datasets.

| Hazard | Authoritative observation | Corroborating change |
| --- | --- | --- |
| Flood | OPERA DSWx observed surface water | Pre- and post-event Sentinel-2 optical context |
| Wildfire | FEDS satellite-derived fire perimeters | NBR/dNBR burn severity, OPERA DIST-ALERT |
| Storm | NOAA/NHC track, cone, wind, and surge products | OPERA DSWx observed water |
| Earthquake | USGS event geometry, ShakeMap, ground failure | OPERA displacement products when available |
| Landslide | NASA landslide nowcasts and slope-change products | - |
| Volcano | USGS volcano observatory alerts and mapped hazards | - |

Everyday wording resolves to those policies, so a bushfire is a wildfire, a
typhoon or cyclone is a storm, and a mudslide or debris flow is a landslide.

## The extent gates the analysis

Assets and people are only called **impacted** when an observed hazard extent
exists. Without one, Overture and WorldPop layers are context, and the workflow
says so rather than quietly presenting context as measured impact.

An extent reaches the analysis one of three ways:

`DERIVED`{ .tag }
:   Floods are the fully automatic case. `derive_flood_benchmark` searches
    OPERA DSWx for the AOI and dates, renders the observed open and partial
    surface water, and vectorizes it into a polygon. That polygon is
    OPERA-observed, not human-QAed, and is labeled as such wherever it appears.

`OFFICIAL`{ .tag }
:   Wildfires use the official perimeter. The workflow finds the matching
    curated NASA Disasters event, and when a time-filtered FEDS perimeter is
    available the latest perimeter for each fire becomes the exposure boundary,
    narrowing the Overture and WorldPop queries to it.

`IMPORTED`{ .tag }
:   Any hazard can take a human-QAed extent. Import a `Polygon` or
    `MultiPolygon` GeoJSON in the panel's **Flood benchmark** section and it is
    locked as authoritative ground truth, persists with the project, and is
    never recomputed or overridden. A sample placeholder lives at
    `examples/sample-benchmark-valencia.geojson`.

For earthquakes, landslides, volcanoes, and storms, the workflow maps the
highest-priority curated NASA event products it can resolve and adds contextual
Overture and WorldPop layers, then explains that quantified exposure still needs
an authoritative hazard polygon. Import one and the exposure steps below apply
unchanged.

## The three steps

1.  **Fix the hazard extent**

    Derived, official, or imported, by one of the routes above. Whichever
    arrives is locked as the working extent, and every downstream number is
    framed relative to it.

2.  **Measure exposure against it**

    With an extent locked, the agent is constrained to it. `overture_in_flood`
    counts buildings through GeoLibre's bounded Overture PMTiles query,
    calculates footprint area, and clips transportation centerlines to the
    polygon. `population_in_flood` returns WorldPop modeled residential
    population inside it, falling back to the WorldPop ArcGIS ImageServer, and
    adds a styled 100 m population layer. `sentinel2_event_imagery` adds the
    least-cloudy Sentinel-2 L2A scene in the window. `buildings_in_flood`
    remains an OSM Overpass fallback for hosts without Overture queries.

3.  **Publish the assessment**

    `build_one_pager` assembles the map snapshot, the extent outline, a legend
    and scale bar, building and road exposure, population figures, impact
    numbers with source URLs and dates, and the narrative into one
    self-contained HTML file that opens from disk, prints cleanly, and
    screenshots well. Hazard wording follows the event, so a fire assessment
    reads as a fire assessment.

!!! danger "What stays separate"

    Observed hazard, modeled exposure, and confirmed impacts are never merged.
    Population exposure is exposure, not deaths, evacuations, or displacement.
    Contextual layers are not labeled as impacted without a hazard extent, and
    when a result is truncated or a service is unavailable the workflow reports
    the limitation instead of publishing a partial number.

## Worked example: a flood

```text
Map the flood in Valencia Region, Spain from 2024-10-27 to 2024-11-05.
```

One request groups pre-event OPERA DSWx-HLS and DSWx-S1, derives their combined
post-event observed water, adds grouped pre- and post-event Sentinel-2, maps
Overture buildings as 3D extrusions above the raster layers with flooded
buildings in red and affected roads in orange, calculates WorldPop exposure, and
downloads the assessment with a generated background narrative. See it run in
the [Valencia demo](index.md#video-demos).

## Worked example: a wildfire

```text
Map the Colorado Fires in July 2026.
```

A state plus a month is a bounded event request. The workflow resolves the
matching NASA Earthdata GIS event group, adds the visible FEDS perimeter,
burn-severity, and OPERA DIST layers, and intersects the latest usable perimeter
with Overture and WorldPop. With no usable perimeter it falls back to contextual
exposure layers and says that it did.

## Cited impacts

`news_impact_search` returns quantified impact figures with source URLs and
dates through GPT web search, and the agent is instructed to report only
citable numbers. It defaults to a retrospective `general` search so events older
than a few days stay reachable, since an extent is usually QAed after the event.
Fresh journalistic coverage is still available with `topic: "news"` and a `days`
window. `search_disasters` is the companion for finding the event in the first
place, including historical and explicitly dated ones.

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
