# Roadmap

The GeoLibre NASA OPERA plugin adds OPERA product search/display, a companion
GeoAgent, and a supervised constrained-flood one-pager workflow to GeoLibre.
This file tracks what has shipped and what is under consideration. It is a
living document, not a commitment; items may change or drop.

Current version: **0.3.0**.

## Shipped

### OPERA search and display

- [x] OPERA product registry (DSWx-HLS, DSWx-S1, DIST-ALERT, DIST-ANN, RTC-S1,
      CSLC-S1, and their static variants) with per-product render defaults.
- [x] NASA CMR granule search by product, bbox (typed, map extent, or drawn),
      and date range, with sortable results and bidirectional map/table selection.
- [x] Multi-granule display through titiler-cmr, each granule pinned by
      `granule_ur`, with rescale/colormap/expression overrides.
- [x] Categorical DSWx water colormap; opt-in **water-only** DSWx rendering that
      keeps open + partial surface water and hides cloud/ocean/no-data.
- [x] Change detection between two dates and time-series analysis.
- [x] titiler-cmr endpoint resolution (build var / global / override) and an
      optional Cloudflare Worker statistics proxy.

### OPERA GeoAgent

- [x] Natural-language assistant that operates the live MapLibre map: navigate,
      add markers/GeoJSON/XYZ layers, inspect layers, screenshot.
- [x] OPERA domain tools: search, display, change detection, time series, report
      export, and advanced titiler-cmr tilejson/point/statistics/timeseries.
- [x] Optional build-time bundling of the OpenAI key for trusted sessions.

### Constrained flood one-pager workflow

- [x] **Space + time → one-pager.** `derive_flood_benchmark` auto-derives the
      flood extent from OPERA DSWx (searches DSWx-HLS, renders observed
      open/partial water, and vectorizes it into a polygon) so the agent can
      produce a one-pager from just an AOI + date range — no human benchmark
      required. The derived extent is labeled OPERA-observed, not QAed.
- [x] Import + **lock** a human-QAed flood water-extent GeoJSON as the
      authoritative ground truth; it persists with the project and redraws on reload.
- [x] `buildings_in_flood` — benchmark ∩ OSM building footprints (Overpass) for
      exposure counts and flooded footprint area.
- [x] `news_impact_search` — cited impact figures (source URL + publisher + date)
      via a Tavily-backed Cloudflare Worker. Defaults to a **retrospective**
      `general` search so events older than a few days remain reachable; supports
      `topic: "news"` + a `days` window for fresh journalistic coverage.
- [x] `build_one_pager` — self-contained, print/PDF-ready HTML one-pager: map
      snapshot (DSWx layer + flooded buildings + benchmark outline), legend, scale
      bar, building exposure, cited impacts, and narrative.
- [x] News proxy hardening: fail-closed `ALLOWED_ORIGINS` default, stricter CORS,
      an optional `X-Client-Secret` shared-secret gate, and error-body pass-through.

## Under consideration

These are candidate directions, not scheduled work:

- [ ] A benchmark editing/QA UI (simplify, split, or trim the locked extent
      in-app) instead of importing a finalized GeoJSON.
- [ ] Use DSWx-S1 (all-weather SAR) in the flood workflow so cloudy optical
      scenes don't limit the observed-water layer.
- [ ] Per-product render-default tuning surfaced in the panel rather than only in
      `products.ts`.
- [ ] A backend proxy path for model credentials to support public (untrusted)
      deployments.
- [ ] One-pager customization: title/branding, layout, and additional cited
      metrics beyond building exposure.
- [ ] Broader impact sources and de-duplication in `news_impact_search`.

Have a request? Open an issue on the repository.
