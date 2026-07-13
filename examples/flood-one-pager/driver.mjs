// End-to-end driver for the constrained flood one-pager workflow.
//
// Reproduces examples/opera-one-pager-valencia.html by exercising the REAL
// integrations the plugin uses — no mocks:
//   - Overpass (OSM buildings) via fetchOsmBuildings + buildingsInFlood
//   - the actual workers/news-proxy.js Worker code, run in-process, -> real Tavily
//   - the OpenAI Responses API (narrative + cited impact extraction)
//   - OPERA DSWx-HLS tiles via NASA CMR + titiler-cmr (water-only colormap)
//   - MapLibre + OSM basemap rendered headless by Playwright (map snapshot)
//   - the library's buildOnePagerHtml renderer
//
// This is a standalone harness, NOT the GeoAgent chat workflow; it wires the
// same library calls the agent's tools make. See README.md in this folder.
//
// Prerequisites:
//   npm install && npm run build:lib      # produces dist/index.mjs
//   export TAVILY_API_KEY=...  OPENAI_API_KEY=...
//   node examples/flood-one-pager/driver.mjs [output.html]
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "opera-onepager-"));
const OUT = path.resolve(process.argv[2] ?? path.join(process.cwd(), "opera-one-pager-valencia.html"));
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

const lib = await import(path.join(REPO, "dist/index.mjs"));
const { lockBenchmark, fetchOsmBuildings, buildingsInFlood, searchNews, buildOnePagerHtml,
  searchGranules, getProduct, resolveConceptId, buildTileJsonUrl, fetchTileJson,
  DEFAULT_TITILER_CMR_ENDPOINT } = lib;
const { handleRequest } = await import(path.join(REPO, "workers/news-proxy.js"));

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!TAVILY_API_KEY || !OPENAI_API_KEY) {
  throw new Error("Set TAVILY_API_KEY and OPENAI_API_KEY in the environment.");
}

const log = (...a) => console.log("•", ...a);

// 1) Load + lock the benchmark (real library code path).
const raw = JSON.parse(
  readFileSync(path.join(REPO, "examples/sample-benchmark-valencia.geojson"), "utf8"),
);
const benchmark = lockBenchmark(raw, {
  event: { name: "Valencia DANA flooding", date: "2024-10-29", location: "Valencia, Spain" },
  render: {
    label: "Flood assessment layers",
    fillColor: "#2b7fff",
    classes: [
      { label: "DSWx open water", color: "#0000ff" },
      { label: "DSWx partial water", color: "#87cefa" },
      { label: "Flooded buildings", color: "#e11d48" },
      { label: "Benchmark extent", color: "#2b7fff" },
    ],
  },
  lockedAt: "2024-11-01T00:00:00Z",
});
log("Locked benchmark:", benchmark.event.name, "| bbox", benchmark.bbox.map((n) => n.toFixed(3)).join(","), "| area", benchmark.areaKm2.toFixed(2), "km²");

// 2) Buildings in flood — REAL Overpass fetch + intersection.
log("Fetching OSM buildings via Overpass (real network)…");
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let osm;
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    osm = await fetchOsmBuildings(benchmark.bbox, { endpoints: OVERPASS, timeoutMs: 60000 });
    break;
  } catch (e) {
    log(`  Overpass attempt ${attempt} failed (${e.message}); backing off…`);
    if (attempt === 6) throw e;
    await sleep(attempt * 8000);
  }
}
const flood = buildingsInFlood(osm, benchmark.water, { computeArea: true });
log(`Buildings: ${flood.floodedCount} flooded of ${flood.total} in view (${(flood.fraction * 100).toFixed(1)}%), footprint ${flood.floodedAreaKm2?.toFixed(2)} km²`);
const buildings = {
  floodedCount: flood.floodedCount,
  total: flood.total,
  fraction: flood.fraction,
  floodedAreaKm2: flood.floodedAreaKm2,
  source: "OpenStreetMap (Overpass)",
};

// 3) News impacts — REAL Worker code in-process -> REAL Tavily.
//    fetchImpl routes searchNews through the actual handleRequest with the real
//    key, so no deployed Worker is needed; this still exercises the Worker's
//    CORS + error-body handling. (endpoint is a placeholder the fetchImpl ignores.)
const workerFetch = (url, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", "http://localhost:5173");
  const req = new Request(url, { ...init, headers });
  return handleRequest(req, { TAVILY_API_KEY, ALLOWED_ORIGINS: "http://localhost:5173" });
};
log("Searching news via the news-proxy Worker -> Tavily (real)…");
const news = await searchNews(
  "Valencia Spain DANA flood October 2024 death toll damages people affected",
  { maxResults: 6, endpoint: "http://localhost:8788", fetchImpl: workerFetch },
);
log(`News: ${news.results.length} result(s)`);
for (const r of news.results) log("   -", r.publisher, "|", r.title.slice(0, 70));

// 4) OpenAI Responses API — narrative + cited impacts (the agent's role).
log(`Calling OpenAI Responses API (${OPENAI_MODEL}) to extract cited impacts + narrative…`);
const sources = news.results.map((r, i) => ({
  n: i + 1, title: r.title, url: r.sourceUrl, publisher: r.publisher, date: r.date,
  snippet: (r.snippet || "").slice(0, 900),
}));
const instructions = `You are a NASA OPERA flood-impact analyst. From the provided news search results about the October 2024 Valencia (DANA) flooding, produce a JSON object with:
- "narrative": 2-3 sentence factual background of the event (concise, no numbers you cannot attribute).
- "impacts": array of up to 5 quantified impact figures. Each item: {"claim": short label e.g. "Fatalities", "value": short string e.g. "224", "sourceUrl": EXACT url from a source, "publisher": host, "date": source date or ""}.
Rules: Every figure MUST be traceable to one of the provided sources; use that source's exact url. If a number has no citable source, omit it. Do not invent figures. Return ONLY the JSON object, no prose.`;
const oaResp = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
  body: JSON.stringify({
    model: OPENAI_MODEL,
    instructions,
    input: `Return a JSON object as specified. Sources:\n${JSON.stringify(sources, null, 2)}`,
    text: { format: { type: "json_object" } },
  }),
});
if (!oaResp.ok) throw new Error(`OpenAI ${oaResp.status}: ${await oaResp.text()}`);
const oaData = await oaResp.json();
let outText = oaData.output_text;
if (!outText && Array.isArray(oaData.output)) {
  outText = oaData.output.flatMap((o) => (o.content || []).map((c) => c.text || "")).join("");
}
const parsed = JSON.parse(outText);
const narrative = parsed.narrative;
const impacts = (parsed.impacts || []).filter((im) => im && im.sourceUrl);
log(`OpenAI: narrative (${narrative?.length ?? 0} chars) + ${impacts.length} cited impact(s)`);
for (const im of impacts) log("   -", im.value, im.claim, "→", im.publisher);

// 5a) OPERA DSWx-HLS surface-water tiles over the flood dates (real CMR + titiler-cmr).
log("Searching OPERA DSWx-HLS granules over the AOI (real CMR)…");
const product = getProduct("OPERA_L3_DSWX-HLS_V1");
const band = product.render.bands[0];
const gres = await searchGranules({
  shortName: "OPERA_L3_DSWX-HLS_V1", bbox: benchmark.bbox,
  start: "2024-10-30", end: "2024-11-03", count: 8,
});
const granules = gres.granules ?? gres;
log(`DSWx granules: ${granules.length}`);
const conceptId = granules[0]?.conceptId ?? (await resolveConceptId("OPERA_L3_DSWX-HLS_V1"));
// Water-only colormap: keep open water (1) + partial surface water (2), make
// cloud/ocean-masked/snow/no-data transparent so the flood extent reads cleanly
// over the basemap when stacking multiple post-storm scenes. (This mirrors the
// library's dswxWaterOnlyColormap()/colormapForBand(..., { waterOnly:true }).)
const categorical = JSON.stringify({
  "0": [0, 0, 0, 0], "1": [0, 0, 255, 255], "2": [135, 206, 250, 255],
  "252": [0, 0, 0, 0], "253": [0, 0, 0, 0], "254": [0, 0, 0, 0], "255": [0, 0, 0, 0],
});
const dswxTiles = [];
for (const g of granules) {
  try {
    const url = buildTileJsonUrl({
      endpoint: DEFAULT_TITILER_CMR_ENDPOINT, conceptId, backend: product.render.backend,
      granuleUr: g.id, bands: [band], bandsRegex: product.render.bandsRegex, colormap: categorical,
    });
    const tj = await fetchTileJson(url);
    if (tj.tiles?.[0]) dswxTiles.push(tj.tiles[0]);
  } catch (e) { log("  skip granule (tilejson failed):", g.id.slice(0, 40), e.message); }
}
log(`DSWx tile layers ready: ${dswxTiles.length}`);

// 5b) Render the assessment map (DSWx + flooded buildings + benchmark) via Playwright.
log("Rendering assessment map (DSWx + buildings + benchmark)…");
let mapDataUrl;
try {
  writeFileSync(path.join(WORK, "map-input.json"), JSON.stringify({
    bbox: benchmark.bbox,
    water: benchmark.water,
    fill: benchmark.render.fillColor,
    dswxTiles,
    buildings: { type: "FeatureCollection", features: flood.floodedFeatures },
  }));
  execFileSync("node", [path.join(HERE, "capture-map.mjs"), WORK], { stdio: "inherit", timeout: 180000 });
  mapDataUrl = readFileSync(path.join(WORK, "map-dataurl.txt"), "utf8").trim();
  log("Map data URL:", (mapDataUrl.length / 1024).toFixed(0), "KB");
} catch (e) {
  log("Map capture failed, one-pager will show placeholder:", e.message);
}

// 6) Assemble the one-pager (real library renderer).
const onePager = buildOnePagerHtml({
  title: "Valencia DANA flooding: OPERA flood assessment",
  event: benchmark.event,
  narrative,
  mapImageDataUrl: mapDataUrl,
  benchmark: { bbox: benchmark.bbox, areaKm2: benchmark.areaKm2, render: benchmark.render },
  buildings,
  impacts,
  generatedAt: "2026-07-13",
  credit: "NASA OPERA · GeoLibre",
});
writeFileSync(OUT, onePager);
log("One-pager written:", OUT, `(${(onePager.length / 1024).toFixed(0)} KB)`);
console.log("\nDONE");
