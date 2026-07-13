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
- Open the companion **OPERA GeoAgent** control to ask an AI assistant to
  inspect and operate on the live MapLibre map. The agent can navigate the map,
  add markers and GeoJSON/XYZ layers, inspect visible layers, take screenshots,
  search NASA CMR for OPERA granules, display OPERA rasters through
  titiler-cmr, and use optional JavaScript execution for advanced local
  MapLibre operations.

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

## Panel modes

The OPERA search UI can render in one of two modes, switchable at runtime from
the **NASA OPERA** menu in the top toolbar (Dock panel / Float panel):

- **Docked** (default) — a native right-sidebar panel the host renders and
  manages (via `app.registerRightPanel`), docked beside GeoLibre's built-in
  Style panel. This is the default for a fresh activation.
- **Floating** — the original draggable card overlaid on the map (a MapLibre
  control). Projects saved before docking existed reopen in this mode, so
  existing layouts are unchanged.

The chosen mode is persisted with the GeoLibre project (`panelMode`). On hosts
without a right sidebar, the plugin falls back to the floating panel
automatically. The OPERA GeoAgent chat companion is always a floating control in
both modes.

## titiler-cmr endpoint

The endpoint is user-editable in the OPERA panel. The first-run default can be
configured without code changes:

- Pass `defaultEndpoint` when constructing `OperaControl`.
- Set `window.GEOLIBRE_NASA_OPERA_TITILER_CMR_ENDPOINT` before the plugin loads.
- Build with `VITE_TITILER_CMR_ENDPOINT=https://your-endpoint.example`.

If none of those are set, the plugin falls back to the OpenGeos titiler-cmr
endpoint:

```text
https://titiler-cmr.opengeos.org
```

> [!IMPORTANT]
> For production use, set the endpoint to a titiler-cmr service you control, or
> deploy your own Worker proxy, then set your endpoint in the panel's
> "titiler-cmr endpoint" field or one of the runtime/build configuration
> mechanisms above. The endpoint is persisted with the GeoLibre project.

### Cloudflare Worker statistics proxy

The hosted staging endpoint allows TileJSON/tile reads from the browser, but
its `/statistics` POST can fail CORS preflight checks. This repository includes
a small Wrangler Worker proxy that keeps the titiler-cmr API shape unchanged and
adds browser CORS headers.

Run it locally:

```bash
npm run proxy:dev
```

Then set the OPERA panel's `titiler-cmr endpoint` to:

```text
http://127.0.0.1:8787
```

Deploy it to Cloudflare:

```bash
npm run proxy:deploy
```

Then set the endpoint to your deployed Worker URL, for example:

```text
https://<your-worker>.<your-subdomain>.workers.dev
```

The proxy forwards only `/rasterio/...` and `/xarray/...` titiler-cmr paths to
the `TITILER_CMR_UPSTREAM` configured in `wrangler.toml`. Adjust that upstream
if you self-host titiler-cmr, and restrict `ALLOWED_ORIGINS` to specific
GeoLibre URLs for production deployments.

## OPERA GeoAgent

The plugin embeds the
[`maplibre-gl-geoagent`](https://github.com/opengeos/maplibre-gl-geoagent)
MapLibre control, similar to how the QGIS NASA OPERA plugin launches the
OpenGeoAgent panel. The GeoAgent control is added as a separate map button so
users can keep the OPERA search workflow and the chat assistant open
independently.

GeoAgent supports OpenAI Responses, OpenAI Chat, Anthropic, Google Gemini,
Amazon Bedrock, and OpenAI-compatible endpoints. Provider settings and API keys
are handled by the GeoAgent panel. Keys are stored in browser `sessionStorage`
under the `geolibre.nasa-opera.geoagent` prefix after the user commits them.

The NASA OPERA plugin registers OPERA-specific agent tools:

- `get_opera_context` — list supported products, current settings, and latest
  search results.
- `search_opera_granules` — search NASA CMR and populate the OPERA results
  table plus footprint layer.
- `display_opera_granules` — render selected search results as titiler-cmr
  raster layers.
- `search_and_display_opera` — search and immediately display the first
  matching granule(s).
- `detect_opera_change_between_dates` — find nearest before/after granules for
  two dates, display both layers, and compute AOI change statistics.
- `titiler_cmr_tilejson` — build TileJSON from arbitrary titiler-cmr
  `rasterio` or `xarray` backend parameters and optionally add it as a map
  layer.
- `titiler_cmr_point_query` — sample raster pixels or xarray variables at a
  lon/lat point.
- `titiler_cmr_statistics` — compute backend-aware AOI statistics from a bbox
  or GeoJSON geometry.
- `titiler_cmr_timeseries_tilejson` — request time-indexed TileJSON responses
  for temporal rasterio/xarray workflows.

Example prompts:

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
Use the xarray backend to build a TileJSON for collection C... with variable
water_class, group /science/grids, sel time=2024-02-01T00:00:00Z, then add it
to the map.
```

This is a browser-side agent: provider SDKs run in the browser and send prompts
directly to the selected model provider. Use it in trusted local or internal
GeoLibre deployments, or place a backend proxy in front of provider credentials
for production. JavaScript execution is available for local MapLibre tasks;
destructive layer-removal tools start disabled and can be enabled in the
GeoAgent permission toggles.

### Bundling the LLM API key (optional)

So end users don't have to enter an API key, the OpenAI key can be baked into the
build from the `OPENAI_API_KEY` environment variable:

```bash
export OPENAI_API_KEY=sk-...
npm run build:geolibre    # or: npm run dev
```

When set, the key is passed to the GeoAgent's `apiKeys` option and the panel
starts ready to chat; a key the user later enters (saved in `sessionStorage`)
still takes precedence. When `OPENAI_API_KEY` is unset (the default), nothing is
bundled and the panel falls back to manual key entry.

> **Security:** bundling a key ships it to every browser that loads the app.
> Use this only for controlled/sponsor demo deployments. For public deployments,
> leave it unset and put the key behind a server-side proxy.

## Constrained flood one-pager workflow

A supervised, human-in-the-loop workflow that turns a human-QAed flood map into a
shareable one-pager, designed so the agent cannot hallucinate the authoritative
map or uncited impact numbers:

1. **Get a flood extent** one of two ways:
   - **Just space + time (auto).** Ask the agent for a one-pager for a place and a
     date range and it calls `derive_flood_benchmark`: it searches OPERA DSWx-HLS
     for the AOI + dates, renders the observed open/partial surface water, and
     **vectorizes it** into a flood polygon that is locked as the working
     benchmark. This extent is *OPERA-observed, not human-QAed* and is labeled as
     such on the one-pager.
   - **Import a QAed benchmark (authoritative).** In the OPERA panel's **Flood
     benchmark** section, import a QAed flood water-extent GeoJSON
     (`Polygon`/`MultiPolygon`). It is *locked* as the authoritative ground truth
     and drawn on the map. A sample placeholder is at
     [`examples/sample-benchmark-valencia.geojson`](examples/sample-benchmark-valencia.geojson).
     When a QAed benchmark is locked, the agent uses it instead of deriving one.
2. **Ask the agent.** With a benchmark locked, the GeoAgent is constrained to it:
   - `buildings_in_flood` intersects the benchmark with OSM building footprints
     (via the public Overpass API — no proxy needed) to quantify exposure.
   - `news_impact_search` returns quantified impact figures **with source URLs +
     dates**; the agent is instructed to report only citable numbers. It defaults
     to a retrospective `general` search so events older than a few days remain
     reachable (a locked benchmark is QAed after the event); the agent can still
     request fresh journalistic coverage with `topic: "news"` and a `days` window.
   - To show the OPERA-observed flood behind the benchmark, the agent displays
     DSWx (`OPERA_L3_DSWX-HLS_V1`, band `B01_WTR`) for the event dates with
     `water_only=true` — open water + partial surface water stay visible while
     cloud/ocean/no-data become transparent, so stacked post-event scenes don't
     bury the map under grey cloud.
   - `build_one_pager` assembles a self-contained HTML one-pager (map snapshot
     with the DSWx layer, flooded buildings, and benchmark outline + legend/scale
     bar + building exposure + cited impacts + narrative) and downloads it. It is
     print/PDF-ready and screenshots cleanly for social.

### News search proxy (Tavily)

`news_impact_search` calls the Tavily search API through a small Cloudflare
Worker so the Tavily key stays server-side (`workers/news-proxy.js`):

```bash
npx wrangler secret put TAVILY_API_KEY --config wrangler.news.toml
npm run news-proxy:deploy      # or: npm run news-proxy:dev  (local, port 8788)
```

Point the plugin at the deployed Worker with the `VITE_NEWS_PROXY_ENDPOINT`
build variable, or the `GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT` window global.
Without it, `news_impact_search` returns a clear "not configured" message and the
rest of the workflow (benchmark, buildings, one-pager) still works.

The Worker fails closed: `ALLOWED_ORIGINS` defaults to `http://localhost:5173`
(set it to your deployed origin(s), or `*` only if you intentionally want any
origin to use the proxy). To keep the proxy from being an open Tavily relay for
non-browser clients, optionally set a `CLIENT_SECRET` secret and have callers
send a matching `X-Client-Secret` header:

```bash
npx wrangler secret put CLIENT_SECRET --config wrangler.news.toml
```

## Build and install

```bash
npm install

# Build the GeoLibre bundle (geolibre-plugin/dist/{index.js,style.css})
npm run build:geolibre

# Package a distributable zip (geolibre-plugin/geolibre-nasa-opera-<version>.zip)
npm run package:geolibre
```

This package consumes the published `maplibre-gl-geoagent` dependency from npm.
Use version `0.5.4` or newer so the OPERA plugin can inject its custom agent
tools and system prompt.

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
- `maplibre-gl-geoagent` — companion MapLibre AI assistant control.
- `src/lib/opera/products.ts` — OPERA product registry + render defaults.
- `src/lib/opera/cmr.ts` — CMR granule/collection search + footprint parsing.
- `src/lib/opera/titiler.ts` — titiler-cmr tilejson URL builder.
- `src/lib/geolibre/host-api.ts` — the GeoLibre host-plugin contract.

## Limitations

- Per-product render defaults (`assets` / `assets_regex` / `rescale` /
  `colormap`) in `products.ts` are starting points and may need tuning per
  product against your titiler-cmr endpoint.
- Browser-side model credentials are appropriate for trusted sessions. For
  public deployments, configure provider access through a backend proxy.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for shipped capabilities and what's under
consideration next.

## License

MIT
