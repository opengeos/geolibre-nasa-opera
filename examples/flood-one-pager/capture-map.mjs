// Renders the flood assessment map (OPERA DSWx + flooded buildings + benchmark
// outline) over an OSM basemap with MapLibre, headless via Playwright, and
// writes a PNG data URL. Invoked by driver.mjs with a working directory arg.
//
// Requires Playwright + its Chromium. If not already present:
//   npx playwright install chromium
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const WORK = process.argv[2] || process.env.WORKDIR;
if (!WORK) throw new Error("Pass a working directory as argv[2].");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  throw new Error(
    "Playwright is not installed. Run `npm install -D playwright && npx playwright install chromium` to enable the map snapshot.",
  );
}

// Copy the MapLibre bundle next to the page so the file:// template can load it.
const MLB = path.join(REPO, "node_modules/maplibre-gl/dist");
copyFileSync(path.join(MLB, "maplibre-gl.js"), path.join(WORK, "maplibre-gl.js"));
copyFileSync(path.join(MLB, "maplibre-gl.css"), path.join(WORK, "maplibre-gl.css"));

const cfg = JSON.parse(readFileSync(path.join(WORK, "map-input.json"), "utf8"));
const tmpl = readFileSync(path.join(HERE, "map.html"), "utf8");
const html = tmpl.replace(
  "const cfg = window.__CFG__;",
  `window.__CFG__ = ${JSON.stringify(cfg)};\n  const cfg = window.__CFG__;`,
);
writeFileSync(path.join(WORK, "map.filled.html"), html);

const out = path.join(WORK, "map.png");
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 640 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`file://${path.join(WORK, "map.filled.html")}`, { waitUntil: "load", timeout: 60000 });
try {
  await page.waitForFunction("window.__ready === true", { timeout: 60000 });
  console.log("map idle/ready");
} catch {
  console.log("map not ready; capturing current frame");
  await page.waitForTimeout(6000);
}
await page.waitForTimeout(2000); // let final DSWx/basemap tiles paint
await (await page.$("#map")).screenshot({ path: out });
await browser.close();

const b64 = readFileSync(out).toString("base64");
writeFileSync(path.join(WORK, "map-dataurl.txt"), `data:image/png;base64,${b64}`);
console.log("saved", out, (b64.length / 1024).toFixed(0), "KB");
