import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GeoLibreAppAPI,
  GeoLibreControl,
  GeoLibreNativeLayerRegistration,
} from "../src/lib/geolibre/host-api";
import type { OperaControl } from "../src/lib/core/OperaControl";

async function freshPlugin() {
  vi.resetModules();
  return (await import("../src/geolibre")).plugin;
}

/**
 * The MapLibre-shaped facade GeoLibre hands a control on the Cesium globe.
 *
 * It answers the camera, container and event API but has no style layers:
 * `getLayer` is absent outright and `addSource`/`addLayer` throw by design. The
 * facade is truthy, which is precisely why a `if (!map)` guard does not catch
 * it — see packages/map/src/cesium-control-host.ts in GeoLibre.
 */
function globeFacade(container: HTMLElement) {
  const throws = (name: string) => () => {
    throw new Error(
      `CesiumControlHost: ${name} is not supported on the globe.`,
    );
  };
  return {
    getContainer: () => container,
    getCanvas: () => ({ style: {} }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    project: vi.fn(() => ({ x: 0, y: 0 })),
    getCenter: () => ({ lng: 0, lat: 0 }),
    getZoom: () => 3,
    getBearing: () => 0,
    getPitch: () => 0,
    addSource: throws("addSource"),
    addLayer: throws("addLayer"),
    removeSource: throws("removeSource"),
    removeLayer: throws("removeLayer"),
    setPaintProperty: throws("setPaintProperty"),
    setLayoutProperty: throws("setLayoutProperty"),
    getStyle: throws("getStyle"),
    getSource: () => undefined,
    // getLayer, moveLayer and queryRenderedFeatures are deliberately absent.
  };
}

/** A real MapLibre map's style-layer surface, enough for the native path. */
function styleSpecMap(container: HTMLElement) {
  return {
    getContainer: () => container,
    getCanvas: () => ({ style: {} }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    getLayer: vi.fn(() => undefined),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    getSource: vi.fn(() => undefined),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    moveLayer: vi.fn(),
    getStyle: () => ({ layers: [] }),
    queryRenderedFeatures: vi.fn(() => []),
  };
}

/**
 * Mount the plugin's docked panel against `map`, collecting every layer the
 * control registers with the host.
 */
function mountWith(map: object, extras: Record<string, unknown> = {}) {
  const registrations: GeoLibreNativeLayerRegistration[] = [];
  // No registerRightPanel: the plugin then mounts floating, so the OPERA
  // control is the first one handed to addMapControl (docked mode only routes
  // the GeoAgent companion through there) and its panel DOM lands in the map
  // container we can query.
  const app = {
    addMapControl: vi.fn(() => true),
    removeMapControl: vi.fn(),
    getMap: vi.fn(() => map),
    registerExternalNativeLayer: vi.fn(
      (registration: GeoLibreNativeLayerRegistration) => {
        registrations.push(registration);
      },
    ),
    unregisterExternalNativeLayer: vi.fn(),
    addGeoJsonLayer: vi.fn(),
    fitBounds: vi.fn(),
    registerToolbarMenu: vi.fn(() => vi.fn()),
    unregisterToolbarMenu: vi.fn(),
    ...extras,
  } as unknown as GeoLibreAppAPI<GeoLibreControl>;
  return { app, registrations };
}

/**
 * The impact-layer drawer, reached through a cast.
 *
 * It is private because nothing outside the control should add impact layers,
 * and its public callers are long agent workflows that would need the whole
 * CMR/titiler/Overture network surface mocked to reach one branch. The branch
 * under test is the renderer split, so drive it directly.
 */
interface ImpactLayerDrawer {
  _addStyledGeoJsonImpactLayer(options: {
    id: string;
    name: string;
    data: typeof BUILDINGS;
    geometry: "fill" | "line" | "point" | "extrusion";
    color: string;
    opacity: number;
    strokeColor?: string;
    strokeWidth: number;
    sourceKind?: string;
    extrusionHeightProperty?: string;
  }): string | undefined;
}

const BUILDINGS = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { _opera_height_m: 12 },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

describe("renderer-neutral layer registration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("asks the host to own the source when the map cannot paint style layers", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app, registrations } = mountWith(facade);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);

    expect(() =>
      (control as unknown as ImpactLayerDrawer)._addStyledGeoJsonImpactLayer({
        id: "opera-impact-buildings",
        name: "Buildings in flood",
        data: BUILDINGS,
        geometry: "extrusion",
        color: "#ff0000",
        opacity: 0.8,
        strokeWidth: 1,
      }),
    ).not.toThrow();

    const registration = registrations.at(-1);
    expect(registration).toBeDefined();
    // Host-created-source mode: no native ids to adopt, but the data and the
    // full styling hints travel with the record so the globe can draw it.
    expect(registration?.nativeLayerIds).toEqual([]);
    expect(registration?.geojson).toBe(BUILDINGS);
    expect(registration?.style?.extrusionEnabled).toBe(true);
    expect(registration?.style?.extrusionHeightProperty).toBe(
      "_opera_height_m",
    );
  });

  it("still draws and adopts native layers on a style-spec map", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const map = styleSpecMap(container);
    const { app, registrations } = mountWith(map);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(map as never);

    (control as unknown as ImpactLayerDrawer)._addStyledGeoJsonImpactLayer({
      id: "opera-impact-buildings",
      name: "Buildings in flood",
      data: BUILDINGS,
      geometry: "extrusion",
      color: "#ff0000",
      opacity: 0.8,
      strokeWidth: 1,
    });

    expect(map.addSource).toHaveBeenCalledTimes(1);
    expect(map.addLayer).toHaveBeenCalledTimes(1);
    const registration = registrations.at(-1);
    expect(registration?.nativeLayerIds).toEqual([
      "opera-impact-buildings-extrusion",
    ]);
    expect(registration?.sourceIds).toEqual(["opera-impact-buildings-source"]);
  });
});

describe("renderer-neutral overlays and picking", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  /** Put two granules with known footprints into the control's results. */
  function seedGranules(control: OperaControl) {
    const square = (west: number): unknown => ({
      type: "Polygon",
      coordinates: [
        [
          [west, 0],
          [west, 2],
          [west + 2, 2],
          [west + 2, 0],
          [west, 0],
        ],
      ],
    });
    (
      control as unknown as {
        _granules: Array<{ id: string; geometry: unknown }>;
        _selectedIds: Set<string>;
      }
    )._granules = [
      { id: "G-west", geometry: square(0) },
      { id: "G-east", geometry: square(10) },
    ];
  }

  it("hit-tests footprints geometrically when the map cannot pick", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app } = mountWith(facade);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);
    seedGranules(control);

    const pick = (lng: number, lat: number) =>
      (
        control as unknown as {
          _granuleAtPoint(e: unknown): { id: string } | undefined;
        }
      )._granuleAtPoint({ lngLat: { lng, lat }, point: { x: 0, y: 0 } });

    expect(pick(1, 1)?.id).toBe("G-west");
    expect(pick(11, 1)?.id).toBe("G-east");
    expect(pick(50, 50)).toBeUndefined();
  });

  it("draws the selection highlight as a store layer on the globe", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app, registrations } = mountWith(facade);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);
    seedGranules(control);

    const internals = control as unknown as {
      _selectedIds: Set<string>;
      _highlightSelectedFootprints(): void;
      _clearHighlight(): void;
    };
    internals._selectedIds = new Set(["G-east"]);
    expect(() => internals._highlightSelectedFootprints()).not.toThrow();

    const highlight = registrations.at(-1);
    expect(highlight?.id).toBe("opera-footprint-highlight");
    expect(highlight?.nativeLayerIds).toEqual([]);
    expect(highlight?.geojson?.features).toHaveLength(1);
    expect(highlight?.style?.strokeColor).toBe("#ffd400");

    // Clearing the selection drops the layer rather than leaving an empty one.
    internals._clearHighlight();
    expect(app.unregisterExternalNativeLayer).toHaveBeenCalledWith(
      "opera-footprint-highlight",
    );
  });

  it("drops stale footprints when a later search finds nothing", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app, registrations } = mountWith(facade);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);

    const internals = control as unknown as {
      _addFootprintsLayer(
        name: string,
        data: { type: "FeatureCollection"; features: unknown[] },
      ): void;
      _removeFootprintsStoreLayer(): void;
    };
    internals._addFootprintsLayer("OPERA DSWX-HLS Footprints (1)", {
      type: "FeatureCollection",
      features: [BUILDINGS.features[0]],
    });
    expect(registrations.at(-1)?.id).toBe("opera-granule-footprints");

    // The store path reuses one id, so an empty result must drop the layer
    // rather than leave the previous search's footprints on the map.
    internals._removeFootprintsStoreLayer();
    expect(app.unregisterExternalNativeLayer).toHaveBeenCalledWith(
      "opera-granule-footprints",
    );
  });

  it("refuses map drawing on a renderer with no interaction handlers", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app } = mountWith(facade);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);

    expect(control.toggleAgentAoiDraw()).toBe(false);
    expect(container.textContent).toContain(
      "Drawing on the map is not available on this renderer",
    );
  });

  it("tears down cleanly on the globe without touching style layers", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app } = mountWith(facade);
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);

    expect(() => control.onRemove?.()).not.toThrow();
  });
});

describe("renderer-neutral viewport reads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("reads the extent through getViewBounds when the host offers it", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const getViewBounds = vi.fn(
      () => [-10, -5, 10, 5] as [number, number, number, number],
    );
    const facade = globeFacade(container);
    const { app } = mountWith(facade, {
      getViewBounds,
      getMapRenderer: () => "cesium",
    });
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);

    const extentBtn = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use map extent",
    );
    expect(extentBtn).toBeDefined();
    extentBtn?.click();

    expect(getViewBounds).toHaveBeenCalled();
    expect(control.getState().bbox).toBe("-10.0000, -5.0000, 10.0000, 5.0000");
  });

  it("refuses rather than widening the search when no extent is available", async () => {
    const plugin = await freshPlugin();
    const container = document.createElement("div");
    const facade = globeFacade(container);
    const { app } = mountWith(facade, {
      // The globe mid-morph, or a camera pointed away from Earth.
      getViewBounds: vi.fn(() => null),
      getMapRenderer: () => "cesium",
    });
    plugin.activate(app);
    const control = vi.mocked(app.addMapControl).mock
      .calls[0][0] as unknown as OperaControl;
    control.onAdd?.(facade as never);

    const extentBtn = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use map extent",
    );
    extentBtn?.click();

    expect(control.getState().bbox).toBe("");
    expect(container.textContent).toContain("Map extent unavailable.");
  });
});
