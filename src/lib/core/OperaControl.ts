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
import {
  colormapForBand,
  DSWX_OPEN_WATER_CLASS,
  DSWX_PARTIAL_WATER_CLASS,
  DSWX_WTR_CLASS_LABELS,
  isCategoricalBand,
  isDswxWaterBand,
} from "../opera/colormaps";
import {
  bandRenderDefaults,
  expressionPresets,
  type ExpressionPreset,
  getProduct,
  OPERA_PIXEL_SIZE_METERS,
  OPERA_PRODUCTS,
} from "../opera/products";
import {
  buildPointUrl,
  buildStatisticsUrl,
  buildTileJsonUrl,
  DEFAULT_TITILER_CMR_ENDPOINT,
  fetchPoint,
  fetchStatistics,
  fetchTileJson,
  resolveDefaultTitilerCmrEndpoint,
  tileJsonBounds,
  tileSizeFromTemplate,
  type BandStatistics,
  type PointResult,
  type StatisticsResult,
  type TileJson,
} from "../opera/titiler";
import type {
  BBox,
  GranuleBand,
  OperaGranule,
} from "../opera/types";
import {
  lockBenchmark,
  summarizeBenchmark,
  type BenchmarkEvent,
  type BenchmarkRender,
  type BenchmarkSummary,
  type LockedBenchmark,
} from "../opera/benchmark";
import { fetchOsmBuildings } from "../opera/buildings";
import { deriveFloodExtent } from "../opera/flood-extent";
import { buildingsInFlood, type GeoFeatureCollection } from "../opera/geometry";
import { searchNews, type NewsResult } from "../opera/news";
import {
  buildOnePagerHtml,
  type OnePagerImpact,
} from "../opera/one-pager";

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
  /** Optional band-math expression (e.g. "10*log10(b1)"); blank renders the raw band. */
  expression: string;
  /** titiler-cmr endpoint. */
  endpoint: string;
  /**
   * The human-QAed flood benchmark locked as the agent's authoritative
   * boundary. Persisted with the project so a locked benchmark survives reloads.
   */
  benchmark?: LockedBenchmark;
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
  /** Initial titiler-cmr endpoint. Overrides runtime/build defaults. */
  defaultEndpoint?: string;
  /**
   * Reveal the panel when the control renders in a host-docked right panel
   * (bound by the GeoLibre wrapper to `app.openRightPanel`). In floating mode
   * this is unset and {@link OperaControl.expand} drives the internal panel.
   */
  onRequestReveal?: () => void;
}

export interface OperaAgentSearchParams {
  /** OPERA CMR short_name or short title, e.g. OPERA_L3_DSWX-HLS_V1 or DSWX-HLS. */
  product?: string;
  /** Bounding box as [west, south, east, north] or "west,south,east,north". */
  bbox?: BBox | string;
  /** Inclusive start date, YYYY-MM-DD. */
  start?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end?: string;
  /** Max granules to request. */
  count?: number;
}

export interface OperaAgentDisplayParams {
  /** Granule ids from the latest search. Omit to display the first matching result(s). */
  granuleIds?: string[];
  /** Max granules to display when granuleIds is omitted. */
  maxGranules?: number;
  /** Band/layer token, e.g. B01_WTR, VV, VH, B10_DEM. */
  band?: string;
  /** Optional "min,max" render stretch. */
  rescale?: string;
  /** Optional titiler named colormap. */
  colormapName?: string;
  /** Optional rio-tiler expression; selected band is b1. */
  expression?: string;
  /**
   * DSWx WTR bands only: render open water + partial surface water and make
   * cloud/ocean-masked/no-data transparent. Keeps flood snapshots (the
   * one-pager) legible when several post-event scenes are stacked.
   */
  waterOnly?: boolean;
}

export interface OperaAgentChangeParams {
  /** OPERA CMR short_name or short title. */
  product?: string;
  /** AOI bbox as [west, south, east, north] or "west,south,east,north". */
  bbox?: BBox | string;
  /** Baseline date, YYYY-MM-DD. */
  beforeDate: string;
  /** Comparison date, YYYY-MM-DD. */
  afterDate: string;
  /** Days on each side of each date to search for a nearby granule. */
  windowDays?: number;
  /** Band/layer token, e.g. B01_WTR, VV, VH. */
  band?: string;
  /** Optional rio-tiler expression used for display/statistics. */
  expression?: string;
  /** Optional "min,max" render stretch. */
  rescale?: string;
  /** Optional titiler named colormap. */
  colormapName?: string;
}

export interface OperaAgentTimeSeriesParams {
  /** OPERA CMR short_name or short title. */
  product?: string;
  /** AOI bbox as [west, south, east, north] or "west,south,east,north". */
  bbox?: BBox | string;
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Max observations to analyze. */
  count?: number;
  /** Optional sampling interval in days; closest granule per interval is used. */
  intervalDays?: number;
  /** Band/layer token, e.g. B01_WTR, VV, VH. */
  band?: string;
  /** Optional rio-tiler expression used for display/statistics. */
  expression?: string;
  /** Optional "min,max" render stretch. */
  rescale?: string;
  /** Optional titiler named colormap. */
  colormapName?: string;
  /** Display the first and last observations as map layers. */
  displayEndpoints?: boolean;
}

export interface OperaAgentReportParams {
  /** Report format. Markdown is intended for direct download/readback. */
  format?: "markdown" | "json";
}

export interface OperaAgentResult {
  ok: boolean;
  status: string;
  product: string;
  granules: Array<{
    id: string;
    beginDate?: string;
    endDate?: string;
    bbox?: BBox;
    bands: string[];
    linkCount: number;
  }>;
}

export interface OperaAgentChangeResult {
  ok: boolean;
  status: string;
  product: string;
  band: string;
  bbox?: BBox;
  before?: OperaAgentChangeObservation;
  after?: OperaAgentChangeObservation;
  change?: Record<string, number | string | null>;
  derivedLayer?: OperaAgentDerivedLayer;
  displayedLayerIds: string[];
}

export interface OperaAgentChangeObservation {
  date: string;
  granuleId: string;
  granuleDate?: string;
  layerIds: string[];
  statistics?: Record<string, number | string | null>;
}

export interface OperaAgentTimeSeriesResult {
  ok: boolean;
  status: string;
  product: string;
  band: string;
  bbox?: BBox;
  observations: OperaAgentChangeObservation[];
  trends?: Record<string, number | string | null>;
  displayedLayerIds: string[];
}

export interface OperaAgentDerivedLayer {
  name: string;
  featureCount: number;
  changeType?: "gain" | "loss" | "stable" | "unknown";
}

export interface OperaAgentReportResult {
  ok: boolean;
  status: string;
  filename?: string;
  format?: "markdown" | "json";
  content?: string;
}

export interface OperaAgentTileLayerParams {
  id?: string;
  name: string;
  tilejson: TileJson;
  metadata?: Record<string, unknown>;
  opacity?: number;
  fitBounds?: boolean;
}

/** Result of `getBenchmarkForAgent` / benchmark-gated tools. */
export interface OperaAgentBenchmarkResult {
  ok: boolean;
  status: string;
  benchmark?: BenchmarkSummary;
}

export interface OperaAgentDeriveFloodParams {
  /** AOI as [west,south,east,north] or a "w,s,e,n" string. Omit to use panel bbox. */
  bbox?: BBox | string;
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Event name for the derived benchmark (e.g. "Valencia DANA flooding"). */
  eventName?: string;
  /** Human place label for the benchmark/one-pager subtitle. */
  place?: string;
  /** Max DSWx granules to mosaic (1-12); default 6. */
  maxGranules?: number;
}

export interface OperaAgentDeriveFloodResult extends OperaAgentBenchmarkResult {
  /** DSWx raster layer ids added to the map for the one-pager snapshot. */
  dswxLayerIds: string[];
  /** How many DSWx granules contributed to the observed-water mosaic. */
  granulesUsed: number;
}

export interface OperaAgentBuildingsParams {
  /** Ancillary building source. Only "osm" (Overpass) is supported in v1. */
  buildingSource?: "osm";
  /** Draw the flooded buildings as a map layer. */
  addLayer?: boolean;
  /** Also sum the flooded buildings' footprint area (km²). */
  computeArea?: boolean;
}

export interface OperaAgentBuildingsResult {
  ok: boolean;
  status: string;
  /** Buildings tested within the benchmark bbox. */
  total: number;
  /** Buildings whose centroid falls inside the flood water polygon. */
  floodedCount: number;
  /** floodedCount / total. */
  fraction: number;
  floodedAreaKm2?: number;
  source: string;
  layerId?: string;
}

export interface OperaAgentNewsParams {
  /** Search query, e.g. "Valencia flood October 2024 deaths damages". */
  query: string;
  /** Max results to return (1-20). */
  maxResults?: number;
}

export interface OperaAgentNewsResult {
  ok: boolean;
  status: string;
  results: NewsResult[];
  answer?: string;
}

export interface OperaAgentOnePagerParams {
  title?: string;
  narrative?: string;
  impacts?: OnePagerImpact[];
  buildings?: {
    floodedCount: number;
    total: number;
    fraction: number;
    floodedAreaKm2?: number;
    source?: string;
  };
  /** Map PNG data URL; when omitted the control captures the current map. */
  mapSnapshotDataUrl?: string;
  /** Download the generated HTML (default true). */
  download?: boolean;
}

export interface OperaAgentOnePagerResult {
  ok: boolean;
  status: string;
  filename?: string;
  /** The generated self-contained HTML document. */
  html?: string;
}

const PANEL_CLASS = "plugin-control-panel opera-panel";

/** Message returned by benchmark-gated agent tools when none is locked. */
const BENCHMARK_REQUIRED =
  "No benchmark is locked. Import and lock a QAed flood water-extent GeoJSON first (Benchmark section in the OPERA panel).";

// Self-managed map overlay for highlighting the selected footprint. These ids
// are not touched by GeoLibre's layer-sync (which only prunes its own
// `layer-<id>-...` prefixes), so they persist across store updates.
const HL_SRC = "opera-hl-src";
const HL_FILL = "opera-hl-fill";
const HL_LINE = "opera-hl-line";

type BBoxFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
};

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
  // The scrollable body holding every `[data-field]` input. In floating mode it
  // lives inside `_panel`; in docked mode it is mounted straight into the host's
  // right-panel container. `_readForm`/`_syncForm` query it in both modes.
  private _content?: HTMLElement;
  // True while the control is rendered into a host-provided docked right panel
  // (via `renderDocked`) rather than added as a floating MapLibre control.
  private _docked = false;
  private _status?: HTMLElement;
  private _tableBody?: HTMLElement;
  private _bandSelect?: HTMLSelectElement;
  private _rescaleInput?: HTMLInputElement;
  private _colormapSelect?: HTMLSelectElement;
  private _expressionInput?: HTMLInputElement;
  private _expressionPresetSelect?: HTMLSelectElement;
  private _expressionHint?: HTMLElement;
  private _currentExpressionPresets: ExpressionPreset[] = [];
  private _displayBtn?: HTMLButtonElement;
  private _downloadBandBtn?: HTMLButtonElement;
  private _downloadAllBtn?: HTMLButtonElement;
  private _downloadReportBtn?: HTMLButtonElement;
  private _options: OperaControlOptions;
  private _state: OperaState;
  private _lastStatus = "";
  private _lastChangeResult?: OperaAgentChangeResult;

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

  // Zonal statistics (titiler-cmr /statistics) UI.
  private _statsBtn?: HTMLButtonElement;
  private _statsPanel?: HTMLElement;

  // Benchmark import UI.
  private _benchmarkStatus?: HTMLElement;

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
      expression: "",
      endpoint: resolveDefaultTitilerCmrEndpoint(options.defaultEndpoint),
    };
  }

  // --- IControl (floating mode) ------------------------------------------

  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._docked = false;
    this._container = this._createContainer();
    this._panel = this._createPanel();
    this._mapContainer.appendChild(this._panel);
    this._attachMapInteractions();
    this._setupFloatingListeners();
    this._restoreBenchmarkLayer();

    if (!this._state.collapsed) {
      this._panel.classList.add("expanded");
      requestAnimationFrame(() => this._updatePanelPosition());
    }
    return this._container;
  }

  /**
   * Redraw a benchmark restored from saved project state onto the map. The
   * benchmark itself persists in `OperaState`, but its map layer is host-owned
   * and not restored automatically, so re-add it when the control (re)mounts.
   */
  private _restoreBenchmarkLayer(): void {
    if (this._state.benchmark) this._addBenchmarkLayer(this._state.benchmark);
  }

  onRemove(): void {
    this._detachMapInteractions();
    this._panel?.parentNode?.removeChild(this._panel);
    this._container?.parentNode?.removeChild(this._container);
    this._resetRefs();
  }

  // --- Docked mode (host right panel) ------------------------------------

  /**
   * Render the OPERA UI into a host-provided docked right-panel container
   * instead of a floating MapLibre control. The host owns the panel chrome
   * (header, collapse/close, resize); this method fills only the body and wires
   * up the same map interactions (footprint select, draw, inspect) as floating
   * mode. Pair with {@link teardownDocked}, which the wrapper returns as the
   * panel's cleanup callback.
   */
  renderDocked(container: HTMLElement, map: MapLibreMap): void {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._docked = true;
    // Wrapper carries the `.plugin-control` (theme tokens + box-sizing reset)
    // and `.opera-panel` (input sizing) classes the panel CSS is scoped to,
    // without the floating panel's positioning/resize behavior.
    const wrap = document.createElement("div");
    wrap.className = "plugin-control opera-panel opera-docked";
    const content = this._buildContent();
    wrap.appendChild(content);
    container.appendChild(wrap);
    this._panel = wrap;
    this._attachMapInteractions();

    // Restore any results/selection captured before a previous teardown so a
    // close/reopen of the docked panel does not lose the search table. A fresh
    // mount (no prior search) starts empty, matching floating mode.
    if (this._granules.length > 0) {
      if (this._view.length === 0) this._view = [...this._granules];
      this._renderRows();
      this._refreshSelectionUI();
    }
    this._restoreBenchmarkLayer();
    if (this._lastStatus) this._setStatus(this._lastStatus);
  }

  /** Tear down the docked render, detaching map interactions and DOM. */
  teardownDocked(): void {
    this._detachMapInteractions();
    this._panel?.parentNode?.removeChild(this._panel);
    this._docked = false;
    this._resetRefs();
  }

  // --- Shared attach/teardown --------------------------------------------

  /** Detach every map listener, overlay, and registered layer this control owns. */
  private _detachMapInteractions(): void {
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
  }

  /** Clear all DOM/element references after the control is removed. */
  private _resetRefs(): void {
    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._content = undefined;
    this._status = undefined;
    this._tableBody = undefined;
    this._bandSelect = undefined;
    this._rescaleInput = undefined;
    this._colormapSelect = undefined;
    this._expressionInput = undefined;
    this._expressionPresetSelect = undefined;
    this._expressionHint = undefined;
    this._displayBtn = undefined;
    this._downloadBandBtn = undefined;
    this._downloadAllBtn = undefined;
    this._downloadReportBtn = undefined;
    this._inspectBtn = undefined;
    this._statsBtn = undefined;
    this._statsPanel = undefined;
    this._benchmarkStatus = undefined;
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
    // In docked mode the host owns collapse/expand, so ask it to reveal the
    // panel (e.g. when an agent action needs the UI visible) instead of driving
    // the internal floating panel.
    if (this._docked) {
      this._state.collapsed = false;
      this._options.onRequestReveal?.();
      return;
    }
    if (this._state.collapsed) this.toggle();
  }

  getAgentContext(): OperaAgentResult & {
    products: Array<{ shortName: string; shortTitle: string; description: string }>;
    selectedGranuleIds: string[];
    endpoint: string;
    bbox: string;
    start: string;
    end: string;
    benchmark: BenchmarkSummary | null;
  } {
    this._readForm();
    return {
      ok: true,
      status: this._lastStatus,
      product: this._state.product,
      endpoint: this._state.endpoint,
      bbox: this._state.bbox,
      start: this._state.start,
      end: this._state.end,
      selectedGranuleIds: [...this._selectedIds],
      products: OPERA_PRODUCTS.map((p) => ({
        shortName: p.shortName,
        shortTitle: p.shortTitle,
        description: p.description,
      })),
      granules: this._agentGranuleSummaries(),
      benchmark: this._state.benchmark
        ? summarizeBenchmark(this._state.benchmark)
        : null,
    };
  }

  async searchForAgent(params: OperaAgentSearchParams): Promise<OperaAgentResult> {
    this.expand();
    const product = params.product ? resolveProductForAgent(params.product) : undefined;
    if (params.product && !product) {
      return {
        ok: false,
        status: `Unknown OPERA product: ${params.product}`,
        product: this._state.product,
        granules: this._agentGranuleSummaries(),
      };
    }
    if (product) this._state.product = product.shortName;
    if (params.bbox !== undefined) {
      const bbox = normalizeAgentBBox(params.bbox);
      if (!bbox) {
        return {
          ok: false,
          status: "Invalid bbox. Use [west,south,east,north].",
          product: this._state.product,
          granules: this._agentGranuleSummaries(),
        };
      }
      this._state.bbox = bbox.map((v) => trimNumber(v)).join(", ");
    }
    if (params.start !== undefined) this._state.start = params.start;
    if (params.end !== undefined) this._state.end = params.end;
    if (params.count !== undefined && Number.isFinite(params.count)) {
      this._state.count = Math.min(Math.max(Math.round(params.count), 1), 500);
    }
    this._syncForm();
    await this._onSearch();
    return {
      ok: !/^Search failed:/i.test(this._lastStatus),
      status: this._lastStatus,
      product: this._state.product,
      granules: this._agentGranuleSummaries(),
    };
  }

  async displayForAgent(params: OperaAgentDisplayParams): Promise<
    OperaAgentResult & { displayedLayerIds: string[]; selectedGranuleIds: string[] }
  > {
    this.expand();
    const selected = this._selectGranulesForAgent(
      params.granuleIds,
      params.maxGranules,
    );
    if (selected.length === 0) {
      return {
        ok: false,
        status:
          "No granules selected. Run search_opera_granules first or pass granuleIds from the latest search.",
        product: this._state.product,
        granules: this._agentGranuleSummaries(),
        displayedLayerIds: [],
        selectedGranuleIds: [],
      };
    }
    if (params.band) this._setBandForAgent(params.band);
    if (params.rescale !== undefined) {
      this._state.rescale = params.rescale;
      if (this._rescaleInput) this._rescaleInput.value = params.rescale;
    }
    if (params.colormapName !== undefined) {
      this._state.colormapName = params.colormapName;
      if (this._colormapSelect) this._colormapSelect.value = params.colormapName;
    }
    if (params.expression !== undefined) {
      this._setExpression(params.expression);
    }
    const before = new Set(this._registeredLayerIds);
    await this._onDisplay({ waterOnly: params.waterOnly });
    const displayedLayerIds = this._registeredLayerIds.filter((id) => !before.has(id));
    return {
      ok: displayedLayerIds.length > 0 && !/^Display failed:/i.test(this._lastStatus),
      status: this._lastStatus,
      product: this._state.product,
      granules: this._agentGranuleSummaries(),
      displayedLayerIds,
      selectedGranuleIds: [...this._selectedIds],
    };
  }

  registerTileJsonForAgent(params: OperaAgentTileLayerParams): {
    ok: boolean;
    layerId?: string;
    status: string;
  } {
    const tileUrl = params.tilejson.tiles[0];
    if (!tileUrl) {
      return { ok: false, status: "TileJSON did not include any tile URL." };
    }
    const layerId = params.id ?? `titiler-cmr-${slug(params.name) || Date.now()}`;
    this._registerLayer({
      id: layerId,
      name: params.name,
      type: "raster",
      source: {
        type: "raster",
        tiles: [tileUrl],
        tileSize: tileSizeFromTemplate(tileUrl),
        ...(params.tilejson.minzoom != null
          ? { minzoom: params.tilejson.minzoom }
          : {}),
        ...(params.tilejson.maxzoom != null
          ? { maxzoom: params.tilejson.maxzoom }
          : {}),
      },
      nativeLayerIds: [],
      opacity: params.opacity ?? 1,
      metadata: params.metadata,
    });
    const bounds = tileJsonBounds(params.tilejson);
    if (params.fitBounds !== false && bounds) this._options.fitBounds?.(bounds);
    const status = `Registered titiler-cmr layer ${layerId}.`;
    this._setStatus(status);
    return { ok: true, layerId, status };
  }

  async detectChangeForAgent(
    params: OperaAgentChangeParams,
  ): Promise<OperaAgentChangeResult> {
    this.expand();
    const product =
      params.product !== undefined
        ? resolveProductForAgent(params.product)
        : getProduct(this._state.product);
    if (!product) {
      return {
        ok: false,
        status: `Unknown OPERA product: ${params.product ?? this._state.product}`,
        product: this._state.product,
        band: params.band ?? "",
        displayedLayerIds: [],
      };
    }
    const bbox =
      params.bbox !== undefined
        ? normalizeAgentBBox(params.bbox)
        : this._currentBBox();
    if (!bbox) {
      return {
        ok: false,
        status: "Set or pass a bbox for change detection.",
        product: product.shortName,
        band: params.band ?? product.render.bands?.[0] ?? "",
        displayedLayerIds: [],
      };
    }
    const windowDays = Math.min(Math.max(params.windowDays ?? 7, 0), 90);
    const beforeRange = dateWindow(params.beforeDate, windowDays);
    const afterRange = dateWindow(params.afterDate, windowDays);
    const band = params.band ?? product.render.bands?.[0] ?? "";

    this._setStatus("Searching before/after OPERA granules…");
    try {
      const [beforeSearch, afterSearch] = await Promise.all([
        searchGranules({
          shortName: product.shortName,
          bbox,
          start: beforeRange.start,
          end: beforeRange.end,
          count: 20,
        }),
        searchGranules({
          shortName: product.shortName,
          bbox,
          start: afterRange.start,
          end: afterRange.end,
          count: 20,
        }),
      ]);
      const beforeGranule = closestGranule(beforeSearch.granules, params.beforeDate);
      const afterGranule = closestGranule(afterSearch.granules, params.afterDate);
      if (!beforeGranule || !afterGranule) {
        return {
          ok: false,
          status: "No before/after granule pair found for the requested dates.",
          product: product.shortName,
          band,
          bbox,
          displayedLayerIds: [],
        };
      }

      this._state.product = product.shortName;
      this._state.bbox = bbox.map((v) => trimNumber(v)).join(", ");
      this._state.start = beforeRange.start;
      this._state.end = afterRange.end;
      this._state.count = 2;
      this._state.expression = params.expression ?? "";
      this._state.rescale = params.rescale ?? bandRenderDefaults(product.shortName, band).rescale;
      this._state.colormapName =
        params.colormapName ?? bandRenderDefaults(product.shortName, band).colormapName;
      this._granules = [beforeGranule, afterGranule];
      this._renderResults();
      this._syncForm();
      this._options.addGeoJsonLayer?.(`OPERA ${product.shortTitle} Change Pair`, {
        type: "FeatureCollection",
        features: [beforeGranule, afterGranule]
          .filter((granule) => granule.geometry)
          .map((granule, index) => ({
            type: "Feature",
            geometry: granule.geometry,
            properties: {
              _operaGranuleId: granule.id,
              id: granule.id,
              role: index === 0 ? "before" : "after",
              beginDate: granule.beginDate ?? "",
            },
          })),
      });
      this._options.fitBounds?.(this._combinedBounds(this._granules) ?? bbox);

      const beforeDisplay = await this.displayForAgent({
        granuleIds: [beforeGranule.id],
        band,
        rescale: params.rescale,
        colormapName: params.colormapName,
        expression: params.expression,
      });
      const afterDisplay = await this.displayForAgent({
        granuleIds: [afterGranule.id],
        band,
        rescale: params.rescale,
        colormapName: params.colormapName,
        expression: params.expression,
      });
      const [beforeStats, afterStats] = await Promise.all([
        this._statsForChange(product.shortName, beforeGranule, band, bbox, params.expression),
        this._statsForChange(product.shortName, afterGranule, band, bbox, params.expression),
      ]);
      const change = changeDelta(beforeStats, afterStats);
      const status =
        hasStatisticError(beforeStats) || hasStatisticError(afterStats)
          ? `Change detection displayed for ${product.shortTitle} ${band}; statistics unavailable.`
          : `Change detection complete for ${product.shortTitle} ${band}.`;
      this._setStatus(status);
      const result: OperaAgentChangeResult = {
        ok: true,
        status,
        product: product.shortName,
        band,
        bbox,
        before: {
          date: params.beforeDate,
          granuleId: beforeGranule.id,
          granuleDate: beforeGranule.beginDate,
          layerIds: beforeDisplay.displayedLayerIds,
          statistics: beforeStats,
        },
        after: {
          date: params.afterDate,
          granuleId: afterGranule.id,
          granuleDate: afterGranule.beginDate,
          layerIds: afterDisplay.displayedLayerIds,
          statistics: afterStats,
        },
        change,
        displayedLayerIds: [
          ...beforeDisplay.displayedLayerIds,
          ...afterDisplay.displayedLayerIds,
        ],
      };
      if (!hasStatisticError(beforeStats) && !hasStatisticError(afterStats)) {
        result.derivedLayer = this._addChangeSummaryLayer(product.shortTitle, result);
      }
      this._lastChangeResult = result;
      this._updateReportButton();
      return result;
    } catch (err) {
      return {
        ok: false,
        status: `Change detection failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        product: product.shortName,
        band,
        bbox,
        displayedLayerIds: [],
      };
    }
  }

  async analyzeTimeSeriesForAgent(
    params: OperaAgentTimeSeriesParams,
  ): Promise<OperaAgentTimeSeriesResult> {
    this.expand();
    const product =
      params.product !== undefined
        ? resolveProductForAgent(params.product)
        : getProduct(this._state.product);
    if (!product) {
      return {
        ok: false,
        status: `Unknown OPERA product: ${params.product ?? this._state.product}`,
        product: this._state.product,
        band: params.band ?? "",
        observations: [],
        displayedLayerIds: [],
      };
    }
    const bbox =
      params.bbox !== undefined
        ? normalizeAgentBBox(params.bbox)
        : this._currentBBox();
    if (!bbox) {
      return {
        ok: false,
        status: "Set or pass a bbox for time-series analysis.",
        product: product.shortName,
        band: params.band ?? product.render.bands?.[0] ?? "",
        observations: [],
        displayedLayerIds: [],
      };
    }

    const count = Math.min(Math.max(Math.round(params.count ?? 12), 1), 100);
    const searchCount = Math.min(500, Math.max(count * 4, count));
    const band = params.band ?? product.render.bands?.[0] ?? "";
    this._setStatus("Searching OPERA time series…");

    try {
      const search = await searchGranules({
        shortName: product.shortName,
        bbox,
        start: params.start,
        end: params.end,
        count: searchCount,
      });
      const granules = selectTimeSeriesGranules(
        search.granules,
        params.start,
        params.end,
        count,
        params.intervalDays,
      );
      if (granules.length === 0) {
        return {
          ok: false,
          status: "No granules found for the requested time series.",
          product: product.shortName,
          band,
          bbox,
          observations: [],
          displayedLayerIds: [],
        };
      }

      this._state.product = product.shortName;
      this._state.bbox = bbox.map((v) => trimNumber(v)).join(", ");
      this._state.start = params.start;
      this._state.end = params.end;
      this._state.count = granules.length;
      this._state.expression = params.expression ?? "";
      this._state.rescale = params.rescale ?? bandRenderDefaults(product.shortName, band).rescale;
      this._state.colormapName =
        params.colormapName ?? bandRenderDefaults(product.shortName, band).colormapName;
      this._granules = granules;
      this._renderResults();
      this._syncForm();
      this._options.addGeoJsonLayer?.(`OPERA ${product.shortTitle} Time Series`, {
        type: "FeatureCollection",
        features: granules
          .filter((granule) => granule.geometry)
          .map((granule, index) => ({
            type: "Feature",
            geometry: granule.geometry,
            properties: {
              _operaGranuleId: granule.id,
              id: granule.id,
              sequence: index + 1,
              beginDate: granule.beginDate ?? "",
            },
          })),
      });
      this._options.fitBounds?.(this._combinedBounds(this._granules) ?? bbox);

      let displayedLayerIds: string[] = [];
      const endpoints = params.displayEndpoints
        ? uniqueGranules([granules[0], granules[granules.length - 1]])
        : [];
      for (const granule of endpoints) {
        const display = await this.displayForAgent({
          granuleIds: [granule.id],
          band,
          rescale: params.rescale,
          colormapName: params.colormapName,
          expression: params.expression,
        });
        displayedLayerIds = displayedLayerIds.concat(display.displayedLayerIds);
      }

      const observations = await Promise.all(
        granules.map(async (granule) => ({
          date: granule.beginDate?.slice(0, 10) ?? "",
          granuleId: granule.id,
          granuleDate: granule.beginDate,
          layerIds: displayedLayerIdsForGranule(granule.id, displayedLayerIds),
          statistics: await this._statsForChange(
            product.shortName,
            granule,
            band,
            bbox,
            params.expression,
          ),
        })),
      );
      const stats = observations
        .map((item) => item.statistics)
        .filter((item): item is Record<string, number | string | null> => !!item);
      const trends =
        stats.length >= 2 ? changeDelta(stats[0], stats[stats.length - 1]) : {};
      const errorCount = stats.filter(hasStatisticError).length;
      const status =
        errorCount > 0
          ? `Analyzed ${observations.length} ${product.shortTitle} observation(s); ${errorCount} statistic request(s) failed.`
          : `Analyzed ${observations.length} ${product.shortTitle} observation(s).`;
      this._setStatus(status);
      return {
        ok: true,
        status,
        product: product.shortName,
        band,
        bbox,
        observations,
        trends,
        displayedLayerIds,
      };
    } catch (err) {
      return {
        ok: false,
        status: `Time-series analysis failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        product: product.shortName,
        band,
        bbox,
        observations: [],
        displayedLayerIds: [],
      };
    }
  }

  exportChangeReportForAgent(
    params: OperaAgentReportParams = {},
  ): OperaAgentReportResult {
    const result = this._lastChangeResult;
    const format = params.format ?? "markdown";
    if (!result) {
      return {
        ok: false,
        status: "Run change detection before exporting a change report.",
        format,
      };
    }
    const filename = changeReportFilename(result, format);
    const content =
      format === "json"
        ? JSON.stringify(result, null, 2)
        : buildChangeReportMarkdown(result);
    return {
      ok: true,
      status: `Prepared ${format} change report.`,
      filename,
      format,
      content,
    };
  }

  // --- Benchmark (human-QAed authoritative flood extent) -----------------

  /** The locked benchmark, or null. */
  getBenchmark(): LockedBenchmark | null {
    return this._state.benchmark ?? null;
  }

  /**
   * Import + lock a QAed flood benchmark from parsed GeoJSON. Adds the water
   * polygon to the map, fits the view, and stores it as the agent's boundary.
   */
  lockBenchmarkFromGeoJson(
    rawGeoJson: unknown,
    event: BenchmarkEvent,
    render?: BenchmarkRender,
  ): OperaAgentBenchmarkResult {
    let benchmark: LockedBenchmark;
    try {
      benchmark = lockBenchmark(rawGeoJson, {
        event,
        render,
        lockedAt: new Date().toISOString(),
      });
    } catch (err) {
      const status = err instanceof Error ? err.message : String(err);
      this._setStatus(status);
      return { ok: false, status };
    }
    this._state.benchmark = benchmark;
    this._addBenchmarkLayer(benchmark);
    this._options.fitBounds?.(benchmark.bbox);
    this._updateBenchmarkStatus();
    const status = `Locked benchmark "${benchmark.event.name}" (${benchmark.areaKm2.toFixed(2)} km²).`;
    this._setStatus(status);
    return { ok: true, status, benchmark: summarizeBenchmark(benchmark) };
  }

  /** Remove the locked benchmark. */
  clearBenchmark(): void {
    this._state.benchmark = undefined;
    this._updateBenchmarkStatus();
    this._setStatus("Benchmark cleared.");
  }

  /** Agent-facing benchmark summary, or an ok:false prompt to import one. */
  getBenchmarkForAgent(): OperaAgentBenchmarkResult {
    const benchmark = this._state.benchmark;
    if (!benchmark) return { ok: false, status: BENCHMARK_REQUIRED };
    return {
      ok: true,
      status: `Benchmark "${benchmark.event.name}" is locked (${benchmark.areaKm2.toFixed(2)} km²).`,
      benchmark: summarizeBenchmark(benchmark),
    };
  }

  private _addBenchmarkLayer(benchmark: LockedBenchmark): void {
    this._options.addGeoJsonLayer?.(`Benchmark — ${benchmark.event.name}`, {
      type: "FeatureCollection",
      features: benchmark.water.features,
    });
  }

  /**
   * Auto-derive a flood benchmark from OPERA DSWx for an AOI + date range, so
   * the flood one-pager can be produced from just space + time (no human-QAed
   * GeoJSON). Searches DSWx-HLS, renders the observed open/partial water as
   * water-only tiles on the map (for the one-pager snapshot), vectorizes that
   * water into a polygon, and locks it as the working benchmark. The result is
   * explicitly OPERA-observed, not a human-QAed benchmark.
   */
  async deriveFloodBenchmarkForAgent(
    params: OperaAgentDeriveFloodParams,
  ): Promise<OperaAgentDeriveFloodResult> {
    this.expand();
    const shortName = "OPERA_L3_DSWX-HLS_V1";
    const bbox =
      (params.bbox !== undefined ? normalizeAgentBBox(params.bbox) : undefined) ??
      normalizeAgentBBox(this._state.bbox);
    if (!bbox) {
      return {
        ok: false,
        status: "Provide a bbox [west,south,east,north] or set the panel extent first.",
        dswxLayerIds: [],
        granulesUsed: 0,
      };
    }
    const product = getProduct(shortName);
    if (!product) {
      return { ok: false, status: `Unknown product ${shortName}.`, dswxLayerIds: [], granulesUsed: 0 };
    }
    const maxGranules = Math.min(Math.max(params.maxGranules ?? 6, 1), 12);

    // 1) Search DSWx-HLS over the AOI + dates (also populates the panel/table).
    const search = await this.searchForAgent({
      product: shortName, bbox, start: params.start, end: params.end, count: maxGranules,
    });
    const granules = this._granules.slice(0, maxGranules);
    if (!search.ok || granules.length === 0) {
      return {
        ok: false,
        status: `No OPERA DSWx-HLS granules found for the AOI over ${params.start}..${params.end}.`,
        dswxLayerIds: [],
        granulesUsed: 0,
      };
    }

    // 2) Build water-only DSWx tiles, register them on the map (for the
    //    snapshot), and collect the tile templates to vectorize.
    const band = product.render.bands?.[0] ?? "B01_WTR";
    const colormap = colormapForBand(shortName, band, { waterOnly: true });
    const conceptId = granules[0].conceptId ?? (await resolveConceptId(shortName));
    const endpoint = this._state.endpoint || DEFAULT_TITILER_CMR_ENDPOINT;
    const tileTemplates: string[] = [];
    const dswxLayerIds: string[] = [];
    this._setStatus("Loading OPERA DSWx observed-water tiles…");
    for (const g of granules) {
      try {
        const url = buildTileJsonUrl({
          endpoint, conceptId, backend: product.render.backend, granuleUr: g.id,
          bands: [band], bandsRegex: product.render.bandsRegex, colormap,
        });
        const tj = await fetchTileJson(url);
        if (!tj.tiles?.[0]) continue;
        tileTemplates.push(tj.tiles[0]);
        const reg = this.registerTileJsonForAgent({
          name: `OPERA DSWx water — ${g.id}`,
          id: `opera-dswx-water-${slug(g.id)}`,
          tilejson: tj,
          fitBounds: false,
          metadata: { sourceKind: "opera-titiler-cmr", granuleId: g.id },
        });
        if (reg.layerId) dswxLayerIds.push(reg.layerId);
      } catch {
        // Skip a granule whose tilejson fails; report the partial count below.
      }
    }
    if (tileTemplates.length === 0) {
      return { ok: false, status: "Could not load DSWx tiles from titiler-cmr.", dswxLayerIds, granulesUsed: 0 };
    }

    // 3) Vectorize the observed open + partial surface water into a polygon.
    this._setStatus("Deriving the OPERA-observed flood extent…");
    let water: GeoFeatureCollection;
    try {
      water = await deriveFloodExtent(bbox, tileTemplates);
    } catch (err) {
      const status = `Flood-extent derivation failed: ${err instanceof Error ? err.message : String(err)}`;
      this._setStatus(status);
      return { ok: false, status, dswxLayerIds, granulesUsed: tileTemplates.length };
    }
    if (water.features.length === 0) {
      const status =
        "No OPERA DSWx surface water was observed in the AOI for these dates (or the tiles could not be read). Try a wider date window or a different AOI.";
      this._setStatus(status);
      return { ok: false, status, dswxLayerIds, granulesUsed: tileTemplates.length };
    }

    // 4) Lock the derived extent as the working benchmark (OPERA-derived, not QAed).
    const eventName =
      params.eventName?.trim() || (params.place ? `${params.place} flood` : "OPERA-derived flood");
    const dateLabel =
      params.start === params.end ? params.start : `${params.start} – ${params.end}`;
    const lock = this.lockBenchmarkFromGeoJson(
      water,
      { name: eventName, date: dateLabel, location: params.place },
      {
        label: "OPERA DSWx observed water",
        fillColor: "#2b7fff",
        classes: [{ label: "DSWx open + partial water", color: "#2b7fff" }],
      },
    );
    if (!lock.ok) {
      return { ok: false, status: lock.status, dswxLayerIds, granulesUsed: tileTemplates.length };
    }
    const status = `Derived an OPERA flood extent from ${tileTemplates.length} DSWx granule(s): ${
      lock.benchmark?.areaKm2.toFixed(2) ?? "?"
    } km². This is observed OPERA water, not a human-QAed benchmark.`;
    this._setStatus(status);
    return { ok: true, status, benchmark: lock.benchmark, dswxLayerIds, granulesUsed: tileTemplates.length };
  }

  /**
   * Intersect the locked benchmark water polygon with OSM building footprints
   * (Overpass) to quantify building exposure within the flooded area.
   */
  async buildingsInFloodForAgent(
    params: OperaAgentBuildingsParams = {},
  ): Promise<OperaAgentBuildingsResult> {
    const benchmark = this._state.benchmark;
    if (!benchmark) {
      return {
        ok: false,
        status: BENCHMARK_REQUIRED,
        total: 0,
        floodedCount: 0,
        fraction: 0,
        source: "osm",
      };
    }
    this.expand();
    this._setStatus("Fetching OSM buildings for the flooded area…");
    let buildings: GeoFeatureCollection;
    try {
      buildings = await fetchOsmBuildings(benchmark.bbox);
    } catch (err) {
      const status = `Building fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this._setStatus(status);
      return {
        ok: false,
        status,
        total: 0,
        floodedCount: 0,
        fraction: 0,
        source: "osm",
      };
    }
    const result = buildingsInFlood(buildings, benchmark.water, {
      computeArea: params.computeArea,
    });
    let layerId: string | undefined;
    // Draw the flooded buildings by default so they appear on the map (and in
    // the one-pager snapshot); pass addLayer: false to skip.
    if (params.addLayer !== false && result.floodedFeatures.length > 0) {
      layerId = `Flooded buildings — ${benchmark.event.name}`;
      this._options.addGeoJsonLayer?.(layerId, {
        type: "FeatureCollection",
        features: result.floodedFeatures,
      });
    }
    const status = `Found ${result.floodedCount} building(s) within the flood extent (${(
      result.fraction * 100
    ).toFixed(1)}% of ${result.total} in view).`;
    this._setStatus(status);
    return {
      ok: true,
      status,
      total: result.total,
      floodedCount: result.floodedCount,
      fraction: result.fraction,
      floodedAreaKm2: result.floodedAreaKm2,
      source: "OpenStreetMap (Overpass)",
      layerId,
    };
  }

  /** Search reputable news for quantified, citable impact figures. */
  async newsImpactSearchForAgent(
    params: OperaAgentNewsParams,
  ): Promise<OperaAgentNewsResult> {
    const query = params.query?.trim();
    if (!query) return { ok: false, status: "Provide a search query.", results: [] };
    this._setStatus("Searching news for impact figures…");
    try {
      const { results, answer } = await searchNews(query, {
        maxResults: params.maxResults,
      });
      const status = `Found ${results.length} news result(s).`;
      this._setStatus(status);
      return { ok: true, status, results, answer };
    } catch (err) {
      const status = `News search failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this._setStatus(status);
      return { ok: false, status, results: [] };
    }
  }

  /**
   * Capture the current map as a PNG data URL. Uses a one-shot render after
   * `triggerRepaint()` so real pixels are read even when the map was created
   * without `preserveDrawingBuffer`. Returns null when no map is attached.
   */
  async captureMapSnapshotForAgent(): Promise<string | null> {
    const map = this._map;
    if (!map) return null;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const grab = (): string | null => {
        try {
          return map.getCanvas().toDataURL("image/png");
        } catch {
          return null;
        }
      };
      try {
        map.once("render", () => finish(grab()));
        map.triggerRepaint();
        // Fallback so a map that never emits "render" (already idle) can't hang
        // the one-pager build; grab whatever is on the canvas instead.
        setTimeout(() => finish(grab()), 2000);
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Assemble the self-contained one-pager HTML from the locked benchmark plus
   * agent-supplied narrative, buildings exposure, and cited impacts; captures a
   * map snapshot when one is not supplied and downloads the result.
   */
  async buildOnePagerForAgent(
    params: OperaAgentOnePagerParams = {},
  ): Promise<OperaAgentOnePagerResult> {
    const benchmark = this._state.benchmark;
    if (!benchmark) return { ok: false, status: BENCHMARK_REQUIRED };
    const mapImageDataUrl =
      params.mapSnapshotDataUrl ??
      (await this.captureMapSnapshotForAgent()) ??
      undefined;
    const html = buildOnePagerHtml({
      title: params.title ?? `${benchmark.event.name}: OPERA flood assessment`,
      event: benchmark.event,
      narrative: params.narrative,
      mapImageDataUrl,
      benchmark: {
        bbox: benchmark.bbox,
        areaKm2: benchmark.areaKm2,
        render: benchmark.render,
      },
      buildings: params.buildings,
      impacts: params.impacts,
      generatedAt: new Date().toISOString().slice(0, 10),
      credit: "NASA OPERA · GeoLibre",
    });
    const filename = `opera-one-pager-${slug(benchmark.event.name) || "flood"}.html`;
    if (params.download !== false) {
      this._downloadTextFile(filename, html, "text/html");
    }
    const status = `One-pager ready${
      params.download !== false ? " and downloaded" : ""
    }.`;
    this._setStatus(status);
    return { ok: true, status, filename, html };
  }

  private _addChangeSummaryLayer(
    productTitle: string,
    result: OperaAgentChangeResult,
  ): OperaAgentDerivedLayer | undefined {
    if (!result.bbox || !result.before || !result.after) return undefined;
    const name = `OPERA ${productTitle} Change Summary`;
    const changeType = classifyChange(result.change);
    this._options.addGeoJsonLayer?.(name, {
      type: "FeatureCollection",
      features: [
        {
          ...bboxFeature(result.bbox),
          properties: {
            _operaChangeLayer: true,
            id: `${result.before.granuleId}-${result.after.granuleId}`,
            product: result.product,
            band: result.band,
            changeType,
            beforeDate: result.before.date,
            afterDate: result.after.date,
            beforeGranuleId: result.before.granuleId,
            afterGranuleId: result.after.granuleId,
            ...prefixedProperties("before", result.before.statistics),
            ...prefixedProperties("after", result.after.statistics),
            ...prefixedProperties("change", result.change),
          },
        },
      ],
    });
    return { name, featureCount: 1, changeType };
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

  private async _onDisplay(opts: { waterOnly?: boolean } = {}): Promise<void> {
    const product = getProduct(this._state.product);
    const selected = this._granules.filter((g) => this._selectedIds.has(g.id));
    if (!product || selected.length === 0) {
      this._setStatus("Select a granule first.");
      return;
    }
    const band = this._bandSelect?.value || product.render.bands?.[0];
    const userRescale = this._state.rescale.trim();
    const userColormap = this._state.colormapName.trim();
    const expression = this._state.expression.trim();
    // A user-selected named colormap overrides the categorical class colormap
    // (e.g. choosing "terrain" for a DEM band instead of the DSWx classes). An
    // expression produces a computed continuous value, so the categorical class
    // colormap never applies.
    const categorical =
      userColormap || expression
        ? undefined
        : colormapForBand(product.shortName, band, {
            waterOnly: opts.waterOnly,
          });

    this._setDisplayBusy(true);
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
            expression,
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
    } finally {
      this._setDisplayBusy(false);
    }
  }

  private async _statsForChange(
    shortName: string,
    granule: OperaGranule,
    band: string | undefined,
    bbox: BBox,
    expression?: string,
  ): Promise<Record<string, number | string | null> | undefined> {
    const product = getProduct(shortName);
    if (!product) return undefined;
    const conceptId = granule.conceptId ?? (await resolveConceptId(shortName));
    const expr = expression?.trim();
    const categorical = !expr && isCategoricalBand(shortName, band);
    const url = buildStatisticsUrl({
      endpoint: this._state.endpoint || DEFAULT_TITILER_CMR_ENDPOINT,
      conceptId,
      backend: product.render.backend,
      granuleUr: granule.id,
      bands: band ? [band] : product.render.bands,
      bandsRegex: product.render.bandsRegex,
      categorical,
      expression: expr,
      histogramBins: categorical ? undefined : 20,
    });
    let bandStats: BandStatistics | undefined;
    try {
      const stats = await fetchStatistics(url, bboxFeature(bbox));
      bandStats = firstBandStats(stats);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!bandStats) return { error: "No statistics returned for AOI." };

    if (isDswxWaterBand(shortName, band) && !expr) {
      return waterStatisticsSummary(bandStats);
    }
    return continuousStatisticsSummary(bandStats);
  }

  /** Toggle the Display button's loading state. */
  private _setDisplayBusy(busy: boolean): void {
    const btn = this._displayBtn;
    if (!btn) return;
    btn.classList.toggle("opera-busy", busy);
    btn.disabled = busy;
    btn.textContent = busy ? "Displaying…" : "Display";
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
    if (this._statsBtn) this._statsBtn.disabled = !hasSelection || !hasBand;
    // A selection change can invalidate the band being inspected; leave inspect
    // mode if there is nothing left to query.
    if (this._inspecting && (!hasSelection || !hasBand)) this._stopInspect();
    this._highlightSelectedFootprints();
  }

  private _agentGranuleSummaries(): OperaAgentResult["granules"] {
    return this._granules.map((granule) => ({
      id: granule.id,
      beginDate: granule.beginDate,
      endDate: granule.endDate,
      bbox: granule.bbox,
      bands: granuleBands(granule).map((band) => band.token),
      linkCount: granule.dataLinks.length,
    }));
  }

  private _selectGranulesForAgent(
    granuleIds: string[] | undefined,
    maxGranules: number | undefined,
  ): OperaGranule[] {
    const wanted = new Set((granuleIds ?? []).map((id) => id.trim()).filter(Boolean));
    const limit =
      maxGranules !== undefined && Number.isFinite(maxGranules)
        ? Math.min(Math.max(Math.round(maxGranules), 1), 25)
        : granuleIds && granuleIds.length > 0
          ? granuleIds.length
          : 1;
    const selected =
      wanted.size > 0
        ? this._granules.filter((granule) => wanted.has(granule.id))
        : this._granules.slice(0, limit);
    this._selectedIds = new Set(selected.map((granule) => granule.id));
    this._activeGranule = selected[0] ?? null;
    this._anchorId = this._activeGranule?.id ?? null;
    this._refreshSelectionUI(this._activeGranule?.id);
    return selected;
  }

  private _setBandForAgent(band: string): void {
    const token = band.trim();
    if (!token || !this._bandSelect) return;
    if (!Array.from(this._bandSelect.options).some((option) => option.value === token)) {
      const opt = document.createElement("option");
      opt.value = token;
      opt.textContent = token;
      this._bandSelect.appendChild(opt);
    }
    this._bandSelect.value = token;
    this._applyBandDefaults(token);
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
    // Satellite glyph: signals NASA OPERA's satellite-derived products and
    // avoids reusing the globe, which already denotes GeoLibre's core map
    // projection and caused visual confusion (see geolibre issue #631).
    toggleBtn.innerHTML = `
      <span class="plugin-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 7 9 3 5 7l4 4"/>
          <path d="m17 11 4 4-4 4-4-4"/>
          <path d="m8 12 4 4 6-6-4-4Z"/>
          <path d="m16 8 3-3"/>
          <path d="M9 21a6 6 0 0 0-6-6"/>
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

    panel.append(header, this._buildContent());
    return panel;
  }

  /**
   * Build the scrollable panel body (every control below the header). Shared by
   * the floating panel ({@link _createPanel}) and the docked panel
   * ({@link renderDocked}), which supplies its own host-rendered header.
   */
  private _buildContent(): HTMLElement {
    const content = document.createElement("div");
    content.className = "plugin-control-content";

    content.appendChild(this._buildBenchmarkGroup());
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
    content.appendChild(this._buildStatisticsButton());
    content.appendChild(this._buildStatsPanel());
    content.appendChild(this._buildDownloadGroup());
    content.appendChild(this._buildReportButton());

    // Spacing between the Display action and the endpoint settings below.
    const endpointDivider = document.createElement("div");
    endpointDivider.className = "plugin-control-divider";
    content.appendChild(endpointDivider);

    content.appendChild(this._buildEndpointGroup());

    this._content = content;
    return content;
  }

  /**
   * Benchmark import section: load a human-QAed flood water-extent GeoJSON and
   * lock it as the authoritative boundary the agent operates within.
   */
  private _buildBenchmarkGroup(): HTMLElement {
    const group = el("div", "plugin-control-group opera-benchmark");
    const row = el("div", "opera-label-row");
    row.appendChild(label("Flood benchmark (QAed)"));
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "opera-link-button";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => this.clearBenchmark());
    row.appendChild(clearBtn);
    group.appendChild(row);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".geojson,.json,application/geo+json,application/json";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void this._importBenchmarkFile(file);
      fileInput.value = "";
    });

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "plugin-control-button opera-secondary-button opera-block-button";
    importBtn.textContent = "Import benchmark…";
    importBtn.title = "Load a QAed flood water-extent GeoJSON and lock it as ground truth";
    importBtn.addEventListener("click", () => fileInput.click());
    group.append(importBtn, fileInput);

    const status = el("div", "opera-benchmark-status");
    this._benchmarkStatus = status;
    group.appendChild(status);
    this._updateBenchmarkStatus();
    return group;
  }

  /** Read a benchmark file, parse GeoJSON, and lock it. */
  private async _importBenchmarkFile(file: File): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this._setStatus("Benchmark file is not valid JSON.");
      return;
    }
    // Default the event name to the file name; the agent/one-pager can override
    // the display title, location, and date.
    const name = file.name.replace(/\.[^.]+$/, "");
    this.lockBenchmarkFromGeoJson(parsed, { name });
  }

  /** Reflect the locked benchmark (or absence) in the panel status line. */
  private _updateBenchmarkStatus(): void {
    if (!this._benchmarkStatus) return;
    const benchmark = this._state.benchmark;
    this._benchmarkStatus.textContent = benchmark
      ? `Locked: ${benchmark.event.name} — ${benchmark.areaKm2.toFixed(2)} km²`
      : "No benchmark locked.";
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
    if (this._statsBtn) this._statsBtn.disabled = true;
    this._stopInspect();
    this._clearStats();
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
    this._refreshExpressionPresets();
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
      this._updateExpressionHint();
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

    wrap.append(rescaleGroup, cmapGroup, this._buildExpressionGroup());
    return wrap;
  }

  /**
   * Optional band-math expression (rio-tiler `expression`). When set it
   * overrides plain band rendering everywhere (Display / Inspect / Statistics);
   * the selected band is `b1`. A per-band presets dropdown fills the field.
   */
  private _buildExpressionGroup(): HTMLElement {
    const group = el("div", "plugin-control-group");
    const row = el("div", "opera-label-row");
    row.appendChild(label("Expression (band math)"));

    const presets = document.createElement("select");
    presets.className = "opera-expr-presets";
    presets.title = "Insert a ready-made expression";
    this._expressionPresetSelect = presets;
    presets.addEventListener("change", () => {
      const preset = this._currentExpressionPresets.find(
        (p) => p.expression === presets.value,
      );
      if (preset) this._applyExpressionPreset(preset);
      presets.selectedIndex = 0; // reset to the "Presets…" placeholder
    });
    row.appendChild(presets);
    group.appendChild(row);

    const input = document.createElement("input");
    input.className = "plugin-control-input";
    input.type = "text";
    input.placeholder = "blank = raw band — e.g. 10*log10(b1)";
    input.value = this._state.expression;
    input.dataset.field = "expression";
    input.addEventListener("input", () => {
      this._state.expression = input.value;
      this._updateExpressionHint();
    });
    this._expressionInput = input;
    group.appendChild(input);

    const hint = el("div", "opera-expr-hint");
    hint.textContent =
      "Set a Rescale (min,max) above so the computed result displays.";
    this._expressionHint = hint;
    group.appendChild(hint);

    this._refreshExpressionPresets();
    this._updateExpressionHint();
    return group;
  }

  /** Apply a preset's expression plus its rescale/colormap, if any. */
  private _applyExpressionPreset(preset: ExpressionPreset): void {
    this._setExpression(preset.expression);
    if (preset.rescale != null) {
      this._state.rescale = preset.rescale;
      if (this._rescaleInput) this._rescaleInput.value = preset.rescale;
    }
    if (preset.colormapName != null) {
      this._state.colormapName = preset.colormapName;
      if (this._colormapSelect) this._colormapSelect.value = preset.colormapName;
    }
    this._updateExpressionHint();
  }

  /**
   * Show a hint when an expression is set but no rescale is given: a computed
   * value rarely matches the band's default stretch, so it would render flat.
   */
  private _updateExpressionHint(): void {
    if (!this._expressionHint) return;
    const needsRescale =
      !!this._state.expression.trim() && !this._state.rescale.trim();
    this._expressionHint.style.display = needsRescale ? "block" : "none";
  }

  /** Set the expression field + state. */
  private _setExpression(value: string): void {
    this._state.expression = value;
    if (this._expressionInput) this._expressionInput.value = value;
    this._updateExpressionHint();
  }

  /** Rebuild the presets dropdown for the active product/band. */
  private _refreshExpressionPresets(): void {
    const select = this._expressionPresetSelect;
    if (!select) return;
    const band = this._bandSelect?.value;
    const presets = expressionPresets(this._state.product, band);
    this._currentExpressionPresets = presets;
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Presets…";
    select.appendChild(placeholder);
    for (const preset of presets) {
      const opt = document.createElement("option");
      opt.value = preset.expression;
      opt.textContent = preset.label;
      select.appendChild(opt);
    }
    select.disabled = presets.length === 0;
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
              expression: this._state.expression.trim(),
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

  // --- Zonal statistics (titiler-cmr /statistics) ------------------------

  private _buildStatisticsButton(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "plugin-control-button opera-secondary-button opera-block-button";
    btn.textContent = "Statistics (current AOI)";
    btn.title =
      "Compute zonal statistics for the selected band over the current bounding box";
    btn.disabled = true;
    btn.addEventListener("click", () => void this._onStatistics());
    this._statsBtn = btn;
    return btn;
  }

  private _buildStatsPanel(): HTMLElement {
    const panel = el("div", "opera-stats");
    // Delegate clicks for the buttons rendered into the panel's HTML (the stats
    // block is rebuilt as a string each run, so per-element listeners would not
    // survive).
    panel.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      const rescaleBtn = target?.closest(
        ".opera-stats-apply-rescale",
      ) as HTMLElement | null;
      if (rescaleBtn?.dataset.rescale) {
        this._applyRescale(rescaleBtn.dataset.rescale);
        return;
      }
      if (target?.closest(".opera-hist-download")) {
        const container = target.closest(".opera-hist") as HTMLElement | null;
        if (container) this._downloadHistogram(container);
      }
    });
    this._statsPanel = panel;
    return panel;
  }

  /** Fill the Rendering rescale field from a suggested "min,max" value. */
  private _applyRescale(value: string): void {
    this._state.rescale = value;
    if (this._rescaleInput) this._rescaleInput.value = value;
    this._setStatus(`Rescale set to ${value}. Click Display to apply it.`);
  }

  /** Export the histogram (data stashed on the container) as a standalone SVG. */
  private _downloadHistogram(container: HTMLElement): void {
    const raw = container.dataset.hist;
    if (!raw) return;
    let data: HistogramPayload;
    try {
      data = JSON.parse(raw) as HistogramPayload;
    } catch {
      this._setStatus("Could not read histogram data for export.");
      return;
    }
    const svg = buildHistogramSvg(data);
    const name = `histogram-${slug(data.band)}${
      data.granuleId ? `-${slug(data.granuleId)}` : ""
    }.svg`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click is processed so the download is not interrupted.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this._setStatus(`Downloaded ${name}.`);
  }

  private _clearStats(): void {
    if (this._statsPanel) this._statsPanel.innerHTML = "";
  }

  private _setStatsContent(html: string): void {
    if (this._statsPanel) this._statsPanel.innerHTML = html;
  }

  /**
   * Build a GeoJSON Polygon Feature for the current AOI (the bbox field, or the
   * map extent when the field is blank) plus the bbox itself and whether it came
   * from the map extent, so the panel can show what area was actually summarized.
   */
  private _aoiFeature():
    | { feature: unknown; bbox: BBox; fromMapExtent: boolean }
    | undefined {
    const typed = this._parseBBox(this._state.bbox);
    const bbox = typed ?? this._options.getMapBounds?.() ?? undefined;
    if (!bbox) return undefined;
    const [w, s, e, n] = bbox;
    const feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    };
    return { feature, bbox, fromMapExtent: !typed };
  }

  /**
   * Compute zonal statistics for the selected band over the current AOI, one
   * `/statistics` POST per selected granule (pinned by `granule_ur` so the
   * numbers reflect exactly the chosen granules). DSWx water bands are queried
   * categorically to derive open-water area.
   */
  private async _onStatistics(): Promise<void> {
    const product = getProduct(this._state.product);
    const selected = this._granules.filter((g) => this._selectedIds.has(g.id));
    if (!product || selected.length === 0) {
      this._setStatus("Select a granule first.");
      return;
    }
    const aoi = this._aoiFeature();
    if (!aoi) {
      this._setStatus(
        "Set a bounding box (type it, Use map extent, or Draw) for the AOI.",
      );
      return;
    }
    const band = this._bandSelect?.value || product.render.bands?.[0];
    const expression = this._state.expression.trim();
    // An expression yields a computed continuous value, so class-count
    // (categorical) statistics no longer apply.
    const categorical = !expression && isCategoricalBand(product.shortName, band);
    this._setStatsContent(
      `<div class="opera-stats-loading">Computing statistics for ${selected.length} granule(s)…</div>`,
    );
    this._setStatus(`Computing statistics for ${selected.length} granule(s)…`);
    try {
      const conceptId =
        selected[0].conceptId ?? (await resolveConceptId(product.shortName));
      const results = await Promise.all(
        selected.map(async (granule) => {
          try {
            const url = buildStatisticsUrl({
              endpoint: this._state.endpoint || DEFAULT_TITILER_CMR_ENDPOINT,
              conceptId,
              backend: product.render.backend,
              granuleUr: granule.id,
              bands: band ? [band] : product.render.bands,
              bandsRegex: product.render.bandsRegex,
              categorical,
              expression,
              // A finer histogram for continuous bands makes the distribution
              // (and a good rescale) easy to read; ignored in categorical mode.
              histogramBins: categorical ? undefined : 20,
            });
            return { granule, stats: await fetchStatistics(url, aoi.feature) };
          } catch {
            return { granule, stats: null };
          }
        }),
      );
      this._renderStats(results, product.shortName, band, aoi);
      const ok = results.filter((r) => r.stats).length;
      this._setStatus(
        ok === selected.length
          ? `Statistics for ${ok} granule(s).`
          : `Statistics for ${ok}/${selected.length} granule(s).`,
      );
    } catch (err) {
      this._clearStats();
      this._setStatus(
        `Statistics failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private _renderStats(
    results: Array<{ granule: OperaGranule; stats: StatisticsResult | null }>,
    shortName: string,
    band: string | undefined,
    aoi: { bbox: BBox; fromMapExtent: boolean },
  ): void {
    const blocks = results.map(({ granule, stats }) => {
      const head = `<div class="opera-stats-granule" title="${escapeHtml(
        granule.id,
      )}">${escapeHtml(shorten(granule.id, 26))}</div>`;
      const bandStats = stats ? firstBandStats(stats) : undefined;
      if (!bandStats) {
        return `<div class="opera-stats-block">${head}<div class="opera-stats-empty">no data in AOI</div></div>`;
      }
      // With an expression the value is computed, not a water class, so always
      // show the continuous block.
      const body =
        isDswxWaterBand(shortName, band) && !this._state.expression.trim()
          ? renderWaterStats(bandStats)
          : renderContinuousStats(bandStats, band, granule.id);
      return `<div class="opera-stats-block">${head}${body}</div>`;
    });
    const [w, s, e, n] = aoi.bbox;
    const extentNote = aoi.fromMapExtent ? " · map extent" : "";
    const header =
      `<div class="opera-stats-title">${escapeHtml(
        band ?? "band",
      )} — AOI statistics</div>` +
      `<div class="opera-stats-aoi">AOI ${w.toFixed(2)}, ${s.toFixed(
        2,
      )}, ${e.toFixed(2)}, ${n.toFixed(2)}${extentNote}</div>`;
    this._setStatsContent(header + blocks.join(""));
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

  private _buildReportButton(): HTMLElement {
    const row = el("div", "opera-download-row");
    const reportBtn = document.createElement("button");
    reportBtn.type = "button";
    reportBtn.className = "plugin-control-button opera-secondary-button";
    reportBtn.textContent = "Download change report";
    reportBtn.title = "Download a Markdown report from the latest change detection result";
    reportBtn.disabled = !this._lastChangeResult;
    reportBtn.addEventListener("click", () => this._downloadChangeReport());
    this._downloadReportBtn = reportBtn;
    row.append(reportBtn);
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

  private _downloadChangeReport(): void {
    const report = this.exportChangeReportForAgent({ format: "markdown" });
    if (!report.ok || !report.content || !report.filename) {
      this._setStatus(report.status);
      return;
    }
    this._downloadTextFile(report.filename, report.content, "text/markdown");
    this._setStatus(`Downloaded ${report.filename}.`);
  }

  private _downloadTextFile(filename: string, content: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private _updateReportButton(): void {
    if (this._downloadReportBtn) {
      this._downloadReportBtn.disabled = !this._lastChangeResult;
    }
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
    if (!this._content) return;
    const fields = this._content.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
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
    if (!this._content) return;
    const fields = this._content.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
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
    this._lastStatus = message;
    if (this._status) this._status.textContent = message;
  }

  // --- Positioning (adapted from the template's PluginControl) -----------

  /**
   * Bidirectional footprint selection: clicking a footprint on the map selects
   * its row; a pointer cursor signals it is clickable. Shared by both modes.
   */
  private _attachMapInteractions(): void {
    this._map?.on("click", this._onMapClick);
    this._map?.on("mousemove", this._onMapMouseMove);
  }

  /**
   * Reposition the floating panel on window/map resize. Only needed in floating
   * mode; the host manages a docked panel's geometry.
   */
  private _setupFloatingListeners(): void {
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
    // Keep a small breathing space from the map edges, and never shrink the
    // panel below a usable height even on a very short map.
    const margin = 8;
    const minPanelHeight = 200;

    this._panel.style.top = "";
    this._panel.style.bottom = "";
    this._panel.style.left = "";
    this._panel.style.right = "";

    // Vertical space available to the panel inside the map container. The map
    // container's bottom edge sits at the top of any auxiliary UI below the map
    // (the coordinate/status bar), so clamping the panel's max-height to this
    // budget keeps the whole panel, including its bottom controls and the
    // resize grip, above that bar instead of rendering underneath it
    // (geolibre issue #631).
    let available: number;

    switch (position) {
      case "top-left":
        this._panel.style.top = `${buttonTop + buttonRect.height + gap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        available = mapRect.height - (buttonTop + buttonRect.height + gap);
        break;
      case "top-right":
        this._panel.style.top = `${buttonTop + buttonRect.height + gap}px`;
        this._panel.style.right = `${buttonRight}px`;
        available = mapRect.height - (buttonTop + buttonRect.height + gap);
        break;
      case "bottom-left":
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + gap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        available = mapRect.height - (buttonBottom + buttonRect.height + gap);
        break;
      case "bottom-right":
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + gap}px`;
        this._panel.style.right = `${buttonRight}px`;
        available = mapRect.height - (buttonBottom + buttonRect.height + gap);
        break;
      default:
        available = mapRect.height;
    }

    this._panel.style.maxHeight = `${Math.max(minPanelHeight, available - margin)}px`;
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

function trimNumber(value: number): string {
  return parseFloat(value.toFixed(6)).toString();
}

function normalizeAgentBBox(value: BBox | string): BBox | undefined {
  const parts = Array.isArray(value)
    ? value
    : value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return undefined;
  const [w, s, e, n] = parts.map(Number);
  if (w >= e || s >= n) return undefined;
  return [w, s, e, n];
}

function resolveProductForAgent(value: string): ReturnType<typeof getProduct> {
  const normalized = value.trim().toLowerCase();
  return OPERA_PRODUCTS.find(
    (product) =>
      product.shortName.toLowerCase() === normalized ||
      product.shortTitle.toLowerCase() === normalized ||
      product.title.toLowerCase() === normalized,
  );
}

function dateWindow(date: string, windowDays: number): { start: string; end: string } {
  const center = parseIsoDate(date);
  const days = Math.max(Math.round(windowDays), 0);
  return {
    start: addDays(center, -days).toISOString().slice(0, 10),
    end: addDays(center, days).toISOString().slice(0, 10),
  };
}

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  }
  return date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function closestGranule(
  granules: OperaGranule[],
  targetDate: string,
): OperaGranule | undefined {
  const target = parseIsoDate(targetDate).getTime();
  return [...granules].sort((a, b) => {
    const da = Math.abs(granuleTime(a) - target);
    const db = Math.abs(granuleTime(b) - target);
    return da - db;
  })[0];
}

function selectTimeSeriesGranules(
  granules: OperaGranule[],
  start: string,
  end: string,
  count: number,
  intervalDays?: number,
): OperaGranule[] {
  const sorted = granules
    .filter((granule) => Number.isFinite(granuleTime(granule)))
    .sort((a, b) => granuleTime(a) - granuleTime(b));
  if (sorted.length <= count && !intervalDays) return sorted;

  const step = intervalDays ? Math.max(Math.round(intervalDays), 1) : 0;
  if (step > 0) {
    const picked: OperaGranule[] = [];
    const used = new Set<string>();
    for (
      let cursor = parseIsoDate(start);
      cursor <= parseIsoDate(end) && picked.length < count;
      cursor = addDays(cursor, step)
    ) {
      const target = cursor.getTime();
      const nearest = sorted
        .filter((granule) => !used.has(granule.id))
        .sort(
          (a, b) =>
            Math.abs(granuleTime(a) - target) - Math.abs(granuleTime(b) - target),
        )[0];
      if (nearest) {
        picked.push(nearest);
        used.add(nearest.id);
      }
    }
    return picked.sort((a, b) => granuleTime(a) - granuleTime(b));
  }

  if (sorted.length <= count) return sorted;
  const result: OperaGranule[] = [];
  const last = sorted.length - 1;
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i / Math.max(count - 1, 1)) * last);
    const granule = sorted[index];
    if (granule && !result.some((item) => item.id === granule.id)) {
      result.push(granule);
    }
  }
  return result;
}

function uniqueGranules(granules: Array<OperaGranule | undefined>): OperaGranule[] {
  const seen = new Set<string>();
  const result: OperaGranule[] = [];
  for (const granule of granules) {
    if (!granule || seen.has(granule.id)) continue;
    seen.add(granule.id);
    result.push(granule);
  }
  return result;
}

function displayedLayerIdsForGranule(granuleId: string, layerIds: string[]): string[] {
  const token = slug(granuleId);
  return layerIds.filter((id) => id.includes(token));
}

function granuleTime(granule: OperaGranule): number {
  const value = granule.beginDate ?? granule.endDate ?? "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Infinity;
}

function bboxFeature(bbox: BBox): BBoxFeature {
  const [w, s, e, n] = bbox;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  };
}

function waterStatisticsSummary(
  stats: BandStatistics,
): Record<string, number | string | null> {
  let openWaterPixels = 0;
  let partialWaterPixels = 0;
  let validPixels = 0;
  if (stats.histogram) {
    const [counts, values] = stats.histogram;
    values.forEach((value, index) => {
      const count = counts[index] ?? 0;
      validPixels += count;
      if (value === DSWX_OPEN_WATER_CLASS) openWaterPixels = count;
      if (value === DSWX_PARTIAL_WATER_CLASS) partialWaterPixels = count;
    });
  }
  const surfaceWaterPixels = openWaterPixels + partialWaterPixels;
  return {
    metric: "DSWx water class area",
    validPixels,
    validKm2: pixelsToKm2(validPixels),
    openWaterPixels,
    openWaterKm2: pixelsToKm2(openWaterPixels),
    openWaterPercent:
      validPixels > 0 ? (openWaterPixels / validPixels) * 100 : null,
    partialWaterPixels,
    partialWaterKm2: pixelsToKm2(partialWaterPixels),
    surfaceWaterPixels,
    surfaceWaterKm2: pixelsToKm2(surfaceWaterPixels),
    surfaceWaterPercent:
      validPixels > 0 ? (surfaceWaterPixels / validPixels) * 100 : null,
  };
}

function continuousStatisticsSummary(
  stats: BandStatistics,
): Record<string, number | string | null> {
  return {
    metric: "continuous raster statistics",
    min: stats.min,
    max: stats.max,
    mean: stats.mean,
    std: stats.std,
    median: stats.median ?? null,
    count: stats.count,
    validPixels: stats.validPixels ?? null,
    validPercent: stats.validPercent ?? null,
    validKm2:
      stats.validPixels != null ? pixelsToKm2(stats.validPixels) : null,
    percentile2: stats.percentile2 ?? null,
    percentile98: stats.percentile98 ?? null,
  };
}

function changeDelta(
  before?: Record<string, number | string | null>,
  after?: Record<string, number | string | null>,
): Record<string, number | string | null> {
  if (!before || !after) return {};
  const delta: Record<string, number | string | null> = {};
  for (const [key, afterValue] of Object.entries(after)) {
    const beforeValue = before[key];
    if (typeof beforeValue !== "number" || typeof afterValue !== "number") {
      continue;
    }
    const change = afterValue - beforeValue;
    delta[`${key}Before`] = beforeValue;
    delta[`${key}After`] = afterValue;
    delta[`${key}Change`] = change;
    delta[`${key}PercentChange`] =
      beforeValue !== 0 ? (change / Math.abs(beforeValue)) * 100 : null;
  }
  return delta;
}

function classifyChange(
  change?: Record<string, number | string | null>,
): "gain" | "loss" | "stable" | "unknown" {
  const value = numericChangeMetric(change);
  if (value == null) return "unknown";
  const tolerance = Math.max(Math.abs(value) * 0.001, 1e-9);
  if (value > tolerance) return "gain";
  if (value < -tolerance) return "loss";
  return "stable";
}

function numericChangeMetric(
  change?: Record<string, number | string | null>,
): number | null {
  const preferred = [
    "surfaceWaterKm2Change",
    "openWaterKm2Change",
    "meanChange",
    "medianChange",
    "validKm2Change",
  ];
  for (const key of preferred) {
    const value = change?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function prefixedProperties(
  prefix: string,
  values?: Record<string, number | string | null>,
): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  if (!values) return out;
  for (const [key, value] of Object.entries(values)) {
    out[`${prefix}_${key}`] = value;
  }
  return out;
}

function changeReportFilename(
  result: OperaAgentChangeResult,
  format: "markdown" | "json",
): string {
  const before = safeDateToken(result.before?.date ?? result.before?.granuleDate);
  const after = safeDateToken(result.after?.date ?? result.after?.granuleDate);
  const ext = format === "json" ? "json" : "md";
  return `opera-change-${slug(result.product)}-${slug(result.band)}-${before}-to-${after}.${ext}`;
}

function buildChangeReportMarkdown(result: OperaAgentChangeResult): string {
  const lines = [
    "# OPERA Change Detection Report",
    "",
    `- Product: ${result.product}`,
    `- Band: ${result.band}`,
    `- Status: ${result.status}`,
  ];
  if (result.bbox) lines.push(`- AOI bbox: ${result.bbox.join(", ")}`);
  if (result.derivedLayer) {
    lines.push(
      `- Derived layer: ${result.derivedLayer.name} (${result.derivedLayer.changeType ?? "unknown"})`,
    );
  }
  lines.push("", "## Before", "");
  lines.push(...observationReportLines(result.before));
  lines.push("", "## After", "");
  lines.push(...observationReportLines(result.after));
  lines.push("", "## Change", "");
  lines.push(...metricReportLines(result.change));
  return `${lines.join("\n")}\n`;
}

function observationReportLines(
  observation?: OperaAgentChangeObservation,
): string[] {
  if (!observation) return ["No observation recorded."];
  return [
    `- Requested date: ${observation.date}`,
    `- Granule date: ${observation.granuleDate ?? "n/a"}`,
    `- Granule ID: ${observation.granuleId}`,
    `- Layer IDs: ${observation.layerIds.length ? observation.layerIds.join(", ") : "none"}`,
    "",
    ...metricReportLines(observation.statistics),
  ];
}

function metricReportLines(
  values?: Record<string, number | string | null>,
): string[] {
  if (!values || Object.keys(values).length === 0) return ["No metrics recorded."];
  return Object.entries(values).map(([key, value]) => {
    const text =
      typeof value === "number" && Number.isFinite(value)
        ? formatNumber(value)
        : value == null
          ? "n/a"
          : String(value);
    return `- ${key}: ${text}`;
  });
}

function safeDateToken(value?: string): string {
  const token = value?.slice(0, 10) ?? "unknown";
  return token.replace(/[^0-9a-z-]/gi, "");
}

function hasStatisticError(
  stats?: Record<string, number | string | null>,
): boolean {
  return typeof stats?.error === "string" && stats.error.length > 0;
}

/** Format a number for the inspect popup: integers as-is, floats trimmed. */
function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return parseFloat(v.toPrecision(5)).toString();
}

/** A finite number formatted for display, or "n/a". */
function formatStat(n: number): string {
  return Number.isFinite(n) ? formatNumber(n) : "n/a";
}

/** Format an area in km², widening precision for small areas. */
function formatArea(km2: number): string {
  if (km2 >= 100) return km2.toFixed(0);
  if (km2 >= 1) return km2.toFixed(2);
  return km2.toFixed(3);
}

/** The first (typically only) band's statistics from a result. */
function firstBandStats(stats: StatisticsResult): BandStatistics | undefined {
  return Object.values(stats.bands)[0];
}

/** A key/value grid of scalar statistics. */
function statGrid(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([k, v]) =>
        `<span class="opera-stats-k">${escapeHtml(
          k,
        )}</span><span class="opera-stats-v">${escapeHtml(v)}</span>`,
    )
    .join("");
  return `<div class="opera-stats-grid">${cells}</div>`;
}

/** Pixels -> area in km² at the OPERA native grid spacing. */
function pixelsToKm2(pixels: number): number {
  return (pixels * OPERA_PIXEL_SIZE_METERS * OPERA_PIXEL_SIZE_METERS) / 1e6;
}

/** Continuous-band statistics block (min/max/mean/std/median/coverage). */
function renderContinuousStats(
  s: BandStatistics,
  band?: string,
  granuleId?: string,
): string {
  const rows: Array<[string, string]> = [
    ["min", formatStat(s.min)],
    ["max", formatStat(s.max)],
    ["mean", formatStat(s.mean)],
    ["std", formatStat(s.std)],
  ];
  if (s.median != null) rows.push(["median", formatStat(s.median)]);
  if (s.validPixels != null) {
    rows.push(["valid px", Math.round(s.validPixels).toLocaleString()]);
    rows.push(["valid area", `${formatArea(pixelsToKm2(s.validPixels))} km²`]);
  } else {
    rows.push(["count", formatStat(s.count)]);
  }
  if (s.validPercent != null)
    rows.push(["valid %", `${s.validPercent.toFixed(1)}%`]);
  return (
    statGrid(rows) +
    renderHistogram(s, band, granuleId) +
    renderRescaleSuggestion(s)
  );
}

/**
 * A compact bar-chart of the band's value distribution over the AOI, from the
 * `/statistics` histogram (`[counts, edges]`). The chart area is vertically
 * resizable (CSS), and the histogram data is stashed on the container so the
 * Download button can export a self-contained, labeled SVG. Empty when no
 * histogram is present.
 */
function renderHistogram(
  s: BandStatistics,
  band?: string,
  granuleId?: string,
): string {
  const hist = s.histogram;
  if (!hist || hist[0].length === 0) return "";
  const [counts, edges] = hist;
  // Binned histograms carry one more edge than counts (bin boundaries);
  // categorical histograms (e.g. DIST status) carry one edge per count (the
  // class value). Label each bar by its range or its single class accordingly.
  const categorical = edges.length === counts.length;
  const max = Math.max(...counts, 1);
  const bars = counts
    .map((c, i) => {
      const label = categorical
        ? formatStat(edges[i])
        : `${formatStat(edges[i])}–${formatStat(edges[i + 1])}`;
      const height = Math.max(Math.round((c / max) * 100), c > 0 ? 2 : 0);
      const title = `${label}: ${c.toLocaleString()}`;
      return `<span class="opera-hist-bar" style="height:${height}%" title="${escapeHtml(
        title,
      )}"></span>`;
    })
    .join("");
  // Stash the raw histogram + labels so the Download handler can rebuild a
  // standalone SVG without re-querying.
  const payload = escapeHtml(
    JSON.stringify({ counts, edges, band: band ?? "band", granuleId }),
  );
  return (
    `<div class="opera-hist" data-hist="${payload}">` +
    `<div class="opera-hist-bars" title="Drag the bottom-right corner to resize">${bars}</div>` +
    `<div class="opera-hist-axis"><span>${escapeHtml(
      formatStat(edges[0]),
    )}</span><span>${escapeHtml(
      formatStat(edges[edges.length - 1]),
    )}</span></div>` +
    `<button type="button" class="opera-link-button opera-hist-download">Download SVG</button>` +
    `</div>`
  );
}

/** Histogram payload stashed on the chart container for SVG export. */
interface HistogramPayload {
  counts: number[];
  edges: number[];
  band: string;
  granuleId?: string;
}

/**
 * Build a standalone, labeled SVG of a histogram for download. Self-contained
 * (inline attributes, no external CSS or fonts beyond a generic family) so it
 * renders on its own when opened as a file.
 */
function buildHistogramSvg(data: HistogramPayload): string {
  const W = 480;
  const H = 260;
  const m = { t: 34, r: 14, b: 36, l: 52 };
  const cw = W - m.l - m.r;
  const ch = H - m.t - m.b;
  const { counts, edges } = data;
  const max = Math.max(...counts, 1);
  const n = counts.length || 1;
  const bw = cw / n;
  const bars = counts
    .map((c, i) => {
      const h = (c / max) * ch;
      const x = m.l + i * bw;
      const y = m.t + (ch - h);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(
        bw - 1,
        0.5,
      ).toFixed(1)}" height="${h.toFixed(1)}" fill="#2b7fff"/>`;
    })
    .join("");
  const baseY = m.t + ch;
  const text = (
    x: number,
    y: number,
    value: string,
    anchor = "start",
    size = 12,
    weight = "normal",
  ) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="#333">${escapeHtml(
      value,
    )}</text>`;
  const labels =
    text(W / 2, 20, `${data.band} — value distribution`, "middle", 14, "600") +
    text(m.l, H - 12, formatStat(edges[0]), "start") +
    text(m.l + cw, H - 12, formatStat(edges[edges.length - 1]), "end") +
    text(m.l - 6, m.t + 10, max.toLocaleString(), "end", 11) +
    text(m.l - 6, baseY, "0", "end", 11);
  const axis = `<line x1="${m.l}" y1="${baseY}" x2="${m.l + cw}" y2="${baseY}" stroke="#999" stroke-width="1"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Roboto, sans-serif">` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    bars +
    axis +
    labels +
    `</svg>`
  );
}

/**
 * A one-click "apply a 2–98% rescale" button, when the stats carry sensible
 * percentile bounds. The bounds are stashed on `data-rescale` and applied by
 * the panel's delegated click handler.
 */
function renderRescaleSuggestion(s: BandStatistics): string {
  const lo = s.percentile2;
  const hi = s.percentile98;
  if (lo == null || hi == null || !(hi > lo)) return "";
  const value = `${formatNumber(lo)},${formatNumber(hi)}`;
  return `<button type="button" class="plugin-control-button opera-secondary-button opera-block-button opera-stats-apply-rescale" data-rescale="${escapeHtml(
    value,
  )}">Apply 2–98% rescale (${escapeHtml(value)})</button>`;
}

/**
 * DSWx water-band block: derive open-water area from the categorical histogram
 * (class pixel counts x pixel area) and list every class count. Areas are a
 * fraction of the total valid area, which is shown so the magnitude is
 * interpretable (e.g. a whole-granule AOI yields thousands of km²).
 */
function renderWaterStats(s: BandStatistics): string {
  let openCount = 0;
  let partialCount = 0;
  let validCount = 0;
  const classRows: string[] = [];
  if (s.histogram) {
    const [counts, values] = s.histogram;
    values.forEach((v, i) => {
      const count = counts[i] ?? 0;
      validCount += count;
      if (v === DSWX_OPEN_WATER_CLASS) openCount = count;
      if (v === DSWX_PARTIAL_WATER_CLASS) partialCount = count;
      const label = DSWX_WTR_CLASS_LABELS[String(v)] ?? `Class ${v}`;
      classRows.push(
        `<div class="opera-stats-row"><span>${escapeHtml(
          label,
        )}</span><span>${count.toLocaleString()}</span></div>`,
      );
    });
  }
  // Percentages are of valid (non-fill) pixels; keep each one on the line it
  // describes so the open-water fraction is never mistaken for open+partial.
  const pct = (px: number) =>
    validCount > 0 ? ` (${((px / validCount) * 100).toFixed(1)}% of valid)` : "";
  const openLine = `Open water: <b>${formatArea(
    pixelsToKm2(openCount),
  )} km²</b>${pct(openCount)}`;
  const waterLine = `Open + partial: ${formatArea(
    pixelsToKm2(openCount + partialCount),
  )} km²${pct(openCount + partialCount)}`;
  const validLine = `Valid: ${formatArea(
    pixelsToKm2(validCount),
  )} km² · ${validCount.toLocaleString()} px`;
  return (
    `<div class="opera-stats-headline">${openLine}</div>` +
    `<div class="opera-stats-sub">${waterLine}</div>` +
    `<div class="opera-stats-sub">${validLine}</div>` +
    `<div class="opera-stats-classes">${classRows.join("")}</div>`
  );
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
