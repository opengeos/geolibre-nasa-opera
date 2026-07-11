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
 * Registration payload passed to {@link GeoLibreAppAPI.registerRightPanel}. The
 * host renders a native right-sidebar panel (header with collapse/close buttons,
 * a collapsible rail, and a resize handle) and the plugin owns only the body via
 * {@link render}. While a plugin right panel is the active right-side workspace
 * the host collapses its built-in Style panel and restores it when the plugin
 * panel closes, so the two never compete for space.
 */
export interface GeoLibreRightPanelRegistration {
  /** Stable, plugin-unique id used to open/collapse/close the panel. */
  id: string;
  /** Title shown in the panel header and the collapsed rail. */
  title: string;
  /** Optional rail icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** Preferred expanded width in px (desktop only; the host clamps it). */
  defaultWidth?: number;
  /**
   * Populate the panel body. Called with an empty container the plugin fills
   * with its own DOM (the contract is plain DOM, so a plugin never has to share
   * the host's UI framework). May return a cleanup function the host runs when
   * the panel closes or is unregistered.
   */
  render: (container: HTMLElement) => void | (() => void);
  /** Called after the panel opens (becomes the active workspace). */
  onOpen?: () => void;
  /** Called after the panel collapses to its rail. */
  onCollapse?: () => void;
  /** Called after the panel closes (releases the workspace). */
  onClose?: () => void;
}

/**
 * An action item in a plugin {@link GeoLibreToolbarMenu}. Selecting it runs
 * {@link onSelect} (for example, to open or re-dock the plugin panel).
 */
export interface GeoLibreToolbarMenuAction {
  /** Discriminator; defaults to "action" when omitted. */
  type?: "action";
  /** Stable id, unique within the menu. */
  id: string;
  /** Label shown in the menu. */
  label: string;
  /** Optional icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** When true, the item is shown disabled and cannot be selected. */
  disabled?: boolean;
  /** Invoked when the user selects the item. */
  onSelect: () => void;
}

/** A nested submenu in a plugin {@link GeoLibreToolbarMenu}. */
export interface GeoLibreToolbarSubmenu {
  type: "submenu";
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
}

/** A divider between groups of items in a plugin toolbar menu. */
export interface GeoLibreToolbarSeparator {
  type: "separator";
  id?: string;
}

/** One entry in a plugin toolbar menu: an action, a submenu, or a separator. */
export type GeoLibreToolbarMenuItem =
  | GeoLibreToolbarMenuAction
  | GeoLibreToolbarSubmenu
  | GeoLibreToolbarSeparator;

/**
 * A plugin-owned top-level toolbar menu. The host renders it as a dropdown
 * button in the banner beside the built-in menus.
 */
export interface GeoLibreToolbarMenu {
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
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
  /**
   * Register a native right-sidebar panel that docks beside the host's built-in
   * Style panel. Returns an unregister function (call it from `deactivate`). The
   * panel is not shown until {@link openRightPanel} is called. Present only on
   * hosts with a right sidebar (for example, GeoLibre Desktop and the web app).
   * See {@link GeoLibreRightPanelRegistration}.
   */
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  /** Remove a previously registered right panel (closing it if active). */
  unregisterRightPanel?: (id: string) => void;
  /**
   * Make the panel the active right-side workspace and expand it. Returns
   * `false` if no panel with that id is registered. Re-opening a collapsed panel
   * expands it.
   */
  openRightPanel?: (id: string) => boolean;
  /** Collapse the active right panel to its rail without closing it. */
  collapseRightPanel?: (id: string) => void;
  /** Close the active right panel and restore the host's Style panel. */
  closeRightPanel?: (id: string) => void;
  /** Id of the active right-side workspace panel, or `null` when none is open. */
  getActiveRightPanel?: () => string | null;
  /**
   * Register a top-level toolbar menu in the host banner, with nested submenus
   * and action items. Returns an unregister function (call it from
   * `deactivate`). Re-registering the same id replaces the menu. See
   * {@link GeoLibreToolbarMenu}.
   */
  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  /** Remove a previously registered toolbar menu. */
  unregisterToolbarMenu?: (id: string) => void;
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
