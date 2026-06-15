import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  GeoJSONSource,
  IControl,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import type { GeoLibreNativeLayerRegistration } from "../geolibre/host-api";
import {
  getLayerBand,
  granuleBands,
  resolveConceptId,
  searchGranules,
} from "../opera/cmr";
import { colormapForBand } from "../opera/colormaps";
import { bandRenderDefaults, getProduct, OPERA_PRODUCTS } from "../opera/products";
import {
  buildPointUrl,
  buildTileJsonUrl,
  DEFAULT_TITILER_CMR_ENDPOINT,
  fetchPoint,
  fetchTileJson,
  tileSizeFromTemplate,
  type PointResult,
} from "../opera/titiler";
import type {
  BBox,
  GranuleBand,
  OperaGranule,
} from "../opera/types";

/**
 * Persisted state for the OPERA control. Saved with the GeoLibre project via the
 * plugin's `getProjectState`/`applyProjectState`.
 */
export interface OperaState {
  collapsed: boolean;
  panelWidth: number;
  /** CMR short_name of the selected product. */
  product: string;
  /** Bounding box as a "west, south, east, north" string; blank = map extent. */
  bbox: string;
  /** Date range, ISO `YYYY-MM-DD`. */
  start: string;
  end: string;
  /** Max granules to request. */
  count: number;
  /** Optional rescale override "min,max"; blank uses the product/band default. */
  rescale: string;
  /** Optional named colormap override; blank uses the product/band default. */
  colormapName: string;
  /** titiler-cmr endpoint. */
  endpoint: string;
}

/** Host capabilities the control needs, bound by the GeoLibre wrapper. */
export interface OperaControlOptions {
  collapsed?: boolean;
  panelWidth?: number;
  title?: string;
  className?: string;
  /** Add footprints as a GeoJSON layer. */
  addGeoJsonLayer?: (
    name: string,
    data: { type: "FeatureCollection"; features: unknown[] },
  ) => void;
  /** Register a native (raster) layer GeoLibre owns. */
  registerLayer?: (layer: GeoLibreNativeLayerRegistration) => void;
  /** Remove a previously registered native layer by id. */
  unregisterLayer?: (id: string) => void;
  /** Fit the map to a `[w, s, e, n]` box. */
  fitBounds?: (bounds: BBox) => void;
  /** Read the current map extent as a `[w, s, e, n]` box. */
  getMapBounds?: () => BBox | null;
}

const PANEL_CLASS = "plugin-control-panel opera-panel";

// Self-managed map overlay for highlighting the selected footprint. These ids
// are not touched by GeoLibre's layer-sync (which only prunes its own
// `layer-<id>-...` prefixes), so they persist across store updates.
const HL_SRC = "opera-hl-src";
const HL_FILL = "opera-hl-fill";
const HL_LINE = "opera-hl-line";

/**
 * Named titiler colormaps offered in the Rendering section. Empty string means
 * "use the band/product default" (e.g. the DSWx categorical colormap).
 */
const COLORMAP_NAMES = [
  "",
  "viridis",
  "terrain",
  "gist_earth",
  "gray",
  "plasma",
  "magma",
  "inferno",
  "cividis",
  "blues",
  "greens",
  "reds",
  "rdylgn",
  "spectral",
  "jet",
  "ocean",
];

function defaultDateRange(): { start: string; end: string } {
  // Avoid Date.now() coupling in tests by reading the current date lazily here;
  // this runs only in the browser at panel construction time.
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const prior = new Date(now);
  prior.setMonth(prior.getMonth() - 1);
  const start = prior.toISOString().slice(0, 10);
  return { start, end };
}

/**
 * MapLibre control hosting the NASA OPERA search + display UI.
 *
 * Workflow: pick a product, set a bbox + date range, Search (CMR granule
 * search, public) to draw footprints and fill the results table, select a
 * granule + band, then Display to render its COG tiles via titiler-cmr.
 */
export class OperaControl implements IControl {
  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _status?: HTMLElement;
  private _tableBody?: HTMLElement;
  private _bandSelect?: HTMLSelectElement;
  private _rescaleInput?: HTMLInputElement;
  private _colormapSelect?: HTMLSelectElement;
  private _displayBtn?: HTMLButtonElement;
  private _downloadBandBtn?: HTMLButtonElement;
  private _downloadAllBtn?: HTMLButtonElement;
  private _options: OperaControlOptions;
  private _state: OperaState;

  private _granules: OperaGranule[] = [];
  // Current displayed (sorted) order of the results table.
  private _view: OperaGranule[] = [];
  // Multi-selection: ids of selected granules, the last-clicked "active"
  // granule (drives the band list), and the shift-range anchor.
  private _selectedIds = new Set<string>();
  private _activeGranule: OperaGranule | null = null;
  private _anchorId: string | null = null;
  private _sortKey: "id" | "begin" | "links" | null = null;
  private _sortDir: 1 | -1 = 1;
  private _bands: GranuleBand[] = [];
  private _registeredLayerIds: string[] = [];

  private _resizeHandler: (() => void) | null = null;
  private _mapResizeHandler: (() => void) | null = null;

  // Bbox draw-on-map state.
  private _drawing = false;
  private _drawBtn?: HTMLButtonElement;
  private _drawRect?: HTMLDivElement;
  private _drawStart?: { x: number; y: number };
  private _drawStartLngLat?: { lng: number; lat: number };

  // Click-to-inspect (titiler-cmr /point) state.
  private _inspecting = false;
  private _inspectBtn?: HTMLButtonElement;
  private _inspectPopup?: HTMLDivElement;
  private _inspectLngLat?: { lng: number; lat: number };
  private _inspectMoveHandler: (() => void) | null = null;

  constructor(options: OperaControlOptions = {}) {
    this._options = options;
    const { start, end } = defaultDateRange();
    this._state = {
      collapsed: options.collapsed ?? true,
      panelWidth: options.panelWidth ?? 340,
      product: OPERA_PRODUCTS[0]?.shortName ?? "",
      bbox: "",
      start,
      end,
      count: 50,
      rescale: "",
      colormapName: "",
      endpoint: DEFAULT_TITILER_CMR_ENDPOINT,
    };
  }

  // --- IControl ----------------------------------------------------------

  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._container = this._createContainer();
    this._panel = this._createPanel();
    this._mapContainer.appendChild(this._panel);
    this._setupEventListeners();

    if (!this._state.collapsed) {
      this._panel.classList.add("expanded");
      requestAnimationFrame(() => this._updatePanelPosition());
    }
    return this._container;
  }

  onRemove(): void {
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._mapResizeHandler && this._map) {
      this._map.off("resize", this._mapResizeHandler);
      this._mapResizeHandler = null;
    }
    if (this._drawing) this._endDraw();
    this._stopInspect();
    this._removeInspectPopup();
    if (this._map) {
      this._map.off("click", this._onMapClick);
      this._map.off("mousemove", this._onMapMouseMove);
    }
    this._removeHighlightLayers();
    this._clearLayers();
    this._panel?.parentNode?.removeChild(this._panel);
    this._container?.parentNode?.removeChild(this._container);
    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._status = undefined;
    this._tableBody = undefined;
    this._bandSelect = undefined;
    this._rescaleInput = undefined;
    this._colormapSelect = undefined;
    this._displayBtn = undefined;
    this._downloadBandBtn = undefined;
    this._downloadAllBtn = undefined;
  }

  // --- State -------------------------------------------------------------

  getState(): OperaState {
    // Pull the latest form values before serializing.
    this._readForm();
    return { ...this._state };
  }

  setState(next: Partial<OperaState>): void {
    this._state = { ...this._state, ...next };
  }

  toggle(): void {
    this._state.collapsed = !this._state.collapsed;
    if (!this._panel) return;
    if (this._state.collapsed) {
      this._panel.classList.remove("expanded");
    } else {
      this._panel.classList.add("expanded");
      this._updatePanelPosition();
    }
  }

  collapse(): void {
    if (!this._state.collapsed) this.toggle();
  }

  expand(): void {
    if (this._state.collapsed) this.toggle();
  }

  // --- Layer registration ------------------------------------------------

  private _registerLayer(layer: GeoLibreNativeLayerRegistration): void {
    try {
      this._options.registerLayer?.(layer);
      if (!this._registeredLayerIds.includes(layer.id)) {
        this._registeredLayerIds.push(layer.id);
      }
    } catch {
      this._setStatus("Failed to add layer.");
    }
  }

  private _clearLayers(): void {
    const ids = [...this._registeredLayerIds];
    this._registeredLayerIds = [];
    for (const id of ids) {
      try {
        this._options.unregisterLayer?.(id);
      } catch {
        // keep clearing
      }
    }
  }

  // --- Actions -----------------------------------------------------------

  private async _onSearch(): Promise<void> {
    this._readForm();
    const product = getProduct(this._state.product);
    if (!product) {
      this._setStatus("Select a product first.");
      return;
    }
    const bbox = this._currentBBox();
    this._setStatus("Searching CMR…");
    try {
      const result = await searchGranules({
        shortName: product.shortName,
        bbox,
        start: this._state.start || undefined,
        end: this._state.end || undefined,
        count: this._state.count,
      });
      this._granules = result.granules;
      this._renderResults();

      if (result.featureCollection.features.length > 0) {
        this._options.addGeoJsonLayer?.(
          `OPERA ${product.shortTitle} Footprints (${result.granules.length})`,
          result.featureCollection,
        );
      }
      if (result.bounds) this._options.fitBounds?.(result.bounds);

      this._setStatus(
        result.granules.length > 0
          ? `Found ${result.granules.length} granule(s).`
          : "No granules found for this query.",
      );
    } catch (err) {
      this._setStatus(
        `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _onDisplay(): Promise<void> {
    const product = getProduct(this._state.product);
    const selected = this._granules.filter((g) => this._selectedIds.has(g.id));
    if (!product || selected.length === 0) {
      this._setStatus("Select a granule first.");
      return;
    }
    const band = this._bandSelect?.value || product.render.bands?.[0];
    const userRescale = this._state.rescale.trim();
    const userColormap = this._state.colormapName.trim();
    // A user-selected named colormap overrides the categorical class colormap
    // (e.g. choosing "terrain" for a DEM band instead of the DSWx classes).
    const categorical = userColormap
      ? undefined
      : colormapForBand(product.shortName, band);

    this._setStatus(
      `Requesting ${selected.length} granule(s) from titiler-cmr…`,
    );
    try {
      const conceptId =
        selected[0].conceptId ?? (await resolveConceptId(product.shortName));
      let ok = 0;
      // Render each selected granule as its own granule_ur-pinned layer so the
      // result is exactly the chosen granules (titiler-cmr has no granule-list
      // param; a temporal window would also pull in unselected granules).
      await Promise.all(
        selected.map(async (granule) => {
          const url = buildTileJsonUrl({
            endpoint: this._state.endpoint || DEFAULT_TITILER_CMR_ENDPOINT,
            conceptId,
            backend: product.render.backend,
            granuleUr: granule.id,
            bands: band ? [band] : product.render.bands,
            bandsRegex: product.render.bandsRegex,
            rescale: userRescale || product.render.rescale,
            colormapName: userColormap || product.render.colormapName,
            colormap: categorical,
          });
          try {
            const tilejson = await fetchTileJson(url);
            const tileUrl = tilejson.tiles[0];
            const layerId = `opera-cog-${slug(granule.id)}-${slug(band ?? "band")}`;
            this._registerLayer({
              id: layerId,
              name: `OPERA ${product.shortTitle} ${band ?? ""} — ${granule.id}`.trim(),
              type: "raster",
              source: {
                type: "raster",
                tiles: [tileUrl],
                tileSize: tileSizeFromTemplate(tileUrl),
                ...(tilejson.minzoom != null
                  ? { minzoom: tilejson.minzoom }
                  : {}),
                ...(tilejson.maxzoom != null
                  ? { maxzoom: tilejson.maxzoom }
                  : {}),
              },
              nativeLayerIds: [],
              opacity: 1,
              metadata: {
                sourceKind: "opera-titiler-cmr",
                granuleId: granule.id,
              },
            });
            ok++;
          } catch {
            // Skip a granule that fails; report the partial count below.
          }
        }),
      );

      const bounds = this._combinedBounds(selected);
      if (bounds) this._options.fitBounds?.(bounds);
      this._setStatus(
        ok === selected.length
          ? `Displayed ${ok} granule(s).`
          : `Displayed ${ok}/${selected.length} granule(s).`,
      );
    } catch (err) {
      this._setStatus(
        `Display failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Update the selection from a row/footprint click, honoring modifier keys:
   * Ctrl/Cmd toggles, Shift selects a contiguous range from the anchor, plain
   * click selects just that granule.
   */
  private _applySelection(
    granule: OperaGranule,
    opts: { toggle?: boolean; range?: boolean; scroll?: boolean } = {},
  ): void {
    const id = granule.id;
    if (opts.range && this._anchorId) {
      const order = this._view.map((g) => g.id);
      const a = order.indexOf(this._anchorId);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        this._selectedIds = new Set(order.slice(lo, hi + 1));
      } else {
        this._selectedIds = new Set([id]);
        this._anchorId = id;
      }
    } else if (opts.toggle) {
      if (this._selectedIds.has(id)) this._selectedIds.delete(id);
      else this._selectedIds.add(id);
      this._anchorId = id;
    } else {
      this._selectedIds = new Set([id]);
      this._anchorId = id;
    }
    this._activeGranule = granule;
    this._refreshSelectionUI(opts.scroll ? id : undefined);
  }

  /** Sync row highlight, band list, Display button, and footprint highlight. */
  private _refreshSelectionUI(scrollToId?: string): void {
    if (this._tableBody) {
      for (const node of Array.from(this._tableBody.children)) {
        const row = node as HTMLElement;
        const id = row.dataset.granuleId ?? "";
        row.classList.toggle("selected", this._selectedIds.has(id));
        if (scrollToId && id === scrollToId) {
          row.scrollIntoView({ block: "nearest" });
        }
      }
    }
    this._bands = this._activeGranule ? granuleBands(this._activeGranule) : [];
    this._populateBands();
    const hasSelection = this._selectedIds.size > 0;
    const hasBand = this._bands.length > 0;
    if (this._displayBtn) this._displayBtn.disabled = !hasSelection || !hasBand;
    if (this._downloadBandBtn)
      this._downloadBandBtn.disabled = !hasSelection || !hasBand;
    if (this._downloadAllBtn) this._downloadAllBtn.disabled = !hasSelection;
    if (this._inspectBtn) this._inspectBtn.disabled = !hasSelection || !hasBand;
    // A selection change can invalidate the band being inspected; leave inspect
    // mode if there is nothing left to query.
    if (this._inspecting && (!hasSelection || !hasBand)) this._stopInspect();
    this._highlightSelectedFootprints();
  }

  /** Union of the given granules' bounding boxes. */
  private _combinedBounds(granules: OperaGranule[]): BBox | undefined {
    const boxes = granules.map((g) => g.bbox).filter((b): b is BBox => !!b);
    if (boxes.length === 0) return undefined;
    return boxes.reduce<BBox>(
      (acc, b) => [
        Math.min(acc[0], b[0]),
        Math.min(acc[1], b[1]),
        Math.max(acc[2], b[2]),
        Math.max(acc[3], b[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  }

  // --- Footprint highlight overlay (self-managed map layers) -------------

  private _highlightData(features: unknown[]): Parameters<GeoJSONSource["setData"]>[0] {
    return {
      type: "FeatureCollection",
      features,
    } as Parameters<GeoJSONSource["setData"]>[0];
  }

  private _ensureHighlightLayers(): void {
    const map = this._map;
    if (!map) return;
    if (!map.getSource(HL_SRC)) {
      map.addSource(HL_SRC, { type: "geojson", data: this._highlightData([]) });
    }
    if (!map.getLayer(HL_FILL)) {
      map.addLayer({
        id: HL_FILL,
        type: "fill",
        source: HL_SRC,
        paint: { "fill-color": "#ffd400", "fill-opacity": 0.12 },
      });
    }
    if (!map.getLayer(HL_LINE)) {
      map.addLayer({
        id: HL_LINE,
        type: "line",
        source: HL_SRC,
        paint: { "line-color": "#ffd400", "line-width": 3 },
      });
    }
  }

  private _highlightSelectedFootprints(): void {
    const map = this._map;
    if (!map) return;
    this._ensureHighlightLayers();
    const features = this._granules
      .filter((g) => this._selectedIds.has(g.id) && g.geometry)
      .map((g) => ({
        type: "Feature",
        geometry: g.geometry,
        properties: {},
      }));
    const src = map.getSource(HL_SRC) as GeoJSONSource | undefined;
    src?.setData(this._highlightData(features));
    // Keep the highlight above later-added layers (e.g. a displayed COG).
    if (map.getLayer(HL_FILL)) map.moveLayer(HL_FILL);
    if (map.getLayer(HL_LINE)) map.moveLayer(HL_LINE);
  }

  private _clearHighlight(): void {
    const src = this._map?.getSource(HL_SRC) as GeoJSONSource | undefined;
    src?.setData(this._highlightData([]));
  }

  private _removeHighlightLayers(): void {
    const map = this._map;
    if (!map) return;
    for (const id of [HL_FILL, HL_LINE]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(HL_SRC)) map.removeSource(HL_SRC);
  }

  // --- Map interaction: click-to-select + hover cursor -------------------

  private _onMapClick = (e: MapMouseEvent): void => {
    const map = this._map;
    if (!map || this._drawing) return;
    // In inspect mode a map click reads pixel values instead of selecting a
    // footprint.
    if (this._inspecting) {
      void this._inspectAt({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      return;
    }
    const hit = map
      .queryRenderedFeatures(e.point)
      .find((f) => f.properties && f.properties._operaGranuleId);
    if (!hit) return;
    const id = String(hit.properties!._operaGranuleId);
    const granule = this._granules.find((g) => g.id === id);
    if (!granule) return;
    const oe = e.originalEvent as MouseEvent | undefined;
    this.expand();
    this._applySelection(granule, {
      toggle: !!oe && (oe.ctrlKey || oe.metaKey),
      range: !!oe && oe.shiftKey,
      scroll: true,
    });
  };

  private _onMapMouseMove = (e: MapMouseEvent): void => {
    const map = this._map;
    if (!map || this._drawing) return;
    if (this._inspecting) {
      map.getCanvas().style.cursor = "crosshair";
      return;
    }
    const over = map
      .queryRenderedFeatures(e.point)
      .some((f) => f.properties && f.properties._operaGranuleId);
    map.getCanvas().style.cursor = over ? "pointer" : "";
  };

  // --- Bbox draw on map -------------------------------------------------

  private _toggleDraw(): void {
    if (this._drawing) this._endDraw();
    else this._startDraw();
  }

  private _startDraw(): void {
    const map = this._map;
    if (!map) return;
    this._stopInspect();
    this._drawing = true;
    if (this._drawBtn) this._drawBtn.textContent = "Cancel";
    map.getCanvas().style.cursor = "crosshair";
    map.dragPan.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    map.on("mousedown", this._onDrawDown);
  }

  private _endDraw(): void {
    const map = this._map;
    this._drawing = false;
    this._drawStart = undefined;
    this._drawStartLngLat = undefined;
    if (this._drawRect) {
      this._drawRect.remove();
      this._drawRect = undefined;
    }
    if (this._drawBtn) this._drawBtn.textContent = "Draw";
    if (map) {
      map.getCanvas().style.cursor = "";
      map.off("mousedown", this._onDrawDown);
      map.off("mousemove", this._onDrawMove);
      map.dragPan.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
    }
  }

  private _onDrawDown = (e: MapMouseEvent): void => {
    const map = this._map;
    if (!map || !this._mapContainer) return;
    e.preventDefault();
    this._drawStart = { x: e.point.x, y: e.point.y };
    this._drawStartLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    const rect = document.createElement("div");
    rect.className = "opera-draw-rect";
    this._mapContainer.appendChild(rect);
    this._drawRect = rect;
    map.on("mousemove", this._onDrawMove);
    map.once("mouseup", this._onDrawUp);
  };

  private _onDrawMove = (e: MapMouseEvent): void => {
    if (!this._drawRect || !this._drawStart) return;
    const { x: x1, y: y1 } = this._drawStart;
    const x2 = e.point.x;
    const y2 = e.point.y;
    this._drawRect.style.left = `${Math.min(x1, x2)}px`;
    this._drawRect.style.top = `${Math.min(y1, y2)}px`;
    this._drawRect.style.width = `${Math.abs(x2 - x1)}px`;
    this._drawRect.style.height = `${Math.abs(y2 - y1)}px`;
  };

  private _onDrawUp = (e: MapMouseEvent): void => {
    const start = this._drawStartLngLat;
    if (start) {
      const end = e.lngLat;
      const w = Math.min(start.lng, end.lng);
      const s = Math.min(start.lat, end.lat);
      const ee = Math.max(start.lng, end.lng);
      const n = Math.max(start.lat, end.lat);
      this._state.bbox = [w, s, ee, n].map((v) => v.toFixed(4)).join(", ");
      this._syncForm();
    }
    this._endDraw();
  };

  // --- BBox helpers ------------------------------------------------------

  private _currentBBox(): BBox | undefined {
    // Fall back to the current map extent when the field is blank or invalid.
    return this._parseBBox(this._state.bbox) ?? this._options.getMapBounds?.() ?? undefined;
  }

  /** Parse a "west, south, east, north" string into a BBox, or undefined. */
  private _parseBBox(value: string): BBox | undefined {
    const parts = value.split(",").map((p) => parseFloat(p.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2], parts[3]];
    }
    return undefined;
  }

  private _useMapExtent(): void {
    const bounds = this._options.getMapBounds?.();
    if (!bounds) {
      this._setStatus("Map extent unavailable.");
      return;
    }
    this._state.bbox = bounds.map((v) => v.toFixed(4)).join(", ");
    this._syncForm();
  }

  // --- DOM ---------------------------------------------------------------

  private _createContainer(): HTMLElement {
    const container = document.createElement("div");
    container.className = `maplibregl-ctrl maplibregl-ctrl-group plugin-control opera-control${
      this._options.className ? ` ${this._options.className}` : ""
    }`;

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "plugin-control-toggle";
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-label", this._options.title ?? "NASA OPERA");
    toggleBtn.innerHTML = `
      <span class="plugin-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M3 12h18"/>
          <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>
        </svg>
      </span>`;
    toggleBtn.addEventListener("click", () => this.toggle());
    container.appendChild(toggleBtn);
    return container;
  }

  private _createPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = PANEL_CLASS;
    panel.style.width = `${this._state.panelWidth}px`;

    // Header
    const header = document.createElement("div");
    header.className = "plugin-control-header";
    const title = document.createElement("span");
    title.className = "plugin-control-title";
    title.textContent = this._options.title ?? "NASA OPERA";
    const closeBtn = document.createElement("button");
    closeBtn.className = "plugin-control-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close panel");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", () => this.collapse());
    header.append(title, closeBtn);

    const content = document.createElement("div");
    content.className = "plugin-control-content";

    content.appendChild(this._buildProductGroup());
    content.appendChild(this._buildBBoxGroup());
    content.appendChild(this._buildDateGroup());
    content.appendChild(this._buildCountGroup());
    content.appendChild(this._buildSearchButton());

    const status = document.createElement("div");
    status.className = "plugin-control-status";
    this._status = status;
    content.appendChild(status);

    const divider = document.createElement("div");
    divider.className = "plugin-control-divider";
    content.appendChild(divider);

    content.appendChild(this._buildResultsTable());
    content.appendChild(this._buildBandGroup());
    content.appendChild(this._buildRenderGroup());
    content.appendChild(this._buildDisplayButton());
    content.appendChild(this._buildInspectButton());
    content.appendChild(this._buildDownloadGroup());

    // Spacing between the Display action and the endpoint settings below.
    const endpointDivider = document.createElement("div");
    endpointDivider.className = "plugin-control-divider";
    content.appendChild(endpointDivider);

    content.appendChild(this._buildEndpointGroup());

    panel.append(header, content);
    return panel;
  }

  private _buildProductGroup(): HTMLElement {
    const group = el("div", "plugin-control-group");
    group.appendChild(label("Product"));
    const select = document.createElement("select");
    select.className = "plugin-control-input opera-select";
    select.dataset.field = "product";
    for (const p of OPERA_PRODUCTS) {
      const opt = document.createElement("option");
      opt.value = p.shortName;
      opt.textContent = `${p.shortTitle} — ${p.shortName}`;
      opt.title = p.title;
      if (p.shortName === this._state.product) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this._state.product = select.value;
    });
    group.appendChild(select);
    return group;
  }

  private _buildBBoxGroup(): HTMLElement {
    const group = el("div", "plugin-control-group");
    const row = document.createElement("div");
    row.className = "opera-label-row";
    row.appendChild(label("Bounding box (W, S, E, N)"));

    const actions = document.createElement("span");
    actions.className = "opera-bbox-actions";

    const extentBtn = document.createElement("button");
    extentBtn.type = "button";
    extentBtn.className = "opera-link-button";
    extentBtn.textContent = "Use map extent";
    extentBtn.addEventListener("click", () => this._useMapExtent());

    const drawBtn = document.createElement("button");
    drawBtn.type = "button";
    drawBtn.className = "opera-link-button";
    drawBtn.textContent = "Draw";
    drawBtn.addEventListener("click", () => this._toggleDraw());
    this._drawBtn = drawBtn;

    actions.append(extentBtn, drawBtn);
    row.appendChild(actions);
    group.appendChild(row);

    const input = document.createElement("input");
    input.className = "plugin-control-input";
    input.type = "text";
    input.placeholder = "west, south, east, north";
    input.value = this._state.bbox;
    input.dataset.field = "bbox";
    input.addEventListener("input", () => {
      this._state.bbox = input.value;
    });
    group.appendChild(input);
    return group;
  }

  private _buildDateGroup(): HTMLElement {
    const group = el("div", "plugin-control-group");
    group.appendChild(label("Date range"));
    const row = document.createElement("div");
    row.className = "plugin-control-flex";
    for (const field of ["start", "end"] as const) {
      const input = document.createElement("input");
      input.className = "plugin-control-input";
      input.type = "date";
      input.value = this._state[field];
      input.dataset.field = field;
      input.addEventListener("input", () => {
        this._state[field] = input.value;
      });
      row.appendChild(input);
    }
    group.appendChild(row);
    return group;
  }

  private _buildCountGroup(): HTMLElement {
    const group = el("div", "plugin-control-group");
    group.appendChild(label("Max results"));
    const input = document.createElement("input");
    input.className = "plugin-control-input";
    input.type = "number";
    input.min = "1";
    input.max = "500";
    input.value = String(this._state.count);
    input.dataset.field = "count";
    input.addEventListener("input", () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v)) this._state.count = Math.min(Math.max(v, 1), 500);
    });
    group.appendChild(input);
    return group;
  }

  private _buildSearchButton(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plugin-control-button opera-block-button";
    btn.textContent = "Search";
    btn.addEventListener("click", () => void this._onSearch());
    return btn;
  }

  private _buildResultsTable(): HTMLElement {
    const container = document.createElement("div");

    const hint = el("div", "opera-hint");
    hint.textContent =
      "Click a header to sort. Ctrl/Cmd or Shift-click rows to select multiple.";
    container.appendChild(hint);

    const wrap = document.createElement("div");
    wrap.className = "opera-results";
    const table = document.createElement("table");
    table.className = "opera-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const columns: Array<[OperaControl["_sortKey"] & string, string]> = [
      ["id", "Granule"],
      ["begin", "Begin"],
      ["links", "Links"],
    ];
    for (const [key, text] of columns) {
      const th = document.createElement("th");
      th.className = "opera-th";
      th.dataset.sort = key;
      th.innerHTML = `${text}<span class="opera-sort-ind"></span>`;
      th.addEventListener("click", () => this._onSortClick(key));
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const body = document.createElement("tbody");
    this._tableBody = body;
    table.appendChild(body);
    wrap.appendChild(table);
    container.appendChild(wrap);
    return container;
  }

  private _renderResults(): void {
    this._view = [...this._granules];
    this._selectedIds.clear();
    this._anchorId = null;
    this._activeGranule = null;
    this._bands = [];
    this._populateBands();
    if (this._displayBtn) this._displayBtn.disabled = true;
    if (this._downloadBandBtn) this._downloadBandBtn.disabled = true;
    if (this._downloadAllBtn) this._downloadAllBtn.disabled = true;
    if (this._inspectBtn) this._inspectBtn.disabled = true;
    this._stopInspect();
    this._clearHighlight();
    this._renderRows();
  }

  /** (Re)build the table body from the current view + sort, keeping selection. */
  private _renderRows(): void {
    if (!this._tableBody) return;
    this._sortView();
    this._tableBody.innerHTML = "";
    for (const granule of this._view) {
      const tr = document.createElement("tr");
      tr.className = "opera-row";
      tr.dataset.granuleId = granule.id;
      if (this._selectedIds.has(granule.id)) tr.classList.add("selected");
      const begin = granule.beginDate?.slice(0, 10) ?? "";
      tr.innerHTML = `
        <td title="${escapeHtml(granule.id)}">${escapeHtml(shorten(granule.id))}</td>
        <td>${escapeHtml(begin)}</td>
        <td>${granule.dataLinks.length}</td>`;
      tr.addEventListener("click", (ev) =>
        this._applySelection(granule, {
          toggle: ev.ctrlKey || ev.metaKey,
          range: ev.shiftKey,
        }),
      );
      this._tableBody.appendChild(tr);
    }
    this._updateSortIndicators();
  }

  private _onSortClick(key: "id" | "begin" | "links"): void {
    if (this._sortKey === key) {
      this._sortDir = this._sortDir === 1 ? -1 : 1;
    } else {
      this._sortKey = key;
      this._sortDir = 1;
    }
    this._renderRows();
  }

  private _sortView(): void {
    const key = this._sortKey;
    if (!key) return;
    const dir = this._sortDir;
    this._view.sort((a, b) => {
      if (key === "links") return (a.dataLinks.length - b.dataLinks.length) * dir;
      const av = key === "begin" ? (a.beginDate ?? "") : a.id;
      const bv = key === "begin" ? (b.beginDate ?? "") : b.id;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  private _updateSortIndicators(): void {
    const head = this._tableBody?.parentElement?.querySelector("thead");
    if (!head) return;
    head.querySelectorAll<HTMLElement>(".opera-th").forEach((th) => {
      const ind = th.querySelector(".opera-sort-ind");
      if (!ind) return;
      ind.textContent =
        th.dataset.sort === this._sortKey
          ? this._sortDir === 1
            ? " ▲"
            : " ▼"
          : "";
    });
  }

  private _buildBandGroup(): HTMLElement {
    const group = el("div", "plugin-control-group");
    group.appendChild(label("Layer / band"));
    const select = document.createElement("select");
    select.className = "plugin-control-input opera-select";
    select.addEventListener("change", () => this._applyBandDefaults(select.value));
    this._bandSelect = select;
    group.appendChild(select);
    return group;
  }

  /**
   * Populate the Rendering fields with the selected band's default rescale +
   * colormap, so the applied rendering is visible and tweakable. Categorical
   * water bands populate blanks (their built-in class colormap applies).
   */
  private _applyBandDefaults(band: string): void {
    if (!band) return;
    const defaults = bandRenderDefaults(this._state.product, band);
    this._state.rescale = defaults.rescale;
    this._state.colormapName = defaults.colormapName;
    if (this._rescaleInput) this._rescaleInput.value = defaults.rescale;
    if (this._colormapSelect) this._colormapSelect.value = defaults.colormapName;
  }

  private _populateBands(): void {
    const select = this._bandSelect;
    if (!select) return;
    select.innerHTML = "";
    const product = getProduct(this._state.product);
    const preferred = product?.render.bands?.[0];
    for (const band of this._bands) {
      const opt = document.createElement("option");
      opt.value = band.token;
      opt.textContent = band.label;
      if (preferred && band.token === preferred) opt.selected = true;
      select.appendChild(opt);
    }
    if (this._bands.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "Select a granule…";
      opt.disabled = true;
      opt.selected = true;
      select.appendChild(opt);
    } else {
      // Auto-fill the Rendering fields for the selected band.
      this._applyBandDefaults(select.value);
    }
  }

  // Optional render overrides: rescale + named colormap. Blank fields fall back
  // to the product/band defaults. Useful for continuous bands like DEM that
  // otherwise render flat gray (e.g. rescale "0,3000" + colormap "terrain").
  private _buildRenderGroup(): HTMLElement {
    const wrap = document.createElement("div");

    const rescaleGroup = el("div", "plugin-control-group");
    rescaleGroup.appendChild(label("Rescale (min,max)"));
    const rescale = document.createElement("input");
    rescale.className = "plugin-control-input";
    rescale.type = "text";
    rescale.placeholder = "auto — e.g. 0,3000 for DEM";
    rescale.value = this._state.rescale;
    rescale.dataset.field = "rescale";
    rescale.addEventListener("input", () => {
      this._state.rescale = rescale.value;
    });
    this._rescaleInput = rescale;
    rescaleGroup.appendChild(rescale);

    const cmapGroup = el("div", "plugin-control-group");
    cmapGroup.appendChild(label("Colormap"));
    const cmap = document.createElement("select");
    cmap.className = "plugin-control-input opera-select";
    cmap.dataset.field = "colormapName";
    for (const name of COLORMAP_NAMES) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name || "(default)";
      if (name === this._state.colormapName) opt.selected = true;
      cmap.appendChild(opt);
    }
    cmap.addEventListener("change", () => {
      this._state.colormapName = cmap.value;
    });
    this._colormapSelect = cmap;
    cmapGroup.appendChild(cmap);

    wrap.append(rescaleGroup, cmapGroup);
    return wrap;
  }

  private _buildDisplayButton(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plugin-control-button opera-block-button";
    btn.textContent = "Display";
    btn.disabled = true;
    this._displayBtn = btn;
    btn.addEventListener("click", () => void this._onDisplay());
    return btn;
  }

  // --- Click-to-inspect (titiler-cmr /point) -----------------------------

  private _buildInspectButton(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "plugin-control-button opera-secondary-button opera-block-button";
    btn.textContent = "Inspect pixel values";
    btn.title =
      "Toggle, then click the map to read the selected band's value at that location";
    btn.disabled = true;
    btn.addEventListener("click", () => this._toggleInspect());
    this._inspectBtn = btn;
    return btn;
  }

  private _toggleInspect(): void {
    if (this._inspecting) this._stopInspect();
    else this._startInspect();
  }

  private _startInspect(): void {
    if (!this._map) return;
    if (this._drawing) this._endDraw();
    this._inspecting = true;
    if (this._inspectBtn) {
      this._inspectBtn.classList.add("active");
      this._inspectBtn.textContent = "Inspecting — click the map";
    }
    this._map.getCanvas().style.cursor = "crosshair";
    this._setStatus(
      "Click the map to read pixel values. Click Inspect again to stop.",
    );
  }

  private _stopInspect(): void {
    if (!this._inspecting) return;
    this._inspecting = false;
    if (this._inspectBtn) {
      this._inspectBtn.classList.remove("active");
      this._inspectBtn.textContent = "Inspect pixel values";
    }
    if (this._map) this._map.getCanvas().style.cursor = "";
  }

  /**
   * Query titiler-cmr `/point` for each selected granule at the clicked
   * location and show the values in a map popup. Each granule is pinned by
   * `granule_ur` so the values match exactly what Display renders.
   */
  private async _inspectAt(lngLat: { lng: number; lat: number }): Promise<void> {
    const product = getProduct(this._state.product);
    const selected = this._granules.filter((g) => this._selectedIds.has(g.id));
    if (!product || selected.length === 0) {
      this._setStatus("Select a granule first, then click the map to inspect.");
      return;
    }
    const band = this._bandSelect?.value || product.render.bands?.[0];
    this._showInspectPopup(lngLat, "<em>Reading value…</em>");
    try {
      const conceptId =
        selected[0].conceptId ?? (await resolveConceptId(product.shortName));
      const results = await Promise.all(
        selected.map(async (granule) => {
          try {
            const url = buildPointUrl({
              endpoint: this._state.endpoint || DEFAULT_TITILER_CMR_ENDPOINT,
              conceptId,
              backend: product.render.backend,
              lon: lngLat.lng,
              lat: lngLat.lat,
              granuleUr: granule.id,
              bands: band ? [band] : product.render.bands,
              bandsRegex: product.render.bandsRegex,
            });
            return { granule, point: await fetchPoint(url) };
          } catch {
            return { granule, point: null };
          }
        }),
      );
      // The popup may have been dismissed (or inspect stopped) while awaiting.
      if (this._inspectLngLat !== lngLat) return;
      this._showInspectPopup(
        lngLat,
        this._formatInspect(lngLat, results, band),
      );
    } catch (err) {
      if (this._inspectLngLat !== lngLat) return;
      this._showInspectPopup(
        lngLat,
        `Inspect failed: ${escapeHtml(
          err instanceof Error ? err.message : String(err),
        )}`,
      );
    }
  }

  /** Render the per-granule point values as popup HTML. */
  private _formatInspect(
    lngLat: { lng: number; lat: number },
    results: Array<{ granule: OperaGranule; point: PointResult | null }>,
    band?: string,
  ): string {
    const head = `
      <div class="opera-inspect-band">${escapeHtml(band ?? "value")}</div>
      <div class="opera-inspect-coord">${lngLat.lng.toFixed(
        4,
      )}, ${lngLat.lat.toFixed(4)}</div>`;
    const rows = results.map(({ granule, point }) => {
      const name = escapeHtml(shorten(granule.id, 24));
      const value =
        point && point.assets.length > 0
          ? formatPointValues(point)
          : "no data";
      return `<div class="opera-inspect-row"><span class="opera-inspect-g" title="${escapeHtml(
        granule.id,
      )}">${name}</span><span class="opera-inspect-v">${escapeHtml(
        value,
      )}</span></div>`;
    });
    return head + rows.join("");
  }

  private _showInspectPopup(
    lngLat: { lng: number; lat: number },
    html: string,
  ): void {
    const map = this._map;
    const container = this._mapContainer;
    if (!map || !container) return;
    this._inspectLngLat = lngLat;
    if (!this._inspectPopup) {
      const popup = document.createElement("div");
      popup.className = "opera-inspect-popup";
      const close = document.createElement("button");
      close.className = "opera-inspect-close";
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.innerHTML = "&times;";
      close.addEventListener("click", () => this._removeInspectPopup());
      const body = document.createElement("div");
      body.className = "opera-inspect-body";
      popup.append(close, body);
      container.appendChild(popup);
      this._inspectPopup = popup;
      // Keep the popup pinned to its geographic point as the map pans/zooms.
      this._inspectMoveHandler = () => this._positionInspectPopup();
      map.on("move", this._inspectMoveHandler);
    }
    const body = this._inspectPopup.querySelector(".opera-inspect-body");
    if (body) body.innerHTML = html;
    this._positionInspectPopup();
  }

  private _positionInspectPopup(): void {
    const map = this._map;
    const popup = this._inspectPopup;
    const ll = this._inspectLngLat;
    if (!map || !popup || !ll) return;
    const p = map.project([ll.lng, ll.lat]);
    popup.style.left = `${p.x}px`;
    popup.style.top = `${p.y}px`;
  }

  private _removeInspectPopup(): void {
    if (this._inspectMoveHandler && this._map) {
      this._map.off("move", this._inspectMoveHandler);
      this._inspectMoveHandler = null;
    }
    this._inspectPopup?.remove();
    this._inspectPopup = undefined;
    this._inspectLngLat = undefined;
  }

  private _buildDownloadGroup(): HTMLElement {
    const row = el("div", "opera-download-row");

    const bandBtn = document.createElement("button");
    bandBtn.type = "button";
    bandBtn.className = "plugin-control-button opera-secondary-button";
    bandBtn.textContent = "Download band";
    bandBtn.title = "Download the selected band for each selected granule";
    bandBtn.disabled = true;
    bandBtn.addEventListener("click", () => this._downloadSelected(false));
    this._downloadBandBtn = bandBtn;

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "plugin-control-button opera-secondary-button";
    allBtn.textContent = "Download all bands";
    allBtn.title = "Download every band file for each selected granule";
    allBtn.disabled = true;
    allBtn.addEventListener("click", () => this._downloadSelected(true));
    this._downloadAllBtn = allBtn;

    row.append(bandBtn, allBtn);
    return row;
  }

  /**
   * Download the selected granules' files through the browser. OPERA data is
   * Earthdata-protected, so each URL is opened as a navigation (new tab): the
   * browser follows the login redirect and downloads when the user has an
   * Earthdata session. No credentials are handled by the plugin.
   */
  private _downloadSelected(allBands: boolean): void {
    const product = getProduct(this._state.product);
    const selected = this._granules.filter((g) => this._selectedIds.has(g.id));
    if (selected.length === 0) {
      this._setStatus("Select a granule first.");
      return;
    }
    const band = this._bandSelect?.value || product?.render.bands?.[0];
    const urls: string[] = [];
    for (const granule of selected) {
      // Only HTTPS links are browser-downloadable (s3:// links are not).
      const https = granule.dataLinks.filter((u) => u.startsWith("https://"));
      if (allBands) {
        urls.push(...https);
      } else {
        const match = https.find((u) => getLayerBand(u) === band);
        if (match) urls.push(match);
      }
    }
    if (urls.length === 0) {
      this._setStatus("No downloadable files found for the selection.");
      return;
    }
    this._triggerDownloads(urls);
    this._setStatus(
      `Downloading ${urls.length} file(s). Sign in to NASA Earthdata if prompted.`,
    );
  }

  /** Trigger downloads for each URL, staggered to avoid being collapsed. */
  private _triggerDownloads(urls: string[]): void {
    urls.forEach((url, i) => {
      setTimeout(() => void this._openForDownload(url), i * 300);
    });
  }

  /**
   * Open one download URL. Under Tauri the webview ignores anchor/window.open,
   * so route through the system browser via the opener plugin (where the user's
   * Earthdata session lives). On the web/standalone, fall back to an anchor
   * click that opens in a new tab so a login page never replaces the app.
   */
  private async _openForDownload(url: string): Promise<void> {
    if (isTauri()) {
      try {
        await openUrl(url);
        return;
      } catch {
        // Fall through to the anchor approach below.
      }
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  private _buildEndpointGroup(): HTMLElement {
    const group = el("div", "plugin-control-group opera-endpoint");
    group.appendChild(label("titiler-cmr endpoint"));
    const input = document.createElement("input");
    input.className = "plugin-control-input";
    input.type = "text";
    input.value = this._state.endpoint;
    input.dataset.field = "endpoint";
    input.addEventListener("input", () => {
      this._state.endpoint = input.value.trim();
    });
    group.appendChild(input);
    return group;
  }

  // Read all form field values into state.
  private _readForm(): void {
    if (!this._panel) return;
    const fields = this._panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "[data-field]",
    );
    fields.forEach((field) => {
      const key = field.dataset.field as keyof OperaState | undefined;
      if (!key) return;
      if (key === "count") {
        const v = parseInt(field.value, 10);
        if (Number.isFinite(v)) this._state.count = v;
      } else if (key in this._state) {
        // string fields
        (this._state as unknown as Record<string, unknown>)[key] = field.value;
      }
    });
  }

  // Write state values back into the form inputs.
  private _syncForm(): void {
    if (!this._panel) return;
    const fields = this._panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "[data-field]",
    );
    fields.forEach((field) => {
      const key = field.dataset.field as keyof OperaState | undefined;
      if (!key) return;
      const value = this._state[key];
      if (value != null) field.value = String(value);
    });
  }

  private _setStatus(message: string): void {
    if (this._status) this._status.textContent = message;
  }

  // --- Positioning (adapted from the template's PluginControl) -----------

  private _setupEventListeners(): void {
    // Bidirectional footprint selection: clicking a footprint on the map selects
    // its row; a pointer cursor signals it is clickable.
    this._map?.on("click", this._onMapClick);
    this._map?.on("mousemove", this._onMapMouseMove);

    // The panel stays open until the user clicks the toggle button or the X
    // close button; it does not collapse on click-outside.
    this._resizeHandler = () => {
      if (!this._state.collapsed) this._updatePanelPosition();
    };
    window.addEventListener("resize", this._resizeHandler);

    this._mapResizeHandler = () => {
      if (!this._state.collapsed) this._updatePanelPosition();
    };
    this._map?.on("resize", this._mapResizeHandler);
  }

  private _getControlPosition():
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right" {
    const parent = this._container?.parentElement;
    if (!parent) return "top-right";
    if (parent.classList.contains("maplibregl-ctrl-top-left")) return "top-left";
    if (parent.classList.contains("maplibregl-ctrl-top-right")) return "top-right";
    if (parent.classList.contains("maplibregl-ctrl-bottom-left"))
      return "bottom-left";
    if (parent.classList.contains("maplibregl-ctrl-bottom-right"))
      return "bottom-right";
    return "top-right";
  }

  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;
    const button = this._container.querySelector(".plugin-control-toggle");
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();

    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;
    const gap = 5;

    this._panel.style.top = "";
    this._panel.style.bottom = "";
    this._panel.style.left = "";
    this._panel.style.right = "";

    switch (position) {
      case "top-left":
        this._panel.style.top = `${buttonTop + buttonRect.height + gap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;
      case "top-right":
        this._panel.style.top = `${buttonTop + buttonRect.height + gap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
      case "bottom-left":
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + gap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;
      case "bottom-right":
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + gap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
    }
  }
}

// --- small DOM helpers ---------------------------------------------------

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function label(text: string): HTMLElement {
  const node = document.createElement("label");
  node.className = "plugin-control-label";
  node.textContent = text;
  return node;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function shorten(value: string, max = 28): string {
  return value.length > max ? `…${value.slice(value.length - max)}` : value;
}

/** Format a number for the inspect popup: integers as-is, floats trimmed. */
function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return parseFloat(v.toPrecision(5)).toString();
}

/**
 * Flatten a point result's asset values into a compact label, e.g. `1` for a
 * single-band class value or `VV=0.0123, VH=0.0047` across bands.
 */
function formatPointValues(point: PointResult): string {
  const parts: string[] = [];
  for (const asset of point.assets) {
    asset.values.forEach((v, i) => {
      const text = v == null ? "nodata" : formatNumber(v);
      // Only prefix with the band name when there is more than one value, so a
      // single-band read stays terse.
      const single = point.assets.length === 1 && asset.values.length === 1;
      parts.push(single ? text : `${asset.bandNames[i] ?? `b${i + 1}`}=${text}`);
    });
  }
  return parts.length > 0 ? parts.join(", ") : "no data";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
