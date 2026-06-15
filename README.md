# GeoLibre NASA OPERA plugin

A [GeoLibre](https://github.com/opengeos/GeoLibre) plugin to search and visualize
[NASA OPERA](https://www.jpl.nasa.gov/go/opera) products (surface water, SAR
backscatter, land disturbance, and more) directly on the map. It is the GeoLibre
counterpart to the [QGIS NASA OPERA plugin](https://github.com/opengeos/qgis-nasa-opera-plugin).

It runs in both the GeoLibre web build and the Tauri desktop app, and it needs
**no Earthdata login in the browser**: granule search uses the public NASA CMR
API, and raster display is served by
[titiler-cmr](https://github.com/developmentseed/titiler-cmr), which handles
Earthdata authentication and Cloud-Optimized GeoTIFF reads server-side.

## What it does

- Pick an OPERA product, set a bounding box (type it, **Use map extent**, or
  **Draw** a box on the map) and a date range, and **search** NASA CMR for
  matching granules.
- Granule **footprints** are drawn as a GeoJSON layer and listed in a sortable
  results table (click a header to sort by granule, date, or link count).
  Selection is **bidirectional**: clicking a table row highlights its footprint
  on the map, and clicking a footprint on the map selects its row.
- **Select one or many** granules (Ctrl/Cmd-click to toggle, Shift-click for a
  range), pick a band/layer, then **Display**. Each selected granule renders as
  its own titiler-cmr layer (pinned by granule_ur), so exactly the chosen
  granules are shown together.
- Optionally override the **rescale** (min,max) and **colormap** before
  displaying. Categorical DSWx water layers get a built-in colormap; continuous
  bands like `B10_DEM` render flat without a stretch, so set e.g. rescale
  `0,3000` and colormap `terrain`.

### Supported products

| short_name | label |
| --- | --- |
| `OPERA_L3_DSWX-HLS_V1` | DSWX-HLS — surface water from HLS |
| `OPERA_L3_DSWX-S1_V1` | DSWX-S1 — surface water from Sentinel-1 |
| `OPERA_L3_DIST-ALERT-HLS_V1` | DIST-ALERT — near-real-time disturbance |
| `OPERA_L3_DIST-ANN-HLS_V1` | DIST-ANN — annual disturbance |
| `OPERA_L2_RTC-S1_V1` | RTC-S1 — terrain-corrected SAR backscatter |
| `OPERA_L2_RTC-S1-STATIC_V1` | RTC-S1 static layers |
| `OPERA_L2_CSLC-S1_V1` | CSLC-S1 — coregistered single-look complex |
| `OPERA_L2_CSLC-S1-STATIC_V1` | CSLC-S1 static layers |

## How it works

```
Add Data panel (this plugin)
  |
  |-- Search --> NASA CMR granule search (public)        -> footprints + table
  |              https://cmr.earthdata.nasa.gov/search
  |
  |-- Display -> titiler-cmr tilejson (server-side auth)  -> raster tiles
                 {endpoint}/rasterio/WebMercatorQuad/tilejson.json
                   ?collection_concept_id=...&assets=...&assets_regex=...&temporal=...
```

The plugin only calls `app.addGeoJsonLayer` (footprints) and
`app.registerExternalNativeLayer` with a `type: "raster"` tile source (COG tiles)
through the GeoLibre host API, so the layers appear in the normal layer panel.

## titiler-cmr endpoint

The default endpoint is the hosted staging service used by leafmap's
`113_titiler_cmr` notebook:

```
https://staging.openveda.cloud/api/titiler-cmr
```

> [!IMPORTANT]
> This is a **staging/demo** deployment with no uptime or rate-limit guarantees,
> and its API may change. For production use, self-host titiler-cmr (see its
> README for Docker / AWS deployment) and set your endpoint in the panel's
> "titiler-cmr endpoint" field. The endpoint is persisted with the GeoLibre
> project.

## Build and install

```bash
npm install

# Build the GeoLibre bundle (geolibre-plugin/dist/{index.js,style.css})
npm run build:geolibre

# Package a distributable zip (geolibre-plugin/geolibre-nasa-opera-<version>.zip)
npm run package:geolibre
```

Install it into GeoLibre one of these ways:

- **Bake into a local GeoLibre checkout** (web + desktop):
  ```bash
  node scripts/install-geolibre-plugin.mjs --web /path/to/GeoLibre
  ```
  copies the bundle into `apps/geolibre-desktop/public/plugins/geolibre-nasa-opera/`.
- **Desktop app data dir**: `npm run install:geolibre`.
- **Web app by manifest URL** (needs CORS): `npm run serve:geolibre`, then paste
  `http://localhost:8000/plugin.json` into GeoLibre Settings -> Plugins.

## Development

```bash
npm run test         # unit tests (vitest)
npm run build        # full build (npm library + GeoLibre bundle)
npm run lint
```

Key source files:

- `src/geolibre.ts` — plugin entry point + GeoLibre lifecycle wiring.
- `src/lib/core/OperaControl.ts` — the MapLibre control / search panel.
- `src/lib/opera/products.ts` — OPERA product registry + render defaults.
- `src/lib/opera/cmr.ts` — CMR granule/collection search + footprint parsing.
- `src/lib/opera/titiler.ts` — titiler-cmr tilejson URL builder.
- `src/lib/geolibre/host-api.ts` — the GeoLibre host-plugin contract.

## Limitations (v1)

- Displays a **single granule** at a time. Multi-granule per-UTM-zone mosaics and
  data download (present in the QGIS plugin) are not yet implemented.
- Per-product render defaults (`assets` / `assets_regex` / `rescale` /
  `colormap`) in `products.ts` are starting points and may need tuning per
  product against your titiler-cmr endpoint.

## License

MIT
