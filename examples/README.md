# Standalone example

`main.ts` is a standalone development harness that runs the NASA OPERA control
on a plain MapLibre map, outside GeoLibre. It wires the GeoLibre host
capabilities (add GeoJSON footprints, add raster tiles, fit bounds, read the map
extent) to the local map, so search, footprint display, COG display, draw-bbox,
and bidirectional footprint selection all work the same as inside GeoLibre.

## Run it

```bash
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173). The root `index.html`
loads `examples/main.ts`.

## Build for GitHub Pages

```bash
npm run build:examples   # outputs to dist-examples/
```
