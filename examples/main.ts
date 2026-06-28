/**
 * Standalone development harness for the NASA OPERA control.
 *
 * Runs the plugin outside GeoLibre against a plain MapLibre map. The GeoLibre
 * host capabilities (add GeoJSON footprints, add raster tiles, fit bounds, read
 * the map extent) are wired here to this local map, so search -> footprints ->
 * display, draw-bbox, and bidirectional footprint selection all work just like
 * they do inside GeoLibre. Run with `npm run dev`.
 */
import maplibregl from "maplibre-gl";
import { GeoAgentControl } from "maplibre-gl-geoagent";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-geoagent/style.css";
import { OperaControl, type BBox } from "../src/index";
import {
  createOperaAgentTools,
  OPERA_AGENT_SYSTEM_PROMPT,
} from "../src/lib/opera/agent-tools";
import "../src/index.css";

type GeoJsonData = Parameters<maplibregl.GeoJSONSource["setData"]>[0];

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [-121.9, 38.0],
  zoom: 6,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl(), "bottom-right");

map.on("load", () => {
  const control = new OperaControl({
    title: "NASA OPERA",
    collapsed: false,
    // --- GeoLibre host capabilities, wired to this standalone map ---
    addGeoJsonLayer: (name, data) => {
      const id = `opera-geojson-${Date.now()}`;
      map.addSource(id, { type: "geojson", data: data as GeoJsonData });
      map.addLayer({
        id: `${id}-fill`,
        type: "fill",
        source: id,
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: `${id}-line`,
        type: "line",
        source: id,
        paint: { "line-color": "#2563eb", "line-width": 1 },
      });
    },
    registerLayer: (layer) => {
      const source = layer.source as
        | { tiles?: string[]; tileSize?: number }
        | undefined;
      if (!source?.tiles || map.getSource(layer.id)) return;
      map.addSource(layer.id, {
        type: "raster",
        tiles: source.tiles,
        tileSize: source.tileSize ?? 256,
      });
      map.addLayer({
        id: `${layer.id}-layer`,
        type: "raster",
        source: layer.id,
        paint: { "raster-opacity": layer.opacity ?? 1 },
      });
    },
    unregisterLayer: (id) => {
      if (map.getLayer(`${id}-layer`)) map.removeLayer(`${id}-layer`);
      if (map.getSource(id)) map.removeSource(id);
    },
    fitBounds: (bounds: BBox) =>
      map.fitBounds(bounds, { padding: 40, duration: 600 }),
    getMapBounds: (): BBox => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
  });

  map.addControl(control, "top-left");
  map.addControl(
    new GeoAgentControl({
      title: "OPERA GeoAgent",
      collapsed: true,
      panelWidth: 410,
      storagePrefix: "geolibre.nasa-opera.geoagent",
      allowCodeExecutionDefault: true,
      allowDestructiveToolsDefault: false,
      showPermissionToggles: true,
      customSystemPrompt: OPERA_AGENT_SYSTEM_PROMPT,
      customTools: () => createOperaAgentTools(() => control),
    }),
    "top-right",
  );
});
