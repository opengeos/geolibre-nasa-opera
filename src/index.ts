// Import styles
import "./lib/styles/plugin-control.css";

// Core control
export { OperaControl } from "./lib/core/OperaControl";
export type {
  OperaControlOptions,
  OperaState,
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
  buildTileJsonUrl,
  fetchTileJson,
  granuleDatetime,
  tileJsonBounds,
  DEFAULT_TITILER_CMR_ENDPOINT,
} from "./lib/opera/titiler";
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
