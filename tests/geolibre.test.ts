import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoLibreAppAPI, GeoLibreControl } from "../src/lib/geolibre/host-api";
import type { OperaState } from "../src/lib/core/OperaControl";

async function freshPlugin() {
  vi.resetModules();
  return (await import("../src/geolibre")).plugin;
}

function appStub(): GeoLibreAppAPI<GeoLibreControl> {
  return {
    addMapControl: vi.fn(() => true),
    removeMapControl: vi.fn(),
  };
}

/**
 * A host stub that supports the right-sidebar + toolbar-menu capabilities, so
 * the plugin docks instead of floating. `registerRightPanel` renders the panel
 * body immediately (as a real host does on register) into a detached container.
 */
function dockingApp() {
  const mapContainer = document.createElement("div");
  const map = {
    getContainer: () => mapContainer,
    on: vi.fn(),
    off: vi.fn(),
    getBounds: () => ({
      getWest: () => -1,
      getSouth: () => -1,
      getEast: () => 1,
      getNorth: () => 1,
    }),
    // Minimal MapLibre surface the highlight overlay touches on teardown.
    getLayer: vi.fn(() => undefined),
    removeLayer: vi.fn(),
    addLayer: vi.fn(),
    getSource: vi.fn(() => undefined),
    removeSource: vi.fn(),
    addSource: vi.fn(),
    moveLayer: vi.fn(),
    getCanvas: () => ({ style: {} }),
    queryRenderedFeatures: vi.fn(() => []),
  };
  const state = { renders: 0, cleanups: 0, container: null as HTMLElement | null };
  const app = {
    addMapControl: vi.fn(() => true),
    removeMapControl: vi.fn(),
    getMap: vi.fn(() => map),
    registerRightPanel: vi.fn(
      (panel: {
        render: (c: HTMLElement) => void | (() => void);
      }) => {
        const container = document.createElement("div");
        state.container = container;
        const cleanup = panel.render(container);
        state.renders += 1;
        return vi.fn(() => {
          if (typeof cleanup === "function") {
            cleanup();
            state.cleanups += 1;
          }
        });
      },
    ),
    unregisterRightPanel: vi.fn(),
    openRightPanel: vi.fn(() => true),
    collapseRightPanel: vi.fn(),
    closeRightPanel: vi.fn(),
    registerToolbarMenu: vi.fn(() => vi.fn()),
    unregisterToolbarMenu: vi.fn(),
  } as unknown as GeoLibreAppAPI<GeoLibreControl> & {
    registerToolbarMenu: ReturnType<typeof vi.fn>;
    registerRightPanel: ReturnType<typeof vi.fn>;
    openRightPanel: ReturnType<typeof vi.fn>;
  };
  return { app, map, state };
}

describe("GeoLibre plugin entry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("activates the OPERA panel and companion GeoAgent control", async () => {
    const plugin = await freshPlugin();
    const app = appStub();

    plugin.activate(app);

    expect(app.addMapControl).toHaveBeenCalledTimes(2);
    expect(app.addMapControl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        onAdd: expect.any(Function),
        onRemove: expect.any(Function),
      }),
      "top-left",
    );
    expect(app.addMapControl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        onAdd: expect.any(Function),
        onRemove: expect.any(Function),
      }),
      "top-right",
    );
  });

  it("persists combined OPERA and GeoAgent project state", async () => {
    const plugin = await freshPlugin();
    const app = appStub();

    plugin.activate(app);
    const state = plugin.getProjectState?.();

    expect(state).toMatchObject({
      opera: expect.objectContaining({ product: expect.any(String) }),
      geoAgent: expect.objectContaining({
        collapsed: true,
        allowDestructiveTools: true,
      }),
    });
  });

  it("restores legacy OPERA-only project state", async () => {
    const plugin = await freshPlugin();
    const app = appStub();
    const legacyState: Partial<OperaState> = {
      collapsed: true,
      panelWidth: 375,
      product: "OPERA_L2_RTC-S1_V1",
    };

    plugin.applyProjectState?.(app, legacyState);
    plugin.activate(app);
    const state = plugin.getProjectState?.();

    expect(state).toMatchObject({
      opera: expect.objectContaining(legacyState),
      geoAgent: expect.objectContaining({ collapsed: true }),
    });
  });

  it("docks the OPERA panel by default when the host has a right sidebar", async () => {
    const plugin = await freshPlugin();
    const { app, state } = dockingApp();

    plugin.activate(app);

    // OPERA is rendered into the host right panel, not added as a map control.
    expect(app.registerRightPanel).toHaveBeenCalledTimes(1);
    expect(app.openRightPanel).toHaveBeenCalledWith("geolibre-nasa-opera-panel");
    expect(state.renders).toBe(1);
    // Only the GeoAgent companion is a floating map control in docked mode.
    expect(app.addMapControl).toHaveBeenCalledTimes(1);
    expect(app.registerToolbarMenu).toHaveBeenCalled();
    expect(plugin.getProjectState?.()).toMatchObject({ panelMode: "docked" });
  });

  it("switches from docked to floating via the toolbar menu", async () => {
    const plugin = await freshPlugin();
    const { app } = dockingApp();

    plugin.activate(app);
    // Grab the "Float panel" action from the most recent menu registration.
    const menu = app.registerToolbarMenu.mock.calls.at(-1)?.[0] as {
      items: Array<{ id?: string; onSelect?: () => void }>;
    };
    const float = menu.items.find((item) => item.id === "float");
    expect(float?.onSelect).toBeTypeOf("function");

    float!.onSelect!();

    // Now floating: both OPERA and GeoAgent are map controls.
    expect(app.addMapControl).toHaveBeenCalledWith(
      expect.objectContaining({ onAdd: expect.any(Function) }),
      "top-left",
    );
    expect(plugin.getProjectState?.()).toMatchObject({ panelMode: "floating" });
  });

  it("keeps a saved floating project floating even on a docking host", async () => {
    const plugin = await freshPlugin();
    const { app } = dockingApp();

    // A project wrapped with opera + geoAgent but no panelMode predates docking.
    plugin.applyProjectState?.(app, {
      opera: { product: "OPERA_L2_RTC-S1_V1" },
      geoAgent: { collapsed: true },
    });
    plugin.activate(app);

    expect(app.registerRightPanel).not.toHaveBeenCalled();
    // OPERA + GeoAgent both floating.
    expect(app.addMapControl).toHaveBeenCalledTimes(2);
    expect(plugin.getProjectState?.()).toMatchObject({ panelMode: "floating" });
  });

  it("honors an explicit docked panelMode in saved project state", async () => {
    const plugin = await freshPlugin();
    const { app } = dockingApp();

    plugin.applyProjectState?.(app, {
      opera: { product: "OPERA_L2_RTC-S1_V1" },
      panelMode: "docked",
    });
    plugin.activate(app);

    expect(app.registerRightPanel).toHaveBeenCalledTimes(1);
    expect(plugin.getProjectState?.()).toMatchObject({ panelMode: "docked" });
  });
});
