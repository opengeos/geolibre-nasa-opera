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
});
