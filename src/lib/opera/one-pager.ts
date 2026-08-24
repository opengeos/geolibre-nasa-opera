/**
 * Self-contained one-pager (HTML) generator for the constrained flood workflow.
 *
 * Produces a single downloadable `.html` file (inline CSS, data-URL map image,
 * inline-SVG legend + scale bar) that mirrors the reference NASA/JPL OPERA
 * poster: header, title, a background/narrative column, the QAed benchmark map
 * with legend + scale bar, and an impacts column where every quantified figure
 * links to its cited source. It is print/PDF-ready (a Print button calls
 * `window.print()`), and the embedded map is already a PNG so the page also
 * screenshots cleanly for social sharing.
 *
 * Every displayed number is expected to be attributable: building exposure comes
 * from the benchmark ∩ OSM intersection, and each impact carries a source URL.
 */

import type { BenchmarkEvent, BenchmarkRender } from "./benchmark";
import type { BBox } from "./types";

/** A single quantified, cited impact figure. */
export interface OnePagerImpact {
  /** What the number measures, e.g. "Fatalities", "Economic loss". */
  claim: string;
  /** The figure as text, e.g. "224", "$4.2B". */
  value: string;
  /** Source article URL (required — every number must be citable). */
  sourceUrl: string;
  /** Publisher/host, e.g. "reuters.com". */
  publisher?: string;
  /** Publication date. */
  date?: string;
}

/** Building-exposure summary from the benchmark ∩ OSM intersection. */
export interface OnePagerBuildings {
  floodedCount: number;
  total: number;
  fraction: number;
  floodedAreaKm2?: number;
  source?: string;
}

/** WorldPop modeled population within the flood extent. */
export interface OnePagerPopulation {
  totalPopulation: number;
  year: number;
  source?: string;
}

/** Overture transportation exposure within the flood extent. */
export interface OnePagerTransportation {
  impactedSegmentCount: number;
  impactedLengthKm: number;
  source?: string;
}

export interface OnePagerInput {
  title: string;
  event: BenchmarkEvent;
  narrative?: string;
  /** PNG data URL of the current map (benchmark rendered on it). */
  mapImageDataUrl?: string;
  benchmark: { bbox: BBox; areaKm2: number; render: BenchmarkRender };
  buildings?: OnePagerBuildings;
  population?: OnePagerPopulation;
  transportation?: OnePagerTransportation;
  impacts?: OnePagerImpact[];
  /** ISO timestamp; supplied by the caller so this module stays clock-free. */
  generatedAt?: string;
  /** Footer credit line. */
  credit?: string;
  /** Hazard wording; defaults to flood for backward compatibility. */
  hazardLabel?: string;
  /** Citable event/data sources shown independently of quantified impacts. */
  sources?: Array<{ title: string; url: string; publisher?: string; date?: string }>;
}

const NICE_KM = [
  0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000,
];

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Approximate ground width (km) of a bbox at its mean latitude. */
export function bboxWidthKm(bbox: BBox): number {
  const [w, s, e, n] = bbox;
  const meanLat = (s + n) / 2;
  return Math.abs(e - w) * 111.32 * Math.cos((meanLat * Math.PI) / 180);
}

/** Choose a round scale-bar distance ~1/3 of the map width. */
export function scaleBar(bbox: BBox): { km: number; pct: number } {
  const totalKm = bboxWidthKm(bbox);
  if (!Number.isFinite(totalKm) || totalKm <= 0) return { km: 0, pct: 0 };
  const target = totalKm / 3;
  let km = NICE_KM[0];
  for (const candidate of NICE_KM) {
    if (candidate <= target) km = candidate;
  }
  return { km, pct: Math.min(90, (km / totalKm) * 100) };
}

function formatKm(km: number): string {
  return km >= 1 ? `${km} km` : `${km * 1000} m`;
}

function legendSvg(render: BenchmarkRender): string {
  const classes =
    render.classes && render.classes.length > 0
      ? render.classes
      : [
          {
            label: render.label ?? "Flood water",
            color: render.fillColor ?? "#2b7fff",
          },
        ];
  const rowH = 18;
  const height = classes.length * rowH + 8;
  const rows = classes
    .map((c, i) => {
      const y = 4 + i * rowH;
      return (
        `<rect x="4" y="${y}" width="14" height="12" rx="2" fill="${htmlEscape(c.color)}" stroke="rgba(0,0,0,0.25)"/>` +
        `<text x="24" y="${y + 10}" font-size="11" fill="#0b1220">${htmlEscape(c.label)}</text>`
      );
    })
    .join("");
  return `<svg width="150" height="${height}" viewBox="0 0 150 ${height}" xmlns="http://www.w3.org/2000/svg">${rows}</svg>`;
}

/** Only http(s) links are safe to embed; sourceUrl comes from external search. */
function safeHref(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : "#";
  } catch {
    return "#";
  }
}

function impactCard(impact: OnePagerImpact): string {
  const meta = [impact.publisher, impact.date]
    .filter((v): v is string => Boolean(v))
    .map(htmlEscape)
    .join(" · ");
  return (
    `<a class="impact" href="${htmlEscape(safeHref(impact.sourceUrl))}" target="_blank" rel="noopener">` +
    `<span class="impact-value">${htmlEscape(impact.value)}</span>` +
    `<span class="impact-claim">${htmlEscape(impact.claim)}</span>` +
    (meta ? `<span class="impact-meta">${meta}</span>` : "") +
    `</a>`
  );
}

/** Build the full self-contained one-pager HTML document. */
export function buildOnePagerHtml(input: OnePagerInput): string {
  const hazard = input.hazardLabel?.trim() || "flood";
  const extentLabel = `${hazard} extent`;
  const bar = scaleBar(input.benchmark.bbox);
  const [w, s, e, n] = input.benchmark.bbox;
  const buildings = input.buildings;
  const buildingsBlock = buildings
    ? `<div class="exposure">
         <div class="exposure-value">${buildings.floodedCount.toLocaleString()}</div>
         <div class="exposure-label">buildings within the observed ${htmlEscape(extentLabel)}</div>
         <div class="exposure-sub">${(buildings.fraction * 100).toFixed(1)}% of ${buildings.total.toLocaleString()} in view${
           buildings.floodedAreaKm2 !== undefined
             ? ` · ${buildings.floodedAreaKm2.toFixed(2)} km² footprint`
             : ""
         }${buildings.source ? ` · ${htmlEscape(buildings.source)}` : ""}</div>
       </div>`
    : "";
  const population = input.population;
  const populationBlock = population
    ? `<div class="exposure">
         <div class="exposure-value">${Math.round(population.totalPopulation).toLocaleString()}</div>
         <div class="exposure-label">modeled residents within the observed ${htmlEscape(extentLabel)}</div>
         <div class="exposure-sub">WorldPop ${population.year}${
           population.source ? ` · ${htmlEscape(population.source)}` : ""
         } · not a displacement count</div>
       </div>`
    : "";
  const transportation = input.transportation;
  const transportationBlock = transportation
    ? `<div class="exposure">
         <div class="exposure-value">${transportation.impactedLengthKm.toFixed(1)} km</div>
         <div class="exposure-label">transportation centerline within the observed ${htmlEscape(extentLabel)}</div>
         <div class="exposure-sub">${transportation.impactedSegmentCount.toLocaleString()} Overture segment(s)${
           transportation.source
             ? ` · ${htmlEscape(transportation.source)}`
             : ""
         }</div>
       </div>`
    : "";
  const impacts = input.impacts ?? [];
  const impactsBlock = impacts.length
    ? `<div class="impacts">${impacts.map(impactCard).join("")}</div>`
    : `<p class="muted">No cited impacts supplied.</p>`;
  const sources = input.sources ?? [];
  const sourcesBlock = sources.length
    ? `<div class="sources"><h3>Sources</h3>${sources
        .map((source) => {
          const meta = [source.publisher, source.date]
            .filter((value): value is string => Boolean(value))
            .map(htmlEscape)
            .join(" · ");
          return `<a href="${htmlEscape(safeHref(source.url))}" target="_blank" rel="noopener">${htmlEscape(source.title)}${meta ? `<small>${meta}</small>` : ""}</a>`;
        })
        .join("")}</div>`
    : "";
  const mapBlock = input.mapImageDataUrl
    ? `<img class="map-img" src="${input.mapImageDataUrl}" alt="${htmlEscape(hazard)} event map"/>`
    : `<div class="map-img map-missing">Map snapshot unavailable</div>`;
  const narrative = input.narrative
    ? `<p>${htmlEscape(input.narrative)}</p>`
    : `<p class="muted">Add a background narrative describing the event.</p>`;
  const eventMeta = [input.event.location, input.event.date]
    .filter((v): v is string => Boolean(v))
    .map(htmlEscape)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${htmlEscape(input.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0b1220; background: #eef2f7; }
  .page { max-width: 1280px; margin: 16px auto; background: #fff; border: 1px solid #d5dbe5; border-radius: 10px; overflow: hidden; box-shadow: 0 12px 36px rgba(15,23,42,.08); }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 2px solid #0b1220; }
  .brand { font-weight: 700; font-size: 15px; letter-spacing: .3px; }
  .brand small { display:block; font-weight: 500; color:#475569; font-size: 11px; }
  .toolbar button { font: inherit; font-size: 12px; padding: 6px 12px; border: 1px solid #2563eb; background:#2563eb; color:#fff; border-radius: 6px; cursor: pointer; }
  h1.title { text-align:center; font-size: 24px; color:#163f9f; margin: 16px 20px 6px; letter-spacing:-.3px; }
  .subtitle { text-align:center; color:#475569; font-size: 12px; margin: 0 20px 12px; }
  .grid { display: grid; grid-template-columns: .78fr 1.75fr .92fr; gap: 14px; padding: 0 18px 18px; }
  .panel { border:1px solid #d5dbe5; border-radius: 8px; padding: 14px; min-width:0; }
  .panel h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing:.5px; color:#334155; }
  .panel.bg { background:#f3f8f2; font-size:13px; line-height:1.45; }
  .panel.bg p { margin:0; }
  .panel.map { background:#f8fafc; position: relative; padding: 10px; }
  .panel.impact-panel { background:#f1f5fb; }
  .map-wrap { position: relative; }
  .map-img { width: 100%; aspect-ratio: 16 / 10; object-fit:cover; display:block; border-radius: 6px; border:1px solid #b8c4d4; background:#111827; }
  .map-missing { display:flex; align-items:center; justify-content:center; height: 240px; color:#64748b; background:#e2e8f0; }
  .legend { position:absolute; left: 14px; bottom: 42px; max-width:55%; background: rgba(255,255,255,0.94); border:1px solid #cbd5e1; border-radius: 5px; padding: 5px 7px; box-shadow:0 2px 8px rgba(15,23,42,.15); }
  .legend .legend-title { font-size: 10px; font-weight:600; color:#334155; margin-bottom: 2px; }
  .scalebar { position:absolute; left:14px; bottom: 14px; background: rgba(255,255,255,0.9); border:1px solid #cbd5e1; border-radius: 4px; padding: 4px 6px; font-size: 10px; color:#0b1220; }
  .scalebar .bar { height: 6px; background:#0b1220; margin-top: 3px; }
  .exposure { text-align:center; padding: 8px 0 12px; border-bottom:1px solid #cbd5e1; margin-bottom: 10px; }
  .exposure-value { font-size: 30px; font-weight: 800; color:#1d4ed8; line-height:1; }
  .exposure-label { font-size: 12px; color:#334155; }
  .exposure-sub { font-size: 10px; color:#64748b; margin-top: 4px; }
  .impacts { display:flex; flex-direction: column; gap: 8px; }
  a.impact { display:block; text-decoration:none; color:inherit; border:1px solid #cbd5e1; border-radius:6px; padding: 8px 10px; background:#fff; }
  a.impact:hover { border-color:#2563eb; }
  .impact-value { display:block; font-size: 18px; font-weight: 700; color:#0b1220; }
  .impact-claim { display:block; font-size: 12px; color:#334155; }
  .impact-meta { display:block; font-size: 10px; color:#2563eb; margin-top: 2px; }
  .sources { margin-top: 12px; padding-top: 10px; border-top: 1px solid #cbd5e1; }
  .sources h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color:#475569; }
  .sources a { display:block; margin: 0 0 6px; color:#1d4ed8; font-size:11px; text-decoration:none; overflow-wrap:anywhere; }
  .sources small { display:block; color:#64748b; font-size:9px; }
  .muted { color:#64748b; font-size: 12px; }
  .footer { border-top:1px solid #d5dbe5; padding: 8px 20px; font-size: 10px; color:#64748b; display:flex; justify-content:space-between; gap: 12px; flex-wrap: wrap; }
  @media (max-width: 900px) { .grid { grid-template-columns:1fr; } .map { grid-row:1; } }
  @media print { @page { size: landscape; margin: 8mm; } body { background:#fff; } .toolbar { display:none; } .page { border:none; box-shadow:none; margin:0; max-width:none; } }
</style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">NASA OPERA<small>Observational Products for End-users from Remote Sensing Analysis</small></div>
      <div class="toolbar"><button onclick="window.print()">Print / Save PDF</button></div>
    </div>
    <h1 class="title">${htmlEscape(input.title)}</h1>
    ${eventMeta ? `<div class="subtitle">${eventMeta}</div>` : ""}
    <div class="grid">
      <div class="panel bg">
        <h2>Background</h2>
        ${narrative}
      </div>
      <div class="panel map">
        <h2>Observed ${htmlEscape(hazard)} extent</h2>
        <div class="map-wrap">
          ${mapBlock}
          <div class="legend"><div class="legend-title">${htmlEscape(input.benchmark.render.label ?? "Flood water extent")}</div>${legendSvg(input.benchmark.render)}</div>
          ${
            bar.km > 0
              ? `<div class="scalebar">${formatKm(bar.km)}<div class="bar" style="width:${bar.pct.toFixed(1)}%"></div></div>`
              : ""
          }
        </div>
      </div>
      <div class="panel impact-panel">
        <h2>Impacts</h2>
        ${buildingsBlock}
        ${populationBlock}
        ${transportationBlock}
        ${impactsBlock}
        ${sourcesBlock}
      </div>
    </div>
    <div class="footer">
      <span>AOI ${w.toFixed(3)}, ${s.toFixed(3)}, ${e.toFixed(3)}, ${n.toFixed(3)}${input.benchmark.areaKm2 > 0 ? ` · observed ${htmlEscape(hazard)} area ${input.benchmark.areaKm2.toFixed(2)} km²` : ""}</span>
      <span>${htmlEscape(input.credit ?? "Generated by the NASA OPERA GeoLibre plugin")}${
        input.generatedAt ? ` · ${htmlEscape(input.generatedAt)}` : ""
      }</span>
    </div>
  </div>
</body>
</html>`;
}
