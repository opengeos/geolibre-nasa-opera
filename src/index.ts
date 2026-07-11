// Import styles
import "./lib/styles/plugin-control.css";

// Core control
export { OperaControl } from "./lib/core/OperaControl";
export type {
  OperaControlOptions,
  OperaState,
  OperaAgentChangeObservation,
  OperaAgentChangeParams,
  OperaAgentChangeResult,
  OperaAgentDerivedLayer,
  OperaAgentDisplayParams,
  OperaAgentReportParams,
  OperaAgentReportResult,
  OperaAgentResult,
  OperaAgentSearchParams,
  OperaAgentTimeSeriesParams,
  OperaAgentTimeSeriesResult,
} from "./lib/core/OperaControl";

// OPERA data layer
export { OPERA_PRODUCTS, getProduct } from "./lib/opera/products";
export {
  searchGranules,
  resolveConceptId,
  granuleBands,
  getLayerBand,
} from "./lib/opera/cmr";
export {
  buildCmrPointUrl,
  buildCmrStatisticsUrl,
  buildCmrTileJsonUrl,
  buildCmrTimeseriesTileJsonUrl,
  buildTileJsonUrl,
  fetchTimeSeriesTileJson,
  fetchTitilerJson,
  fetchTileJson,
  granuleDatetime,
  tileJsonBounds,
  tileSizeFromTemplate,
  DEFAULT_TITILER_CMR_ENDPOINT,
} from "./lib/opera/titiler";
export { DSWX_WTR_COLORMAP, colormapForBand } from "./lib/opera/colormaps";

// Constrained flood one-pager workflow
export {
  lockBenchmark,
  normalizeWater,
  summarizeBenchmark,
  isLockedBenchmark,
  type LockedBenchmark,
  type BenchmarkEvent,
  type BenchmarkRender,
  type BenchmarkSummary,
} from "./lib/opera/benchmark";
export { buildingsInFlood, waterBBox, waterAreaKm2 } from "./lib/opera/geometry";
export { fetchOsmBuildings } from "./lib/opera/buildings";
export { searchNews, type NewsResult } from "./lib/opera/news";
export {
  buildOnePagerHtml,
  type OnePagerInput,
  type OnePagerImpact,
} from "./lib/opera/one-pager";
export type {
  BBox,
  OperaProduct,
  OperaRenderDefaults,
  OperaGranule,
  GranuleBand,
  GranuleSearchParams,
  GranuleSearchResult,
  TitilerBackend,
} from "./lib/opera/types";

// GeoLibre host-plugin contract
export type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
  GeoLibreControl,
  GeoLibreMapControlPosition,
  GeoLibreNativeLayerRegistration,
  GeoLibreNativeLayerStyle,
  GeoLibreFeatureCollection,
} from "./lib/geolibre/host-api";

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from "./lib/utils";
