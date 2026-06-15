/**
 * Canonical GeoLibre host-plugin contract.
 *
 * This module is the single source of truth for the interface between this
 * plugin and the GeoLibre host application. The GeoLibre wrapper in
 * `src/geolibre.ts` imports these types instead of redeclaring them.
 *
 * The shapes mirror the authoritative GeoLibre types in
 * `packages/plugins/src/types.ts` (`GeoLibreAppAPI`,
 * `GeoLibreExternalNativeLayerRegistration`, `GeoLibrePlugin`), but only the
 * members this plugin actually uses are declared. At runtime GeoLibre passes the
 * full API object, so widening these types is safe.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

/** Corner of the map a control can be docked to. */
export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Minimal GeoJSON `FeatureCollection` shape used when a plugin hands the host a
 * dataset to render. Kept structural so this module does not depend on the
 * `geojson` types.
 */
export interface GeoLibreFeatureCollection {
  type: "FeatureCollection";
  features: unknown[];
}

/**
 * Visual styling hints for a native layer the host renders on the plugin's
 * behalf. Every field is optional; the host applies sensible defaults.
 */
export interface GeoLibreNativeLayerStyle {
  minZoom?: number;
  maxZoom?: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  circleRadius?: number;
}

/**
 * Registration payload passed to
 * {@link GeoLibreAppAPI.registerExternalNativeLayer}. GeoLibre owns the MapLibre
 * sources and layers (so they appear in the host layer panel and respect its
 * theme) while the plugin supplies the data, the source definition, and styling.
 *
 * Two modes:
 * - **Host-created source** (used for the OPERA raster tiles): set `type` and
 *   `source` (e.g. `{ type: "raster", tiles: [...], tileSize: 256 }`). The host
 *   builds the MapLibre source/layer from them; `nativeLayerIds` may be empty.
 * - **Plugin-created source**: the plugin adds the source/layer itself via
 *   `getMap()` and passes the created `nativeLayerIds`/`sourceIds` so the host
 *   can manage visibility/opacity/order.
 */
export interface GeoLibreNativeLayerRegistration {
  /** Stable, plugin-unique id used later to unregister the layer. */
  id: string;
  /** Human-readable name shown in the host's layer list. */
  name: string;
  /** GeoLibre layer type, e.g. "raster" or "geojson". */
  type?: string;
  /** MapLibre source definition the host should create (e.g. raster tiles). */
  source?: Record<string, unknown>;
  /** Optional inline data; omit when the host already has the source. */
  geojson?: GeoLibreFeatureCollection;
  /** MapLibre layer ids the host should create or adopt. */
  nativeLayerIds: string[];
  /** MapLibre source ids backing the layers above. */
  sourceIds?: string[];
  /** Convenience single source id (alternative to `sourceIds`). */
  sourceId?: string;
  /** Insert the layer before this existing layer id. */
  beforeId?: string;
  /** Initial layer opacity in the range 0..1. */
  opacity?: number;
  /** Styling hints applied to the rendered layer. */
  style?: GeoLibreNativeLayerStyle;
  /** Arbitrary extra data the host may persist or display. */
  metadata?: Record<string, unknown>;
}

/**
 * Structural type for a MapLibre control instance. A marker interface keeps this
 * contract independent of the concrete control implementation.
 */
export interface GeoLibreControl {
  onAdd(...args: never[]): HTMLElement;
  onRemove(...args: never[]): void;
}

/**
 * The surface GeoLibre exposes to an active plugin.
 *
 * Only {@link addMapControl} and {@link removeMapControl} are guaranteed. The
 * remaining members are optional host capabilities: always call them with
 * optional chaining (`app.addGeoJsonLayer?.(...)`) and degrade gracefully when a
 * host build does not provide them.
 *
 * @typeParam TControl - The plugin's concrete control type.
 */
export interface GeoLibreAppAPI<TControl extends GeoLibreControl = GeoLibreControl> {
  /**
   * Add the plugin's control to the map. Returns `false` when the host refuses,
   * in which case the plugin should treat activation as failed.
   */
  addMapControl: (
    control: TControl,
    position?: GeoLibreMapControlPosition,
  ) => boolean;
  /** Remove a previously added control from the map. */
  removeMapControl: (control: TControl) => void;
  /**
   * Add a GeoJSON dataset as a native MapLibre layer the host owns and renders.
   * Used here to draw OPERA granule footprints.
   */
  addGeoJsonLayer?: (
    name: string,
    data: GeoLibreFeatureCollection,
    sourcePath?: string,
  ) => void;
  /** Fit the map view to a `[west, south, east, north]` bounding box. */
  fitBounds?: (bounds: [number, number, number, number]) => void;
  /** Return the raw MapLibre map instance (e.g. to read the current extent). */
  getMap?: () => MapLibreMap | null;
  /**
   * Open the host's native directory picker. Present only on hosts that support
   * local file access (for example, GeoLibre Desktop).
   */
  pickLocalDirectoryFiles?: () => Promise<File[] | null>;
  /**
   * Resolve a fetchable URL for an asset bundled inside this plugin's own
   * folder. Returns `null` when the plugin was not loaded from a URL base.
   */
  resolvePluginAssetUrl?: (
    pluginId: string,
    relativePath: string,
  ) => string | null;
  /** Hand the host a dataset/source to render as a native MapLibre layer. */
  registerExternalNativeLayer?: (
    layer: GeoLibreNativeLayerRegistration,
  ) => void;
  /** Remove a native layer previously registered with the given id. */
  unregisterExternalNativeLayer?: (id: string) => void;
}

/**
 * The object a plugin's GeoLibre entry point must export. Everything beyond
 * `id`, `name`, `version`, `activate`, and `deactivate` is optional and only
 * invoked when the plugin declares it.
 *
 * @typeParam TControl - The plugin's concrete control type.
 */
export interface GeoLibrePlugin<TControl extends GeoLibreControl = GeoLibreControl> {
  /** Stable plugin id; must match `plugin.json`'s `id`. */
  id: string;
  /** Display name; must match `plugin.json`'s `name`. */
  name: string;
  /** Semantic version; must match `plugin.json`'s `version`. */
  version: string;
  /**
   * Query-parameter names this plugin owns. When the host opens a URL carrying
   * one of these, it auto-activates the plugin and routes the parameters to
   * {@link handleUrlParameters}.
   */
  urlParameterNames?: string[];
  /** Activate the plugin: create and add the control. */
  activate: (app: GeoLibreAppAPI<TControl>) => boolean | void;
  /** Deactivate the plugin: capture state, then remove the control. */
  deactivate: (app: GeoLibreAppAPI<TControl>) => void;
  /** Handle deep-link query parameters declared in {@link urlParameterNames}. */
  handleUrlParameters?: (
    app: GeoLibreAppAPI<TControl>,
    params: URLSearchParams,
  ) => void | Promise<void>;
  /** Report the control's current dock position (for persistence). */
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  /** Move the control to a new dock position. */
  setMapControlPosition?: (
    app: GeoLibreAppAPI<TControl>,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  /** Serialize plugin state so the host can save it with the project. */
  getProjectState?: () => unknown;
  /** Restore plugin state previously produced by {@link getProjectState}. */
  applyProjectState?: (
    app: GeoLibreAppAPI<TControl>,
    state: unknown,
  ) => boolean | void;
}
