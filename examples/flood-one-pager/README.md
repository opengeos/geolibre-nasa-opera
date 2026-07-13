# Constrained flood one-pager — end-to-end example

A standalone harness that reproduces a NASA OPERA flood one-pager for the
October 2024 Valencia (DANA) flooding, using the plugin's real library calls and
real external services (no mocks).

This is **not** the GeoAgent chat workflow — it wires the same library functions
the agent's tools call, so you can generate the artifact deterministically from
the command line. To do it through the app instead, import + lock a benchmark in
the OPERA panel's **Flood benchmark** section and ask the GeoAgent (see the
"Constrained flood one-pager workflow" section of the repo README).

## What it does

1. `lockBenchmark` on [`../sample-benchmark-valencia.geojson`](../sample-benchmark-valencia.geojson).
2. `fetchOsmBuildings` (Overpass) → `buildingsInFlood` — building exposure.
3. `searchNews` routed through the actual `workers/news-proxy.js` code
   in-process → real Tavily (no deployed Worker needed).
4. OpenAI Responses API — extracts cited impact figures + a short narrative.
5. NASA CMR + titiler-cmr — OPERA DSWx-HLS surface-water tiles (water-only
   colormap), rendered with MapLibre over an OSM basemap via Playwright.
6. `buildOnePagerHtml` — assembles the self-contained one-pager.

## Prerequisites

```bash
npm install
npm run build:lib                    # produces dist/index.mjs (imported by the driver)
npm install -D playwright            # the map step needs Playwright (not a core dep)
npx playwright install chromium      # download the Chromium build
export TAVILY_API_KEY=...
export OPENAI_API_KEY=...
```

Playwright is only needed for the map snapshot and is intentionally kept out of
the plugin's dependencies. If it is not installed, the driver still produces the
one-pager but the map panel shows a "snapshot unavailable" placeholder.

## Run

```bash
node examples/flood-one-pager/driver.mjs [output.html]
```

Writes `opera-one-pager-valencia.html` in the current directory (or the path you
pass). Optional: `OPENAI_MODEL` (default `gpt-4o`). Intermediate files (map PNG,
config) are written to a temp directory and not kept.

## Notes

- Uses live networks: Overpass, Tavily, OpenAI, NASA CMR, titiler-cmr, and OSM
  tiles. Overpass is rate-limited; the driver retries across mirrors with backoff.
- Event details (name, dates, AOI) are hard-coded for the Valencia example. To
  adapt it, swap the benchmark GeoJSON and edit the `event`, the news query, and
  the DSWx date window in `driver.mjs`.
- The one-pager map's water-only DSWx rendering mirrors the library's
  `colormapForBand(shortName, band, { waterOnly: true })`.
