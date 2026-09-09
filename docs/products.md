---
title: Products and data path
icon: lucide/layers
---

# Supported products

Every OPERA collection the plugin knows about, each with its own render
defaults for `assets`, `assets_regex`, `rescale`, and `colormap`.

| `short_name` | Product |
| --- | --- |
| `OPERA_L3_DSWX-HLS_V1` | Surface water from HLS optical imagery |
| `OPERA_L3_DSWX-S1_V1` | Surface water from Sentinel-1 SAR, cloud-penetrating |
| `OPERA_L3_DIST-ALERT-HLS_V1` | Near-real-time land disturbance |
| `OPERA_L3_DIST-ANN-HLS_V1` | Annual land disturbance |
| `OPERA_L2_RTC-S1_V1` | Radiometric terrain-corrected SAR backscatter |
| `OPERA_L2_RTC-S1-STATIC_V1` | RTC-S1 static layers |
| `OPERA_L2_CSLC-S1_V1` | Coregistered single-look complex |
| `OPERA_L2_CSLC-S1-STATIC_V1` | CSLC-S1 static layers |

Categorical DSWx water layers ship with a built-in colormap, and water-only
rendering keeps open and partial surface water visible while cloud, ocean, and
no-data go transparent, so stacked post-event scenes do not bury the map under
grey.

Each family carries a different hazard: DSWx observes surface water for floods
and storm flooding, DIST-ALERT and DIST-ANN carry vegetation and land
disturbance for fires and post-event damage, and the SAR products, RTC-S1 and
CSLC-S1, carry backscatter and the phase data behind displacement. The
[disaster workflows](disaster-workflow.md) page maps hazards to sources.

!!! tip "Continuous bands need a stretch"

    Bands like `B10_DEM` render flat without one. Set a rescale of, say,
    `0,3000` and a `terrain` colormap in the panel before displaying.

## How it works

Granule search hits the public CMR API. Pixels come from titiler-cmr, which
handles Earthdata authentication and Cloud-Optimized GeoTIFF reads server-side.

<div class="path">
  <div class="stage">
    <span class="num">Input</span>
    <strong>OPERA panel</strong>
    <p>Product, bounding box, date range, band, render overrides.</p>
    <div class="url">app.registerRightPanel()</div>
  </div>
  <div class="stage">
    <span class="num">Search</span>
    <strong>NASA CMR</strong>
    <p>Public granule search returns footprints and the results table.</p>
    <div class="url">cmr.earthdata.nasa.gov/search</div>
  </div>
  <div class="stage">
    <span class="num">Display</span>
    <strong>titiler-cmr</strong>
    <p>Server-side authenticated TileJSON becomes raster tiles in GeoLibre's own layer panel.</p>
    <div class="url">/rasterio/WebMercatorQuad/tilejson.json</div>
  </div>
</div>

The plugin touches only two host APIs, `app.addGeoJsonLayer` for footprints and
`app.registerExternalNativeLayer` for raster tiles, so everything it adds
behaves like any other GeoLibre layer. It runs in both the web build and the
Tauri desktop app.

## Panel modes

The search UI renders in one of two modes, switchable at runtime from the
**NASA OPERA** menu in the top toolbar.

`DOCKED`{ .tag }
:   A native right-sidebar panel the host renders and manages through
    `app.registerRightPanel`, docked beside GeoLibre's built-in Style panel.
    This is the default for a fresh activation.

`FLOATING`{ .tag }
:   The original draggable card overlaid on the map, as a MapLibre control.
    Projects saved before docking existed reopen in this mode, and hosts without
    a right sidebar fall back to it automatically.

The chosen mode persists with the GeoLibre project. The GeoAgent chat companion
is always a floating control in both modes.

## titiler-cmr endpoint

The endpoint is editable in the OPERA panel. The first-run default can be set
without code changes, in this resolution order:

1. The `defaultEndpoint` option passed to `OperaControl`.
2. `window.GEOLIBRE_NASA_OPERA_TITILER_CMR_ENDPOINT`, set before the plugin loads.
3. The `VITE_TITILER_CMR_ENDPOINT` build variable.
4. The OpenGeos fallback, `https://titiler-cmr.opengeos.org`.

!!! warning "Point production at an endpoint you control"

    The hosted staging endpoint allows TileJSON and tile reads from the browser,
    but its `/statistics` POST can fail CORS preflight. The repository ships a
    Wrangler Worker proxy that keeps the titiler-cmr API shape and adds browser
    CORS headers. See [Install](install.md#cloudflare-worker-proxies).
