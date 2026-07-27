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
  OperaAgentDisasterContextParams,
  OperaAgentDisasterContextResult,
  OperaAgentOvertureParams,
  OperaAgentOvertureResult,
  OperaAgentPopulationParams,
  OperaAgentPopulationResult,
  OperaAgentSentinel2Params,
  OperaAgentSentinel2Result,
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
export {
  DSWX_WTR_COLORMAP,
  DSWX_WTR_WATER_ONLY_COLORMAP,
  dswxWaterOnlyColormap,
  colormapForBand,
} from "./lib/opera/colormaps";

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
export {
  buildingsInFlood,
  dedupeOvertureFeatures,
  transportationInFlood,
  waterBBox,
  waterAreaKm2,
} from "./lib/opera/geometry";
export { fetchOsmBuildings } from "./lib/opera/buildings";
export {
  deriveFloodExtent,
  maskToFeatureCollection,
  traceMaskRings,
  chooseZoom,
} from "./lib/opera/flood-extent";
export { searchNews, type NewsResult } from "./lib/opera/news";
export {
  fetchWorldPopPopulation,
  worldPopImageUrl,
  WORLDPOP_DATASET,
  WORLDPOP_LATEST_YEAR,
  WORLDPOP_STATS_ENDPOINT,
  WORLDPOP_IMAGE_ENDPOINT,
  type WorldPopPopulationOptions,
  type WorldPopPopulationResult,
} from "./lib/opera/population";
export {
  fetchSentinel2Scene,
  PLANETARY_COMPUTER_DATA_API,
  PLANETARY_COMPUTER_STAC_SEARCH,
  SENTINEL_2_COLLECTION,
  type Sentinel2SceneOptions,
  type Sentinel2SceneResult,
  type Sentinel2SceneSearch,
} from "./lib/opera/satellite-imagery";
export {
  buildOnePagerHtml,
  type OnePagerInput,
  type OnePagerImpact,
  type OnePagerPopulation,
  type OnePagerTransportation,
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
  GeoLibreGeometry,
  GeoLibreOvertureQuery,
  GeoLibreOvertureQueryResult,
  GeoLibreOvertureTheme,
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
